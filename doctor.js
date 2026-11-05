#!/usr/bin/env node
// doctor.js —— 环境自检自愈（v2.10.0，用户拍板「小白开 workbuddy 说岗位即开跑」闭环的最后一块）。
//
// 谁在什么时候跑：AI 会话（workbuddy/豆包/Claude Code 等）在**每个平台的首次招聘任务开工环节**
//（与背景档案确认同时）跑一次；AI-GUIDE「五」已钉死该契约。普通用户也可随时跑 node doctor.js。
//
// 做什么：分四组自检——critical（Node/exceljs）、liepin（liepin-cli）、boss（uv/boss-agent-cli/浏览器内核）、
// info（CDP 登录浏览器）。能自动修的当场修（npm install、pip/uv tool install、内核下载），修不了的
//（Node 缺失、需扫码）给小白可执行的指引。
//   退出码：0 = critical 就绪（平台组件缺口看输出/JSON 的分组状态）｜1 = critical 有缺口（必须先处理）。
//   AI 契约：确认「本次任务平台」的分组就绪再开跑；另一侧缺组件可忽略。
// 用法：node doctor.js [--json] [--skip-browsers]
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has("--json");
const SKIP_BROWSERS = ARGS.has("--skip-browsers");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

// ---------- 纯函数（单测覆盖：tests/doctor.test.js） ----------
/** Node 版本检查：'v24.13.1' → {ok: major≥22, major, detail} */
function checkNodeVersion(v) {
  const major = Number((String(v).match(/v?(\d+)\./) || [])[1] || 0);
  return { ok: major >= 22, major, detail: String(v) };
}

/** 汇总：{criticalReady, liepinReady, bossReady, userActions}（userActions=所有未就绪项的行动指引） */
function summarize(items) {
  const list = items || [];
  const grp = (g) => list.filter((i) => i.group === g);
  const userActions = list.filter((i) => !i.ok && !i.info && i.action).map((i) => `${i.item}：${i.action}`);
  return {
    criticalReady: grp("critical").every((i) => i.ok),
    liepinReady: grp("liepin").every((i) => i.ok),
    bossReady: grp("boss").every((i) => i.ok),
    userActions,
  };
}

// ---------- 工具 ----------
const items = [];
const say = (s) => { if (!JSON_OUT) console.log(s); };
const rec = (group, item, ok, { detail = "", action = "", fixed = false, info = false } = {}) => {
  items.push({ group, item, ok, detail, action, fixed, info });
  const tag = info ? "[信息]" : ok ? (fixed ? "[修好]" : "[OK]") : "[缺]";
  say(`  ${tag} ${item}${detail ? `：${detail}` : ""}${fixed ? "（本轮已自动修复）" : ""}${!ok && !info && action ? ` → ${action}` : ""}`);
};
const run = (cmd, a, timeoutMs = 300000) =>
  spawnSync(cmd, a, { encoding: "utf8", windowsHide: true, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
// ⚠️ Node 的 CVE-2024-27980 补丁后，Windows 上 spawn .cmd/.bat 必须 shell:true（直接 spawn 报 EINVAL，
//    本机实证 2026-10-30）。npm 走这里；参数无空格，仍统一加引号防注入。
const npmRun = (a, timeoutMs = 300000) =>
  spawnSync([NPM, ...a.map((x) => `"${x}"`)].join(" "), { encoding: "utf8", windowsHide: true, timeout: timeoutMs, shell: true, stdio: ["ignore", "pipe", "pipe"] });
const where = (cmd) => run("where", [cmd], 15000).status === 0;
const ROOT = __dirname;
const findBossBin = () => {
  for (const d of [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".local", "share", "uv", "tools", "boss-agent-cli", "Scripts")]) {
    for (const n of process.platform === "win32" ? ["boss.exe", "boss.cmd"] : ["boss"]) {
      if (fs.existsSync(path.join(d, n))) return path.join(d, n);
    }
  }
  return "";
};

console.log(JSON_OUT ? "" : "=== 简历筛选工具 · 环境自检（能自动装的会当场装）===");

// ---------- critical：Node ----------
const nv = checkNodeVersion(process.version);
rec("critical", "Node.js ≥22（取文需原生 WebSocket）", nv.ok,
  nv.ok ? { detail: nv.detail } : { detail: nv.detail, action: "到 https://nodejs.org 装 LTS 版（22 或更新），装好后重开 workbuddy 再说一次岗位" });

// ---------- critical：exceljs ----------
let excelOk = false;
try { require.resolve("exceljs", { paths: [ROOT] }); excelOk = true; } catch { /* 未装 */ }
const excelBefore = excelOk;
if (!excelOk) {
  say("  …自动安装 exceljs（npm，国内镜像优先，约 0.5-2 分钟）…");
  let r = npmRun(["install", "exceljs", "--registry=https://registry.npmmirror.com", "--no-audit", "--no-fund"]);
  if (r.status !== 0) r = npmRun(["install", "exceljs", "--no-audit", "--no-fund"]);
  if (r.status !== 0) say("  npm 输出尾部：" + String(r.stderr || r.stdout || "").slice(-300).trim());
  try { require.resolve("exceljs", { paths: [ROOT] }); excelOk = true; } catch { /* 仍失败 */ }
}
rec("critical", "exceljs（Excel 报告依赖）", excelOk,
  excelOk ? { fixed: !excelBefore } : { action: "自动安装失败——把上面的报错发给给你工具的人，或手动双击 setup.bat" });

// ---------- liepin 组：liepin-cli ----------
const liepinBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "liepin.cmd" : "liepin");
let liepinOk = fs.existsSync(liepinBin);
const liepinBefore = liepinOk;
if (!liepinOk) {
  say("  …自动安装 liepin-cli（npm，国内镜像优先）…");
  let r = npmRun(["install", "@viyzhu/liepin-cli", "--registry=https://registry.npmmirror.com", "--no-audit", "--no-fund"]);
  if (r.status !== 0) r = npmRun(["install", "@viyzhu/liepin-cli", "--no-audit", "--no-fund"]);
  if (r.status !== 0) say("  npm 输出尾部：" + String(r.stderr || r.stdout || "").slice(-300).trim());
  liepinOk = fs.existsSync(liepinBin);
}
rec("liepin", "liepin-cli（猎聘 CLI）", liepinOk,
  liepinOk ? { fixed: !liepinBefore } : { action: "本次用猎聘的话：重跑 node doctor.js 或双击 setup.bat；报错发管理员。不用猎聘可忽略" });

