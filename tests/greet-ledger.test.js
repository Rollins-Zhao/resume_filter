// greet 全局账本测试（v2.15.0，BUG-2026-11-05「假成功与核实失效」P0-2/P1-1）。
// 覆盖：unverified TTL（6h 后允许重试，堵「假成功永久封锁」）、markAlready（平台已招呼记账，
// 不占额度）、sent 不被 already 覆盖、跨天清零回归。
// 用临时目录 + 假 geekId，测完删除（数据纪律）。
// 跑法：node tests/greet-ledger.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const gl = require("../boss-resume-screener/scripts/greet-ledger");

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "greet-ledger-test-"));
const DIR = path.join(TMP, "_quota");
try {
  // ---- chargeGreet / hasGeek 回归 ----
  gl.chargeGreet(DIR, "jobA", "g1", { jobId: "j1", name: "张三" });
  check("chargeGreet 后 hasGeek=true 且占额度", gl.hasGeek(DIR, "g1") === true && gl.loadLedger(DIR).sentToday === 1);
  check("sent 条目无 TTL（当天内永远占用）", (() => {
    const q = gl.loadLedger(DIR);
    q.geeks.g1.at = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    fs.writeFileSync(gl.greetLedgerPath(DIR), JSON.stringify(q));
    return gl.hasGeek(DIR, "g1") === true;
  })());

  // ---- P1-1：unverified TTL——超 6h 视为未占用（允许重试；平台若已记账会撞 ALREADY_GREETED 补 already） ----
  gl.markPending(DIR, "g2", { jobId: "j2", name: "李四", msg: "话术前24字", jobKey: "jobA" });
  check("unverified 6h 内 hasGeek=true（阻断重发防重复触达）", gl.hasGeek(DIR, "g2") === true);
  check("unverified 不占发送额度", gl.loadLedger(DIR).sentToday === 1);
  check("unverified 超 6h hasGeek=false（TTL 出口，允许重试）", (() => {
    const q = gl.loadLedger(DIR);
    q.geeks.g2.at = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    fs.writeFileSync(gl.greetLedgerPath(DIR), JSON.stringify(q));
    return gl.hasGeek(DIR, "g2") === false;
  })());
  check("unverified 缺 at（旧数据防御）仍视为占用（不误放重发）", (() => {
    const q = gl.loadLedger(DIR);
    q.geeks.g2.at = "";
    fs.writeFileSync(gl.greetLedgerPath(DIR), JSON.stringify(q));
    return gl.hasGeek(DIR, "g2") === true;
  })());

  // ---- P0-2：markAlready——平台已招呼（ALREADY_GREETED），记去重不占额度 ----
  gl.markAlready(DIR, "g3", { jobId: "j3", name: "王五", msg: "话术", jobKey: "jobA" });
  const q3 = gl.loadLedger(DIR);
  check("markAlready 记 status=already", q3.geeks.g3 && q3.geeks.g3.status === "already");
  check("markAlready 不占发送额度", q3.sentToday === 1);
  check("already 条目 hasGeek=true（平台已记账，重试无意义）", gl.hasGeek(DIR, "g3") === true);
  // sent 不被 already 覆盖（首记优先）
  gl.markAlready(DIR, "g1", { jobId: "j1", name: "张三", msg: "", jobKey: "jobA" });
  check("markAlready 不覆盖已 sent 条目（首记优先）", gl.loadLedger(DIR).geeks.g1.status === "sent");
  // 已有 already 时 markPending 也不覆盖
  gl.markPending(DIR, "g3", { jobId: "j3", name: "王五", msg: "x", jobKey: "jobA" });
  check("markPending 不覆盖 already 条目", gl.loadLedger(DIR).geeks.g3.status === "already");
  // TTL 过期的 unverified 被 markAlready 接管后恢复占用（重试撞幂等码后的闭环）
  gl.markAlready(DIR, "g2", { jobId: "j2", name: "李四", msg: "话术前24字", jobKey: "jobA" });
  check("TTL 过期 unverified 重试撞幂等码 → markAlready 接管恢复占用", gl.hasGeek(DIR, "g2") === true);

  // ---- 跨天清零回归 ----
  const qd = gl.loadLedger(DIR);
  qd.date = "2000-01-01";
  fs.writeFileSync(gl.greetLedgerPath(DIR), JSON.stringify(qd));
  check("跨天账本归零（geeks 清空、sentToday 归零）", gl.loadLedger(DIR).sentToday === 0 && Object.keys(gl.loadLedger(DIR).geeks).length === 0);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
