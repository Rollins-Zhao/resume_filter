// self-update.js —— 工具本体自更新（v2.13.0：GitHub 公开仓 resume_filter 的 Release 资产，仓址见 REPO 常量）
//
// 语义与两侧 check-cli-update.js 完全同族：查最新版 → 有新版自动升级 → **升级动作永不抛异常、永不阻塞**，
// 任何失败（网络不通 / Release 不存在 / 磁盘失败）只打一行 stderr 后正常退出（exit 0），主流程照常。
//
// 触发点两条路（AI-GUIDE「五」）：run.bat 启动时带 --from-bat；AI 会话开工环节直接跑（cwd 任意，
// ROOT 恒为本脚本所在目录）。用户侧零凭据（公开仓匿名下载），不要求 git。
//
// 用法：node self-update.js [--check-only] [--dry] [--from-bat]
//   --check-only 只查不升（有新版 exit 10）；--dry 打印将写清单不落盘；
//   --from-bat  由 run.bat 调用：run.bat 只写 run.bat.new（cmd 持句柄按字节偏移续读正在执行的
//               .bat，原地改写会错位执行——绝不覆盖），由旧 bat 的 move / 下次非 bat 上下文自愈应用。
// env：SCREENER_SELF_UPDATE=0 应急关断（发现新版只提示不升，exit 10）；
//      SCREENER_SELF_UPDATE_REPO 覆盖 "owner/repo"（测试用）。
// 退出码：0 = 已最新 / 失败不阻塞；10 = 有新版未应用（--check-only / --dry / 关断）；11 = 已升级。
//
// 取版双层：tier1 api.github.com releases/latest（快、结构化；404 尚无 Release / 403 限流 / 超时降级）
//          → tier2 curl -sIL 常量名资产稳定地址，从 Content-Disposition 的文件名读版本
//            （走下载通道不吃 API 限额；github.com 慢但通、objects.githubusercontent.com 快，-L 串起两跳）。
// 应用即「解压覆盖到项目根」：zip 本身是 pack-release 白名单产物（天然不含 data/reports/logs/.env），
// isProtectedEntry 再做第二道白名单防线；叶子文件先写、run.js/package.json 压轴（package.json 即版本标记，
// 最后落位——中途失败时旧 run.js 配旧 scripts 仍自洽，下次全量覆盖自愈）。不做事务/回滚/删除清单（防过度设计）。
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const ROOT = __dirname; // 不依赖 cwd：AI 在任意工作目录用绝对路径调本脚本都更新对地方
const GITHUB_OWNER = process.env.SCREENER_SELF_UPDATE_OWNER || "Rollins-Zhao"; // 建仓后回填真实用户名（一次性替换）
const REPO = process.env.SCREENER_SELF_UPDATE_REPO || `${GITHUB_OWNER}/resume_filter`;
const LATEST_ASSET = "resume-screener-latest.zip"; // --publish 每版同步上传的常量名资产（tier2 / install.bat 依赖）

// ---------- 纯函数（导出供 tests/self-update.test.js） ----------

/** 解析 "1.2.3" / "v1.2.3" / "1.2.3-beta.1" → [1,2,3]（与两侧 check-cli-update 同款） */
function parseVer(v) {
  const core = String(v || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0];
  const parts = core.split(".").map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** 语义化比较，返回 1 / 0 / -1 */
function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] > B[i] ? 1 : -1;
  }
  return 0;
}

/** 读 <root>/package.json 的 version，缺失/损坏返回 null（本地版本源；package.json 恒在发布包内） */
function readLocalVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

/** 从 Release 资产里挑更新包：精确版本号 → 常量名 latest → 第一个 resume-screener-*.zip；没有返回 null */
function pickAsset(assets, wantVer) {
  const list = Array.isArray(assets) ? assets : [];
  const byName = (n) => list.find((a) => a && a.name === n && a.browser_download_url);
  const exact = byName(`resume-screener-${wantVer}.zip`);
  if (exact) return { name: exact.name, url: exact.browser_download_url, size: exact.size || 0 };
  const latest = byName(LATEST_ASSET);
  if (latest) return { name: latest.name, url: latest.browser_download_url, size: latest.size || 0 };
  const any = list.find((a) => a && /^resume-screener-.*\.zip$/i.test(a.name || "") && a.browser_download_url);
  return any ? { name: any.name, url: any.browser_download_url, size: any.size || 0 } : null;
}

