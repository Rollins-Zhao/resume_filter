// BOSS greet 回查模块（v2.12.0 从 greet.js 抽出成可注入模块 + CLI 请求预算适配）
//
// 根因背景（BUG-2026-11-03，源码级证实）：boss-agent-cli v3.1.0 起 RequestBudget 跨进程预算层
//   （~/.boss-agent/request-budget.sqlite3，API 与 browser 通道共享）硬规则：
//   ① 任何两次 CLI 派发最小间隔 30s（interval=request_delay[0]）；
//   ② 单进程等预算上限 30s（wait_timeout），超限抛 REQUEST_BUDGET_EXHAUSTED（request_sent:false，
//     details.retry_after_seconds 可有可无——两处 raise 多数不带）；
//   ③ 高斯 30-60s 节流等待在持有全局租约期间执行。
// 旧 verifyDelivered（3 轮×5s 间隔×60s 进程超时）与此结构性不兼容：发送刚占坑（next_at≈发送+30s），
// 紧随的回查进程在预算内排队时被我们的 60s 超时杀掉 → 恒 UNVERIFIED → 不记账（重复触达风险）。
// 本模块适配：首轮前等 40s（越过发送的预算坑）、轮间隔 45s（>30s 最小间隔+余量）、
// 单次进程超时 150s（让 CLI 在预算内等完而不是被我们杀掉）、预算错误按 retry_after 等待。
//
// v2.15.0（BUG-2026-11-05 假成功与核实失效）：回查必须**单请求**——`--summary-limit 100` 的语义
//   是「给前 100 个会话逐个补最近消息，每 50 个一次串行请求」，一次回查 = 列表 1 次 + 补拉 ≥2 次，
//   每次都撞 30s 预算排队，第二个请求即 REQUEST_BUDGET_EXHAUSTED → 三轮全 unknown → 恒 UNVERIFIED。
//   实测反证：`--summary-limit 0` 单次请求即成功，且列表响应自带 last_msg（summary_source:"page"），
//   补拉完全没必要。改 0 后回查在 1 次请求内出结果。
//
// ⚠️ 匹配器局限（待真机样本升级）：hr chat 回包结构无存档样本，沿用「沟通列表全文含话术
// snippet」匹配；snippet 取前 24 字（覆盖模板 dim1/dim2 差异位，降低同模板候选人互相误命中）。
// v2.15.0 防御：话术含 & < > 时 JSON 串里是转义形式（&amp; 等），纯原文 includes 会漏——
// envelopeContains/containsSnippet 同时匹配原文与转义版（不猜结构，纯字符串防御）。
// 同画像同 dim 组合的极端撞词仍可能误判，下次真机运行应存一份回包样本把匹配器升级为
// 「按 geek 身份定位会话再验内容」（boss-cli-notes 实测纪律：不要猜结构）。
const { runBoss, LoginExpired, VerificationRequired, RiskControlError } = require("./boss");

const BUDGET_CODE = "REQUEST_BUDGET_EXHAUSTED";
const FIRST_WAIT_SEC = 40; // 发送后首个回查进程的预热等待（发送 next_at≈+30s + CLI 启动开销）
const RETRY_WAIT_SEC = 45; // 轮间隔：> 预算最小间隔 30s，余量覆盖进程启动
const CHAT_TIMEOUT_MS = 150000; // 单次 hr chat 进程超时：预算内等待(≤30s)+平台响应+启动开销
const SNIPPET_LEN = 24;

