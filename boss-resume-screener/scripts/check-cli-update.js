/**
 * boss-agent-cli 版本检查 / 升级
 *
 * ⚠️ 与猎聘版的根本差异：boss-agent-cli 是 **Python 包（PyPI 分发）**，不是 npm 包。
 *    所以版本源是 https://pypi.org/pypi/boss-agent-cli/json，升级走 uv tool upgrade。
 *
 * 用法：
 *   node check-cli-update.js              # 检查；有新版本则自动升级（默认行为，无人值守、无需确认）
 *   node check-cli-update.js --check-only # 只检查不升级（手动排查用）
 *
 * 环境变量：
 *   BOSS_CLI_AUTOUPDATE=0     应急关断自动升级（默认必查必升；SCREENER_CLI_AUTOUPDATE=0 同效）
 *   BOSS_CLI_AUTOCONFIRM=0    恢复"等人工确认"（仅应急排查用）
 *   BOSS_CLI_PYPI             覆盖 PyPI 索引（默认 https://pypi.org/pypi）
 *   BOSS_BIN                  手动指定 boss 可执行文件
 *
 * 退出码：0 = 已最新/已升级/检查失败（不阻塞主流程）｜10 = 有新版本待更新（仅 --check-only 或关断时）｜11 = 已升级
 *
 * 设计原则与猎聘版一致：**永不抛异常、永不阻塞主流程**。
 * 升级策略——用户的铁律（2026-10-21 再次重申；旧版「提示+等确认」是对它的稀释，已纠正）：
 *   每次使用前必须检查版本，不是最新版就升级——默认无人值守直接升，
 *   升级失败（PyPI 不可达等）只提示、不阻塞；关断（=0）是应急口子，不是常规路径。
 * （旧 --update 旗标 = 默认升级 + 附带内核就绪确认；--yes 已冗余。）
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const os = require("os");

const PKG = "boss-agent-cli";
const DEFAULT_PYPI = "https://pypi.org/pypi";

// ---------- patchright 浏览器内核（登录通道前置依赖）----------
// ⚠️ 实测坑（2026-10-15）：`patchright install chromium` 从官方 CDN
//    （cdn.playwright.dev → storage.googleapis.com）下载 ~196MB，在国内网络下
//    反复 "server closed connection"（进度到 80-90% 断、重试从 0% 开始，30+ 分钟永不成功）。
//    npmmirror 有同版本镜像且**支持断点续传**（Accept-Ranges: bytes），实测 11 秒下完。
//    → 结论：内核一律走镜像手动落盘，不要用官方 install。
//
// 需要**两个**内核（headless=True 用的是独立包，不是 chromium 本体）：
//   1. chromium-1243               → chrome-win64/chrome.exe           （有头/无头通用）
//   2. chromium_headless_shell-1243 → chrome-headless-shell-win64/chrome-headless-shell.exe
//
// 目录名规则（playwright core index.js）：
//   path.join(registryDirectory, name.replace(/-/g,"_") + "-" + revision)
//   name=chromium                → chromium-1243
//   name=chromium-headless-shell → chromium_headless_shell-1243
// 落地后必须写 INSTALLATION_COMPLETE 标记，否则 playwright 仍判定"未下载"。
const PW_REVISION = "1243";               // browsers.json 里 chromium 的 revision
const PW_CHROMIUM_BUILD = "153.0.8010.12"; // Chrome for Testing 版本
const PW_BROWSERS_DIR = process.env.PLAYWRIGHT_BROWSERS_PATH || null; // 空 = 默认 ms-playwright
const PW_MIRROR_BASE = "https://cdn.npmmirror.com/binaries/chrome-for-testing";
const PW_PACKAGES = [
  { dir: `chromium-${PW_REVISION}`, zip: "chrome-win64.zip", inner: "chrome-win64", exe: "chrome.exe" },
  {
    dir: `chromium_headless_shell-${PW_REVISION}`,
    zip: "chrome-headless-shell-win64.zip",
    inner: "chrome-headless-shell-win64",
    exe: "chrome-headless-shell.exe",
  },
];

// ---------- 小工具 ----------
function parseVer(v) {
  const core = String(v || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0];
  const parts = core.split(".").map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] > B[i] ? 1 : -1;
  return 0;
}

function fetchJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "boss-resume-screener", Accept: "application/json" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchJson(res.headers.location, timeoutMs));
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

// ---------- 定位已安装 CLI 与 uv ----------
function findUv() {
  // uv 可能装在：PATH、托管 Python 的 Scripts、~/.local/bin
  const cands = [];
  const home = os.homedir();
  const isWin = process.platform === "win32";
  const exe = isWin ? "uv.exe" : "uv";
  cands.push(path.join(home, ".local", "bin", exe));
  cands.push(path.join(home, ".cargo", "bin", exe));
  // 托管 Python 解释器同目录（本机实际落点）
  cands.push(path.join(path.dirname(process.execPath), exe));
  cands.push(path.join(path.dirname(process.execPath), "Scripts", exe));
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "uv"; // 交给 PATH
}

/** 用 uv tool list 读已装版本（最可靠，不依赖 --version 输出格式） */
function readVersionViaUv(uv) {
  try {
    const out = execFileSync(uv, ["tool", "list"], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    const m = out.match(new RegExp(`${PKG}\\s+v?([0-9]+\\.[0-9]+\\.[0-9]+[^\\s]*)`));
    if (m) return m[1];
  } catch {
    /* uv 不可用则回退 */
  }
  return null;
}

async function fetchLatestVersion(pypi) {
  const base = (pypi || DEFAULT_PYPI).replace(/\/+$/, "");
  const j = await fetchJson(`${base}/${PKG}/json`);
  if (!j || !j.info || !j.info.version) throw new Error("响应里没有 info.version 字段");
  return j.info.version;
}

// ---------- patchright 内核检查 / 镜像安装 ----------
/** 解析 ms-playwright 目录（与 playwright 官方默认值一致） */
function pwBrowsersDir() {
  // ⚠️ 必须用 path.resolve 规范化：PLAYWRIGHT_BROWSERS_PATH 可能是带引号/混合分隔符的路径，
  //   而 path.join 一旦遇到嵌入的绝对路径会重置整段（曾致 "C:\a\C:\a\chromium-1243" 这种双前缀）。
  let root = PW_BROWSERS_DIR;
  if (!root) {
    if (process.platform === "win32") {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      root = path.join(local, "ms-playwright");
    } else if (process.platform === "darwin") {
      root = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
    } else {
      root = path.join(os.homedir(), ".cache", "ms-playwright");
    }
  }
  return path.resolve(root.replace(/^"|"$/g, "").trim());
}

/** 两个内核是否都已装好（判据：可执行文件 + INSTALLATION_COMPLETE 标记） */
function checkBrowsers() {
  const root = pwBrowsersDir();
  return PW_PACKAGES.map((pkg) => {
    const dir = path.resolve(root, pkg.dir);
    const exe = path.resolve(dir, pkg.inner, pkg.exe);
    const marker = path.resolve(dir, "INSTALLATION_COMPLETE");
    let ok = false;
    try {
      ok = fs.existsSync(exe) && fs.existsSync(marker);
    } catch {
      /* ignore */
    }
    return { ...pkg, dir, exe, marker, ok };
  });
}

/**
 * 走 npmmirror 镜像安装缺失内核。
 * 关键点：官方 `patchright install` 在国内会反复断连；镜像支持断点续传。
 * 落地后必须补 INSTALLATION_COMPLETE，否则 playwright 仍判定未安装。
 */
function installBrowserPackage(pkg, log) {
  const root = pwBrowsersDir();
  const tmpDir = path.join(os.tmpdir(), "boss-pw-download");
  const zipPath = path.join(tmpDir, pkg.zip);
  const url = `${PW_MIRROR_BASE}/${PW_CHROMIUM_BUILD}/win64/${pkg.zip}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  // 优先 curl（支持 -C - 断点续传）；无 curl 则退化为 node 流式下载
  log(`   下载 ${pkg.zip} ← npmmirror…`);
  try {
    execFileSync("curl", ["-L", "--retry", "20", "--retry-delay", "3", "--retry-all-errors", "-C", "-", "--max-time", "1800", "-o", zipPath, url], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 1800000,
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, msg: `下载失败（${pkg.zip}）：${(e.stderr || e.message || "").toString().split("\n")[0]}` };
  }

  // 解压（Windows 用 tar，系统自带 Win10+；否则 PowerShell Expand-Archive）
  const target = path.resolve(root, pkg.dir);
  log(`   解压到 ${pkg.dir}…`);
  let extracted = false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    execFileSync("tar", ["-xf", zipPath, "-C", target], { stdio: ["ignore", "ignore", "pipe"], timeout: 300000, windowsHide: true });
    extracted = true;
  } catch {
    extracted = false;
  }
  if (!extracted) {
    try {
      // 注意：-DestinationPath 用相对路径，先切到 target 再解压，避免路径拼接错乱
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Set-Location -LiteralPath '${target}'; Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '.' -Force`,
        ],
        { stdio: ["ignore", "ignore", "pipe"], timeout: 600000, windowsHide: true }
      );
    } catch (e2) {
      return { ok: false, msg: `解压失败（${pkg.zip}）：${(e2.message || "").toString().split("\n")[0]}` };
    }
  }

  // 写标记文件 —— 少了它 playwright 仍会认为"未下载"
  try {
    fs.writeFileSync(path.resolve(target, "INSTALLATION_COMPLETE"), PW_CHROMIUM_BUILD);
    fs.writeFileSync(path.resolve(target, "DEPENDENCIES_VALIDATED"), "0.0.0.0");
  } catch (e) {
    return { ok: false, msg: `写标记文件失败：${e.message}` };
  }

  const exe = path.resolve(target, pkg.inner, pkg.exe);
  if (!fs.existsSync(exe)) return { ok: false, msg: `解压后未找到可执行文件：${exe}` };
  return { ok: true, msg: `${pkg.dir} 安装完成` };
}