// 第二道防线：zip 是白名单打包产物，这里防的是「包被换 / 打包器将来出错」。
// 语义与 pack-release 的 PROFILES_ALLOWLIST 逐字对齐：profiles 只放行 _template.json 与 example-*。
const PROTECTED_DIRS = new Set([
  "data", "reports", "logs", "release", "node_modules", "chrome-win64",
  ".git", ".workbuddy", ".claude", "tests", ".playwright-mcp",
]);

/** 受保护路径 → true（不写盘）。拒绝对路径/..、运行数据目录、任何位置 .env、profiles 里的非白名单文件 */
function isProtectedEntry(name) {
  const n = String(name || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n || n.endsWith("/")) return true; // 空名与目录条目一律不写
  if (/^[a-zA-Z]:\//.test(n) || n.startsWith("/")) return true;
  const segs = n.split("/");
  if (segs.some((s) => s === ".." || s === ".env")) return true;
  // Win32 归一化会剥每段末尾的点/空格（"data "/ "data." 落盘即 data/，".env." 即 .env——评审 I2）；
  // 合法 zip 条目不会这样命名，一律拒绝；同拒含 ":" 的段（盘符/ADS 变体）
  if (segs.some((s) => /[.\s]$/.test(s) || s.includes(":"))) return true;
  const first = segs[0].toLowerCase();
  if (PROTECTED_DIRS.has(first)) return true;
  if (first === "profiles") {
    const rest = segs.slice(1).join("/");
    if (rest.includes("/")) return true; // 只放行 profiles 根下的单文件
    const lower = rest.toLowerCase();
    return !(lower === "_template.json" || lower.startsWith("example-"));
  }
  return false;
}

/** 应用计划：受保护项进 skipped；--from-bat 时 run.bat 入 batDeferred（写 run.bat.new）；
 *  其余稳定排序——普通文件保持 zip 原序在前，run.js 倒数第二、package.json 压轴（版本标记最后落位） */
function planApply(names, { fromBat = false } = {}) {
  const direct = [];
  const skipped = [];
  const batDeferred = [];
  for (const name of names) {
    if (isProtectedEntry(name)) {
      skipped.push(name);
      continue;
    }
    if (name === "run.bat" && fromBat) {
      batDeferred.push(name);
      continue;
    }
    direct.push(name);
  }
  const prio = (n) => (n === "package.json" ? 2 : n === "run.js" ? 1 : 0);
  direct.sort((a, b) => prio(a) - prio(b)); // Array.sort 稳定（ES2019+）
  return { direct, batDeferred, skipped };
}

// ---------- 零依赖 zip 读取器 ----------
// 包内只有 store(0)/deflate(8)、无加密、无 zip64（发布包 ~350KB / ~250 文件），EOCD 向前扫一段即可。
// 不校验 CRC：完整性由 https 传输 + 应用后版本复核承担（方案定案，不做 sha256 清单）。

/** 解析 zip Buffer → [{name, size, data}]；目录条目与未知压缩法的条目跳过 */
function readZipEntries(buf) {
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - (22 + 65535));
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 尾部未找到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${i + 1} 条结构不符`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`local header 结构不符：${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else continue;
    entries.push({ name, size: data.length, data });
  }
  return entries;
}

// ---------- 网络 ----------

