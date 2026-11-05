#!/usr/bin/env node
/**
 * run.js —— 猎聘 + BOSS直聘 统一双击入口（编排器）
 *
 * 用法：
 *   run.bat                      交互菜单：选平台 → 选岗位 → 概览确认
 *   run.bat liepin               直接指定平台（liepin | boss | all）
 *   run.bat boss 销售经理         平台 + 岗位画像名（模糊匹配 profiles/ 下的文件）
 *
 * 可选旗标：
 *   --city=上海     只跑指定城市（覆盖画像的 city/cities）
 *   --limit 20      单轮最多查看 20 份简历（RESUME_LIMIT）
 *   --kw 1,3        只跑第 1、3 组搜索关键词（KW_GROUPS）
 *   --dup           允许重复推荐（SCREENER_ALLOW_DUPLICATES=1，同一个人会再次进报告）
 *   --report-only   不搜索，只基于本地缓存重算并出报告（rescore + report）
 *   --setup-user    重新填写用户背景档案 profiles/_user.json（首次运行会自动引导）
 *   --setup-greet  重新设置 BOSS 自动打招呼（首次跑 BOSS 会自动问：是否开启 + 话术来源；随时可关）
 *   --greet-dry   打招呼只演练不发送（打印名单与话术，零网络）——试水用
 *   --greet-only <id> 只给指定候选人打招呼（配合单人真机试水）
 *   --from-published [岗位名]  读取平台上已发布的在招岗位：不带名=只列出；带名=匹配并生成画像草稿（不自动跑）
 *   --anytime       越过工作时间窗口（默认 8:00–20:00，可用 profiles/_user.json 的 settings.workingWindow 修改）
 *   --dry-run       只打印将执行的命令与环境，不真跑
 *
 * 设计：
 *  - 本脚本只 spawn 各 skill 的 scripts/*.js 子进程，不 require skill 内模块
 *    （skill 包保持自包含，可单独复制到 ~/.workbuddy/skills/ 使用）。
 *  - 数据目录：data/<岗位名>/<平台>/（每岗位每平台互不污染，去重索引也在其中）。
 *  - 报告统一落到项目根 reports/（通过 SCREENER_REPORTS_DIR 传给 report.js）。
 *  - 登录必须由用户双击对应登录 .bat 完成（扫码），本脚本只探测并提示，绝不代起浏览器。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const readline = require("readline");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const PLATFORMS = {
  liepin: { label: "猎聘", skillDir: path.join(ROOT, "liepin-resume-screener"), defaultMaxResumesPerRun: 30 },
  boss: { label: "BOSS直聘", skillDir: path.join(ROOT, "boss-resume-screener"), defaultMaxResumesPerRun: 20 },
};
const CITY_GAP_SEC = 300; // 多城市之间的休整（秒），降低连续操作节奏

// ---- 全局浏览配额（只读记账；⚠️ 与两侧 skill 的 scripts/quota-global.js 镜像，改 schema 需三处同步）----
const GLOBAL_QUOTA_DIR = () => process.env.SCREENER_GLOBAL_QUOTA_DIR || path.join(ROOT, "data", "_quota");
function globalCapFor() {
  const v = Number(process.env.SCREENER_GLOBAL_DAILY_VIEWS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1000;
}
function readGlobalViews(plat, dir) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(dir, `${plat}.json`), "utf8"));
    if (q && typeof q === "object" && q.date === new Date().toISOString().slice(0, 10)) {
      return {
        resumeViews: Number(q.resumeViews) || 0,
        perJob: q.perJob && typeof q.perJob === "object" ? q.perJob : {},
      };
    }
  } catch { /* 缺失/损坏/跨天 → 视为 0 */ }
  return { resumeViews: 0, perJob: {} };
}