// ---------- boss 组：uv / boss-agent-cli / 浏览器内核 ----------
const pythonOk = where("python");
let uvOk = where("uv") || (pythonOk && run("python", ["-m", "uv", "--version"], 30000).status === 0);
const uvBefore = uvOk;
let bossOk = !!findBossBin() || where("boss");
const bossBefore = bossOk;
if ((!uvOk || !bossOk) && pythonOk) {
  if (!uvOk) {
    say("  …自动安装 uv（pip，清华镜像优先）…");
    let r = run("python", ["-m", "pip", "install", "uv", "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"]);
    if (r.status !== 0) r = run("python", ["-m", "pip", "install", "uv"]);
    uvOk = r.status === 0 || run("python", ["-m", "uv", "--version"], 30000).status === 0;
  }
  if (uvOk && !bossOk) {
    say("  …自动安装 boss-agent-cli（uv tool，清华镜像优先）…");
    let r = run("python", ["-m", "uv", "tool", "install", "boss-agent-cli", "--index-url", "https://pypi.tuna.tsinghua.edu.cn/simple"]);
    if (r.status !== 0) r = run("python", ["-m", "uv", "tool", "install", "boss-agent-cli"]);
    bossOk = !!findBossBin() || where("boss");
  }
}
rec("boss", "uv（BOSS CLI 与本机 OCR 的运行器）", uvOk,
  uvOk ? { fixed: !uvBefore } : { action: "本次用 BOSS 的话：先装 Python 3.10+（https://python.org）后重跑 node doctor.js 自动装。不用 BOSS 可忽略" });
rec("boss", "boss-agent-cli（BOSS CLI）", bossOk,
  bossOk ? { fixed: !bossBefore } : { action: "装好 Python/uv 后重跑 node doctor.js 自动装；报错发管理员。不用 BOSS 可忽略" });

if (!SKIP_BROWSERS) {
  const pwDir = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const hasKernel = () => { try { return fs.readdirSync(pwDir).some((x) => x.startsWith("chromium-")); } catch { return false; } };
  if (hasKernel()) {
    rec("boss", "BOSS 浏览器内核（chromium）", true, { detail: "已就绪" });
  } else if (bossOk) {
    say("  …下载 BOSS 浏览器内核（约 200MB，只需一次；网速慢可中断后用 --skip-browsers 跳过，首次跑 BOSS 会自动重试）…");
    run(process.execPath, [path.join(ROOT, "boss-resume-screener", "scripts", "check-cli-update.js"), "--install-browsers"], 600000);
    const okNow = hasKernel();
    rec("boss", "BOSS 浏览器内核（chromium）", okNow,
      okNow ? { fixed: true } : { action: "下载失败（网络问题）——首次跑 BOSS 时会自动重试，或把报错发管理员" });
  } else {
    rec("boss", "BOSS 浏览器内核（chromium）", false, { action: "BOSS CLI 就绪后重跑 node doctor.js 会自动下载" });
  }
}

// ---------- 汇总（CDP 探测放最后，纯信息） ----------
(async () => {
  for (const [name, port] of [["Edge (9333)", 9333], ["Chrome (9222)", 9222]]) {
    let on = false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      on = res.ok;
    } catch { /* 未开 */ }
    rec("info", `登录浏览器 ${name} ${on ? "已开" : "未开"}`, on,
      on ? { info: true } : { info: false, action: "跑 BOSS 前双击 boss-edge-login.bat（Edge）或 boss-zhipin-login.bat（Chrome）扫码并保持窗口开着——登录本来就要人工扫一次" });
  }

  const s = summarize(items);
  say("");
  if (s.criticalReady) {
    say(`✅ 基础环境就绪（Node/exceljs）。平台组件：猎聘 ${s.liepinReady ? "✅" : "❌"} · BOSS ${s.bossReady ? "✅" : "❌"}——本次任务用哪侧，哪侧必须 ✅。`);
  } else {
    say("❌ 基础环境有缺口，先按下面指引处理，处理完重跑 node doctor.js：");
    s.userActions.forEach((a) => say(`  - ${a}`));
  }
  if (JSON_OUT) console.log("DOCTOR_JSON " + JSON.stringify({ criticalReady: s.criticalReady, liepinReady: s.liepinReady, bossReady: s.bossReady, userActions: s.userActions, items }));
  process.exit(s.criticalReady ? 0 : 1);
})();

module.exports = { checkNodeVersion, summarize };