/** 极简 https GET JSON（与 check-cli-update.js 同款：8s 超时 + 跟随重定向，上限 5 跳） */
function fetchJson(url, timeoutMs = 8000, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("重定向次数过多"));
    const req = https.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "resume-screener-self-update" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchJson(res.headers.location, timeoutMs, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("返回内容不是 JSON"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

/** tier2：从 curl -sIL 的响应头文本解析最新版本。版本**只在第一跳 302 的 Location 路径里**
 *  （`releases/download/<tag>/常量名.zip`），Content-Disposition 只带资产自身名（即常量名，无版本——
 *  评审 C1 实证纠偏）。只接受语义化 tag（数字点分）；解析不出/不合法返回 null——
 *  走诚实的「不可达」单行提示，绝不假报「已是最新」。 */
function parseTier2Headers(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const lm = /^\s*location:\s*(\S+)/i.exec(line);
    if (!lm) continue;
    const tm = /\/releases\/download\/v?([^/?\s]+)\//i.exec(lm[1]);
    if (tm && /^\d+(\.\d+)*$/.test(tm[1])) return tm[1];
  }
  return null;
}

/** 双层取版：tier1 API releases/latest → tier2 常量名资产 HEAD 的重定向 Location tag */
async function fetchLatest() {
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const version = String((rel && rel.tag_name) || "").replace(/^v/, "");
    if (version && Array.isArray(rel.assets)) return { version, assets: rel.assets };
  } catch {
    /* 404（尚无 Release）/403（匿名限流 60 次/时）/超时 → tier2 */
  }
  const stableUrl = `https://github.com/${REPO}/releases/latest/download/${LATEST_ASSET}`;
  const head = spawnSync("curl", ["-sIL", "--max-time", "30", stableUrl], { encoding: "utf8", windowsHide: true });
  const version = parseTier2Headers(head.stdout);
  if (version) {
    return { version, assets: [{ name: `resume-screener-${version}.zip`, browser_download_url: stableUrl, size: 0 }] };
  }
  throw new Error("GitHub Release 信息不可达");
}

/** Node https 流式下载兜底（curl 缺失/失败时；跟随重定向） */
function httpsDownload(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("重定向次数过多"));
    const req = https.get(url, { timeout: 60000, headers: { "User-Agent": "resume-screener-self-update" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsDownload(new URL(res.headers.location, url).href, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载 HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(dest)));
      out.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", reject);
  });
}

/** 下载更新包：curl 优先（--fail 挡 HTTP 错误页落盘；断点续传顺手保险），失败走 Node https 兜底 */
async function downloadZip(url, dest) {
  const r = spawnSync(
    "curl",
    ["-sSFL", "--retry", "5", "--retry-all-errors", "--max-time", "300", "-C", "-", "-o", dest, url],
    { windowsHide: true }
  );
  if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  return httpsDownload(url, dest);
}

// ---------- 应用 ----------

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 带重试写盘：EBUSY/EPERM（杀软/索引器瞬时锁）等一律 3 次 × 300ms */
function writeWithRetry(file, data) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (e) {
      lastErr = e;
      sleep(300);
    }
  }
  throw lastErr;
}

/** 自愈残留 run.bat.new：非 bat 上下文启动时先应用掉（run.bat 的 move 失败场景） */
function applyPendingBat(root) {
  const pending = path.join(root, "run.bat.new");
  if (!fs.existsSync(pending)) return;
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(pending, path.join(root, "run.bat"));
      console.log("[自更新] 已应用上次待生效的 run.bat");
      return;
    } catch {
      sleep(300);
    }
  }
  console.error("[自更新] run.bat.new 暂无法应用（文件被占用），下次启动自动重试");
}

