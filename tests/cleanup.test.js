// 历史文件统一清理测试（v2.11.0，用户拍板保留期默认 1 天可配）：按 mtime 删过期 logs / 简历缓存 /
// 结果缓存（last-results/llm-scores/greet-pool）/ 扫描图；报告 xlsx、去重索引（processed/
// recommended-index）、配额账本（data/_quota、各岗位 quota.json）永不清理；0=关断；dry 只计数。
// 跑法：node tests/cleanup.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const M = require("../boss-resume-screener/scripts/cleanup");
const { parseRetentionDays, resolveRetentionDays, cleanupHistory } = M;

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + extra}`);
  if (!cond) failed++;
};

// ---------- 纯函数：保留期解析 ----------
check("parse：正整数", parseRetentionDays("3") === 3 && parseRetentionDays(7) === 7);
check("parse：0=关断合法", parseRetentionDays(0) === 0 && parseRetentionDays("0") === 0);
check("parse：非法（小数/负/字符串/空/未设）→ null", parseRetentionDays("abc") === null && parseRetentionDays(-1) === null && parseRetentionDays(2.5) === null && parseRetentionDays("") === null && parseRetentionDays(undefined) === null);
check("resolve：env 优先于 settings", resolveRetentionDays({ env: { SCREENER_RETENTION_DAYS: "5" }, settings: { retentionDays: 9 } }).days === 5);
check("resolve：settings 次之", resolveRetentionDays({ env: {}, settings: { retentionDays: 9 } }).days === 9);
check("resolve：都没设 → 默认 1 天", resolveRetentionDays({ env: {}, settings: {} }).days === 1 && resolveRetentionDays({}).days === 1);
check("resolve：非法 env 忽略后走 settings", resolveRetentionDays({ env: { SCREENER_RETENTION_DAYS: "abc" }, settings: { retentionDays: 9 } }).days === 9);

// ---------- 文件系统：统一清理 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-hist-"));
const OLD = new Date(Date.now() - 10 * 86400e3); // 10 天前（> 任何保留期）
const NEW = new Date(); // 刚发生
const touch = (f, t) => fs.utimesSync(f, t, t);
const mk = (rel, content, t) => {
  const f = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  touch(f, t);
  return f;
};
const J = "data/销售经理/boss/data"; // run.bat 形态：data/<岗位>/<平台>/data

try {
  // 根 logs（AI 直跑形态）
  const rootLogOld = mk("logs/run-2026-10-20.log", "x", OLD);
  const rootLogNew = mk("logs/run-2026-11-02.log", "x", NEW);
  // 岗位深处的 logs 与 _joblist 的 logs
  const jobLogOld = mk(`${J}/../logs/run-2026-10-20.log`, "x", OLD);
  const joblistLogOld = mk("data/_joblist/liepin/logs/run-2026-10-20.log", "x", OLD);
  // 简历缓存（resumes/*.json）
  const resumeOld = mk(`${J}/resumes/geek-old.json`, "{}", OLD);
  const resumeNew = mk(`${J}/resumes/geek-new.json`, "{}", NEW);
  // 结果缓存
  const lastOld = mk(`${J}/last-results.json`, "{}", OLD);
  const llmNew = mk(`${J}/llm-scores.json`, "[]", NEW);
  const poolOld = mk(`${J}/greet-pool.json`, "{}", OLD);
  // 扫描图
  const shotOld = mk(`${J}/扫描图/geek-old-01.png`, "png", OLD);
  const shotNew = mk(`${J}/扫描图/geek-new-01.png`, "png", NEW);
  // 永不清理：去重索引 / 岗位配额 / 全局账本 / 报告
  const processedOld = mk(`${J}/processed.json`, "{}", OLD);
  const quotaOld = mk(`${J}/quota.json`, "{}", OLD);
  const recoIdxOld = mk(`${J}/recommended-index.json`, "[]", OLD);
  const globalQuotaOld = mk("data/_quota/boss.json", "{}", OLD);
  const greetLedgerOld = mk("data/_quota/boss-greet.json", "{}", OLD);
  const reportOld = mk("reports/销售经理-2026-10-20.xlsx", "xlsx", OLD);

  // days=0 关断
  const r0 = cleanupHistory(TMP, { days: 0 });
  check("days=0 关断：不删任何文件", r0.deleted === 0 && fs.existsSync(resumeOld) && fs.existsSync(rootLogOld));

  // dry：只计数不动手
  const rd = cleanupHistory(TMP, { days: 1, dry: true });
  check("dry：只计数不删", rd.deleted > 0 && fs.existsSync(resumeOld) && fs.existsSync(shotOld) && fs.existsSync(rootLogOld));
  check("dry：计数与实删一致（byClass 齐）", rd.byClass.resumes >= 1 && rd.byClass.shots >= 1 && rd.byClass.logs >= 3 && rd.byClass.results >= 2, JSON.stringify(rd.byClass));

  // 实删
  const r1 = cleanupHistory(TMP, { days: 1 });
  check("根 logs：过期删、新鲜留", !fs.existsSync(rootLogOld) && fs.existsSync(rootLogNew));
  check("岗位深处与 _joblist 的 logs 也删", !fs.existsSync(jobLogOld) && !fs.existsSync(joblistLogOld));
  check("简历缓存：过期删、新鲜留", !fs.existsSync(resumeOld) && fs.existsSync(resumeNew));
  check("结果缓存：last-results/greet-pool 过期删，llm-scores 新鲜留", !fs.existsSync(lastOld) && !fs.existsSync(poolOld) && fs.existsSync(llmNew));
  check("扫描图：过期删、新鲜留", !fs.existsSync(shotOld) && fs.existsSync(shotNew));
  check("去重索引/岗位配额：过期也不删", fs.existsSync(processedOld) && fs.existsSync(quotaOld) && fs.existsSync(recoIdxOld));
  check("全局账本（data/_quota 全家）：过期也不删", fs.existsSync(globalQuotaOld) && fs.existsSync(greetLedgerOld));
  check("报告 xlsx：过期也不删", fs.existsSync(reportOld));
  check("统计口径：deleted = 各类之和", r1.deleted === r1.byClass.logs + r1.byClass.resumes + r1.byClass.results + r1.byClass.shots, JSON.stringify(r1));

  // 目录本身不删、空目录结构保留
  check("只删文件不删目录", fs.existsSync(path.join(TMP, J, "resumes")) && fs.existsSync(path.join(TMP, "logs")));

  // data/logs 目录不存在 → 零删不抛
  const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-empty-"));
  try {
    const r2 = cleanupHistory(EMPTY, { days: 1 });
    check("空/缺目录：零删除不抛错", r2.deleted === 0);
  } finally {
    try { fs.rmSync(EMPTY, { recursive: true, force: true }); } catch {}
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
}

process.exit(failed ? 1 : 0);
