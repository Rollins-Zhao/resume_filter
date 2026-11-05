// v2.12.0：greet 回查的预算适配（BUG-2026-11-03 根因：CLI v3.1.0+ RequestBudget 跨进程预算层）
// 机制：任何两次 CLI 派发最小间隔 30s、单进程等待上限 30s（超限=REQUEST_BUDGET_EXHAUSTED，
//   request_sent:false）。旧 verifyDelivered 3 轮×5s 间隔×60s 进程超时与预算结构性不兼容——
//   进程在预算内排队时被我们的 60s 超时杀掉，恒 UNVERIFIED。
// 本模块要求：首轮前等 40s（发送刚占坑）、轮间隔 ≥45s、单次进程超时 150s、识别预算错误按
//   retry_after_seconds 等待、返回 {verdict, lastCode} 供失败分类。跑法：node tests/greet-verify.test.js
const assert = require("assert");
const gv = require("../boss-resume-screener/scripts/greet-verify");
const { LoginExpired } = require("../boss-resume-screener/scripts/boss");

let failed = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : ` —— ${detail}`}`);
  if (!cond) failed++;
}

const okEnv = (text) => ({ ok: true, code: null, envelope: { ok: true, data: { list: text } }, exit: 0 });
const errEnv = (code, details) => ({
  ok: false,
  code,
  envelope: { ok: false, error: { code, message: "x", ...(details ? { details } : {}) } },
  exit: 1,
});

// ---------- parseBudgetWait ----------
check("budget 错误带 retry_after=120 → 120", gv.parseBudgetWait(errEnv("REQUEST_BUDGET_EXHAUSTED", { request_sent: false, retry_after_seconds: 120 })) === 120);
check("budget 错误无 retry_after → null", gv.parseBudgetWait(errEnv("REQUEST_BUDGET_EXHAUSTED", { request_sent: false })) === null);
check("非 budget 错误 → null", gv.parseBudgetWait(errEnv("RATE_LIMITED")) === null);
check("ok 回包 → null", gv.parseBudgetWait(okEnv("任意")) === null);
check("null 入参 → null", gv.parseBudgetWait(null) === null);

// ---------- verifyDelivered（注入桩） ----------
async function runWith(stubRun) {
  const sleeps = [];
  const timeouts = [];
  const run = (args, opts) => {
    timeouts.push(opts && opts.timeoutMs);
    return stubRun(args);
  };
  const sleep = (s) => { sleeps.push(s); return Promise.resolve(); };
  const out = await gv.verifyDelivered("您好我是话术前十二字超过截断的部分", { runBossFn: run, sleepFn: sleep });
  return { out, sleeps, timeouts };
}

(async () => {
// ① 首轮命中：只需首轮前 40s 等待；超时参数 150s
{
  const { out, sleeps, timeouts } = await runWith(() => okEnv("会话列表任意前缀，您好我是话术前十二字超过截断的部分，会话列表任意后缀"));
  check("命中 → yes", out.verdict === "yes", JSON.stringify(out));
  check("命中前只有首轮 40s 等待", JSON.stringify(sleeps) === "[40]", JSON.stringify(sleeps));
  check("进程超时 150s", timeouts.every((t) => t === 150000), JSON.stringify(timeouts));
}

// ② 3 轮查询成功但无匹配 → no（确凿未投递）；等待 = 40 + 45×2
{
  const { out, sleeps } = await runWith(() => okEnv("列表里没有这段话术"));
  check("3 轮无匹配 → no", out.verdict === "no", JSON.stringify(out));
  check("轮间隔 45s", JSON.stringify(sleeps) === JSON.stringify([40, 45, 45]), JSON.stringify(sleeps));
}

// ③ budget 错误带 retry_after=120 → 下一轮等待 max(45, 120+5)=125
{
  const { out, sleeps } = await runWith(() => errEnv("REQUEST_BUDGET_EXHAUSTED", { retry_after_seconds: 120 }));
  check("budget×3 → unknown", out.verdict === "unknown", JSON.stringify(out));
  check("lastCode 带 budget 码", out.lastCode === "REQUEST_BUDGET_EXHAUSTED", out.lastCode);
  check("budget 等待按 retry_after", JSON.stringify(sleeps) === JSON.stringify([40, 125, 125]), JSON.stringify(sleeps));
}

// ④ budget 错误无 retry_after → 回落默认 45s
{
  const { out, sleeps } = await runWith(() => errEnv("REQUEST_BUDGET_EXHAUSTED", { request_sent: false }));
  check("budget 无 retry_after → unknown", out.verdict === "unknown", JSON.stringify(out));
  check("回落 45s 间隔", JSON.stringify(sleeps) === JSON.stringify([40, 45, 45]), JSON.stringify(sleeps));
}

// ⑤ 平台限流 → unknown + lastCode
{
  const { out } = await runWith(() => errEnv("RATE_LIMITED"));
  check("RATE_LIMITED×3 → unknown", out.verdict === "unknown" && out.lastCode === "RATE_LIMITED", JSON.stringify(out));
}

// ⑥ 普通异常 → unknown（不吞）
{
  const { out } = await runWith(() => { throw new Error("boom"); });
  check("异常×3 → unknown", out.verdict === "unknown", JSON.stringify(out));
}

// ⑦ 登录失效类错误上抛（红线语义不降级）
{
  let threw = null;
  try { await runWith(() => { throw new LoginExpired("登录失效"); }); } catch (e) { threw = e; }
  check("LoginExpired 上抛", threw instanceof LoginExpired, String(threw));
}
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
})();
