// 全局每日简历浏览配额（平台级，跨岗位共享）——与 boss-resume-screener/scripts/quota-global.js 保持镜像
//
// 记账口径：成功浏览的简历详情数。缓存命中/无权限被拒/缺 ID 跳过/搜索请求均不计
//（与每岗位 data/quota.json 的"请求数"是两层：本文件管全局浏览硬顶，quota.json 管岗位请求兜底）。
// 计数文件：<全局目录>/liepin.json，schema：{date, resumeViews, cap, updatedAt, perJob:{<jobKey>:views}}
// 路径决策树：SCREENER_GLOBAL_QUOTA_DIR（编排层传）→ cwd/data/_quota → skill 上两级/data/_quota
//            → 兜底 ROOT/data/_quota。所有回落静默；写盘失败 fail-open（warn 后继续，不阻塞筛选）。
// ⚠️ jobKeyFromProfileEnv 的 sanitize 正则抄自项目根 run.js（三处镜像，改 schema/正则需同步）。
const fs = require("fs");
const path = require("path");

const PLATFORM = "liepin";

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function globalQuotaPath(dir) {
  return path.join(dir, `${PLATFORM}.json`);
}

// 缺失/损坏/跨天 → 归零对象（不写盘，保持只读安全）
function loadGlobalQuota(dir) {
  try {
    const q = JSON.parse(fs.readFileSync(globalQuotaPath(dir), "utf8"));
    if (q && typeof q === "object" && q.date === todayKey()) {
      return {
        date: todayKey(),
        resumeViews: Number(q.resumeViews) || 0,
        cap: Number(q.cap) || 0,
        updatedAt: q.updatedAt || "",
        perJob: q.perJob && typeof q.perJob === "object" ? q.perJob : {},
      };
    }
  } catch { /* 缺失/损坏/跨天 → 归零 */ }
  return { date: todayKey(), resumeViews: 0, cap: 0, updatedAt: "", perJob: {} };
}

function viewsToday(dir) {
  return loadGlobalQuota(dir).resumeViews;
}

function remainingToday(dir, cap) {
  return Math.max(0, cap - viewsToday(dir));
}

function jobViewsToday(dir, jobKey) {
  return Number(loadGlobalQuota(dir).perJob[jobKey]) || 0;
}

// 纯记账不 throw：停不停由调用方（screener 简历循环）决定
function chargeGlobalView(dir, jobKey, cap) {
  const q = loadGlobalQuota(dir);
  q.resumeViews += 1;
  q.cap = cap || 0;
  q.updatedAt = new Date().toISOString();
  q.perJob[jobKey] = (Number(q.perJob[jobKey]) || 0) + 1;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(globalQuotaPath(dir), JSON.stringify(q, null, 2));
  } catch (e) {
    console.warn(`[全局配额] 记账写盘失败（fail-open 继续运行）：${e.message}`);
  }
  return q;
}

function summarizeToday(dir, cap) {
  const q = loadGlobalQuota(dir);
  const jobs = Object.entries(q.perJob).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join("、");
  return `[全局配额] 今日已浏览 ${q.resumeViews}/${cap}${jobs ? `（${jobs}）` : ""}，次日自动清零`;
}

// 与 run.js 的 sanitize 逐字一致（三处镜像之一）
function jobKeyFromProfileEnv(fallback) {
  const raw = process.env.JOB_PROFILE;
  const name = raw ? path.basename(raw).replace(/\.json$/i, "") : String(fallback || "");
  return String(name).replace(/[\\/:*?"<>|]/g, "-").trim() || "default";
}

function resolveGlobalQuotaDir(dataDir) {
  if (process.env.SCREENER_GLOBAL_QUOTA_DIR) return process.env.SCREENER_GLOBAL_QUOTA_DIR;
  const candidates = [
    path.resolve(process.cwd(), "data", "_quota"),
    path.resolve(__dirname, "..", "..", "data", "_quota"),
  ];
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      return c;
    } catch { /* 尝试下一个 */ }
  }
  return path.join(dataDir, "_quota"); // 兜底：退化为岗位本地记账（极端权限问题）
}

module.exports = {
  PLATFORM,
  todayKey,
  globalQuotaPath,
  loadGlobalQuota,
  viewsToday,
  remainingToday,
  jobViewsToday,
  chargeGlobalView,
  summarizeToday,
  jobKeyFromProfileEnv,
  resolveGlobalQuotaDir,
};
