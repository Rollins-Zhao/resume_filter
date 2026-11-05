// BOSS 自动打招呼阶段（v2.7.0，BOSS 专有）—— run.js 在筛选（含 llm-batch）之后、report 之前 spawn
//
// 授权（机器强制，不靠 AI 自觉读文档）：
//   profiles/_user.json settings.greet.enabled === true，或 env BOSS_GREET=1 显式覆盖；
//   两者皆无 → 退出码 5（未授权），绝不发送。SCREENER_SKIP_USER_CONTEXT=1 / BOSS_GREET=0 → 跳过（exit 0）。
// 触达范围（用户 2026-10-28 拍板）：本轮真实浏览（screener 落盘的 data/greet-pool.json）
//   且最终等级 S/A（llm-scores.json 精细评估优先、规则分兜底——与 report.js finalGrade 同口径）。
//   ⚠️ 不读 last-results.json：rescore 会从缓存重建它并丢 search.geekCard/viewedThisRun，池快照才完整。
// 节奏（照 feature-greet.md §5，比浏览更保守——打招呼是主动触达）：间隔 60–180s 随机、
//   单次运行上限 10（--limit 覆盖）、连续 2 次失败熔断、工作时间窗外软停止、
//   RateLimited 结束本轮不重试；风控错误码 → 写本地风控锁（与 screener 共锁）+ exit 3。
// 退出码：0 正常/跳过；2 登录失效；3 熔断·风控（已落锁）；4 需人工验证；5 打招呼未授权。
// v2.7.1 止血（2026-10-29 事故，见 BUG-2026-10-29-boss-greet-未投递.md）：搜索来源（hr candidates
// 卡片）的参数平台「假成功」——CLI 回执 ok/sent:true 但消息不投递、不落会话。两道闸：
//   ① 搜索来源一律不自动发（manual-required，报告标「需手动」）；
//   ② 即便接口回执成功，也必须 hr chat 回查到会话才记账（堵住一切假 sent）。
// v2.12.0（BUG-2026-11-03 greet UNVERIFIED）：CLI v3.1.0+ RequestBudget 预算层（任何两次派发
//   最小间隔 30s、单进程等待上限 30s）与旧回查节奏（3 轮×5s×60s 超时）结构性不兼容——回查进程
//   在预算内排队时被自己的超时杀掉，恒 UNVERIFIED 不记账。修复：
//   ① 回查交给 greet-verify.js（首轮前等 40s、轮间隔 45s、进程超时 150s、预算错误按 retry_after 等）；
//   ② 发送前预检：拉一次沟通列表——账本 pending（上轮待核实）命中即补记，sendList 已有同话术
//      会话者跳过（防重复触达硬保险）；
//   ③ UNVERIFIED 落账本 pending（markPending：不占额度、命中去重阻断重发），报告标「待核实」。
// 试水参数（M1–M3 里程碑用）：--dry（零发送零网络，打印名单+参数+话术）；--only <id>（单人）；--limit n。
// 运行产物：data/greet-run.json（本轮逐人状态，report.js「打招呼」列读取；与全局账本 greet-ledger 职责正交）。
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const { runBoss, FatalError, LoginExpired, RateLimited, VerificationRequired, RiskControlError } = require("./boss");
const { resolveSendReceipt } = require("./greet-receipt");
const gverify = require("./greet-verify");
const { ensureChatTab } = require("./fetch-text");
const gq = require("./quota-global");
const gl = require("./greet-ledger");
const ww = require("./working-window");
const rg = require("./refresh-guard");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
const DATA = path.join(ROOT, "data");
const LOGS = path.join(ROOT, "logs");
for (const d of [DATA, LOGS]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* 已存在 */ }
}
const logger = { append: (s) => fs.appendFileSync(path.join(LOGS, `run-${new Date().toISOString().slice(0, 10)}.log`), s) };

const GQ_DIR = gq.resolveGlobalQuotaDir(DATA);
const JOB_KEY = gq.jobKeyFromProfileEnv(cfg.jobTitle);

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry") || process.env.BOSS_GREET_DRY === "1";
const onlyIdx = argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || "") : "";
const limitIdx = argv.indexOf("--limit");
const RUN_LIMIT = limitIdx >= 0 && Number(argv[limitIdx + 1]) > 0 ? Math.floor(Number(argv[limitIdx + 1])) : 10;