/** 检查并按需镜像安装内核；返回 {ok, missing, msg} */
function ensureBrowsers(opts = {}, log = () => {}) {
  const states = checkBrowsers();
  const missing = states.filter((s) => !s.ok);
  if (!missing.length) {
    log(`[内核检查] patchright 内核已就绪（${states.map((s) => s.dir).join(" + ")}）`);
    return { ok: true, missing: [], msg: "已就绪" };
  }
  log(`\n⚠️  patchright 内核缺失：${missing.map((m) => m.dir).join("、")}`);
  if (!opts.autoInstall) {
    log(`   安装命令（走镜像，不要用官方 install）：`);
    log(`   node "<skill目录>/scripts/check-cli-update.js" --install-browsers`);
    return { ok: false, missing: missing.map((m) => m.dir), msg: "内核缺失" };
  }
  for (const pkg of missing) {
    const r = installBrowserPackage(pkg, log);
    log(r.ok ? `   ✅ ${r.msg}` : `   ❌ ${r.msg}`);
    if (!r.ok) return { ok: false, missing: missing.map((m) => m.dir), msg: r.msg };
  }
  // 复查
  const after = checkBrowsers().filter((s) => !s.ok);
  return { ok: after.length === 0, missing: after.map((m) => m.dir), msg: after.length ? "安装后仍有缺失" : "安装完成" };
}

