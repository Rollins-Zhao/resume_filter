// greet 回执裁决与回查匹配测试（v2.15.0，BUG-2026-11-05「假成功与核实失效」）。
// 覆盖：ALREADY_GREETED 幂等码识别（P0-2）、三态 verify 裁决、snippet 转义匹配（P2-1）。
// 纯内存（verify 桩注入、匹配器纯函数），不碰 CLI/盘。
// 跑法：node tests/greet-receipt.test.js
const assert = require("assert");
const { resolveSendReceipt } = require("../boss-resume-screener/scripts/greet-receipt");
const gv = require("../boss-resume-screener/scripts/greet-verify");

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
};

(async () => {
// ---- resolveSendReceipt：回执裁决 ----
const stubVerify = (verdict, lastCode = "") => async () => ({ verdict, lastCode });

// P0-2：ALREADY_GREETED 是幂等成功语义（平台已记账），不再按失败提示「下次可重试」
{
  const r = await resolveSendReceipt({ r: { ok: false, code: "ALREADY_GREETED" }, msg: "hi", verify: stubVerify("yes") });
  check("ALREADY_GREETED → status already（幂等成功，不重试不占额度）", r.status === "already" && r.why === "ALREADY_GREETED");
}
{
  const r = await resolveSendReceipt({ r: { ok: false, code: "ALREADY_GREETED" }, msg: "hi", verify: stubVerify("no") });
  check("ALREADY_GREETED 不进回查（幂等码已定案，回查只会白撞预算）", r.status === "already");
}
// 旧契约回归：ok + verify yes/no/unknown 三态
{
  const r = await resolveSendReceipt({ r: { ok: true }, msg: "hi", verify: stubVerify("yes") });
  check("ok + 回查命中 → sent", r.status === "sent" && r.why === "");
}
{
  const r = await resolveSendReceipt({ r: { ok: true }, msg: "hi", verify: stubVerify("no") });
  check("ok + 回查查无会话 → failed/NOT_DELIVERED（不记账可重试）", r.status === "failed" && r.why === "NOT_DELIVERED");
}
{
  const r = await resolveSendReceipt({ r: { ok: true }, msg: "hi", verify: stubVerify("unknown", "REQUEST_BUDGET_EXHAUSTED") });
  check("ok + 回查自身失败 → failed/UNVERIFIED（走 pending 防重发）", r.status === "failed" && r.why === "UNVERIFIED" && r.lastCode === "REQUEST_BUDGET_EXHAUSTED");
}
{
  const r = await resolveSendReceipt({ r: { ok: false, code: "GREET_RESULT_UNKNOWN" }, msg: "hi", verify: stubVerify("yes") });
  check("GREET_RESULT_UNKNOWN + 回查命中 → sent（v2.9.0 契约保持）", r.status === "sent");
}
{
  const r = await resolveSendReceipt({ r: { ok: false, code: "RATE_LIMITED" }, msg: "hi", verify: stubVerify("yes") });
  check("其他非 ok 码 → failed 透传（回查仅对 ok/UNKNOWN 触发）", r.status === "failed" && r.why === "RATE_LIMITED");
}
// 旧字符串 verify 契约兼容（v2.12.0 前 verify 返回字符串）
{
  const r = await resolveSendReceipt({ r: { ok: true }, msg: "hi", verify: async () => "yes" });
  check("verify 返回字符串 'yes'（旧契约）→ sent", r.status === "sent");
}

// ---- envelopeContains：回查匹配（P2-1：话术含 & 等字符会被 JSON 转义，纯 includes 匹配不上） ----
{
  const env = { data: { result: [{ last_msg: "你好，我们&团队在招" }] } };
  check("envelopeContains：原文直接命中", gv.envelopeContains({ data: { result: [{ last_msg: "你好团队" }] } }, "你好团队") === true);
  check("envelopeContains：snippet 含 & 时命中转义版（&amp;）", gv.envelopeContains(env, "我们&团队") === true);
  check("envelopeContains：snippet 含 < > 时命中转义版", gv.envelopeContains({ d: "a&lt;b&gt;c" }, "a<b>c") === true);
  check("envelopeContains：不匹配返回 false", gv.envelopeContains(env, "完全不同的话术内容") === false);
}
// containsSnippet：greet.js 预检对 stringify 快照的同款匹配
{
  const raw = JSON.stringify({ data: { result: [{ last_msg: "加入我们&团队吧" }] } });
  check("containsSnippet：原文命中", gv.containsSnippet(raw, "加入我们") === true);
  check("containsSnippet：转义版命中", gv.containsSnippet(raw, "我们&团队") === true);
  check("containsSnippet：未命中", gv.containsSnippet(raw, "另一段话术") === false);
}

process.exit(failed ? 1 : 0);
})();
