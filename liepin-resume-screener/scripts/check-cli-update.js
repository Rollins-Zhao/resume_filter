/**
 * liepin-cli 版本检查 / 自动更新
 *
 * 用法：
 *   node check-cli-update.js              # 检查；有新版本则自动升级（默认行为，无需任何开关）
 *   node check-cli-update.js --check-only # 只检查不升级（手动排查用）
 *
 * 环境变量：
 *   LIEPIN_CLI_AUTOUPDATE=0   应急关断自动升级（默认必查必升——用户铁律：每次使用必查版本，不是最新版就升级）
 *   LIEPIN_CLI_DIR            手动指定 @viyzhu/liepin-cli 包目录
 *   LIEPIN_CLI_REGISTRY       覆盖 registry（默认 https://registry.npmmirror.com；镜像滞后时可换 registry.npmjs.org）
 *
 * 退出码：0 = 已最新/已升级/检查失败（不阻塞主流程）｜10 = 有新版本待更新（仅 --check-only 或关断时）
 *
 * 设计原则：**升级动作永不抛异常、永不阻塞**。网络不通、registry 挂掉都只提示不报错，
 * 否则会把正常的筛选流程一起带崩。
 * （旧 --update 旗标已冗余：默认即升级。）
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const PKG = "@viyzhu/liepin-cli";
const DEFAULT_REGISTRY = "https://registry.npmmirror.com";
const FALLBACK_REGISTRY = "https://registry.npmjs.org";

// ---------- 小工具 ----------

/** 解析 "1.2.3" / "v1.2.3" / "1.2.3-beta.1" → [1,2,3] */
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