// ---------- 升级 ----------
function doUpdate(uv) {
  const env = { ...process.env, UV_DEFAULT_INDEX: process.env.UV_DEFAULT_INDEX || "https://pypi.tuna.tsinghua.edu.cn/simple" };
  try {
    // 先尝试 upgrade（已安装场景）
    const out = execFileSync(uv, ["tool", "upgrade", PKG], {
      env,
      encoding: "utf8",
      timeout: 600000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, msg: "uv tool upgrade 完成", detail: out.trim().split("\n").slice(-3).join("\n") };
  } catch (e) {
    const err = (e.stderr || e.message || "").toString();
    // 未安装过 → 改为 install
    if (/not installed|no tool|未安装|does not exist/i.test(err)) {
      try {
        execFileSync(uv, ["tool", "install", PKG], {
          env,
          encoding: "utf8",
          timeout: 600000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, msg: "uv tool install 完成（首次安装）" };
      } catch (e2) {
        return { ok: false, msg: `安装失败：${(e2.stderr || e2.message || "").toString().split("\n")[0]}` };
      }
    }
    return { ok: false, msg: `升级失败：${err.split("\n")[0]}` };
  }
}

/** 询问用户是否升级（TTY 下才问；非 TTY 返回 null 表示"无法询问"） */
function askConfirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const readline = require("readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test((ans || "").trim()));
    });
  });
}

// ---------- 对外主函数 ----------
/**
 * @param {{autoUpdate?:boolean, autoConfirm?:boolean, silent?:boolean}} opts
 * @returns {Promise<{status:'latest'|'outdated'|'updated'|'declined'|'unknown'|'failed', installed?, latest?, msg?}>}
 */
