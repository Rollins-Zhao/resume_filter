// 读取猎聘已发布岗位列表（在招职位）——与 boss-resume-screener/scripts/joblist.js 输出语义镜像
// 用法：node joblist.js [--json] [--raw]
//   --json  机器可读（归一化条目数组，含 raw 原始字段，供画像起草深挖）
//   --raw   打印 CLI 原始输出（只在终端显示不落盘；字段适配时用它核对真实键名）
// 退出码：0=成功（含 0 条）｜2=登录失效｜3=风控/熔断｜5=CLI 成功但输出格式未识别｜1=其他失败
//
// ⚠️ 归一化键序目前为保守猜测（猎聘 joblist 输出格式未实测），真机适配入口：
//    登录在线跑 `node joblist.js --raw`，按真实字段回改 normalizeJobItem 的键序并注明实测日期。
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const { checkCliUpdate } = require("./check-cli-update");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
const DATA = path.join(ROOT, "data");
const LOGS = path.join(ROOT, "logs");
[DATA, LOGS].forEach((d) => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

const today = () => new Date().toISOString().slice(0, 10);
const loadJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; } };
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));

class FatalError extends Error {}
class LoginExpired extends Error {}

// 执行 liepin 命令（复刻 screener.js 的 liepin()：代理剥离 / 请求配额记账 / 退出码 2/3 语义 / 日志）
function liepin(args) {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  env.NO_PROXY = "*";
  let quota = loadJson(path.join(DATA, "quota.json"), { date: today(), count: 0 });
  if (quota.date !== today()) quota = { date: today(), count: 0 };
  if (quota.count >= cfg.maxRequestsPerDay) {
    throw new FatalError(`日请求配额已用尽 (${quota.count}/${cfg.maxRequestsPerDay})，今日停止`);
  }
  quota.count++;
  saveJson(path.join(DATA, "quota.json"), quota);

  const cmd = `"${cfg.liepinBin}" ${args}`;
  let stdout = "";
  let code = 0;
  try {
    stdout = execSync(cmd, { env, encoding: "utf8", timeout: 120000, windowsHide: true });
  } catch (e) {
    code = e.status ?? 1;
    stdout = (e.stdout || "") + "";
    if (code === 3) throw new FatalError("风控触发（退出码 3）：立即停止全部自动化");
    if (code === 2) throw new LoginExpired("登录态失效（退出码 2）：请重新登录");
  }
  try { fs.appendFileSync(path.join(LOGS, `run-${today()}.log`), `\n$ liepin ${args}\n[exit ${code}]\n${stdout}\n`); } catch {}
  return { code, stdout, quota };
}

// ---------- 容忍式解析（纯函数，供离线测试） ----------
// 从混杂文本中抽取 JSON（CLI 可能混非 JSON 前后缀行；与 screener.js extractJson 同款）
function extractJson(text) {
  const trimmed = (text || "").trim();
  try { return JSON.parse(trimmed); } catch {}
  const start = Math.min(
    ...["[", "{"].map((c) => { const i = trimmed.indexOf(c); return i === -1 ? Infinity : i; })
  );
  if (start === Infinity) return null;
  for (let end = trimmed.length; end > start; end--) {
    try { return JSON.parse(trimmed.slice(start, end)); } catch {}
  }
  return null;
}

// 列表多键兜底（键序待真机固化）
function pickJobList(data) {
  if (Array.isArray(data)) return data;
  const d = data && typeof data === "object" ? data : null;
  if (!d) return null;
  for (const k of ["jobs", "jobList", "list", "items", "result", "data"]) {
    if (Array.isArray(d[k])) return d[k];
    if (d[k] && typeof d[k] === "object") {
      for (const k2 of ["jobs", "jobList", "list", "items", "result"]) {
        if (Array.isArray(d[k][k2])) return d[k][k2];
      }
    }
  }
  // 空对象 = 真没有在招岗位（0 条）；非空但无列表键 = 输出结构漂移（返回 null → 退出码 5）
  return Object.keys(d).length === 0 ? [] : null;
}

const firstNonEmpty = (obj, keys) => {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return "";
};

// 归一化单条岗位（键序为保守猜测，真机适配后按实际固化并注明日期）
function normalizeJobItem(item) {
  const name = firstNonEmpty(item, ["jobName", "name", "title", "positionName"]);
  if (!name) return null; // 无名称的条目丢弃（多为装饰/分隔数据）
  return {
    name: String(name),
    city: String(firstNonEmpty(item, ["cityName", "city", "location", "workCity"]) || ""),
    salary: String(firstNonEmpty(item, ["salary", "salaryDesc", "pay", "salaryRange"]) || ""),
    status: String(firstNonEmpty(item, ["status", "jobStatus", "state", "online"]) || ""),
    jobId: String(firstNonEmpty(item, ["jobId", "job_id", "encryptJobId", "id"]) || ""),
    source: "liepin",
    raw: item,
  };
}

/** 文本 → {ok, jobs}；ok=false 表示输出格式未识别（调用方走退出码 5 降级） */
function parseJobsFromText(text) {
  const data = extractJson(text);
  const list = pickJobList(data);
  if (!list) return { ok: false, jobs: [] };
  return { ok: true, jobs: list.map((x) => normalizeJobItem(x && typeof x === "object" ? x : {})).filter(Boolean) };
}

// ---------- 主入口 ----------
function main() {
  const args = process.argv.slice(2);
  const r = liepin("joblist");

  if (args.includes("--raw")) {
    process.stdout.write(r.stdout || "");
    process.exit(r.code === 0 ? 0 : r.code === 2 ? 2 : r.code === 3 ? 3 : 1);
  }
  if (r.code !== 0) { console.error(`[joblist] liepin joblist 失败（exit ${r.code}；2=登录失效、3=风控）`); process.exit(r.code === 2 ? 2 : r.code === 3 ? 3 : 1); }

  const parsed = parseJobsFromText(r.stdout);
  if (!parsed.ok) {
    console.error("[joblist] 输出格式未识别。请运行 node joblist.js --raw 查看原始输出：");
    console.error("  - 有岗位但解析不出 → 把 --raw 输出发给维护者适配字段映射；");
    console.error("  - 确实没有在招岗位 → 属正常（先在猎聘后台发布岗位）。");
    process.exit(5);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(parsed.jobs, null, 2));
    process.exit(0);
  }
  if (!parsed.jobs.length) {
    console.log("猎聘在招岗位：0 个（猎聘后台没有发布中的岗位）");
    process.exit(0);
  }
  console.log(`猎聘在招岗位 ${parsed.jobs.length} 个：`);
  parsed.jobs.forEach((j, i) =>
    console.log(`  ${i + 1}. ${j.name}${j.city ? " · " + j.city : ""}${j.salary ? " · " + j.salary : ""}${j.status ? " · " + j.status : ""}`)
  );
  process.exit(0);
}

if (require.main === module) {
  (async () => {
    // 版本必查必升(用户铁律:每次使用 CLI 必查;joblist 真实消耗平台请求,与 screener.js 同口径)
    await checkCliUpdate({ autoUpdate: process.env.LIEPIN_CLI_AUTOUPDATE !== "0" });
    try {
      main();
    } catch (e) {
      if (e instanceof LoginExpired) { console.error(`[joblist] ${e.message}。请先双击 liepin-login.bat 扫码并保持窗口开着`); process.exit(2); }
      if (e instanceof FatalError) { console.error(`[joblist] ${e.message}`); process.exit(3); }
      console.error(`[joblist] ${e.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { extractJson, pickJobList, normalizeJobItem, parseJobsFromText };
