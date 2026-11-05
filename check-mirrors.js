/**
 * 两侧镜像一致性校验（开发工具；不进发布包）
 *
 * 铁律 2：report.js / config.js / show-scores.js / scoring.js / quota-global.js /
 * joblist.js / working-window.js / check-cli-update.js 的结构性改动必须两侧同步。
 * 之前纯靠人肉记忆，本工具把它变成机器强制：
 *
 *   归一化 → 跳过空行与整行注释，行内 liepin/boss/猎聘/直聘 等平台词替换为 § 占位
 *   （PLATFORM 常量、平台专属注释等「有意差异」因此不计数）→ 多重集 diff 行数
 *   → 与 check-mirrors.baseline.json 基线比较，超出即失败。
 *
 * 用法：
 *   node check-mirrors.js                    # 校验（超基线 exit 1）
 *   node check-mirrors.js --update-baseline  # 两侧同步改完后重录基线
 *
 * 被 pack-release.js 前置调用（打包前必须过校验）；也可单独跑。
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const MIRRORS = [
  "report.js",
  "config.js",
  "show-scores.js",
  "scoring.js",
  "quota-global.js",
  "joblist.js",
  "working-window.js",
  "check-cli-update.js",
  "llm-batch.js",
  "refresh-guard.js", // 2026-10-27 新增：刷新/登录环守护（两侧镜像，平台参数三行除外）
  "cleanup.js", // 2026-11-02 新增：历史文件统一清理（两侧镜像，保留期 settings.retentionDays）
];
const BASELINE = path.join(ROOT, "check-mirrors.baseline.json");

const norm = (t) =>
  t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"))
    .map((l) => l.replace(/liepin|boss|猎聘|直聘/gi, "§"));

/** 多重集差异：A 有 B 无 + B 有 A 无 的归一化行数（对顺序不敏感，抓增删漏同步） */
function diffCount(a, b) {
  const cnt = new Map();
  for (const l of a) cnt.set(l, (cnt.get(l) || 0) + 1);
  for (const l of b) cnt.set(l, (cnt.get(l) || 0) - 1);
  let d = 0;
  for (const v of cnt.values()) d += Math.abs(v);
  return d;
}

function measure() {
  const out = {};
  for (const f of MIRRORS) {
    const lp = path.join(ROOT, "liepin-resume-screener", "scripts", f);
    const bp = path.join(ROOT, "boss-resume-screener", "scripts", f);
    if (!fs.existsSync(lp) || !fs.existsSync(bp)) {
      out[f] = -1; // 一侧缺文件：不计数，交由人工判断
      continue;
    }
    out[f] = diffCount(norm(fs.readFileSync(lp, "utf8")), norm(fs.readFileSync(bp, "utf8")));
  }
  return out;
}

/**
 * @returns {boolean} true = 通过（或刚生成/更新基线）
 * fatal=true 时超基线直接 exit 1（pack-release 打包前用它阻断）
 */
function run({ fatal = false, updateBaseline = false } = {}) {
  const cur = measure();
  if (updateBaseline || !fs.existsSync(BASELINE)) {
    fs.writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n");
    console.log(`[镜像校验] 基线已${updateBaseline ? "更新" : "生成"} → ${path.basename(BASELINE)}`);
    for (const [f, d] of Object.entries(cur)) console.log(`  ${f}: ${d}`);
    return true;
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  let bad = 0;
  for (const [f, d] of Object.entries(cur)) {
    const b = base[f] ?? 0;
    if (d > b) {
      console.error(`[镜像校验] ❌ ${f}: 归一化差异 ${d} 行 > 基线 ${b} 行——两侧镜像可能漏同步（铁律 2）`);
      bad++;
    }
  }
  if (bad) {
    console.error(`[镜像校验] ${bad} 个文件超基线。若确为两侧同步后的合法差异，跑 node check-mirrors.js --update-baseline 重录。`);
    if (fatal) process.exit(1);
    return false;
  }
  console.log(`[镜像校验] ✅ ${MIRRORS.length} 个镜像文件均在基线内`);
  return true;
}

module.exports = { run, measure };

if (require.main === module) {
  run({ updateBaseline: process.argv.includes("--update-baseline") });
}