async function checkCliUpdate(opts = {}) {
  const log = (s) => {
    if (!opts.silent) console.error(s);
  };
  const uv = findUv();
  const installed = readVersionViaUv(uv) || (() => {
    try {
      const out = execFileSync(process.env.BOSS_BIN || "boss", ["--version"], { encoding: "utf8", timeout: 20000, windowsHide: true });
      const m = out.match(/(\d+\.\d+\.\d+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  })();

  let latest = null;
  try {
    latest = await fetchLatestVersion(process.env.BOSS_CLI_PYPI);
  } catch {
    log("[CLI 检查] PyPI 不可达，跳过版本检查（不影响筛选）");
    return { status: "unknown", installed, msg: "PyPI 不可达" };
  }

  if (!installed) {
    log(`[CLI 检查] 未检测到已安装的 ${PKG}（最新 v${latest}）。`);
    log(`   安装命令： uv tool install ${PKG} && patchright install chromium`);
    return { status: "unknown", latest, msg: "未安装" };
  }

  if (cmpVer(installed, latest) >= 0) {
    log(`[CLI 检查] ${PKG} 已是最新（v${installed}）`);
    // 版本已最新，但仍要确认内核就绪（登录通道的硬前置）
    const br = ensureBrowsers({ autoInstall: opts.autoInstallBrowsers }, log);
    return { status: "latest", installed, latest, browsers: br };
  }

  log(`\n⚠️  ${PKG} 有新版本：v${installed} → v${latest}`);

  const autoUpdate =
    opts.autoUpdate ??
    (process.env.BOSS_CLI_AUTOUPDATE !== "0" && process.env.SCREENER_CLI_AUTOUPDATE !== "0");
  if (!autoUpdate) {
    // 仅当 BOSS_CLI_AUTOUPDATE=0 / SCREENER_CLI_AUTOUPDATE=0 应急关断时走到这里；默认必查必升
    log(`   （自动升级已被关断；移除 BOSS_CLI_AUTOUPDATE=0 / SCREENER_CLI_AUTOUPDATE=0 后重跑即自动升级）\n`);
    return { status: "outdated", installed, latest, msg: "自动升级被关断" };
  }

  // 人工确认仅在 BOSS_CLI_AUTOCONFIRM=0 应急时启用；默认无人值守直接升（用户铁律）
  const autoConfirm = opts.autoConfirm ?? process.env.BOSS_CLI_AUTOCONFIRM !== "0";
  if (!autoConfirm) {
    const ans = await askConfirm(`   是否现在升级到 v${latest}？`);
    if (ans === false) {
      log("   已跳过升级（继续使用当前版本，功能可能不兼容）。");
      return { status: "declined", installed, latest, msg: "用户跳过升级" };
    }
    if (ans === null) {
      log("   非交互环境，无法确认，跳过自动升级。请手动执行：uv tool upgrade boss-agent-cli");
      return { status: "outdated", installed, latest, msg: "需人工确认，未升级" };
    }
  }

  log("   正在升级…");
  const r = doUpdate(uv);
  log(r.ok ? `[CLI 检查] ✅ ${r.msg}` : `[CLI 检查] ❌ ${r.msg}`);
  return { status: r.ok ? "updated" : "failed", installed, latest, msg: r.msg };
}

module.exports = {
  checkCliUpdate,
  cmpVer,
  parseVer,
  findUv,
  readVersionViaUv,
  ensureBrowsers,
  checkBrowsers,
  installBrowserPackage,
};

// ---------- CLI 入口 ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  // 只装内核：node check-cli-update.js --install-browsers
  if (args.includes("--install-browsers") || args.includes("--install-browser")) {
    // 版本必查必升 + 内核就绪一条龙（用户铁律：版本检查脚本不允许跳过版本检查；升级失败只提示、不阻塞内核安装）
    (async () => {
      await checkCliUpdate({
        autoUpdate:
          process.env.BOSS_CLI_AUTOUPDATE !== "0" && process.env.SCREENER_CLI_AUTOUPDATE !== "0",
        autoConfirm: process.env.BOSS_CLI_AUTOCONFIRM !== "0",
        autoInstallBrowsers: false,
      });
      const r = ensureBrowsers({ autoInstall: true }, (s) => console.error(s));
      process.exit(r.ok ? 0 : 1);
    })();
  }
  // 默认检查并自动升级；--check-only 只查不升；应急关断 BOSS_CLI_AUTOUPDATE=0 / SCREENER_CLI_AUTOUPDATE=0（直跑同样尊重 env）。
  // 内核自动安装仅显式 --update / --install-browsers 时触发（会话/hook 场景不背 196MB 下载；内核由 run.js / setup.bat 显式路径承担）
  const checkOnly = args.includes("--check-only");
  checkCliUpdate({
    autoUpdate:
      !checkOnly &&
      process.env.BOSS_CLI_AUTOUPDATE !== "0" &&
      process.env.SCREENER_CLI_AUTOUPDATE !== "0",
    autoConfirm: !checkOnly && process.env.BOSS_CLI_AUTOCONFIRM !== "0",
    autoInstallBrowsers: args.includes("--update") || args.includes("--install-browsers"),
  }).then((r) => {
    if (r.status === "outdated") process.exit(10);
    if (r.status === "updated") process.exit(11);
    process.exit(0);
  });
}
