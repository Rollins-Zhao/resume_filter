// 读取 BOSS 已发布岗位列表（在招职位）——与 liepin-resume-screener/scripts/joblist.js 输出语义镜像
// 用法：node joblist.js [--json] [--raw]
//   --json  机器可读（归一化条目数组，含 raw 原始字段）
//   --raw   打印 CLI 原始输出（只在终端显示不落盘；字段适配时用它核对真实键名）
// 退出码：0=成功（含 0 条）｜2=登录失效｜3=风控/熔断｜5=CLI 成功但输出格式未识别｜1=其他失败
//
// ✅ `boss hr jobs list` 已真机实测：2026-10-30 · boss-agent-cli v3.1.0（Edge CDP 9333）。
//    v3.1.0 起输出为分页嵌套 {data:{page,pageSize,totalSize,data:[…]}}，岗位城市键=locationName、
//    岗位加密 ID 键=encryptId（旧版扁平结构同时兼容）。
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const { runBoss, FatalError, LoginExpired, RateLimited, VerificationRequired } = require("./boss");
const { checkCliUpdate } = require("./check-cli-update");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
const DATA = path.join(ROOT, "data");
const LOGS = path.join(ROOT, "logs");
[DATA, LOGS].forEach((d) => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

const today = () => new Date().toISOString().slice(0, 10);
const loadJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; } };
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
const logger = { append: (s) => { try { fs.appendFileSync(path.join(LOGS, `run-${today()}.log`), s); } catch {} } };

// 请求配额记账（仿 screener.js 的 chargeQuota：在 CLI 内置节流之外的二次兜底）
function chargeQuota() {
  let quota = loadJson(path.join(DATA, "quota.json"), { date: today(), count: 0 });
  if (quota.date !== today()) quota = { date: today(), count: 0 };
  if (quota.count >= cfg.maxRequestsPerDay) {
    throw new FatalError(`日请求配额已用尽 (${quota.count}/${cfg.maxRequestsPerDay})，今日停止`);
  }
  quota.count++;
  saveJson(path.join(DATA, "quota.json"), quota);
  return quota;
}

// ---------- 容忍式解析（纯函数，供离线测试） ----------
// BOSS 统一 JSON 信封：{ok, data, pagination, error, ...}；列表字段名随接口而变，做多键兼容。
function pickJobList(envelope) {
  const d = envelope && envelope.data;
  if (!d) return null;
  if (Array.isArray(d)) return d;
  // v3.1.0 分页嵌套（2026-10-30 真机实测）：{data:{page,pageSize,hasMore,totalSize,data:[…]}}
  if (Array.isArray(d.data)) return d.data;
  for (const k of ["jobs", "jobList", "list", "items", "result", "zpData"]) {
    if (Array.isArray(d[k])) return d[k];
    if (d[k] && typeof d[k] === "object") {
      for (const k2 of ["jobs", "jobList", "list", "items", "result"]) {
        if (Array.isArray(d[k][k2])) return d[k][k2];
      }
    }
  }
  // 空 data = 真没有在招岗位（0 条）；非空但无列表键 = 输出结构漂移（返回 null → 退出码 5）
  return Object.keys(d).length === 0 ? [] : null;
}

const firstNonEmpty = (obj, keys) => {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return "";
};

// 城市码反查中文名（查不到保留原值）
function cityName(raw) {
  const s = String(raw || "");
  if (!s) return "";
  const map = cfg.bossCityCodeMap || {};
  for (const [name, code] of Object.entries(map)) {
    if (code === s) return name;
  }
  return s;
}

// 归一化单条岗位（键序为保守猜测，真机适配后按实际固化并注明日期）
function normalizeJobItem(item) {
  const name = firstNonEmpty(item, ["jobName", "name", "title", "positionName"]);
  if (!name) return null;
  const cityRaw = firstNonEmpty(item, ["cityName", "city", "cityCode", "location", "locationName", "addressShowText"]);
  return {
    name: String(name),
    city: cityName(cityRaw),
    salary: String(firstNonEmpty(item, ["salary", "salaryDesc", "salaryRange", "pay"]) || ""),
    status: String(firstNonEmpty(item, ["status", "jobStatus", "state", "online", "activeStatus"]) || ""),
    jobId: String(firstNonEmpty(item, ["encryptId", "encryptJobId", "jobId", "job_id", "id"]) || ""),
    source: "boss",
    raw: item,
  };
}

/** 信封 → {ok, jobs}；ok=false 表示输出格式未识别（调用方走退出码 5 降级） */
function parseJobsFromEnvelope(envelope) {
  const list = pickJobList(envelope);
  if (!list) return { ok: false, jobs: [] };
  return { ok: true, jobs: list.map((x) => normalizeJobItem(x && typeof x === "object" ? x : {})).filter(Boolean) };
}

// ---------- 主入口 ----------
function main() {
  const args = process.argv.slice(2);
  chargeQuota();
  const r = runBoss(["hr", "jobs", "list"], { bin: cfg.bossBin, logger });

  if (args.includes("--raw")) {
    process.stdout.write(JSON.stringify(r.envelope || r, null, 2));
    process.exit(0);
  }

  const parsed = parseJobsFromEnvelope(r.envelope || {});
  if (!parsed.ok) {
    console.error("[joblist] 输出格式未识别（hr jobs list 未实测，字段可能不符）。请运行 node joblist.js --raw 查看原始输出：");
    console.error("  - 有岗位但解析不出 → 把 --raw 输出发给维护者适配字段映射；");
    console.error("  - 命令形态报错（如需要 --page 等参数）→ 同样发给维护者修正命令。");
    process.exit(5);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(parsed.jobs, null, 2));
    process.exit(0);
  }
  if (!parsed.jobs.length) {
    console.log("BOSS 在招岗位：0 个（BOSS 后台没有发布中的岗位；仅显示第一页）");
    process.exit(0);
  }
  console.log(`BOSS 在招岗位 ${parsed.jobs.length} 个（仅第一页）：`);
  parsed.jobs.forEach((j, i) =>
    console.log(`  ${i + 1}. ${j.name}${j.city ? " · " + j.city : ""}${j.salary ? " · " + j.salary : ""}${j.status ? " · " + j.status : ""}`)
  );
  process.exit(0);
}

if (require.main === module) {
  (async () => {
    // 版本必查必升(用户铁律:每次使用 CLI 必查;joblist 真实消耗平台请求,与 screener.js 同口径)
    await checkCliUpdate({
      autoUpdate:
        process.env.BOSS_CLI_AUTOUPDATE !== "0" && process.env.SCREENER_CLI_AUTOUPDATE !== "0",
    });
    try {
      main();
    } catch (e) {
      if (e instanceof LoginExpired) { console.error(`[joblist] ${e.message}。请先双击 boss-edge-login.bat / boss-zhipin-login.bat 扫码并保持窗口开着`); process.exit(2); }
      if (e instanceof FatalError || e instanceof VerificationRequired) { console.error(`[joblist] ${e.message}`); process.exit(3); }
      if (e instanceof RateLimited) { console.error(`[joblist] ${e.message}`); process.exit(1); }
      console.error(`[joblist] ${e.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { pickJobList, normalizeJobItem, parseJobsFromEnvelope, cityName };
