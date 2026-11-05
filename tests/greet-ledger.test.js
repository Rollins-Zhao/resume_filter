// v2.12.0：greet 账本 pending 语义（BUG-2026-11-03 greet UNVERIFIED）
// 背景：发送成功但回查失败（CLI 请求预算冷却）时 greet.js 判 UNVERIFIED 且不记账 →
//   hasGeek 不命中 → 下一轮对同一人重发（重复触达风险）。修法：UNVERIFIED 落账本为
//   pending（status:"unverified"）——不占日发送额度、但命中去重（阻断重发）；
//   下轮预检查到会话则补记为 sent（占额度）。跑法：node tests/greet-ledger.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const gl = require("../boss-resume-screener/scripts/greet-ledger");

let failed = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : ` —— ${detail}`}`);
  if (!cond) failed++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "greet-ledger-"));
try {
  // ① markPending：只记去重条目，不占额度
  gl.markPending(dir, "geek-A", { jobId: "j1", name: "张三", msg: "您好，看到您有跨境物流方向的销售经验。我们是讯流国际", jobKey: "岗位K" });
  const q1 = gl.loadLedger(dir);
  check("markPending 落 geeks 条目且 status=unverified", q1.geeks["geek-A"] && q1.geeks["geek-A"].status === "unverified", JSON.stringify(q1.geeks["geek-A"]));
  check("markPending 存话术前 24 字（预检匹配用）", q1.geeks["geek-A"].msg === "您好，看到您有跨境物流方向的销售经验。我们是讯流", JSON.stringify(q1.geeks["geek-A"].msg));
  check("markPending 存 jobKey（补记归账用）", q1.geeks["geek-A"].jobKey === "岗位K", JSON.stringify(q1.geeks["geek-A"].jobKey));
  check("markPending 不计 sentToday", q1.sentToday === 0, `sentToday=${q1.sentToday}`);
  check("markPending 不计 perJob", Object.keys(q1.perJob).length === 0, JSON.stringify(q1.perJob));

  // ② hasGeek 命中 pending（阻断重发）
  check("hasGeek 命中 pending 条目", gl.hasGeek(dir, "geek-A") === true, "未命中");

  // ③ geekEntry 读取
  const e = gl.geekEntry(dir, "geek-A");
  check("geekEntry 返回条目", !!e && e.name === "张三", JSON.stringify(e));
  check("geekEntry 未收录者返回 null", gl.geekEntry(dir, "geek-Z") === null, String(gl.geekEntry(dir, "geek-Z")));

  // ④ 补记：pending 核实到会话后 chargeGreet → sent + 占额度
  gl.chargeGreet(dir, "岗位K", "geek-A", { jobId: "j1", name: "张三" });
  const q2 = gl.loadLedger(dir);
  check("chargeGreet 补记转 sent", q2.geeks["geek-A"].status === "sent", JSON.stringify(q2.geeks["geek-A"]));
  check("chargeGreet 补记占当日额度", q2.sentToday === 1, `sentToday=${q2.sentToday}`);
  check("chargeGreet 补记计 perJob", q2.perJob["岗位K"] === 1, JSON.stringify(q2.perJob));

  // ⑤ 新人正常记账仍是 sent
  gl.chargeGreet(dir, "岗位K", "geek-B", { jobId: "j2", name: "李四" });
  const q3 = gl.loadLedger(dir);
  check("正常记账 status=sent", q3.geeks["geek-B"].status === "sent", JSON.stringify(q3.geeks["geek-B"]));
  check("额度累计 2/…", q3.sentToday === 2, `sentToday=${q3.sentToday}`);
  check("remainingToday 扣减正确", gl.remainingToday(dir, 20) === 18, String(gl.remainingToday(dir, 20)));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