/** 极简 https GET JSON（无第三方依赖，带超时 + 一次重定向） */
function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "liepin-resume-screener" } },
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
          } catch (e) {
            reject(new Error("返回内容不是 JSON"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

// ---------- 定位已安装的 CLI ----------

/** 找到 @viyzhu/liepin-cli 的包目录（含 package.json），找不到返回 null */
function resolveCliDir() {
  const exists = (p) => {
    try {
      return !!p && fs.existsSync(path.join(p, "package.json"));
    } catch {
      return false;
    }
  };
  const cands = [];

  if (process.env.LIEPIN_CLI_DIR) cands.push(process.env.LIEPIN_CLI_DIR);

  // 从 config.liepinBin（…/node_modules/.bin/liepin.cmd）反推包目录
  let bin = process.env.LIEPIN_BIN;
  if (!bin) {
    try {
      bin = require("./config").liepinBin;
    } catch {
      /* config 加载失败不影响本检查 */
    }
  }
  if (bin && /[\\/]/.test(bin)) {
    const binDir = path.dirname(path.resolve(bin)); // …/node_modules/.bin
    const nm = path.dirname(binDir); // …/node_modules
    cands.push(path.join(nm, PKG.replace("/", path.sep)));
  }

  // 项目内 / 脚本上级
  cands.push(path.resolve(process.cwd(), "node_modules", ...PKG.split("/")));
  cands.push(path.resolve(__dirname, "..", "node_modules", ...PKG.split("/")));

  // WorkBuddy 托管 node 工作区（本机默认落点）
  cands.push(
    path.join(
      require("os").homedir(),
      ".workbuddy",
      "binaries",
      "node",
      "workspace",
      "node_modules",
      ...PKG.split("/")
    )
  );

  return cands.find(exists) || null;
}

function readInstalledVersion(cliDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

async function fetchLatestVersion(registry) {
  const base = (registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
  const url = `${base}/${PKG.replace("/", "%2F")}/latest`;
  const j = await fetchJson(url);
  if (!j || !j.version) throw new Error("响应里没有 version 字段");
  return j.version;
}

// ---------- 更新 ----------

function findNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const cands = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return cands.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/** 跑一次 liepin --version，返回 {ok, text} */
function probeLiepin(cliDir) {
  const isWin = process.platform === "win32";
  const nodeDir = path.dirname(process.execPath);
  const entry = path.join(cliDir, "dist", "cli", "index.js");
  const candidates = [];
  if (fs.existsSync(entry)) candidates.push([process.execPath, [entry, "--version"]]);
  const binName = isWin ? "liepin.cmd" : "liepin";
  const binPath = path.join(path.dirname(cliDir), "..", ".bin", binName);
  if (fs.existsSync(binPath)) candidates.push([binPath, ["--version"]]);

  for (const [cmd, args] of candidates) {
    try {
      const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 20000, windowsHide: true });
      return { ok: true, text: out.trim() };
    } catch (e) {
      if (String(e.stdout || "").includes("liepin-cli")) return { ok: true, text: String(e.stdout).trim() };
    }
  }
  return { ok: false, text: "" };
}

/** 执行更新；失败时按 SKILL 记录的 proxy-agent 已知坑做一次补救 */
function doUpdate(cliDir, registry) {
  const npmCli = findNpmCli();
  if (!npmCli) return { ok: false, msg: "找不到 npm-cli.js，请手动执行 npm install " + PKG };

  const nodeModules = path.dirname(path.dirname(cliDir)); // …/node_modules
  const root = path.dirname(nodeModules); // 安装根
  const reg = (registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
  const env = { ...process.env, npm_config_proxy: "", npm_config_https_proxy: "" };

  const run = (args) =>
    execFileSync(process.execPath, [npmCli, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 300000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

  try {
    run(["install", `${PKG}@latest`, `--registry=${reg}`, "--no-audit", "--no-fund"]);
  } catch (e) {
    return { ok: false, msg: `npm install 失败：${(e.stderr || e.message || "").toString().split("\n")[0]}` };
  }

  // 已知坑：镜像源里 @puppeteer/browsers 下会带一个残缺的嵌套 proxy-agent（缺 dist/index.js），
  // 导致 liepin --version 报错。补救：删掉嵌套版本，把 proxy-agent@6.5.0 装到顶层。
  const p = probeLiepin(cliDir);
  if (!p.ok) {
    try {
      const nested = path.join(nodeModules, "@puppeteer", "browsers", "node_modules", "proxy-agent");
      const topLevel = path.join(nodeModules, "proxy-agent");
      if (fs.existsSync(nested)) fs.rmSync(nested, { recursive: true, force: true });
      if (fs.existsSync(topLevel)) fs.rmSync(topLevel, { recursive: true, force: true });
      run(["install", "proxy-agent@6.5.0", `--registry=${reg}`, "--no-audit", "--no-fund"]);
    } catch {
      /* 补救失败就如实报告 */
    }
  }

  const after = probeLiepin(cliDir);
  return { ok: after.ok, msg: after.ok ? `更新完成：${after.text}` : "更新后 CLI 仍无法运行，需人工检查" };
}

// ---------- 对外主函数 ----------

/**
 * @param {{autoUpdate?:boolean, silent?:boolean, timeoutMs?:number}} opts
 * @returns {Promise<{status:'latest'|'outdated'|'updated'|'unknown'|'failed', installed?:string, latest?:string, msg?:string}>}
 */
async function checkCliUpdate(opts = {}) {
  const autoUpdate = opts.autoUpdate ?? process.env.LIEPIN_CLI_AUTOUPDATE !== "0";
  const log = (s) => {
    if (!opts.silent) console.error(s);
  };

  const cliDir = resolveCliDir();
  if (!cliDir) {
    log("[CLI 检查] 未找到已安装的 @viyzhu/liepin-cli，跳过版本检查（首次使用请先安装，见 SKILL.md 步骤1）");
    return { status: "unknown", msg: "未找到 CLI" };
  }

  const installed = readInstalledVersion(cliDir);
  const registry = process.env.LIEPIN_CLI_REGISTRY || DEFAULT_REGISTRY;

  let latest = null;
  try {
    latest = await fetchLatestVersion(registry);
  } catch (e) {
    try {
      latest = await fetchLatestVersion(FALLBACK_REGISTRY);
    } catch {
      log(`[CLI 检查] registry 不可达，跳过版本检查（不影响筛选）`);
      return { status: "unknown", installed, msg: "registry 不可达" };
    }
  }

  if (!latest) return { status: "unknown", installed, msg: "拿不到最新版本" };

  if (cmpVer(installed, latest) >= 0) {
    log(`[CLI 检查] liepin-cli 已是最新（v${installed}）`);
    return { status: "latest", installed, latest };
  }

  // 有新版本
  log(`\n⚠️  liepin-cli 有新版本：v${installed} → v${latest}`);

  if (!autoUpdate) {
    // 仅当 LIEPIN_CLI_AUTOUPDATE=0 应急关断时走到这里；默认必查必升
    log(`   （自动升级已被 LIEPIN_CLI_AUTOUPDATE=0 关断；移除该变量后重跑即自动升级）\n`);
    return { status: "outdated", installed, latest, msg: "自动升级被关断" };
  }

  log(`   正在自动更新…`);
  const r = doUpdate(cliDir, registry);
  log(r.ok ? `[CLI 检查] ✅ ${r.msg}` : `[CLI 检查] ❌ ${r.msg}`);
  return { status: r.ok ? "updated" : "failed", installed, latest, msg: r.msg };
}

module.exports = { checkCliUpdate, resolveCliDir, readInstalledVersion, cmpVer };

// ---------- CLI 入口 ----------
if (require.main === module) {
  // 默认检查并自动升级；--check-only 只查不升；应急关断 LIEPIN_CLI_AUTOUPDATE=0（直跑同样尊重 env）
  const autoUpdate =
    !process.argv.includes("--check-only") && process.env.LIEPIN_CLI_AUTOUPDATE !== "0";
  checkCliUpdate({ autoUpdate }).then((r) => {
    process.exit(r.status === "outdated" ? 10 : 0);
  });
}