const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));
const loadJson = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; }
};
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));

// ---------- 授权（机器强制）----------
function authorize() {
  if (process.env.SCREENER_SKIP_USER_CONTEXT === "1") {
    console.log("[greet] SCREENER_SKIP_USER_CONTEXT=1（测试环境），跳过打招呼");
    return { run: false, code: 0 };
  }
  if (process.env.BOSS_GREET === "0") {
    console.log("[greet] BOSS_GREET=0 强制关断，跳过打招呼");
    return { run: false, code: 0 };
  }
  if (process.env.BOSS_GREET === "1") return { run: true, source: "env" };
  const g = cfg.userSettings && cfg.userSettings.greet;
  if (g && g.enabled === true) return { run: true, source: "settings" };
  console.error("[greet] 未授权：profiles/_user.json 的 settings.greet.enabled 不是 true，本阶段拒绝执行（这是前置条件，不是故障）。");
  console.error("       打招呼是主动触达，须用户显式开启：双击 run.bat 跑 BOSS 时会问两个问题（是否开启 + 话术来源），");
  console.error("       或 node run.js --setup-greet 重新选择；AI 会话按 AI-GUIDE「BOSS 打招呼授权」节向用户确认后写入。");
  console.error("       （测试/一次性关断可设 BOSS_GREET=0 跳过本阶段）");
  return { run: false, code: 5 };
}

// ---------- 最终等级口径（与 report.js finalGrade/finalTotal 同构；report.js 是 IIFE 脚本无导出，故内联） ----------
// 优先级：llm-scores（精细评估）> last-results（rescore 后的规则分）> greet-pool 快照。
// v2.10.0：截图取文模式下 screener 落盘池快照时正文尚未转写、等级恒 C——快照不能当最终口径，
// 中间层 last-results（rescore 从缓存重算，读真实文本）必须排在快照之前。只读 grade/total 两个
// 纯分数字段（池参数仍以 greet-pool 为准，rescore 会丢 search.geekCard/viewedThisRun，见 screener 落盘注释）。
const GRADES = ["S", "A", "B", "C"];
const LLM_SCORES = (() => {
  const d = loadJson(path.join(DATA, "llm-scores.json"), null);
  return d && d.entries && Object.keys(d.entries).length ? d : null;
})();
const LAST_RESULTS_GRADE = (() => {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(DATA, "last-results.json"), "utf8"));
    return Array.isArray(a) ? new Map(a.map((r) => [r.id, r.score || {}])) : null;
  } catch {
    return null;
  }
})();
const llmOf = (id) => (LLM_SCORES && LLM_SCORES.entries[id]) || null;
const lrOf = (id) => (LAST_RESULTS_GRADE && LAST_RESULTS_GRADE.get(id)) || null;
const finalGrade = (p) => {
  const e = llmOf(p.id);
  if (e && GRADES.includes(e.grade)) return e.grade;
  const lr = lrOf(p.id);
  if (lr && GRADES.includes(lr.grade)) return lr.grade;
  return p.grade;
};
const finalTotal = (p) => {
  const e = llmOf(p.id);
  if (e && typeof e.total === "number") return e.total;
  const lr = lrOf(p.id);
  if (lr && typeof lr.total === "number") return lr.total;
  return p.total;
};

// ---------- 话术渲染与校验 ----------
// job 模式：画像 greetTemplate（报告「建议打招呼话术」列同一渲染）；
// fixed 模式：settings.greet.fixedText 走同一套占位符语义（config.renderGreetPlaceholders）。
function renderMessage(p, mode, fixedText) {
  if (mode === "fixed") {
    const txt = String(fixedText || "").trim();
    return txt ? cfg.renderGreetPlaceholders(txt, p.greetVars || {}) : null; // null = 固定话术未配置
  }
  return typeof cfg.greetTemplate === "function" ? cfg.greetTemplate(p.greetVars || {}) : null;
}