/** 把 zip 条目按计划写入项目根（--from-bat 时 run.bat 写 run.bat.new；--dry 只打印不落盘） */
function applyUpdate(root, entries, { fromBat = false, dry = false } = {}) {
  const plan = planApply(
    entries.map((e) => e.name),
    { fromBat }
  );
  // --from-bat 时 run.bat 才走 .new 延迟生效；非 bat 上下文（AI 契约路径）直接覆盖本体
  const targetOf = (name) => path.join(root, fromBat && name === "run.bat" ? "run.bat.new" : name);
  if (dry) {
    console.log(`[自更新] --dry 清单：直接写 ${plan.direct.length} 个（${plan.direct.slice(0, 5).join("、")}${plan.direct.length > 5 ? "…" : ""}）；run.bat 延迟 ${plan.batDeferred.length}；跳过保护项 ${plan.skipped.length}`);
    return plan;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  for (const name of [...plan.direct, ...plan.batDeferred]) {
    const e = byName.get(name);
    const t = targetOf(name);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    writeWithRetry(t, e.data);
  }
  return plan;
}

// ---------- 主流程（退出码契约见文件头） ----------

const oneLine = (msg) => String(msg).split(/\r?\n/)[0].slice(0, 200);

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check-only");
  const dry = args.includes("--dry");
  const fromBat = args.includes("--from-bat");
  const disabled = process.env.SCREENER_SELF_UPDATE === "0";

  // 开发仓防护（评审 I4）：zip 装机不含 .git；本目录有 .git 说明是维护仓——远端 Release 可能是
  // --version 覆盖发的包/测试版（如 9.9.9），高于本地 package.json 时会把未发布的本地改动静默
  // 回滚成已发布包。开发仓一律跳过，更新走 git。
  if (fs.existsSync(path.join(ROOT, ".git"))) {
    console.log("[自更新] 检测到 .git（开发仓），跳过——开发仓请用 git 更新");
    return 0;
  }

  if (!fromBat) applyPendingBat(ROOT);

  // 契约层刷新（v2.13.3 定稿：**每次运行**都刷，不依赖升级动作）——.workbuddy/memory/MEMORY.md 等
  // ai-guide-sync 同步目标不随 zip 走（打包排除），旧版升上来的第一跳用的还是旧 self-update 代码，
  // 只挂在"升级成功后"的话它们永远赶不上（2.13.2 的实证缺陷）；每次运行刷新则下一次启动即补齐。
  // 幂等且纯本地（毫秒级），失败不阻塞。
  try {
    spawnSync(process.execPath, [path.join(ROOT, "ai-guide-sync.js"), "--all"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 30000,
    });
  } catch {
    /* 永不阻塞 */
  }

  const local = readLocalVersion(ROOT);
  if (!local) {
    console.error("[自更新] 本地 package.json 缺失或损坏，跳过");
    return 0;
  }
  const latest = await fetchLatest();
  if (cmpVer(local, latest.version) >= 0) {
    console.log(`[自更新] 已是最新（v${local}）`);
    return 0;
  }
  if (checkOnly) {
    console.log(`[自更新] 有新版：v${local} → v${latest.version}`);
    return 10;
  }
  if (disabled) {
    console.error(`[自更新] 已关断（SCREENER_SELF_UPDATE=0），发现新版 v${latest.version} 未升级`);
    return 10;
  }
  const asset = pickAsset(latest.assets, latest.version);
  if (!asset) {
    console.error(`[自更新] Release v${latest.version} 没有 zip 资产，跳过`);
    return 0;
  }
  const dest = path.join(os.tmpdir(), `resume-screener-selfupdate-${Date.now()}.zip`);
  try {
    await downloadZip(asset.url, dest);
    const entries = readZipEntries(fs.readFileSync(dest));
    applyUpdate(ROOT, entries, { fromBat, dry });
    if (dry) return 10;
    const now = readLocalVersion(ROOT); // 应用后复核：package.json 是最后一个写的文件，读到新版本才算成功
    if (now !== latest.version) throw new Error(`应用后版本复核不符（期望 ${latest.version}，实际 ${now}）`);
    console.log(`[自更新] 已升级 v${local} → v${latest.version}（用户数据未动${fromBat ? "；run.bat 新版已在 run.bat.new 待生效" : ""}）`);
    return 11;
  } finally {
    try {
      fs.rmSync(dest, { force: true });
    } catch {
      /* 临时文件清理失败无所谓 */
    }
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      if (code) process.exit(code);
    },
    (e) => {
      console.error(`[自更新] ${oneLine(e && e.message ? e.message : e)}，本次跳过（不影响使用）`);
      process.exit(0);
    }
  );
}

module.exports = {
  REPO,
  parseVer,
  cmpVer,
  readLocalVersion,
  pickAsset,
  isProtectedEntry,
  planApply,
  readZipEntries,
  parseTier2Headers,
  fetchLatest,
  downloadZip,
  applyUpdate,
};