// ---- 工作时间窗口 ----
// ⚠️ 以下三个函数与两侧 skill 的 scripts/working-window.js 逐字镜像（三处镜像，改必同步）。
// 优先级：env SCREENER_WORKING_WINDOW > profiles/_user.json 的 settings.workingWindow > 默认 08:00–20:00。
const WW_DEFAULT = ["08:00", "20:00"];
function wwParseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { total: h * 60 + min, text: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` };
}
function wwParse(spec) {
  let a = null;
  let b = null;
  if (Array.isArray(spec) && spec.length === 2) { a = spec[0]; b = spec[1]; }
  else if (typeof spec === "string" && spec.includes("-")) { const p = spec.split("-"); a = p[0]; b = p[1]; }
  else return null;
  const sa = wwParseHHMM(a);
  const sb = wwParseHHMM(b);
  if (!sa || !sb || sa.total === sb.total) return null;
  return { start: sa.text, end: sb.text, startMin: sa.total, endMin: sb.total, wraps: sa.total > sb.total };
}
function loadWorkingWindow() {
  let win = { start: WW_DEFAULT[0], end: WW_DEFAULT[1], startMin: 8 * 60, endMin: 20 * 60, wraps: false };
  try {
    const uc = JSON.parse(fs.readFileSync(path.join(ROOT, "profiles", "_user.json"), "utf8"));
    const spec = uc && uc.settings && uc.settings.workingWindow;
    const p = spec ? wwParse(spec) : null;
    if (spec && !p) console.log(`[窗口] _user.json 的 settings.workingWindow 非法（${JSON.stringify(spec)}），回落默认 ${WW_DEFAULT.join("–")}`);
    if (p) win = p;
  } catch { /* 无档案/坏 JSON → 默认 */ }
  const pe = process.env.SCREENER_WORKING_WINDOW ? wwParse(process.env.SCREENER_WORKING_WINDOW) : null;
  if (process.env.SCREENER_WORKING_WINDOW && !pe) console.log("[窗口] SCREENER_WORKING_WINDOW 非法，忽略");
  if (pe) win = pe;
  return win;
}
function withinWindowNow(win) {
  const t = new Date();
  const m = t.getHours() * 60 + t.getMinutes();
  return win.wraps ? m >= win.startMin || m < win.endMin : m >= win.startMin && m < win.endMin;
}
function wwNextOpen(win) {
  const t = new Date();
  const m = t.getHours() * 60 + t.getMinutes();
  return m < win.startMin ? `今天 ${win.start}` : `明天 ${win.start}`;
}
function nowHHMM() {
  const t = new Date();
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

// ---------- 小工具 ----------
const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));
const sanitize = (s) => String(s).replace(/[\\/:*?"<>|]/g, "-").trim() || "default";

/** 探测本机端口是否有服务在听（用于 CDP 登录窗口探测） */
function probePort(port, host = "127.0.0.1", timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function parseArgs(argv) {
  const opts = { platforms: null, profileArg: null, city: null, limit: null, kw: null, dup: false, reportOnly: false, dryRun: false, setupUser: false, setupGreet: false, greetDry: false, greetOnly: null, anytime: false, fromPublished: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dup") opts.dup = true;
    else if (a === "--report-only") opts.reportOnly = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--setup-user") opts.setupUser = true;
    else if (a === "--setup-greet") opts.setupGreet = true;
    else if (a === "--greet-dry") opts.greetDry = true;
    else if (a === "--greet-only") opts.greetOnly = argv[++i];
    else if (a === "--anytime") opts.anytime = true;
    else if (a === "--from-published") opts.fromPublished = true;
    else if (a.startsWith("--city=")) opts.city = a.slice(7);
    else if (a === "--city") opts.city = argv[++i];
    else if (a === "--limit") opts.limit = argv[++i];
    else if (a === "--kw") opts.kw = argv[++i];
    else if (a === "liepin" || a === "boss") opts.platforms = [a];
    else if (a === "all") opts.platforms = ["liepin", "boss"];
    else if (!a.startsWith("--")) opts.profileArg = a;
  }
  return opts;
}

// ---------- 交互菜单 ----------
async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// ---------- 用户背景档案（profiles/_user.json）----------
const USER_CONTEXT_PATH = path.join(ROOT, "profiles", "_user.json");

function loadUserContextFile() {
  try { return JSON.parse(fs.readFileSync(USER_CONTEXT_PATH, "utf8")); } catch { return null; }
}

// businessSummary 的「补充」并入规则（与 AI-GUIDE.md 第二节同口径，不新增档案字段）：
// 存储形态 = "<一句话业务方向>" 或 "<方向>；补充：<自由基内容>"（方向为空则 "补充：<内容>"）。
// 重引导先拆旧补充再合并，避免「；补充：」越叠越长；被替换的旧值整体进 history 保史。
const SUPP_SEP = "；补充：";
function splitBusinessSummary(s) {
  const str = String(s || "");
  const i = str.indexOf(SUPP_SEP);
  if (i !== -1) return { base: str.slice(0, i), supp: str.slice(i + SUPP_SEP.length) };
  if (str.startsWith("补充：")) return { base: "", supp: str.slice(3) };
  return { base: str, supp: "" };
}
function joinBusinessSummary(base, supp) {
  const b = String(base || "").trim();
  const s = String(supp || "").trim();
  if (!s) return b;
  return b ? `${b}${SUPP_SEP}${s}` : `补充：${s}`;
}

// 首次运行自动引导（可全跳过）；--setup-user 随时重新引导（预填现值，回车=保留）。
// 写入前把被覆盖的旧值追加进 history（脚本路径不经过 AI 契约，必须自己保史）。
// 末尾可选补充问的回答以「；补充：…」并入 businessSummary（不新增字段，见 splitBusinessSummary）。
async function maybeSetupUser(opts) {
  const exists = fs.existsSync(USER_CONTEXT_PATH);
  const wantSetup = opts.setupUser || (!exists && !opts.dryRun);
  if (!wantSetup) {
    if (!exists && !opts.dryRun) console.log("[提示] 未配置用户背景（公司/行业），可运行 run.bat --setup-user 生成；跳过不影响使用。");
    return;
  }
  if (!process.stdin.isTTY) {
    console.log("[提示] 当前不是交互终端，无法引导填写。请双击 run.bat 或运行 run.bat --setup-user。");
    if (opts.setupUser) process.exit(1); // 显式要求引导但无法交互，明确失败
    return;
  }
  const cur = exists ? (loadUserContextFile() || {}) : {};
  console.log("\n========== 用户背景档案 ==========");
  console.log(exists ? "以下问题直接回车 = 保留当前值（括号内为现值）：" : "第一次使用，先认识一下（都可直接回车跳过）：");
  const hint = (v) => (v ? `（${v}）` : "");
  const a1 = await ask(`1/4 公司/项目名，用于报告与打招呼话术自称${hint(cur.companyName)}：`);
  const a2 = await ask(`2/4 所属行业，如 跨境电商/制造业/SaaS${hint(cur.industry)}：`);
  const a3 = await ask(`3/4 用一句话介绍业务方向（帮 AI 理解你的招聘语境）${hint(cur.businessSummary)}：`);
  const a4 = await ask(`4/4 常用招聘城市，多个用顿号分隔${hint(Array.isArray(cur.commonCities) && cur.commonCities.length ? cur.commonCities.join("、") : "")}：`);
  const a5 = await ask(`补充（可选，回车跳过）：还想补充什么背景吗？如主要产品、目标客户、招聘偏好：`);
  // 简历评估方式偏好（v2.6.0）：快速=规则引擎（免费/快/颗粒度粗）、精细=AI 会话逐份读工作内容打分（耗模型积分/token）。
  // 只是偏好信号（AI 会话据此在筛选后主动发起精细评估），不配任何模型 API；随时可自然语言切换。
  const curPref = (cur.settings && cur.settings.scoringPreference) || "";
  const a6 = await ask(
    `简历评估方式：1. 快速（默认——免费、速度快，关键词匹配，颗粒度较粗）  2. 精细（AI 逐份读简历工作内容打分，更准并附匹配依据，消耗模型积分/token）${curPref ? `（现值：${curPref === "detailed" ? "2 精细" : "1 快速"}）` : ""}：`
  );
  const pref = a6 === "2" ? "detailed" : a6 === "1" ? "fast" : curPref || "fast";

  const oldSum = splitBusinessSummary(cur.businessSummary);
  // 重答第 3 问 → 旧补充随之作废（旧完整值已进 history）；跳过第 3 问 → 保留旧补充，除非本次给了新补充
  const next = {
    companyName: a1 || cur.companyName || "",
    industry: a2 || cur.industry || "",
    businessSummary: joinBusinessSummary(a3 || oldSum.base, a5 || (a3 ? "" : oldSum.supp)),
    commonCities: a4 ? a4.split(/[、,，;；\s]+/).map((s) => s.trim()).filter(Boolean) : (cur.commonCities || []),
  };
  // v2.3.2：全部留空也写"空档案"文件——screener 的档案门槛看文件存在性，纯双击用户不能被门槛卡死
  const allSkip = !next.companyName && !next.industry && !next.businessSummary && !(next.commonCities || []).length;
  const history = Array.isArray(cur.history) ? cur.history : [];
  const hadOld = cur.companyName || cur.industry || cur.businessSummary || (Array.isArray(cur.commonCities) && cur.commonCities.length);
  if (hadOld) {
    history.push({
      companyName: cur.companyName || "",
      industry: cur.industry || "",
      businessSummary: cur.businessSummary || "",
      commonCities: Array.isArray(cur.commonCities) ? cur.commonCities : [],
      changedAt: new Date().toISOString(),
    });
  }
  const out = {
    _说明: allSkip
      ? "用户背景档案（空：用户在引导中选择全部跳过，不再追问）。想补随时运行 run.bat --setup-user；岗位画像字段优先于本档案。"
      : "用户背景档案（run.bat 首次引导或 AI 会话生成）。删除本文件后下次运行 run.bat 会重新引导；岗位画像字段优先于本档案。",
    ...next,
    commonCities: next.commonCities,
    // 保留既有 settings（如 workingWindow 工作时间窗口）——重引导不得静默抹掉全局设置；
    // scoringPreference 为本次引导的评估方式偏好（v2.6.0，回车=保留现值/默认快速）
    settings: {
      ...(cur.settings && typeof cur.settings === "object" ? cur.settings : {}),
      scoringPreference: pref,
    },
    updatedAt: new Date().toISOString(),
    history,
  };
  fs.mkdirSync(path.dirname(USER_CONTEXT_PATH), { recursive: true });
  fs.writeFileSync(USER_CONTEXT_PATH, JSON.stringify(out, null, 2));
  if (allSkip) console.log(`全部留空，已保存空档案到 ${path.relative(ROOT, USER_CONTEXT_PATH)}（不再追问；想补随时 run.bat --setup-user）。`);
  else console.log(`已保存到 ${path.relative(ROOT, USER_CONTEXT_PATH)}（想改：记事本编辑它，或运行 run.bat --setup-user 重新引导）。`);
  if (a5) console.log("已把补充内容并入「业务方向」字段（businessSummary，不新增字段）。");
  console.log(`简历评估方式：${pref === "detailed" ? "精细（AI 会话在筛选后自动发起逐份评估，消耗模型积分/token）" : "快速（规则引擎，免费）"}——想换随时对 AI 说「换成精细/快速评估」。`);
  console.log("岗位画像里写 project/greetTemplate 可覆盖本档案（多公司/多项目场景）。");
}

// ---------- BOSS 自动打招呼设置（v2.7.0，settings.greet；首跑 BOSS 时问一次，--setup-greet 随时重问）----------
// 机器强制的另一半在 greet.js：settings.greet.enabled 非 true 且无 BOSS_GREET=1 → exit 5 拒发。
function readGreetSettings() {
  const uc = loadUserContextFile();
  const g = uc && uc.settings && uc.settings.greet;
  return g && typeof g === "object" ? g : null;
}

function writeUserSetting(key, value) {
  const cur = loadUserContextFile() || {};
  const out = {
    ...cur,
    settings: {
      ...(cur.settings && typeof cur.settings === "object" ? cur.settings : {}),
      [key]: value,
    },
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(USER_CONTEXT_PATH), { recursive: true });
  fs.writeFileSync(USER_CONTEXT_PATH, JSON.stringify(out, null, 2));
}

function writeGreetSettings(greet) {
  writeUserSetting("greet", { ...greet, updatedAt: new Date().toISOString() });
}

// v2.8.2：BOSS 简历来源偏好（settings.bossSource = "reco" | "both" | "search"）。
// 首跑 BOSS 问一次（含成本提示），--setup-greet 顺带重问；env BOSS_SOURCE 显式指定时不问（接管）。
function bossSourceLabel(v) {
  return v === "both" ? "推荐 + 搜索（搜索来源打招呼需付费「搜索畅聊卡」）"
    : v === "search" ? "仅搜索（打招呼需付费「搜索畅聊卡」）"
    : "仅推荐牛人（打招呼免费）";
}
async function maybeSetupBossSource(opts) {
  if (opts.dryRun || opts.reportOnly) return;
  if (process.env.BOSS_SOURCE) return; // env 显式接管，不问
  const cur = loadUserContextFile() || {};
  const s = (cur.settings && cur.settings.bossSource) || "";
  if (s && !opts.setupGreet) return; // 已问过（无效值也当问过，按默认 reco 跑）；--setup-greet 顺带重问
  if (!process.stdin.isTTY) {
    if (!s) console.log('[来源] BOSS 简历来源未配置，先按默认「仅推荐」跑。三选项（AI 引用请逐字，成本已写在选项文字里）：① 仅推荐牛人（打招呼免费）② 推荐+搜索（搜索来源打招呼需消耗「搜索畅聊卡」，按人头扣 1–5 次、约 ¥10+/人）③ 仅搜索（打招呼需消耗「搜索畅聊卡」）。想改：run.bat --setup-greet 或对 AI 说「来源改成推荐+搜索」。');
    return;
  }
  console.log("\n========== BOSS 简历来源 ==========");
  if (opts.setupGreet && s) {
    console.log(`当前设置：${bossSourceLabel(s)}（直接回车 = 保留）`);
  }
  console.log("1. 仅推荐牛人（打招呼免费）");
  console.log("2. 推荐+搜索（搜索来源打招呼需消耗「搜索畅聊卡」，按人头扣 1–5 次、约 ¥10+/人）");
  console.log("3. 仅搜索（打招呼需消耗「搜索畅聊卡」）");
  const a = await ask(`选 1/2/3${opts.setupGreet && s ? "（回车保留现值）" : "（回车 = 1 仅推荐）"}：`);
  const val = a === "2" ? "both" : a === "3" ? "search" : a === "1" ? "reco" : (["reco", "both", "search"].includes(s) ? s : "reco");
  writeUserSetting("bossSource", val);
  console.log(`简历来源已设为：${bossSourceLabel(val)}。随时 run.bat --setup-greet 修改。`);
}

// 只读今日已打招呼数（greet-ledger.js 的 run.js 侧轻量镜像；全局目录与配额同款）
function readGreetSent(dir) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(dir, "boss-greet.json"), "utf8"));
    if (q && typeof q === "object" && q.date === new Date().toISOString().slice(0, 10)) return Number(q.sentToday) || 0;
  } catch { /* 缺失/损坏/跨天 → 视为 0 */ }
  return 0;
}

// 固定话术草稿（用户 2026-10-28 拍板：预填占位符模板，可改可从零写）
const GREET_FIXED_DRAFT = "您好，看到您有{dim1}方面的{dim2}经验。我们是{company}，正在招聘相关岗位，想和您进一步沟通，期待您的回复。";

async function maybeSetupGreet(opts) {
  if (opts.dryRun || opts.reportOnly) return;
  if (process.env.BOSS_GREET === "0" || process.env.BOSS_GREET === "1") return; // env 显式接管时不问
  const cur = readGreetSettings();
  const asked = cur && typeof cur.enabled === "boolean";
  if (asked && !opts.setupGreet) return; // 已问过（含拒绝）不再追问；--setup-greet 强制重问
  if (!process.stdin.isTTY) {
    if (!asked) console.log("[greet] 打招呼未配置且当前非交互终端，本轮跳过（双击 run.bat 跑 BOSS 时会问，或 run.bat --setup-greet；AI 会话按 AI-GUIDE 契约问用户后写入）。");
    return;
  }
  console.log("\n========== BOSS 自动打招呼 ==========");
  if (opts.setupGreet && asked) {
    console.log(`当前设置：${cur.enabled ? "已开启" : "已关闭"} · 话术：${cur.mode === "fixed" ? "固定话术" : "按岗位建议话术"}（直接回车 = 保留）`);
  } else {
    console.log("筛选完成后，对 S/A 级候选人自动发送首条招呼（话术 = 报告最后一列「建议打招呼话术」）。");
    console.log("注意：这是主动触达——消耗平台打招呼额度、每天本地硬顶 20 条、同一人全局只发一次；自动化操作有账号风控风险。");
    console.log("不开启则保持纯只读筛选（报告照常，联系谁仍由你手动决定）。");
  }
  const a1 = await ask(`1/2 开启自动打招呼？(y 开启 / n 不开启${opts.setupGreet && asked ? " / 回车 保留现值" : " / 回车 不开启"})：`);
  let enabled;
  if (!a1 && opts.setupGreet && asked) enabled = cur.enabled;
  else enabled = /^y/i.test(a1);
  if (!enabled) {
    writeGreetSettings({ enabled: false, mode: (cur && cur.mode) || "job", fixedText: (cur && cur.fixedText) || "", askedAt: (cur && cur.askedAt) || new Date().toISOString() });
    console.log("已选择不开启：之后 BOSS 保持只读筛选，不再追问（想开随时 run.bat --setup-greet）。");
    return;
  }
  const curMode = (cur && cur.mode) || "job";
  const a2 = await ask(`2/2 话术来源：1. 按岗位建议话术（报告「建议打招呼话术」列的模板，各岗位画像可不同，未配用内置默认）  2. 固定话术（你自己写一段，所有岗位通用）（现值：${curMode === "fixed" ? "2 固定话术" : "1 按岗位建议话术"}）：`);
  const mode = a2 === "2" ? "fixed" : a2 === "1" ? "job" : curMode;
  let fixedText = (cur && cur.fixedText) || "";
  if (mode === "fixed") {
    console.log(`\n固定话术${fixedText ? "（现值）" : "草稿（可带占位符 {dim1}{dim2}{company}，按每位候选人自动填充）"}：\n  ${fixedText || GREET_FIXED_DRAFT}`);
    const a3 = await ask(fixedText ? "直接回车保留现值，或输入新话术替换（可从零写，100 字内为宜，勿带链接/联系方式）：" : "直接回车用这段草稿，或输入你自己的话术（可从零写，100 字内为宜，勿带链接/联系方式）：");
    if (a3) fixedText = a3;
    else if (!fixedText) fixedText = GREET_FIXED_DRAFT;
  }
  writeGreetSettings({ enabled: true, mode, fixedText, askedAt: (cur && cur.askedAt) || new Date().toISOString() });
  console.log(`已开启自动打招呼（话术：${mode === "fixed" ? "固定话术" : "按岗位建议话术"}）。已保存到 profiles/_user.json 的 settings.greet；随时 run.bat --setup-greet 修改或关闭。`);
}

async function menuPlatform() {
  console.log("\n选择平台：");
  console.log("  1. 猎聘");
  console.log("  2. BOSS直聘");
  console.log("  3. 两个都跑");
  const a = await ask("输入数字后回车（默认 1）：");
  if (a === "2") return ["boss"];
  if (a === "3") return ["liepin", "boss"];
  return ["liepin"];
}

function listProfiles() {
  const dir = path.join(ROOT, "profiles");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
}

function matchProfile(files, arg) {
  if (!arg) return null;
  const withExt = arg.endsWith(".json") ? arg : `${arg}.json`;
  const exact = files.find((f) => f === withExt || f === arg);
  if (exact) return path.join(ROOT, "profiles", exact);
  const hits = files.filter((f) => f.includes(arg));
  if (hits.length === 1) return path.join(ROOT, "profiles", hits[0]);
  if (hits.length > 1) {
    console.error(`[错误] "${arg}" 匹配到多个画像：${hits.join("、")}，请写全名。`);
    process.exit(1);
  }
  return null;
}

async function menuProfile(files, opts, WIN) {
  if (!files.length) {
    console.log("\nprofiles/ 下还没有岗位画像：可输入 0 从已发布岗位新建，或复制 profiles/_template.json 手填（参考 example-销售经理.json）。");
  } else {
    console.log("\n选择岗位画像（profiles/）：");
    files.forEach((f, i) => console.log(`  ${i + 1}. ${f.replace(/\.json$/, "")}`));
  }
  console.log("  0. 从已发布岗位新建（读取平台上已发布的在招岗位）");
  const a = await ask(`输入序号（默认 1）：`);
  if (a === "0") {
    const p = await createProfileFromPublished(opts, WIN);
    if (p) return p;
    return menuProfile(listProfiles(), opts, WIN); // 重新列出（可能刚生成了新画像；失败则再试/手填）
  }
  if (!files.length) {
    console.error("[错误] 没有可选画像。请复制 profiles/_template.json 改名填写，或运行 run.bat <平台> --from-published 查看在招岗位。");
    process.exit(1);
  }
  const idx = Math.max(1, Math.min(files.length, parseInt(a, 10) || 1));
  return path.join(ROOT, "profiles", files[idx - 1]);
}

// ---------- 已发布岗位直连 ----------
// 调 skill 的 joblist.js（spawn，不 require skill 模块）；单次请求捕获 stdout，列表由本函数渲染。
// v2.9.4：从可能带噪音前缀（[CLI 检查]/[内核检查] 等提示行）的 stdout 里解析 JSON 载荷。
// 旧实现取「末行」——对多行 pretty-print JSON 只会拿到 "]"，「从已发布岗位新建」路径实际是坏的
// （joblist --json 为多行输出，2026-10-30 实证）。顺序：整段直解 → 从首个 JSON 起始符切出再解 → 末行兜底 → null。
function parseJobsPayload(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 前面有噪音行 */ }
  const starts = ["[\n", "{\n"].map((p) => s.indexOf(p)).filter((i) => i >= 0);
  if (starts.length) {
    try { return JSON.parse(s.slice(Math.min(...starts))); } catch { /* 继续兜底 */ }
  }
  const last = s.split("\n").filter(Boolean).pop();
  try { return JSON.parse(last); } catch { return null; }
}

function runJoblistJson(plat) {
  const P = PLATFORMS[plat];
  const dataRoot = path.join(ROOT, "data", "_joblist", plat);
  const r = spawnSync(process.execPath, [path.join(P.skillDir, "scripts", "joblist.js"), "--json"], {
    env: { ...process.env, SCREENER_DATA_DIR: dataRoot },
    encoding: "utf8",
    timeout: 120000,
  });
  return { status: r.status ?? 1, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

function buildDraftProfile(job) {
  let commonCities = [];
  try {
    const uc = JSON.parse(fs.readFileSync(path.join(ROOT, "profiles", "_user.json"), "utf8"));
    if (Array.isArray(uc.commonCities)) commonCities = uc.commonCities.map(String);
  } catch { /* 无档案 → 空数组 */ }
  return {
    _说明: `本画像由已发布岗位直连生成（${new Date().toISOString().slice(0, 10)}，来源 ${job.source}）。打分与关键词为内置默认（偏销售类），建议让 AI 按岗位要求定制：对它说「按 profiles/<本文件> 的岗位帮我定制打分模型」。`,
    jobTitle: job.name,
    city: job.city || commonCities[0] || "北京",
    keywordGroups: [{ name: "组1-职能", kw: job.name }],
    greetTemplate: `您好，看到您有{dim1}方面的{dim2}经验。我们是{company}，正在招聘${job.name}，想和您进一步沟通，方便的话期待您的回复。`,
  };
}

// 交互版：菜单 0 入口 → 列岗位让挑 → 生成草稿 → 回车继续跑 / q 只保存
async function createProfileFromPublished(opts, WIN) {
  if (!process.stdin.isTTY) {
    console.log("[提示] 从已发布岗位新建需要交互终端。非交互可用：run.bat <平台> --from-published <岗位名>。");
    return null;
  }
  console.log("\n从哪个平台读取已发布岗位？  1. 猎聘   2. BOSS直聘");
  const pa = await ask("输入数字（默认 1）：");
  const plat = pa === "2" ? "boss" : "liepin";
  const P = PLATFORMS[plat];
  // joblist 是对平台的请求 → 受工作时间窗口约束
  if (!opts.anytime && !withinWindowNow(WIN)) {
    console.log(`[窗口] 当前在 ${WIN.start}–${WIN.end} 之外，不读取岗位列表（--anytime 可越过）。`);
    return null;
  }
  console.log(`\n正在读取 ${P.label} 已发布岗位…`);
  const r = runJoblistJson(plat);
  if (r.status === 2) { console.log(`[提示] ${P.label}登录态失效，请先双击对应登录 .bat 扫码并保持窗口开着，再回来重试。`); return null; }
  if (r.status === 3) { console.log("[提示] 触发风控/请求配额上限，休息后再试。"); return null; }
  let jobs = null;
  if (r.status === 0) { try { jobs = parseJobsPayload(r.stdout); } catch {} }
  if (r.status === 5 || !Array.isArray(jobs)) {
    console.log(`[提示] 没读到在招岗位（可能没有已发布岗位，或输出格式未适配，exit=${r.status}）。`);
    console.log("       可以复制 profiles/_template.json 手填，或在 AI 对话里描述岗位要求让 AI 生成。");
    return null;
  }
  if (!jobs.length) { console.log(`[提示] ${P.label}后台没有发布中的岗位。先去后台发一个岗位，或走手填/描述流程。`); return null; }
  console.log(`\n${P.label}在招岗位 ${jobs.length} 个：`);
  jobs.forEach((j, i) => console.log(`  ${i + 1}. ${j.name}${j.city ? " · " + j.city : ""}${j.salary ? " · " + j.salary : ""}`));
  const pick = await ask("选择哪个岗位生成画像（输入序号，默认 1）：");
  const idx = Math.max(1, Math.min(jobs.length, parseInt(pick, 10) || 1));
  const job = jobs[idx - 1];

  const base = sanitize(job.name);
  let fileName = `${base}.json`;
  if (fs.existsSync(path.join(ROOT, "profiles", fileName))) {
    const ow = await ask(`画像 ${fileName} 已存在。回车=不覆盖另存 ${base}-2.json，输入 y=覆盖：`);
    if (ow.toLowerCase() !== "y") fileName = `${base}-2.json`;
  }
  fs.mkdirSync(path.join(ROOT, "profiles"), { recursive: true });
  const filePath = path.join(ROOT, "profiles", fileName);
  fs.writeFileSync(filePath, JSON.stringify(buildDraftProfile(job), null, 2) + "\n");

  console.log(`\n已保存画像草稿：profiles/${fileName}`);
  console.log(`  岗位：${job.name}${job.city ? " · " + job.city : ""}　公司自称用 {company} 占位符（读 _user.json）`);
  console.log(`  打分：内置默认（偏销售类）——建议之后让 AI 定制（对它说：按 profiles/${fileName} 的岗位帮我定制打分模型）`);
  const go = await ask("回车=用这个画像继续跑；输入 q=只保存并返回菜单：");
  if (go.toLowerCase() === "q") return null;
  return filePath;
}

// 非交互版 --from-published：不带名=列表；带名=匹配生成草稿后停止（不自动跑：默认打分对非销售岗失真，无确认环节不烧配额）
async function fromPublishedNonInteractive(opts, WIN) {
  const plat = opts.platforms && opts.platforms[0];
  if (!plat) {
    console.error("[错误] --from-published 需要指定平台：run.bat liepin --from-published [岗位名]");
    return 1;
  }
  if (!opts.anytime && !withinWindowNow(WIN)) {
    console.error(`[窗口] 当前在工作时间窗口 ${WIN.start}–${WIN.end} 之外，不读取岗位列表（--anytime 可越过）。`);
    return 1;
  }
  const P = PLATFORMS[plat];
  console.log(`正在读取 ${P.label} 已发布岗位…`);
  const r = runJoblistJson(plat);
  if (r.status !== 0) {
    console.error(r.stderr.trim() || `读取失败（exit ${r.status}；2=登录失效、3=风控、5=格式未适配）`);
    return r.status >= 2 && r.status <= 5 ? r.status : 1;
  }
  let jobs = null;
  try { jobs = parseJobsPayload(r.stdout); } catch {}
  if (!Array.isArray(jobs)) { console.error("岗位列表解析失败（--json 输出异常）。"); return 1; }
  if (!jobs.length) { console.log(`${P.label}后台没有发布中的岗位。`); return 0; }
  console.log(`${P.label}在招岗位 ${jobs.length} 个：`);
  jobs.forEach((j, i) => console.log(`  ${i + 1}. ${j.name}${j.city ? " · " + j.city : ""}${j.salary ? " · " + j.salary : ""}`));

  if (!opts.profileArg) {
    console.log(`\n交互新建：双击 run.bat 选 0；或指定岗位名直接生成：run.bat ${plat} --from-published <岗位名>`);
    return 0;
  }
  // 匹配：精确 → 唯一子串（与 matchProfile 同款规则）
  let hit = jobs.find((j) => j.name === opts.profileArg);
  if (!hit) {
    const subs = jobs.filter((j) => j.name.includes(opts.profileArg));
    if (subs.length === 1) hit = subs[0];
    else {
      console.error(`"${opts.profileArg}" ${subs.length ? "匹配到多个岗位（见上表）" : "没有匹配到在招岗位"}；请用完整名称重试。`);
      return 1;
    }
  }
  const base = sanitize(hit.name);
  const filePath = path.join(ROOT, "profiles", `${base}.json`);
  if (fs.existsSync(filePath)) {
    console.error(`画像 ${base}.json 已存在，非交互模式不覆盖。请删除/改名后重试。`);
    return 1;
  }
  fs.mkdirSync(path.join(ROOT, "profiles"), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(buildDraftProfile(hit), null, 2) + "\n");
  console.log(`\n已保存画像草稿：profiles/${base}.json`);
  console.log(`  岗位：${hit.name}${hit.city ? " · " + hit.city : ""}；打分为内置默认，建议让 AI 定制。`);
  console.log(`下一步运行：run.bat ${plat} ${base}`);
  return 0;
}

// ---------- 平台自检 ----------
async function selfCheckLiepin(dryRun) {
  const ok = dryRun ? true : await probePort(53471);
  if (!ok) {
    console.log("  [提示] 未探测到猎聘登录浏览器（端口 53471）。");
    console.log("         建议先双击 liepin-login.bat 扫码登录，并保持窗口开着。");
    console.log("         （仍继续尝试，screener 会自行做登录预检）");
  } else {
    console.log("  [OK] 猎聘登录浏览器在位（端口 53471）");
  }
  const localCli = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "liepin.cmd" : "liepin");
  if (fs.existsSync(localCli)) console.log("  [OK] liepin-cli 已安装（项目内）");
  else console.log("  [提示] 项目内未找到 liepin-cli，若未跑过 setup.bat 请先跑一次。");
}

async function selfCheckBoss(dryRun) {
  // 1) CDP 登录窗口探测：9333（Edge）→ 9222（Chrome）
  //    （2026-10-27 交接 R-07：dry-run 也真探测——此前一律假定 9333「在位」，排障时误导；
  //     但探不到只提示不拦截：dry-run 语义 = 验证命令与环境组装，不要求浏览器真开着）
  let cdp = null;
  if (await probePort(9333)) cdp = "http://127.0.0.1:9333";
  else if (await probePort(9222)) cdp = "http://127.0.0.1:9222";
  if (!cdp) {
    if (dryRun) {
      console.log("  [提示] dry-run：未探测到 BOSS 登录浏览器（9333 / 9222 都没开），仅提示不拦截。");
      console.log("         正式运行前请双击 boss-edge-login.bat（Edge）或 boss-zhipin-login.bat（Chrome）扫码并保持窗口开着。");
      return true;
    }
    console.error("  [错误] 未探测到 BOSS 登录浏览器（端口 9333 / 9222 都没开）。");
    console.error("         请先双击 boss-edge-login.bat（Edge）或 boss-zhipin-login.bat（Chrome），");
    console.error("         打开 zhipin.com/web/user 扫码登录，并保持窗口开着，再重新运行。");
    return false;
  }
  process.env.BOSS_CDP_URL = cdp;
  console.log(`  [OK] BOSS 登录浏览器在位（${cdp}）`);

  // 2) boss CLI 是否可用
  const bossCandidates = [
    process.env.BOSS_BIN,
    path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "boss.exe" : "boss"),
  ].filter(Boolean);
  const bossFound = bossCandidates.some((p) => fs.existsSync(p));
  if (bossFound) console.log("  [OK] boss-agent-cli 已安装");
  else console.log("  [提示] 常见位置未找到 boss 命令，若未跑过 setup.bat 的 BOSS 部分请先跑一次。");

  // 3) 浏览器内核：缺失自动安装（走 npmmirror 镜像，约 200MB，只需一次）
  console.log("  [内核] 检查 BOSS 浏览器内核（缺失会自动下载安装）...");
  const r = dryRun
    ? { status: 0 }
    : spawnSync(process.execPath, [path.join(PLATFORMS.boss.skillDir, "scripts", "check-cli-update.js"), "--install-browsers"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("  [错误] 浏览器内核安装失败。可稍后重跑，或按 boss-resume-screener/SKILL.md 的排障节手动安装。");
    return false;
  }
  return true;
}

// ---------- 子进程执行 ----------
function runStep(title, script, args, env, dryRun) {
  const cmdline = `node ${path.relative(ROOT, script)}${args.length ? " " + args.join(" ") : ""}`;
  console.log(`\n>>> ${title}\n    ${cmdline}\n`);
  if (dryRun) {
    const envKeys = Object.keys(env).filter((k) => !process.env[k] || process.env[k] !== env[k]);
    console.log("    环境变量：");
    envKeys.forEach((k) => console.log(`      ${k}=${env[k]}`));
    return 0;
  }
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env: { ...process.env, ...env } });
  return r.status ?? 1;
}


// ---------- 主流程 ----------
// v2.9.4：require 守卫——单测可 require 本文件取 parseJobsPayload 而不触发入口流程
if (require.main === module) (async () => {
  const opts = parseArgs(process.argv.slice(2));
  await maybeSetupUser(opts);

  // v2.7.0：--setup-greet 纯设置模式——不带平台/岗位时问完即退（不进菜单不筛选），
  // 夜里看完报告想关掉打招呼也不受工作时间窗口拦截（与 --setup-user 同为离线操作）。
  if (opts.setupGreet && !opts.platforms && !opts.profileArg && !opts.dryRun) {
    await maybeSetupGreet({ ...opts, reportOnly: false });
    await maybeSetupBossSource({ ...opts, reportOnly: false });
    console.log("（--setup-greet 完成（打招呼 + 简历来源）。跑 BOSS 筛选：run.bat boss <岗位名>；查看/再改随时重跑本命令。）");
    process.exit(0);
  }

  // ---- 工作时间窗口硬拦截（启动时）----
  // 豁免：--report-only / --setup-user / --setup-greet / --dry-run（离线与诊断操作）/ --anytime（显式越过）。
  const WIN = loadWorkingWindow();
  if (!opts.reportOnly && !opts.setupUser && !opts.setupGreet && !opts.dryRun && !opts.anytime && !withinWindowNow(WIN)) {
    console.error(`[窗口] 当前 ${nowHHMM()} 在工作时间窗口 ${WIN.start}–${WIN.end} 之外，下次窗口 ${wwNextOpen(WIN)}。`);
    console.error(`       急用可运行 run.bat --anytime 越过（自动化识别风险自担）。`);
    console.error(`       改窗口：让 AI 帮你改，或用记事本编辑 profiles/_user.json 的 settings.workingWindow。`);
    process.exit(1);
  }

  if (!opts.platforms) {
    // 依赖自检（2026-10-27 交接 R-06）：exceljs 缺失时 report.js 会抛裸模块栈，
    // 提前换成一句可执行指引（setup-user 纯引导模式不需要它，跳过）
    if (!opts.setupUser) {
      try {
        require.resolve("exceljs");
      } catch {
        console.error("[错误] 缺少依赖 exceljs（生成 Excel 报告必需）。请先运行 setup.bat，或在本目录执行 npm install 后重跑。");
        process.exit(1);
      }
    }
    if (process.stdin.isTTY) opts.platforms = await menuPlatform();
    else { console.error('用法：run.bat [liepin|boss|all] [岗位画像名] [--from-published [岗位名]] [--anytime] [--city=..] [--limit N] [--kw 1,3] [--dup] [--report-only] [--setup-greet] [--greet-dry] [--greet-only <id>] [--dry-run]'); process.exit(1); }
  }
  if (opts.platforms.includes("all")) opts.platforms = ["liepin", "boss"];

  // 非交互的已发布岗位直连（列表/按名生成草稿，不自动跑）
  if (opts.fromPublished && !process.stdin.isTTY) {
    process.exit(await fromPublishedNonInteractive(opts, WIN));
  }

  const files = listProfiles();
  let profilePath = matchProfile(files, opts.profileArg);
  if (!profilePath) {
    if (process.stdin.isTTY) profilePath = await menuProfile(files, opts, WIN);
    else { console.error("[错误] 未指定岗位画像（非交互模式下请把画像名作为参数传入，或用 --from-published <岗位名> 从已发布岗位生成）"); process.exit(1); }
  }

  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const jobKey = sanitize(path.basename(profilePath, ".json"));
  const cities = opts.city
    ? [opts.city]
    : Array.isArray(profile.cities) && profile.cities.length
      ? profile.cities.map(String)
      : [String(profile.city || "北京")];
  const jobTitle = profile.jobTitle || jobKey;
  const reportsDir = path.join(ROOT, "reports");
  const startedAt = Date.now();

  console.log("\n==================== 运行概览 ====================");
  console.log(`岗位：${jobTitle}（画像：${path.basename(profilePath)}）`);
  console.log(`平台：${opts.platforms.map((p) => PLATFORMS[p].label).join(" + ")}`);
  console.log(`城市：${cities.join("、")}`);
  console.log(`数据目录：data/${jobKey}/<平台>/`);
  console.log(`推荐去重：${opts.dup ? "已关闭（--dup，同一人会再次进报告）" : "开启（同一岗位同一人只推荐一次）"}`);
  // v2.9.0：评估档位可见（BUG-2026-10-30 P0——档案选了精细，筛完必须先 llm-batch 评估再出报告，
  // report.js 侧退出码 6 机器强制；run.bat 路径在筛选完成后会出现断点交互）
  const scorePref = ((loadUserContextFile() || {}).settings || {}).scoringPreference || "fast";
  if (scorePref === "detailed") console.log("评估方式偏好：精细（筛选完成后停下等 AI 精细评估再出报告；SCREENER_FORCE_FAST=1 可单次降级）");
  if (opts.reportOnly) console.log("模式：只出报告（不搜索，基于本地缓存重算）");
  if (opts.dryRun) console.log("模式：dry-run（只打印命令，不执行）");
  console.log(`工作时间窗口：${WIN.start}–${WIN.end}（按本机时钟；${opts.anytime ? "本次已用 --anytime 越过" : "到点自动收尾，--anytime 可越过"}）`);
  console.log(`今日已浏览：${opts.platforms.map((p) => `${PLATFORMS[p].label} ${readGlobalViews(p, GLOBAL_QUOTA_DIR()).resumeViews}/${globalCapFor()}`).join("、")}（跨岗位共享，每平台每日硬顶）`);
  if (opts.platforms.includes("boss")) console.log(`今日已打招呼：BOSS ${readGreetSent(GLOBAL_QUOTA_DIR())}/20 条（本地硬顶，BOSS_GREET_LIMIT 可调；自动打招呼需首次使用时显式开启）`);
  console.log("==================================================\n");

  const envCommon = {
    JOB_PROFILE: path.resolve(profilePath),
    SCREENER_REPORTS_DIR: reportsDir,
    ...(opts.kw ? { KW_GROUPS: opts.kw } : {}),
    ...(opts.dup ? { SCREENER_ALLOW_DUPLICATES: "1" } : {}),
    ...(opts.anytime ? { SCREENER_ANYTIME: "1" } : {}),
  };

  let aborted = false;
  let abortCode = 0; // 0=未中止；2=登录失效；3=熔断/风控；4=档案缺失（R-02：仅 3 中止后仍出报告）
  // v2.11.0 历史文件全局预清理（2026-11-02 用户拍板「所有历史文件保留 1 天可配」）：启动时扫项目根
  // logs/ 与整棵 data/（各岗位各平台、_joblist），过期即清；报告/去重索引/配额账本永不清理。
  // 失败不阻塞（本地 fs 操作，异常只提示）；dry-run 语义下不真删。各 screener 启动还会再清自己的 ROOT。
  if (!opts.dryRun) {
    try {
      const sweepSkill = PLATFORMS[opts.platforms[0]] || PLATFORMS.boss;
      const r = spawnSync(process.execPath, [path.join(sweepSkill.skillDir, "scripts", "cleanup.js")], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
      const line = String(r.stdout || "").trim();
      if (line) console.log(line);
    } catch { /* 清理失败不阻塞主流程 */ }
  }
  for (const plat of opts.platforms) {
    if (aborted) break;
    const P = PLATFORMS[plat];
    // 平台边界检查：上一个平台的耗时/休整可能已把时钟推出窗外
    if (!opts.reportOnly && !opts.anytime && !withinWindowNow(WIN)) {
      console.log(`[窗口] 已到 ${WIN.end}（工作时间窗外），跳过 ${P.label} 剩余平台（已完成的照常出报告）`);
      break;
    }
    console.log(`\n########## ${P.label} ##########`);
    const dataRoot = path.join(ROOT, "data", jobKey, plat);
    fs.mkdirSync(path.join(dataRoot, "data"), { recursive: true });
    const envPlat = { ...envCommon, SCREENER_DATA_DIR: dataRoot };
    // v2.7.0：本次运行的唯一标识（greet-pool 按它跨城市累积、换运行重置——多城 spawn 的
    // screener 各自落盘，靠 runId 才不会互相覆盖掉前几城市的 S/A 候选池）。
    envPlat.SCREENER_RUN_ID = String(startedAt);

    if (plat === "liepin") await selfCheckLiepin(opts.dryRun);
    else if (!(await selfCheckBoss(opts.dryRun))) continue;

    // v2.7.0：BOSS 首次使用时问一次「是否自动打招呼 + 话术来源」（settings.greet 落档后不再追问）
    if (plat === "boss") await maybeSetupGreet(opts);
    // v2.8.2：BOSS 简历来源偏好（settings.bossSource，含畅聊卡成本提示）
    if (plat === "boss") await maybeSetupBossSource(opts);

    // ---- 全局浏览配额：份额 = 全局剩余 ÷ 岗位画像总数（新增画像自动参与重分，无需参数）----
    // 份额是该岗位"今日"的浏览预算（跨多次运行生效）；画像 dailyResumeQuota 显式指定则优先（仍受全局硬顶）。
    const gqDir = GLOBAL_QUOTA_DIR();
    const cap = globalCapFor();
    const g0 = readGlobalViews(plat, gqDir);
    const remaining = Math.max(0, cap - g0.resumeViews);
    const jobCount = Math.max(1, listProfiles().length);
    const share = Math.floor(remaining / jobCount);
    const usedToday = Number(g0.perJob[jobKey]) || 0;
    let jobLeft = share - usedToday;
    if (Number(profile.dailyResumeQuota) > 0) {
      jobLeft = Math.min(jobLeft, Number(profile.dailyResumeQuota) - usedToday);
    }
    const base = opts.limit ? Number(opts.limit) : P.defaultMaxResumesPerRun;
    const resumeLimit = Math.max(0, Math.min(base, jobLeft)); // 钳制：份额永不抬高单轮默认上限
    envPlat.SCREENER_GLOBAL_QUOTA_DIR = gqDir;

    let skippedByQuota = false;
    if (!opts.reportOnly && resumeLimit <= 0) {
      console.log(`  [配额] ${P.label}今日全局已浏览 ${g0.resumeViews}/${cap}（${jobCount} 个岗位、本岗位今日已用 ${usedToday}），本轮跳过筛选，直接基于本地缓存出报告（次日自动恢复；或临时调大 SCREENER_GLOBAL_DAILY_VIEWS）`);
      skippedByQuota = true;
    } else if (!opts.reportOnly) {
      console.log(`  [配额] ${P.label}今日剩余 ${remaining}/${cap} ÷ ${jobCount} 个岗位 = 份额 ${share}，本岗位本次最多浏览 ${resumeLimit} 份`);
      envPlat.RESUME_LIMIT = String(resumeLimit);
    }

    if (!opts.reportOnly && !skippedByQuota) {
      for (const [i, city] of cities.entries()) {
        // 城市边界检查：300s 城市间休整可能把下一城推过窗口边界
        if (!opts.reportOnly && !opts.anytime && !withinWindowNow(WIN)) {
          console.log(`  [窗口] 已到 ${WIN.end}（工作时间窗外），跳过 ${P.label} 剩余城市（已跑城市正常出报告）；下次窗口 ${wwNextOpen(WIN)}`);
          break;
        }
        console.log(`\n----- ${P.label} · 城市 ${i + 1}/${cities.length}：${city} -----`);
        const code = runStep(
          `筛选（${jobTitle} · ${city}）`,
          path.join(P.skillDir, "scripts", "screener.js"),
          [],
          { ...envPlat, SCREENER_CITY: city },
          opts.dryRun
        );
        if (code === 2) {
          console.error(`\n[登录失效] 请重新双击${plat === "liepin" ? " liepin-login.bat" : " boss-edge-login.bat / boss-zhipin-login.bat"}扫码后再跑。`);
          aborted = true;
          abortCode = 2;
          break;
        }
        if (code === 3) {
          console.error("\n[已熔断] 触发风控或连续错误，已停止本轮。请休息一段时间再试，不要反复重跑。");
          aborted = true;
          abortCode = 3;
          break;
        }
        if (code === 4) {
          console.error("\n[档案缺失] 背景档案（profiles/_user.json）不存在，筛选被前置拦截。双击 run.bat 首跑引导会创建（4 个问题），或让 AI 按提示问四项后重跑。");
          aborted = true;
          abortCode = 4;
          break;
        }
        if (code !== 0) {
          console.error(`\n[警告] screener 退出码 ${code}，继续处理已拿到的数据。`);
        }
        if (i < cities.length - 1 && !opts.dryRun) {
          console.log(`\n[休整] 城市间等待 ${CITY_GAP_SEC}s ...`);
          await sleep(CITY_GAP_SEC);
        }
      }
    }
    if (aborted) {
      // 2026-10-27 交接 R-02：熔断（exit 3）≠白跑——已抓取的简历都在本地缓存，rescore+report
      // 是零网络纯本地行为（rescore 在 screener main 之前分流，不碰平台），不违反"停手"红线。
      // 登录失效（2）通常发生在预检、无新数据；档案缺失（4）是门槛不是故障——两者保持直接跳过。
      if (abortCode === 3) {
        console.log("\n[收尾] 本轮中途熔断：基于已抓取的本地缓存重算评分并出报告（不再向平台发任何请求）…");
        runStep("基于缓存重算评分（rescore）", path.join(P.skillDir, "scripts", "screener.js"), ["rescore"], envPlat, opts.dryRun);
        const rc3 = runStep("生成 Excel 推荐报告", path.join(P.skillDir, "scripts", "report.js"), [], envPlat, opts.dryRun);
        if (rc3 === 7) { console.error("\n[转写未完成] 报告被转写门槛拦下（已截图未转写，评分全 0/C）。完成 ocr-batch 转写链路后 --report-only 重出。"); process.exitCode = 7; }
        if (rc3 === 6) { console.error("\n[精细评估未完成] 报告被评估档位门槛拦下（档案偏好=精细）。完成 llm-batch 评估后 --report-only 重出，或 SCREENER_FORCE_FAST=1 显式降级。"); process.exitCode = 6; }
      }
      break;
    }

    // ---- v2.10.0：截图转写断点（BOSS 截图取文模式）：待转写 >0 → greet/report 前停下 ----
    // 转写由 AI 会话执行（工具不接 OCR API，PII 不出「本机 + AI 会话」边界），run.js 只能"停"不能"跑"；
    // report.js 退出码 7 机器兜底。无降级选项——无文本则评分恒 0/C，跳过转写出报告只会误导。
    if (plat === "boss" && !opts.dryRun) {
      const ocrPending = (() => {
        try {
          const res = JSON.parse(fs.readFileSync(path.join(dataRoot, "data", "last-results.json"), "utf8"));
          if (!Array.isArray(res)) return 0;
          return res.filter((r) => {
            try {
              const c = JSON.parse(fs.readFileSync(path.join(dataRoot, "data", "resumes", `${r.id}.json`), "utf8"));
              return Array.isArray(c.images) && c.images.length && !String(c.text || "").trim();
            } catch { return false; }
          }).length;
        } catch { return 0; }
      })();
      if (ocrPending > 0) {
        console.log(`\n[截图转写] ${ocrPending} 份已截图待转写——本轮 ${P.label} 不出报告、不自动打招呼（无文本则评分全 0/C）。`);
        console.log("  AI 会话内执行：node <skill>/scripts/ocr-batch.js next → AI 读图转写为纯文本 → node <skill>/scripts/ocr-batch.js save <转写.json>，循环至 status 完成；");
        console.log(`  然后重算+出报告：run.bat ${opts.platforms.join(" ")} ${jobKey} --report-only（内部 rescore → report；精细档另有 llm-batch 断点与退出码 6）`);
        if (!process.stdin.isTTY) process.exitCode = 7; // 机器面：非交互编排路径以 7 明示被门槛拦下
        continue; // 跳过本平台的 greet/rescore/report（下一平台照常）
      }
    }

    // ---- v2.9.0：精细评估断点（BUG-2026-10-30 P0）：偏好=精细且本轮尚有未评估 → greet/report 前停下 ----
    // 精细评估由 AI 会话执行（工具不接模型 API），run.js 只能"停"不能"跑"；report.js 侧另有
    // 退出码 6 机器兜底。打招呼排在评估后（greet 的最终等级口径读 llm-scores，未评估就发=按规则分发错人）。
    if (scorePref === "detailed" && process.env.SCREENER_FORCE_FAST !== "1" && !opts.dryRun) {
      const llmPending = (() => {
        try {
          const res = JSON.parse(fs.readFileSync(path.join(dataRoot, "data", "last-results.json"), "utf8"));
          if (!Array.isArray(res)) return 0;
          let doneIds = new Set();
          try {
            const d = JSON.parse(fs.readFileSync(path.join(dataRoot, "data", "llm-scores.json"), "utf8"));
            if (d && d.entries) doneIds = new Set(Object.keys(d.entries));
          } catch { doneIds = new Set(); }
          return res.filter((r) => !doneIds.has(r.id)).length;
        } catch { return 0; }
      })();
      if (llmPending > 0) {
        let downgrade = false;
        if (process.stdin.isTTY) {
          console.log("\n========== 精细评估（档案偏好：精细）==========");
          console.log(`本轮 ${P.label} 筛选完成，${llmPending} 份待精细评估（AI 逐份读简历按画像标准打分，更准、附匹配依据；消耗模型积分/token）。`);
          console.log(`  1. 现在停下（推荐）：对 AI 会话说「精细评估 ${jobTitle}」，完成后运行 run.bat ${opts.platforms.join(" ")} ${jobKey} --report-only 出报告`);
          console.log("  2. 本次降级快速档：跳过精细评估，按关键词规则分直接出报告+打招呼（仅本次有效，不改档案）");
          const a = await ask("选 1/2（默认 1）：");
          downgrade = a === "2";
        }
        if (!downgrade) {
          console.log(`\n[精细评估] ${llmPending} 份待评估——本轮 ${P.label} 不出报告、不自动打招呼（防未评估先触达）。`);
          console.log("  AI 会话内执行：node <skill>/scripts/llm-batch.js next → 批内输出全部评估 JSON → node <skill>/scripts/llm-batch.js save <文件>，循环至 status 全部已评；");
          console.log(`  然后出报告：run.bat ${opts.platforms.join(" ")} ${jobKey} --report-only（降级快速档：前置 SCREENER_FORCE_FAST=1）`);
          if (!process.stdin.isTTY) process.exitCode = 6; // 机器面：非交互编排路径以 6 明示被门槛拦下
          continue; // 跳过本平台的 greet/rescore/report（下一平台照常）
        }
        envPlat.SCREENER_FORCE_FAST = "1";
        console.log("[精细评估] 本次已选择降级快速档（SCREENER_FORCE_FAST=1，仅本次有效）。");
      }
    }

    // ---- v2.7.0：自动打招呼（BOSS 专有、授权制；rescore 之前——greet-pool 按 runId 跨城市累积，与 last-results 解耦）----
    // 任何失败只警告不阻断：报告永远照出。greet.js 内部自管授权（exit 5）/风控（exit 3，风控类落锁）/节奏与去重。
    if (plat === "boss") {
      const enabled = process.env.BOSS_GREET === "1" || (readGreetSettings() || {}).enabled === true;
      let why = "";
      if (process.env.BOSS_GREET === "0") why = "BOSS_GREET=0 强制关断";
      else if (!enabled) why = "自动打招呼未开启（settings.greet.enabled 不是 true）";
      else if (opts.reportOnly || skippedByQuota) why = "本轮未跑新筛选（report-only / 配额跳过），无本轮浏览池";
      else if (!opts.anytime && !withinWindowNow(WIN)) why = `已到 ${WIN.end}（工作时间窗外），主动触达不做窗外补发`;
      if (why) {
        console.log(`\n[greet] ${why}，本轮不自动打招呼（报告照常）。`);
        // 清上一轮 greet-run.json 残留：防旧状态漏进本轮报告的「打招呼」列（greet 真跑时总会重写）
        if (!opts.dryRun) { try { fs.rmSync(path.join(dataRoot, "data", "greet-run.json"), { force: true }); } catch { /* 无旧文件 */ } }
      } else {
        const gEnv = { ...envPlat };
        const gArgs = [];
        if (opts.greetDry) gEnv.BOSS_GREET_DRY = "1";
        if (opts.greetOnly) gArgs.push("--only", opts.greetOnly);
        const gcode = runStep("自动打招呼（授权制，S/A 级）", path.join(P.skillDir, "scripts", "greet.js"), gArgs, gEnv, opts.dryRun);
        if (gcode === 5) console.log("[greet] 返回未授权（exit 5）：跳过打招呼，报告照常。");
        else if (gcode === 3) console.log("[greet] 打招呼阶段熔断（风控类错误已落锁 data/_quota/boss.risk-lock.json；其他熔断不落锁）：本轮不再打招呼，报告照常。");
        else if (gcode !== 0) console.log(`[greet] 打招呼阶段退出码 ${gcode}（不阻断报告）。`);
      }
    }

    runStep("基于缓存重算评分（rescore）", path.join(P.skillDir, "scripts", "screener.js"), ["rescore"], envPlat, opts.dryRun);
    const rcode = runStep("生成 Excel 推荐报告", path.join(P.skillDir, "scripts", "report.js"), [], envPlat, opts.dryRun);
    if (rcode === 7) {
      console.error("\n[转写未完成] 报告被转写门槛拦下（已截图未转写，评分全 0/C）。");
      console.error("  AI 会话内完成 ocr-batch 转写链路后 --report-only 重出报告。");
      process.exitCode = 7;
    }
    if (rcode === 6) {
      console.error("\n[精细评估未完成] 报告被评估档位门槛拦下（档案偏好=精细且 LLM 评估未覆盖本轮候选池）。");
      console.error("  AI 会话内完成 llm-batch 评估后 --report-only 重出报告；或前置 SCREENER_FORCE_FAST=1 显式降级（不改档案）。");
      process.exitCode = 6;
    }
  }

  // 收尾：列出本次新生成的报告
  console.log("\n==================== 完成 ====================");
  for (const plat of opts.platforms) {
    const g = readGlobalViews(plat, GLOBAL_QUOTA_DIR()); // 重新读盘（子进程刚写入，不能用开跑快照）
    const jobs = Object.entries(g.perJob).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join("、");
    console.log(`今日${PLATFORMS[plat].label}浏览配额：${g.resumeViews}/${globalCapFor()}${jobs ? `（${jobs}）` : ""}，次日自动清零`);
    if (plat === "boss") console.log(`今日BOSS已打招呼：${readGreetSent(GLOBAL_QUOTA_DIR())} 条（本地硬顶 20/日，全局同一人只发一次）`);
  }
  try {
    const fresh = fs.readdirSync(reportsDir)
      .map((f) => ({ f, t: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
      .filter((x) => x.t >= startedAt)
      .sort((a, b) => a.t - b.t);
    if (fresh.length) {
      console.log("本次生成的报告（reports/）：");
      fresh.forEach((x) => console.log(`  ${x.f}`));
    } else {
      console.log("本次没有生成新报告（可能全部候选人已被推荐过，或无达标者）。");
    }
  } catch { /* reports/ 不存在则跳过 */ }
  console.log("提示：数据与报告含真实候选人信息，仅保存在本机，请勿外发整个文件夹。");
  console.log("      转发工具给别人请用 pack-release.bat 打干净包。");
})();

module.exports = { parseJobsPayload };