// 发送前硬校验：命中即跳过该条并记原因——不静默截断、不改写（不做粗糙兜底）
const MSG_MAX_LEN = 120;
const MSG_FORBIDDEN = [
  { re: /(https?:\/\/|www\.)/i, why: "含链接（平台对首条消息的外部信息敏感）" },
  { re: /(微信|weixin|vx|v信|whatsapp|qq号)/i, why: "含联系方式类词汇" },
  { re: /1[3-9]\d{9}/, why: "疑似含手机号" },
];
function validateMessage(msg) {
  const s = String(msg || "");
  if (!s.trim()) return "话术为空";
  if (s.length > MSG_MAX_LEN) return `话术超长（${s.length}>${MSG_MAX_LEN} 字，平台易截断）`;
  for (const f of MSG_FORBIDDEN) if (f.re.test(s)) return f.why;
  return "";
}

// ---- v2.7.1 止血闸①：搜索来源识别 ----
// 2026-10-29 实测：搜索卡片（hr candidates）的 lid 形如 *.lookupsearchgeek.*，用它 greet 平台
// 「假成功」（sent:true 但不投递）；CLI 帮助要求的参数来自推荐流（lid 含 f1:common.eyJ…、免费）。
// 病因定案前（参数上下文 / 开聊卡 / 登录令牌三假设，实验决策树见 BUG 文档§11），搜索来源一律不自动发。
// 第二条兜底：pickIds 在 securityId 缺失时会回退填 expectId——两个令牌语义不同，混用同样视为不可发。
function isSearchContext(p) {
  const lid = String(p.lid || "");
  if (lid.includes("lookupsearchgeek")) return true;
  if (String(p.securityId || "") === String(p.expectId || "") && p.expectId) return true;
  return false;
}

// ---- v2.7.1 止血闸②（v2.12.0 起回查实现移 greet-verify.js）：发送后回查，查到会话才允许记账 ----
// CLI 的 sent:true 只是 HTTP 层成功，响应无 chatId/msgId 等落库证据（2026-10-29 实证）。
// 回查实现 = gverify.verifyDelivered（预算适配：首轮前 40s、轮间隔 45s、进程超时 150s、
// REQUEST_BUDGET_EXHAUSTED 按 retry_after 等待；详见 greet-verify.js 头注与 BUG-2026-11-03）。
const verifyFn = (msg, { logger: lg }) =>
  gverify.verifyDelivered(msg, { runBossFn: (args, opts) => runBoss(args, { ...opts, bin: cfg.bossBin }), logger: lg });

// ---------- 运行产物 ----------
let RUN_OUTCOMES = [];
function writeRunSummary(meta = {}) {
  const payload = {
    at: new Date().toISOString(),
    jobKey: JOB_KEY,
    mode: meta.mode,
    dry: DRY,
    only: ONLY || null,
    ...meta,
    results: RUN_OUTCOMES,
  };
  try {
    saveJson(path.join(DATA, "greet-run.json"), payload);
  } catch (e) {
    console.warn(`[greet] greet-run.json 写盘失败（不影响主流程）：${e.message}`);
  }
}