// REQUEST_BUDGET_EXHAUSTED 的建议等待秒数（读 envelope.error.details.retry_after_seconds）；
// 没给（上游两处 raise 常不带）返回 null → 调用方回落默认轮间隔
function parseBudgetWait(r) {
  if (!r || r.ok) return null;
  if (String(r.code) !== BUDGET_CODE) return null;
  const d = r.envelope && r.envelope.error && r.envelope.error.details;
  const v = d && Number(d.retry_after_seconds);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function snippetOf(msg) {
  return String(msg || "").slice(0, SNIPPET_LEN);
}

// P2-1 防御（BUG-2026-11-05）：话术里的 & < > 在 JSON 串里是 &amp; &lt; &gt; 形式，
// 纯原文 includes 会漏匹配（回查误判 not-delivered）。同时测原文与转义版，不猜回包结构。
function escapeHtmlText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function envelopeContains(envelope, snippet) {
  const raw = JSON.stringify(envelope || {});
  return raw.includes(snippet) || raw.includes(escapeHtmlText(snippet));
}
// greet.js 预检对 stringify 快照的同款匹配（haystack 已是字符串）
function containsSnippet(haystack, snippet) {
  const raw = String(haystack || "");
  return raw.includes(snippet) || raw.includes(escapeHtmlText(snippet));
}

// 回查核实：返回 {verdict:"yes"|"no"|"unknown", lastCode}
//   yes=沟通列表含话术 snippet（核实投递）；no=3 轮查询全部成功且都未匹配（核实未投递）；
//   unknown=查询自身失败（预算/限流/异常），无法核实。红线错误码（登录失效/需验证/风控）上抛。
async function verifyDelivered(msg, { runBossFn, sleepFn, logger } = {}) {
  const run = runBossFn || ((args, opts) => runBoss(args, opts));
  const sleep = sleepFn || ((sec) => new Promise((res) => setTimeout(res, sec * 1000)));
  const snippet = snippetOf(msg);
  await sleep(FIRST_WAIT_SEC);
  let queryFailed = "";
  let lastCode = "";
  let budgetWait = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      await sleep(budgetWait != null ? Math.max(RETRY_WAIT_SEC, budgetWait + 5) : RETRY_WAIT_SEC);
    }
    budgetWait = null;
    try {
      // v2.15.0：summary-limit 必须为 0（单请求）——100 会触发逐会话补拉（≥3 次串行请求），
      // 每次撞 30s 预算排队 → 第二个请求即 REQUEST_BUDGET_EXHAUSTED（BUG-2026-11-05 实证）。
      // 列表页响应自带 last_msg（summary_source:"page"），文本匹配不受影响。
      const r = run(["hr", "chat", "--page", "1", "--summary-limit", "0"], { timeoutMs: CHAT_TIMEOUT_MS, logger });
      if (r && r.ok && r.envelope && envelopeContains(r.envelope, snippet)) {
        return { verdict: "yes", lastCode: "" };
      }
      if (r && r.ok) continue; // 查询成功但没匹配到 → 等下一轮（可能尚未落库）
      lastCode = String((r && r.code) || "not-ok");
      budgetWait = parseBudgetWait(r);
      queryFailed = lastCode;
      continue;
    } catch (e) {
      if (e instanceof LoginExpired || e instanceof VerificationRequired || e instanceof RiskControlError) throw e;
      lastCode = String((e && e.code) || e.constructor.name);
      queryFailed = e.message || lastCode;
      continue;
    }
  }
  return { verdict: queryFailed ? "unknown" : "no", lastCode };
}

// 发送前预检（防重复触达的硬保险，BUG-2026-11-03 修复建议④）：拉一次沟通列表全文。
// best-effort：失败返回 null（预检弱化但不阻塞主流程——账本 pending 去重仍在，平台
// 「首条招呼唯一性」是最后一道兜底，2026-11-03 实证两轮发送只送达 1 条）。
// v2.15.0：同 verifyDelivered 改 --summary-limit 0（单请求，不撞预算；见文件头注）。
function chatSnapshotText({ runBossFn, logger } = {}) {
  const run = runBossFn || ((args, opts) => runBoss(args, opts));
  try {
    const r = run(["hr", "chat", "--page", "1", "--summary-limit", "0"], { timeoutMs: CHAT_TIMEOUT_MS, logger });
    return r && r.ok && r.envelope ? JSON.stringify(r.envelope) : null;
  } catch {
    return null;
  }
}

module.exports = {
  BUDGET_CODE,
  FIRST_WAIT_SEC,
  RETRY_WAIT_SEC,
  CHAT_TIMEOUT_MS,
  SNIPPET_LEN,
  parseBudgetWait,
  snippetOf,
  escapeHtmlText,
  envelopeContains,
  containsSnippet,
  verifyDelivered,
  chatSnapshotText,
};
