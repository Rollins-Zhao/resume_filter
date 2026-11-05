// 打招呼回执裁决（v2.9.0，BUG-2026-10-30 BUG-3）——从 greet.js 主流程抽出成可注入模块
//
// 裁决规则（CLI 回执两头不可信：假成功报成功、真成功报未确认——2026-10-29 王海洋实证）：
//   r.ok === true                    → 回查核实（查到会话才记账；查无/查失败均不入账、可重试）
//   r.code === "GREET_RESULT_UNKNOWN" → 同样回查核实（BUG-3 修复点：此前直接判失败不记账，
//                                      但实测 UNKNOWN 时消息可能已送达——不查就漏账，下轮对同一人重发）
//   其他非 ok                         → 失败可重试（幂等返回码补齐前不猜成功，feature-greet.md §12）
// verify 注入（greet.js 传 greet-verify.verifyDelivered；测试传桩）——本模块自身不发任何请求。
// v2.12.0：verify 返回 {verdict:"yes"|"no"|"unknown", lastCode}（旧契约是字符串，仍兼容），
// lastCode 透传给 greet.js 做失败分类（budget 冷却/平台限流/查询异常）。
async function resolveSendReceipt({ r, msg, logger, verify }) {
  if (r && (r.ok === true || String(r.code) === "GREET_RESULT_UNKNOWN")) {
    const landed = await verify(msg, { logger });
    const verdict = typeof landed === "string" ? landed : landed && landed.verdict;
    const lastCode = (landed && landed.lastCode) || "";
    if (verdict === "yes") return { status: "sent", why: "", lastCode: "" };
    return { status: "failed", why: verdict === "unknown" ? "UNVERIFIED" : "NOT_DELIVERED", lastCode };
  }
  const why = String((r && r.code) || "UNKNOWN");
  return { status: "failed", why, lastCode: why };
}

module.exports = { resolveSendReceipt };