// ---------- 主流程 ----------
(async () => {
  const auth = authorize();
  if (!auth.run) process.exit(auth.code);

  const settings = (cfg.userSettings && cfg.userSettings.greet) || {};
  const MODE = settings.mode === "fixed" ? "fixed" : "job";
  const FIXED_TEXT = typeof settings.fixedText === "string" ? settings.fixedText : "";
  const CAP = gl.resolveGreetCap();
  console.log(`\n=== BOSS 自动打招呼 · ${cfg.jobTitle} · ${JOB_KEY} ${DRY ? "· 演练模式（--dry，零发送）" : ""} ===`);
  console.log(`[greet] 话术来源：${MODE === "fixed" ? "固定话术（settings.greet.fixedText）" : "按岗位建议话术（画像 greetTemplate / 内置默认）"} · 授权：${auth.source}`);
  console.log(gl.summarizeToday(GQ_DIR, CAP));

  // 风控锁预检（与 screener 同款两把锁里的本工具锁；带锁 = 拒绝主动触达）
  const lock = rg.readRiskLock(GQ_DIR);
  if (lock && lock.locked) {
    throw new FatalError(
      `检测到本地风控锁（${lock.reason || "原因未知"}，${lock.at || "时间未知"}），拒绝打招呼。` +
        `解锁：人工确认账号正常并冷却后删除 ${rg.lockPath(GQ_DIR)}（若 boss status 也有锁，再 boss clean --risk-lock）。不要反复重试。`
    );
  }

  const poolRaw = loadJson(path.join(DATA, "greet-pool.json"), null);
  const poolAll = poolRaw && Array.isArray(poolRaw.entries) ? poolRaw.entries : [];
  if (!poolAll.length) {
    console.log("[greet] 本轮无真实浏览记录（data/greet-pool.json 为空或不存在），跳过打招呼");
    writeRunSummary({ mode: MODE, status: "no-pool" });
    return;
  }

  // 名单：最终等级 S/A（S 优先、分高在前）；--only 单人试水
  let pool = poolAll.filter((p) => ["S", "A"].includes(finalGrade(p)));
  if (ONLY) pool = pool.filter((p) => p.id === ONLY);
  const rank = { S: 0, A: 1 };
  pool.sort((a, b) => (rank[finalGrade(a)] - rank[finalGrade(b)]) || (finalTotal(b) - finalTotal(a)));
  console.log(`[greet] 候选池 ${poolAll.length} 人中最终 S/A ${pool.length} 人${ONLY ? `（--only 过滤后）` : ""}`);

  // 逐人预检：全局 geek 去重、话术渲染与校验
  const sendList = [];
  for (const p of pool) {
    const base = { id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p) };
    if (!p.geekId || !p.jobId || !p.securityId || !p.expectId || !p.lid) {
      RUN_OUTCOMES.push({ ...base, status: "skip", note: "greet 参数不全（geek/job/security/expectId/lid）" });
      continue;
    }
    if (isSearchContext(p)) {
      RUN_OUTCOMES.push({ ...base, status: "manual-required", note: "搜索来源参数（2026-10-29 实测平台假成功不投递，止血不自动发）——请按报告「BOSS简历」列链接手动打招呼" });
      continue;
    }
    if (gl.hasGeek(GQ_DIR, p.geekId)) {
      RUN_OUTCOMES.push({ ...base, status: "dup", note: "全局账本已打过招呼" });
      continue;
    }
    const msg = renderMessage(p, MODE, FIXED_TEXT);
    if (msg === null) {
      RUN_OUTCOMES.push({ ...base, status: "no-msg", note: MODE === "fixed" ? "固定话术未配置（settings.greet.fixedText 为空）" : "话术模板不可用" });
      continue;
    }
    const bad = validateMessage(msg);
    if (bad) {
      RUN_OUTCOMES.push({ ...base, status: "invalid-msg", note: bad });
      continue;
    }
    sendList.push({ p, msg });
  }

  // 上限：全局日余额 × 单次运行上限（--limit）
  const budget = Math.min(gl.remainingToday(GQ_DIR, CAP), RUN_LIMIT);
  const over = sendList.splice(Math.max(0, budget));
  for (const { p } of over) RUN_OUTCOMES.push({ id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p), status: "over-limit", note: `超出本轮上限（单次≤${RUN_LIMIT}，全局日余额 ${budget}）` });

  // ---- 演练模式：零发送零网络（不碰 CLI、不开标签），打印名单 + 参数 + 话术 ----
  if (DRY) {
    for (const { p, msg } of sendList) {
      RUN_OUTCOMES.push({ id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p), status: "dry" });
      console.log(`\n  ▶ ${p.name || p.id}（${finalGrade(p)} 级 · ${p.group || "-"}）`);
      console.log(`    geek=${p.geekId} job=${p.jobId} security=${p.securityId}`);
      console.log(`    expectId=${p.expectId} lid=${p.lid}`);
      console.log(`    话术：${msg}`);
    }
    const drySkip = RUN_OUTCOMES.filter((o) => o.status !== "dry");
    for (const o of drySkip) console.log(`  ✖ 跳过 ${o.name}（${o.status}）：${o.note || ""}`);
    console.log(`\n[greet·演练] 应发 ${sendList.length} 人 / 跳过 ${drySkip.length} 人。零网络请求、账本未动。`);
    writeRunSummary({ mode: MODE, status: "dry", planned: sendList.length });
    return;
  }

  if (!sendList.length) {
    console.log("[greet] 无可发送名单（全部被去重/校验/上限跳过），本轮结束");
    writeRunSummary({ mode: MODE, status: "empty" });
    return;
  }

  // ---- 真发前预检：登录态（boss status 不请求平台）+ 沟通页标签（v2.5.1 机器强制同款）----
  console.log("[greet] 预检：登录态 + 沟通页标签…");
  const pre = runBoss(["status"], { bin: cfg.bossBin, timeoutMs: 60000, logger });
  if (!pre.ok) throw new LoginExpired("登录态不可用：请双击 boss-edge-login.bat / boss-zhipin-login.bat 扫码并保持窗口开着");
  await ensureChatTab({ logger });

  // ---- v2.12.0 发送前预检（BUG-2026-11-03 修复建议④）：拉一次沟通列表快照 →
  //      ① 账本 pending（上轮 UNVERIFIED 待核实）命中会话 → chargeGreet 补记为 sent（占当日额度）；
  //      ② sendList 中已存在同话术会话者 → 跳过发送（防重复触达的硬保险——UNVERIFIED 不记账时代的
  //        结构性风险兜底）。best-effort：快照拉取失败仅提示不阻塞（账本去重仍在，平台「首条招呼
  //        唯一性」是最后一道兜底，2026-11-03 实证两轮发送只送达 1 条）。
  //      ⚠️ 匹配为话术前 24 字文本匹配（同模板同 dim 组合的撞词局限见 greet-verify.js 头注）。----
  console.log("[greet] 预检：沟通列表快照（防重复触达）…");
  const snapshot = gverify.chatSnapshotText({ runBossFn: (args, opts) => runBoss(args, { ...opts, bin: cfg.bossBin }), logger });
  if (snapshot) {
    let backfilled = 0;
    for (const [gk, e] of Object.entries(gl.loadLedger(GQ_DIR).geeks)) {
      if (e && e.status === "unverified" && e.msg && snapshot.includes(e.msg)) {
        gl.chargeGreet(GQ_DIR, e.jobKey || JOB_KEY, gk, { jobId: e.jobId || "", name: e.name || "" });
        backfilled++;
        const row = RUN_OUTCOMES.find((o) => o.geekId === gk && o.status === "dup");
        if (row) { row.status = "sent-backfill"; row.note = "上轮待核实，本轮预检发现会话，补记为已发送"; }
        console.log(`  [预检·补记] ${e.name || gk}：上轮待核实 → 沟通列表已有会话，补记为已发送`);
      }
    }
    const stillPending = Object.values(gl.loadLedger(GQ_DIR).geeks).filter((e) => e && e.status === "unverified").length;
    if (stillPending) console.log(`  [预检] 仍有 ${stillPending} 人待核实（沟通列表未见其话术，请人工确认后再决定是否补发；本工具已阻断自动重发）`);
    const dupIds = new Set(sendList.filter(({ msg }) => snapshot.includes(gverify.snippetOf(msg))).map(({ p }) => p.id));
    if (dupIds.size) {
      for (let i = sendList.length - 1; i >= 0; i--) {
        if (!dupIds.has(sendList[i].p.id)) continue;
        const p = sendList[i].p;
        RUN_OUTCOMES.push({ id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p), status: "dup-existing", note: "沟通列表已含本话术会话（上轮已发或人工已发），跳过发送" });
        sendList.splice(i, 1);
      }
      console.log(`  [预检·防重] ${dupIds.size} 人沟通列表已存在同话术会话，跳过发送`);
    }
    if (backfilled) console.log(`  [预检] 补记 ${backfilled} 人（占当日额度）`);
  } else {
    console.log("  [预检] 沟通列表快照拉取失败（不影响本轮：账本去重仍在，仅少一道防重保险）");
  }
  if (!sendList.length) {
    console.log("[greet] 预检后无可发送名单（会话已存在者全部跳过），本轮结束");
    writeRunSummary({ mode: MODE, status: "empty-after-precheck" });
    return;
  }

  // ---- 风控守护（与 screener 同款纪律，2026-10-27）：打招呼是主动触达、单轮可长达约 30 分钟，
  //      刷新/登录环侦听同样机器强制（评审 M-5 补上）；测试 SCREENER_SKIP_REFRESH_GUARD=1 跳过 ----
  let guard = null;
  const guardTick = () => { if (guard) guard.tick(); };
  if (process.env.SCREENER_SKIP_REFRESH_GUARD === "1") {
    console.log("[greet] SCREENER_SKIP_REFRESH_GUARD=1，刷新/登录环侦听已跳过（仅限测试）");
  } else {
    guard = rg.createGuard({ lockDir: GQ_DIR, logger });
    await guard.start();
  }

  // ---- 发送循环 ----
  const WIN = ww.parseWorkingWindow(cfg.workingWindow);
  // 把 sendList 中尚无状态的人显式记 stop（break/throw 路径共用——不猜测、不静默，评审 M-1）
  const markRest = (note) => {
    const marked = new Set(RUN_OUTCOMES.map((o) => o.id));
    for (const { p } of sendList) {
      if (!marked.has(p.id)) RUN_OUTCOMES.push({ id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p), status: "stop", note });
    }
  };
  let consecutiveFails = 0;
  let stopReason = "";
  let sentCount = 0;
  for (const [i, { p, msg }] of sendList.entries()) {
    if (i > 0) {
      const s = rand(60, 180);
      console.log(`  [间隔] 打招呼间隔: ${s}s`);
      // 1s 粒度切片：守护在休息中途触发也能立即停（同 screener.randSleep）；
      // tick 抛 RiskSignalError 时不经过下方 runBoss 的 try，这里同样先补剩余名单状态再上抛
      for (let left = s; left > 0; left--) {
        await sleep(1);
        try { guardTick(); } catch (e) { markRest(`本轮异常中断（${e.constructor.name}）未发`); throw e; }
      }
    }
    if (process.env.SCREENER_ANYTIME !== "1" && !ww.isWithinWindow(new Date(), WIN)) {
      console.log(`  [窗口] 已到 ${cfg.workingWindow[1]}（工作时间窗外），本轮打招呼软停止；下次窗口 ${ww.describeNextOpen(new Date(), WIN)}`);
      stopReason = "window";
      break;
    }
    console.log(`  (${i + 1}/${sendList.length}) ${p.name || p.id}（${finalGrade(p)} 级）…`);
    const args = [
      "hr", "greet",
      "--geek-id", p.geekId,
      "--job-id", p.jobId,
      "--security-id", p.securityId,
      "--expect-id", p.expectId,
      "--lid", p.lid,
      "--message", msg,
      "--yes",
    ];
    try {
      const r = runBoss(args, { bin: cfg.bossBin, logger });
      // v2.9.0：回执裁决统一走 greet-receipt.js（BUG-2026-10-30 BUG-3）——GREET_RESULT_UNKNOWN
      // 不再直接判失败：CLI 回执两头不可信（UNKNOWN 时消息可能实际已送达，2026-10-29 王海洋实证），
      // 必须与 ok 同路走 hr chat 回查，查到会话即视为送达并入账（防漏账 → 下轮对同一人重发）。
      // 「已打过招呼/已存在会话」的幂等返回码仍未实测（feature-greet.md §12）：其他非 ok 一律按失败、
      // 不进账本（下次可重试）；拿到真实幂等码后在 greet-receipt.js 补分支。
      const verdict = await resolveSendReceipt({ r, msg, logger, verify: verifyFn });
      if (verdict.status === "sent") {
        gl.chargeGreet(GQ_DIR, JOB_KEY, p.geekId, { jobId: p.jobId, name: p.name });
        RUN_OUTCOMES.push({ id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p), status: "sent", code: "" });
        sentCount++;
        consecutiveFails = 0;
        console.log(`    已发送（已回查沟通列表核实${r.ok === true ? "" : "；回执 UNKNOWN 但会话在，按送达入账"}）`);
      } else if (verdict.why === "UNVERIFIED") {
        // v2.12.0：回查失败≠未发送——落 pending 阻断自动重发（不占额度），下轮预检核实或人工确认。
        // 2026-11-03 实证：回执 ok 且消息实际送达，但回查被 CLI 预算冷却拦死 → 不记账会导致下轮重发。
        gl.markPending(GQ_DIR, p.geekId, { jobId: p.jobId, name: p.name, msg, jobKey: JOB_KEY });
        RUN_OUTCOMES.push({ id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p), status: "unverified", code: `UNVERIFIED${verdict.lastCode ? "/" + verdict.lastCode : ""}` });
        consecutiveFails++;
        console.log(`    发送回执 ok 但回查失败（${verdict.lastCode || "查询异常"}）——已记「待核实」防重发（下轮预检自动核实/请人工在沟通列表确认）；连续失败 ${consecutiveFails}`);
      } else {
        RUN_OUTCOMES.push({ id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p), status: "failed", code: verdict.why });
        consecutiveFails++;
        const tip = verdict.why === "NOT_DELIVERED"
          ? `⚠️ ${r.ok === true ? "接口回执成功但沟通列表无此会话（假成功，2026-10-29 同款）" : "回执未确认且沟通列表无此会话"}，不记账`
          : `回执 ${verdict.why}`;
        console.log(`    ${tip}——下次可重试；连续失败 ${consecutiveFails}`);
      }
    } catch (e) {
      if (e instanceof RateLimited) {
        console.log("  ⚠️ 触发平台频率限制，本轮打招呼结束（不重试）");
        stopReason = "rate";
        break;
      }
      if (e instanceof rg.RiskSignalError || e instanceof RiskControlError || e instanceof LoginExpired || e instanceof VerificationRequired || e instanceof FatalError) {
        // 红线/守护错误上抛（catch 统一退出码/落锁），先把当前人与剩余名单显式记状态（M-1）
        RUN_OUTCOMES.push({ id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p), status: "failed", code: e.constructor.name });
        markRest(`本轮异常中断（${e.constructor.name}）未发`);
        throw e;
      }
      RUN_OUTCOMES.push({ id: p.id, geekId: p.geekId, name: p.name || p.id, grade: finalGrade(p), status: "failed", code: String((e && e.message) || e).slice(0, 80) });
      consecutiveFails++;
      console.log(`    异常（${String((e && e.message) || e).slice(0, 80)}），连续失败 ${consecutiveFails}`);
    }
    if (consecutiveFails >= 2) {
      console.log("  ⚠️ 连续 2 次失败，本轮打招呼熔断结束（报告照常生成；多为账号级问题，别硬撞）");
      stopReason = "fail";
      break;
    }
  }
  // 中断/熔断时，剩余名单显式记状态（不猜测、不静默；throw 路径已在 catch 内提前 markRest）
  if (stopReason) {
    markRest(`本轮${stopReason === "window" ? "到工作时间窗外" : stopReason === "rate" ? "触发频率限制" : "连续失败熔断"}未发`);
  }
  if (guard) guard.stop(); // 关守护 WebSocket（不关会挂住进程退出）

  writeRunSummary({ mode: MODE, status: stopReason ? `stop-${stopReason}` : "done", sent: sentCount });
  const failed = RUN_OUTCOMES.filter((o) => o.status === "failed").length;
  console.log(`\n[greet 完成] 已发送 ${sentCount} · 失败 ${failed} · 跳过 ${RUN_OUTCOMES.length - sentCount - failed}`);
  console.log(gl.summarizeToday(GQ_DIR, CAP));
})().catch((e) => {
  try { writeRunSummary({ mode: (cfg.userSettings && cfg.userSettings.greet && cfg.userSettings.greet.mode) || "job", status: "error", error: String((e && e.message) || e).slice(0, 300) }); } catch { /* 尽力而为 */ }
  if (e instanceof LoginExpired) {
    console.error(`\n[登录失效] ${e.message}`);
    process.exit(2);
  }
  if (e instanceof VerificationRequired) {
    console.error(`\n[需人工验证] ${e.message}`);
    process.exit(4);
  }
  if (e instanceof rg.RiskSignalError) {
    console.error(`\n[风控守护] ${e.message}`);
    process.exit(3);
  }
  if (e instanceof RiskControlError) {
    rg.writeRiskLock(GQ_DIR, "boss-greet-risk-code", e.message);
    console.error(`\n[熔断·风控] ${e.message}`);
    console.error(`[greet] 已落本地风控锁：${rg.lockPath(GQ_DIR)}（与 CLI 的 cdp_risk_lock 是两把锁，解锁见 SKILL.md）`);
    process.exit(3);
  }
  console.error(`\n[熔断] ${e.message}`);
  process.exit(3);
});
