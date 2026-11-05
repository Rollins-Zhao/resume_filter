/**
 * 历史文件统一清理（v2.11.0，两侧镜像；2026-11-02 用户拍板「所有历史文件保留 1 天，做成可配」）
 *
 * 清什么（一律按 mtime 超过保留期才删，只删文件不删目录）：
 *   - 日志：logs/ 与 data/ 树下任意深度的 .log 文件（run.bat 形态的 data/<岗位>/<平台>/logs、
 *     data/_joblist/<平台>/logs，AI 直跑形态的根 logs/ 全覆盖）
 *   - 简历缓存：resumes/ 目录下的 .json（含 PII 正文，过期即清）
 *   - 结果缓存：last-results.json / llm-scores.json / greet-pool.json（池快照）
 *   - 截图：扫描图/ 目录下的 .png（v2.10.0 的 7 天独立清理并入本统一保留期）
 *
 * 永不清理（产品承诺，非「历史文件」）：reports/ 报告、去重索引（processed.json /
 * recommended-index.json）、配额与记账（data/_quota/ 全家、各岗位 quota.json）——
 * 删账本会破坏「日顶 20 条 / 同一人全局只发一次 / 不重复推荐」。
 *
 * 保留期：env SCREENER_RETENTION_DAYS > profiles/_user.json settings.retentionDays > 默认 1 天；
 * 0 = 关断。自然语言改法见 AI-GUIDE.md（对 AI 说「历史文件保留改成 N 天」即改 settings.retentionDays）。
 *
 * CLI：node <skill>/scripts/cleanup.js [--days N] [--dry]（项目根运行；--dry 只计数不实删）
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_RETENTION_DAYS = 1;
const RESULT_FILES = new Set(["last-results.json", "llm-scores.json", "greet-pool.json"]);

/** 解析保留期：非负整数（含字符串数字）→ 该值；空/未设/小数/负数/非数字 → null（非法或未设） */
function parseRetentionDays(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 保留期三级裁决：env SCREENER_RETENTION_DAYS > settings.retentionDays > 默认 1 天 */
function resolveRetentionDays({ env = {}, settings = {} } = {}) {
  const e = parseRetentionDays(env && env.SCREENER_RETENTION_DAYS);
  if (e !== null) return { days: e, source: "env" };
  const s = parseRetentionDays(settings && settings.retentionDays);
  if (s !== null) return { days: s, source: "settings" };
  return { days: DEFAULT_RETENTION_DAYS, source: "default" };
}

/** 文件归类（父目录名 + 文件名）：返回 byClass 键或 null（null = 不在清理范围） */
function classifyFile(base, parentName) {
  if (parentName === "resumes" && base.endsWith(".json")) return "resumes";
  if (parentName === "扫描图" && base.toLowerCase().endsWith(".png")) return "shots";
  if (RESULT_FILES.has(base)) return "results";
  if (base.toLowerCase().endsWith(".log")) return "logs";
  return null;
}

/** 统一清理：扫 root/logs 与 root/data（跳过任何深度的 _quota），按 mtime 删过期历史文件。
 *  @returns {{days, deleted, byClass:{logs,resumes,results,shots}}} days=0/非法 → 关断零删 */
function cleanupHistory(root, { days, now = Date.now(), dry = false } = {}) {
  const r = { days: parseRetentionDays(days) ?? 0, deleted: 0, byClass: { logs: 0, resumes: 0, results: 0, shots: 0 } };
  if (!(r.days > 0)) return r;
  const cutoff = now - r.days * 86400e3;
  const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return Infinity; } };
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.name === "_quota") continue; // 账本目录：永不清理
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        const cls = classifyFile(ent.name, path.basename(dir));
        if (!cls || mtimeOf(p) >= cutoff) continue;
        if (!dry) { try { fs.unlinkSync(p); } catch { continue; } }
        r.deleted++;
        r.byClass[cls]++;
      }
    }
  };
  walk(path.join(root, "logs"));
  walk(path.join(root, "data"));
  return r;
}

module.exports = { DEFAULT_RETENTION_DAYS, parseRetentionDays, resolveRetentionDays, cleanupHistory };

// ---------- CLI：node <skill>/scripts/cleanup.js [--days N] [--dry] ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  const has = (k) => args.includes(k);
  const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  let settings = {};
  try {
    const uc = JSON.parse(fs.readFileSync(path.join(process.cwd(), "profiles", "_user.json"), "utf8"));
    if (uc.settings && typeof uc.settings === "object") settings = uc.settings;
  } catch { /* 无档案 → 走默认 */ }
  const cliDays = parseRetentionDays(argOf("--days"));
  const days = cliDays !== null ? cliDays : resolveRetentionDays({ env: process.env, settings }).days;
  const root = process.env.SCREENER_DATA_DIR || process.cwd();
  const ret = cleanupHistory(root, { days, dry: has("--dry") });
  if (!(ret.days > 0)) {
    console.log(`[历史清理] 保留期配置为 ${days}（0=关断），本次不清理。改法：settings.retentionDays 或 env SCREENER_RETENTION_DAYS。`);
  } else if (ret.deleted === 0) {
    console.log(`[历史清理] 保留${ret.days}天策略：无过期文件${has("--dry") ? "（dry 演练）" : ""}。`);
  } else {
    const b = ret.byClass;
    console.log(`[历史清理] 保留${ret.days}天${has("--dry") ? "（dry 演练，未实删）" : ""}：清理 ${ret.deleted} 个过期文件（日志 ${b.logs} · 简历缓存 ${b.resumes} · 结果缓存 ${b.results} · 截图 ${b.shots}）。报告 / 去重索引 / 配额账本永不清理。`);
  }
}
