// BOSS 直聘自动筛选编排器 —— 只读筛选 + 授权触达（v2.7.0 起）
//
// 红线（与猎聘一致，绝不违反）：
//   1. 本文件保持只读：不收藏、不发消息（v2.7.0 起自动收藏已弃用——弹层收藏按钮对未沟通
//      候选人被平台权限拦截，2026-10-28 证伪）。自动打招呼的唯一例外在 greet.js（独立阶段，
//      rescore 之后由 run.js spawn）：仅当 profiles/_user.json settings.greet.enabled=true
//      （首跑引导两问授权）时对 S/A 级候选人发首条招呼；回复/求简历/换联系方式仍 100% 手动。
//   2. 允许的"写"：hr download-resume（显式开启时）+ hr greet（仅 greet.js、须 settings.greet 授权）。
//   3. 遇 ACCOUNT_RISK / ENVIRONMENT_RISK / LOGIN_RISK_CONTROL / PLATFORM_VERIFICATION_REQUIRED
//      → 立即全停，不重试。
//   4. 每次使用前检查 CLI 版本（用户要求），有更新则走升级流程。
//
// 与猎聘编排器的差异：
//   - 数据源是三段式：hr candidates（搜人）→ hr resume（看简历，需 geek_id+job_id+security_id）
//   - 输出是统一 JSON 信封，解析走 envelope.data
//   - 错误语义在 error.code（52 个错误码），不看退出码
//   - 2026-10-26 起：hr resume 只回骨架，正文由 fetch-text.js 走 canvas 复制通道取回（失败即中止）
//   - 2026-10-29 起：hr resume 底层接口被平台下线（ENDPOINT_DEPRECATED，上游追踪 boss-agent-cli#472）
//     ——v2.8.0 起骨架改由候选卡片字段构建（cardToStructured，搜索/推荐卡同构），正文仍走 canvas 通道；
//     并新增推荐源（hr recommendations，开聊免费、参数已被平台受理——2026-10-29 实证）：
//     BOSS_SOURCE=reco（v2.8.1 起默认，仅推荐——开聊免费）/ both / search；推荐源优先入池，已聊过/好友跳过。
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const { scoreResume } = require("./scoring");
const { runBoss, FatalError, LoginExpired, RateLimited, VerificationRequired, RiskControlError, AUTH_CODES } = require("./boss");
const { fetchResumeText, ensureChatTab } = require("./fetch-text");
const { captureResumeShots } = require("./shot-capture");
const { runLocalOcr } = require("./ocr-local");
const { cleanupHistory } = require("./cleanup");
const { validateText } = require("./ocr-batch");
const { checkCliUpdate } = require("./check-cli-update");
const gq = require("./quota-global");
const ww = require("./working-window");
const rg = require("./refresh-guard");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
// v2.10.0 取文通道（2026-10-31 用户拍板架构）：默认「截图 + AI 转写」（shot-capture.js 截图存
// data/扫描图/，text 留空由 ocr-batch.js 回填）；拖选-复制通道保留为显式回退（BOSS_TEXT_MODE=drag）。
// 不做运行中自动跨通道兜底——失败即中止，由人工决定是否换通道重跑（开合纪律）。
const TEXT_MODE = String(process.env.BOSS_TEXT_MODE || "shot").trim().toLowerCase() === "drag" ? "drag" : "shot";
// v2.10.0 OCR 内联（用户 2026-10-30 拍板）：截图后本机 RapidOCR 立即识别回填 text——零 token、纯本地
// （PII 边界更紧）；识别不过校验的个别份留给 AI 会话转写兜底（ocr-batch 链路原样承接）。BOSS_OCR=0 关断。
const OCR_ON = process.env.BOSS_OCR !== "0";
// v2.9.7 节奏纠偏（2026-10-30 用户二次拍板）：**不注入 --delay**——CLI v3.1.0 的 30-60s 请求节流
// 是防识别保护，保持官方默认；总节奏靠本层间隔与旧方案对齐（见 config.intervals 注释）。
// boss.js 的 BOSS_CLI_DELAY 注入机制保留但默认无人设置（显式设 env 才生效，仅供用户本人应急）。
const DATA = path.join(ROOT, "data");
const LOGS = path.join(ROOT, "logs");
const REPORTS = path.join(ROOT, "reports");

[DATA, LOGS, REPORTS, path.join(DATA, "resumes")].forEach((d) => {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    /* 目录已存在 */
  }
});

// 全局浏览配额（跨岗位共享，按平台记账）：目录解析见 quota-global.js
const GQ_DIR = gq.resolveGlobalQuotaDir(DATA);
const JOB_KEY = gq.jobKeyFromProfileEnv(cfg.jobTitle);
console.log(`[全局配额] 岗位=${JOB_KEY} · 今日已浏览 ${gq.viewsToday(GQ_DIR)}/${cfg.globalMaxResumeViewsPerDay} · 记账 ${gq.globalQuotaPath(GQ_DIR)}`);

// ---------- 风控守护（刷新/登录环，2026-10-27 引入；与猎聘侧镜像，节奏参数不动）----------
let guard = null; // main() 里 start() 成功后非空；tick() 在命令边界与休息切片里检查
const guardTick = () => { if (guard) guard.tick(); };

// ---------- 工具 ----------
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));
const randSleep = async ([a, b], tag) => {
  const s = rand(a, b);
  console.log(`  [间隔] ${tag}: ${s}s`);
  // 1s 粒度切片：风控守护在休息中途触发也能立即停下（execSync 阻塞事件循环时事件会缓存在
  // socket 里，切片的 await 让它在这里被处理）；tick 顺带节流重扫 CLI 新开的标签
  for (let left = s; left > 0; left--) { await sleep(1); guardTick(); }
};
const today = () => new Date().toISOString().slice(0, 10);

const loadJson = (p, dflt) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
};
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));

const logger = { append: (s) => fs.appendFileSync(path.join(LOGS, `run-${today()}.log`), s) };

// 配额记账（在 CLI 内置节流之外的二次兜底）
function chargeQuota() {
  let quota = loadJson(path.join(DATA, "quota.json"), { date: today(), count: 0 });
  if (quota.date !== today()) quota = { date: today(), count: 0 };
  if (quota.count >= cfg.maxRequestsPerDay) {
    throw new FatalError(`日配额已用尽 (${quota.count}/${cfg.maxRequestsPerDay})，今日停止`);
  }
  quota.count++;
  saveJson(path.join(DATA, "quota.json"), quota);
  return quota;
}

// ---------- 从 BOSS 返回结构中抽取列表 ----------
// BOSS 信封：{ok,data:{...},pagination:{...}}，列表字段名随接口而变，做多键兼容。
function pickList(envelope) {
  const d = envelope && envelope.data;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  // ⚠️ 实测（v3.0.0，2026-10-16）：`hr candidates` 的候选数组在 data.geeks，
  //    元素形如 { geekCard: {...}, ... }。"geeks" 必须放在候选键最前。
  for (const k of ["geeks", "geekList", "list", "items", "result", "candidates", "recommendList", "friendList", "zpData"]) {
    if (Array.isArray(d[k])) return d[k];
    if (d[k] && typeof d[k] === "object") {
      for (const k2 of ["geeks", "list", "items", "result", "geekList"]) {
        if (Array.isArray(d[k][k2])) return d[k][k2];
      }
    }
  }
  return [];
}

/** 从候选人卡片里抽取三段式所需 ID（字段名做多键兼容） */
function pickIds(item) {
  // ⚠️ 实测（v3.0.0，2026-10-16）：`hr candidates` 返回的元素是 { geekCard: {...} }，
  //    ID 与姓名都在 geekCard 内（geekCard.encryptGeekId / geekCard.securityId / geekCard.name）。
  //    少数版本可能平铺在顶层 → 两层都查，geekCard 优先。
  const src = item && item.geekCard && typeof item.geekCard === "object" ? item.geekCard : item;
  // 注意：geekCard.jobId 实测恒为数字 0（占位），真正可用的是 geekCard.encryptJobId（形如 "07b5df7e..."）。
  // 因此 jobId 的键序必须把 encryptJobId 放前，且要跳过纯 "0" 这类占位值。
  const ok = (v) => v != null && v !== "" && String(v) !== "0";
  const g = (keys, { skipZero = false } = {}) => {
    for (const k of keys) {
      const v = src && src[k] != null && src[k] !== "" ? src[k] : item && item[k] != null && item[k] !== "" ? item[k] : null;
      if (v == null) continue;
      if (skipZero && !ok(v)) continue;
      return String(v);
    }
    return "";
  };
  return {
    geekId: g(["geekId", "geek_id", "encryptGeekId", "encrypt_geek_id", "uid"]),
    jobId: g(["encryptJobId", "encrypt_job_id", "encJobId", "jobId", "job_id"], { skipZero: true }),
    securityId: g(["securityId", "security_id", "expectId", "expect_id"]),
    name: g(["name", "geekName", "geek_name"]),
    raw: item,
  };
}

// ---------- 候选卡片 → 结构化骨架（v2.8.0：hr resume 接口退役后的替代数据源）----------
// 搜索卡与推荐卡同构（geekCard），字段全时结构更全、缺失时留空——打分正文靠 canvas 通道，不依赖此处完整。
function cardToStructured(card) {
  const c = card || {};
  const works = Array.isArray(c.geekWorks) ? c.geekWorks : [];
  return {
    basic: {
      name: c.geekName || "",
      degree: c.geekDegree || "",
      work_years: c.geekWorkYear || "",
      age: c.ageDesc || "",
      gender: c.geekGender || "",
    },
    expectation: {
      position: c.expectPositionName || "",
      salary: c.salary || "",
      city: c.expectLocationName || "",
    },
    work_experience: works.map((w) => ({
      company: w.company || "",
      position: w.positionName || w.positionCategory || "",
      startDate: w.startDate || "",
      endDate: w.endDate || "",
      responsibility: w.responsibility || "",
    })),
    geekDesc: (c.geekDesc && (typeof c.geekDesc === "object" ? c.geekDesc.content : c.geekDesc)) || "",
  };
}

// 推荐列表宽容解析（纯函数）：信封 data.geekList 多键兼容（可用保存的信封离线测试）
function pickRecoList(envelope) {
  const d = envelope && envelope.data;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  for (const k of ["geekList", "geeks", "list", "items", "result", "recommendList"]) {
    if (Array.isArray(d[k])) return d[k];
  }
  return [];
}

// ---------- 主流程 ----------
async function main() {
  const mode = process.argv[2] || "full";
  console.log(
    `=== ${cfg.platformLabel}自动筛选 · ${cfg.jobTitle} · ${cfg.city} · ${today()} ===\n`
  );
  const WIN = ww.parseWorkingWindow(cfg.workingWindow);
  if (process.env.SCREENER_ANYTIME === "1") console.log("[窗口] 已用 SCREENER_ANYTIME=1 越过工作时间限制");
  else console.log(`[窗口] 工作时间 ${cfg.workingWindow.join("–")}（本地时间，到点自动收尾）`);
  // v2.11.0 历史文件统一清理（2026-11-02 用户拍板「保留 1 天可配」，取代 v2.10.0 截图 7 天独立清理）：
  // 按 cfg.retentionDays 清过期 logs/简历缓存/结果缓存/截图（本 ROOT 范围）；报告、去重索引、
  // 配额账本永不清理（产品承诺）；待转写截图超过保留期同样清（隔天即视为弃案，不再永久保留）。
  {
    const cr = cleanupHistory(ROOT, { days: cfg.retentionDays });
    if (cr.deleted > 0) console.log(`[历史清理] 保留${cr.days}天：清理 ${cr.deleted} 个过期文件（日志 ${cr.byClass.logs} · 简历缓存 ${cr.byClass.resumes} · 结果缓存 ${cr.byClass.results} · 截图 ${cr.byClass.shots}）`);
  }
  // 背景档案硬门槛（v2.3.2）：档案不存在直接拒绝筛选——不靠 AI 自觉读文档，撞门槛即按指令补建后重跑
  if (!cfg.userContext && process.env.SCREENER_SKIP_USER_CONTEXT !== "1") {
    console.error("[门槛] profiles/_user.json 不存在，本次不执行筛选（这是前置条件，不是故障）。");
    console.error("       请先建立用户背景档案：向用户问一次「公司名 / 所属行业 / 业务方向 / 常用招聘城市」四项，确认后写入 profiles/_user.json，");
    console.error('       JSON 格式：{"companyName":"..","industry":"..","businessSummary":"..","commonCities":[".."],"updatedAt":"<当前时间>","history":[]}');
    console.error("       或让用户双击 run.bat 完成首跑引导。建好后重跑本命令（测试环境可设 SCREENER_SKIP_USER_CONTEXT=1 跳过）。");
    process.exit(4);
  }

  // 0.3 风控锁预检（2026-10-27 引入，与猎聘侧同款）：上一轮触发过风控信号（刷新环/登录环/
  //     CLI 风控错误码）会留下平台级本地锁；带锁 = 账号疑似仍在风控态，拒绝再跑。
  //     注意与 CLI 自己的 cdp_risk_lock 是两把锁：CLI 那把用 boss clean --risk-lock 清，
  //     本工具这把删锁文件即可，两把都要清。
  {
    const lock = rg.readRiskLock(GQ_DIR);
    if (lock && lock.locked) {
      throw new rg.RiskSignalError(
        `检测到本地风控锁（${lock.reason || "原因未知"}，${lock.at || "时间未知"}）。` +
          `请先人工在浏览器确认账号正常（能手动搜索、浏览候选人），冷却一段时间后：\n` +
          `  1. 删除本工具的锁文件：${rg.lockPath(GQ_DIR)}\n` +
          `  2. 若 CLI 侧也有锁（boss status 的 cdp_risk_lock），执行：boss clean --risk-lock\n` +
          `然后重跑。不要反复重试（平台侧风控不会因重试解除）。`
      );
    }
  }

  // 0. 启动自检：boss-agent-cli 必查版本，不是最新版就自动升级（用户铁律：每次使用必查必升）。
  //    升级失败（PyPI 不可达等）只提示、不阻塞；应急关断 BOSS_CLI_AUTOUPDATE=0 / SCREENER_CLI_AUTOUPDATE=0。
  const upd = await checkCliUpdate({
    autoUpdate:
      process.env.BOSS_CLI_AUTOUPDATE !== "0" && process.env.SCREENER_CLI_AUTOUPDATE !== "0",
  });
  if (upd.status === "outdated") {
    console.log(
      `\n[提示] CLI 有新版（v${upd.installed} → v${upd.latest}），但自动升级被关断未执行。请移除 BOSS_CLI_AUTOUPDATE=0 / SCREENER_CLI_AUTOUPDATE=0 后重跑，或手动 uv tool upgrade boss-agent-cli。\n`
    );
  }

  // 0.5 预检：低成本只读命令验证登录态（boss status 不请求平台，用 hr candidates 轻探更准）
  // 带自愈：实测 CLI 会话短命（筛完一轮后
  // 短时间内即失效），登录浏览器开着时免扫码重新导入一次即可。只试一次，绝不反复重登（红线）。
  console.log("[预检] 检查登录态…");
  let pre = runBoss(["status"], { bin: cfg.bossBin, timeoutMs: 60000, logger });
  if (!pre.ok && AUTH_CODES.has(String(pre.code))) {
    console.log("[预检] CLI 会话过期，从登录浏览器自动导入（boss login --cdp，免扫码）…");
    const imp = runBoss(["login", "--cdp"], { bin: cfg.bossBin, timeoutMs: 90000, logger });
    if (imp.ok) pre = runBoss(["status"], { bin: cfg.bossBin, timeoutMs: 60000, logger });
    else {
      throw new LoginExpired("会话自动导入失败（登录浏览器可能未登录或已关闭）：请双击 boss-edge-login.bat / boss-zhipin-login.bat 扫码并保持窗口开着");
    }
  }
  if (!pre.ok) {
    throw new LoginExpired("登录态不可用，请先双击 boss-edge-login.bat / boss-zhipin-login.bat 扫码并保持窗口开着");
  }
  // 风控锁预检（2026-10-27 交接 R-01）：boss status 的 ok=true 不代表账号干净——带本地风控锁时
  // 预检会"假通过"，等到第一次搜索才撞 ACCOUNT_RISK 白跑。带锁即拦下并给可执行指引。
  const riskLock = pre.envelope && pre.envelope.data && pre.envelope.data.cdp_risk_lock;
  if (riskLock && riskLock.locked) {
    throw new FatalError(
      `账号存在本地风控锁（${riskLock.reason || "原因未知"}，${riskLock.locked_at || "时间未知"}）。\n` +
        `请先到 BOSS 网页端确认能正常搜索候选人（人工验证通过、账号恢复后），再执行：\n` +
        `  boss clean --risk-lock\n` +
        `然后重跑。不要反复重试（平台侧风控不会因重试解除）。`
    );
  }
  console.log("[预检] 登录态正常\n");

  // 0.6 预检：沟通页标签必须存在（v2.5.1 机器强制）。2026-10-26 事故：沟通页没开 → hr resume
  //     页面兜底失效 → 连撞 3 次 ENDPOINT_DEPRECATED 熔断空跑。此前只写文档靠人记，违反铁律 9。
  console.log("[预检] 检查沟通页标签…");
  const chatTab = await ensureChatTab({ logger });
  if (!chatTab.opened) console.log("[预检] 沟通页标签在位\n");

  // 0.7 风控守护（2026-10-27 用户拍板，与猎聘侧同款）：侦听登录浏览器主帧导航，频繁刷新/
  //     落到登录页立即全停并落锁。复用 BOSS_CDP_URL（与 CLI、取文同一浏览器）；机器强制。
  if (process.env.SCREENER_SKIP_REFRESH_GUARD === "1") {
    console.log("[守护] SCREENER_SKIP_REFRESH_GUARD=1，刷新/登录环侦听已跳过（仅限测试）");
  } else {
    guard = rg.createGuard({ lockDir: GQ_DIR, logger });
    await guard.start();
  }

  const processed = loadJson(path.join(DATA, "processed.json"), { ids: [] });
  const seen = new Set(processed.ids); // v2.8.0：denied.json 随 hr resume 接口退役失去写入方，仅去重 processed
  let consecutiveErrors = 0;

  // 来源模式（v2.8.2）：env BOSS_SOURCE（最高优先）→ _user.json settings.bossSource（首跑引导问过）→ 默认 reco。
  // 默认仅推荐的原因：搜索来源开聊需手动/付费搜索畅聊卡（2026-10-29 用户拍板，v2.8.1）。
  const SRC_SETTING = String((cfg.userSettings && cfg.userSettings.bossSource) || "").trim().toLowerCase();
  const SOURCE = ["both", "search", "reco"].includes(process.env.BOSS_SOURCE || "")
    ? String(process.env.BOSS_SOURCE).trim().toLowerCase()
    : ["both", "search", "reco"].includes(SRC_SETTING) ? SRC_SETTING : "reco";
  if (SOURCE !== "reco") console.log(`[来源] 本次使用：${SOURCE === "both" ? "推荐 + 搜索" : "仅搜索"}（搜索来源的 S/A 打招呼将标「需手动」——畅聊卡扣费待定案）`);
  const buckets = [];

  // 1. 推荐阶段（v2.8.0，免费开聊来源——推荐卡 searchChatCardCostCount=0、greet 参数被平台受理，2026-10-29 实证）：
  //    hr jobs list 按 jobTitle 解析职位加密 ID（画像可显式写 bossJobEncryptId 跳过匹配）→ hr recommendations 分页拉取。
  if (SOURCE === "reco" || SOURCE === "both") {
    let jobEncryptId = String(cfg.bossJobEncryptId || "").trim();
    if (!jobEncryptId) {
      chargeQuota();
      const jr = runBoss(["hr", "jobs", "list"], { bin: cfg.bossBin, logger });
      if (jr.ok) {
        const jobs = require("./joblist").parseJobsFromEnvelope(jr.envelope || {}).jobs;
        const exact = jobs.find((j) => j.name === cfg.jobTitle);
        const subs = jobs.filter((j) => String(cfg.jobTitle || "") && j.name.includes(cfg.jobTitle));
        const picked = exact || (subs.length === 1 ? subs[0] : null);
        if (picked && picked.jobId) jobEncryptId = picked.jobId;
      }
      if (!jobEncryptId) {
        console.log(`  [推荐] 未解析到「${cfg.jobTitle}」的在招职位加密 ID（hr jobs list 匹配不到或命令失败），跳过推荐源（搜索源照常）。`);
        console.log('         可在画像里显式写 "bossJobEncryptId": "..." 跳过匹配。');
      }
    }
    if (jobEncryptId) {
      console.log(`\n[推荐] 职位加密 ID ${jobEncryptId.slice(0, 12)}…（开聊免费；已聊过/好友自动跳过）`);
      const bucket = [];
      buckets.push({ name: "推荐", items: bucket });
      for (let page = 1; page <= 6; page++) {
        guardTick();
        if (consecutiveErrors >= cfg.maxConsecutiveErrors) throw new FatalError("连续 3 次一般错误，熔断");
        // 工作时间窗口软停止（推荐翻页同样是平台请求）
        if (process.env.SCREENER_ANYTIME !== "1" && !ww.isWithinWindow(new Date(), WIN)) {
          console.log(`  [窗口] 已到 ${cfg.workingWindow[1]}（工作时间窗外），推荐阶段提前收尾（正常结束）`);
          break;
        }
        chargeQuota();
        let r;
        try {
          r = runBoss(["hr", "recommendations", "--job-id", jobEncryptId, "--page", String(page)], { bin: cfg.bossBin, logger });
        } catch (e) {
          if (e instanceof RateLimited) {
            console.log("  ⚠️ 触发平台频率限制，推荐阶段提前结束");
            break;
          }
          if (e instanceof FatalError || e instanceof LoginExpired || e instanceof VerificationRequired) throw e;
          consecutiveErrors++;
          continue;
        }
        if (!r.ok) {
          consecutiveErrors++;
          console.log(`  推荐第 ${page} 页返回 ok=false（${r.code || "未知"}），累计错误 ${consecutiveErrors}`);
          continue;
        }
        consecutiveErrors = 0;
        const list = pickRecoList(r.envelope);
        if (!list.length) break;
        let added = 0;
        for (const item of list) {
          // 已聊过/已是好友的人跳过（联系已建立，无需再筛再打招呼——卡片自带标记）
          if (item && (item.haveChatted || item.isFriend)) continue;
          const rawCard = item && item.geekCard && typeof item.geekCard === "object" ? item.geekCard : item;
          // 推荐卡自带数字 geekId，而弹层/打招呼都要加密形态——统一改写为 encryptGeekId
          const card = { ...rawCard, geekId: rawCard.encryptGeekId || rawCard.geekId };
          const ids = pickIds({ geekCard: card });
          const key = ids.geekId || ids.name;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          bucket.push({ id: key, group: "推荐", ids, raw: ids.raw });
          added++;
        }
        console.log(`  推荐第 ${page} 页命中 ${list.length} 条，新增去重后 ${added} 条`);
        // v2.9.6 按需早停（2026-10-30 用户拍板提速）：凑够本轮浏览预算就不再翻页——
        // 少翻页 = 少发平台请求（更安全），也省掉 CLI v3.1.0 每请求 30-60s 的节流等待。
        // +5 缓冲：浏览阶段还要剔除已聊过/好友/参数缺失者。
        const recoNeed = (Number(process.env.RESUME_LIMIT) || cfg.maxResumesPerRun) + 5;
        if (bucket.length >= recoNeed) {
          console.log(`  推荐池已凑够 ${bucket.length}/${recoNeed}（按需早停，不再翻页）`);
          break;
        }
        const hasMore = !!(r.envelope && r.envelope.data && r.envelope.data.hasMore);
        if (!hasMore) break;
        if (page < 6) await randSleep(cfg.intervals.betweenSearches, "推荐翻页");
      }
      console.log(`  推荐源累计 ${bucket.length} 条`);
    }
  }

  // 2. 搜索阶段：hr candidates（BOSS_SOURCE=reco 时跳过）
  const kwFilter = (process.env.KW_GROUPS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x) - 1);
  const allGroups = kwFilter.length
    ? cfg.keywordGroups.filter((_, i) => kwFilter.includes(i))
    : cfg.keywordGroups;
  const groups = SOURCE === "reco" ? [] : allGroups;
  const pages = Math.max(1, Math.ceil((cfg.searchLimit || 20) / (cfg.perPage || 10)));
  for (const g of groups) {
    guardTick();
    if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
      throw new FatalError("连续 3 次一般错误，熔断");
    }
    // 工作时间窗口软停止（搜索阶段同样受限：避免起跑于窗口尾段时越界继续发搜索请求）
    if (process.env.SCREENER_ANYTIME !== "1" && !ww.isWithinWindow(new Date(), WIN)) {
      console.log(`  [窗口] 已到 ${cfg.workingWindow[1]}（工作时间窗外），搜索阶段提前收尾（正常结束）；下次窗口 ${ww.describeNextOpen(new Date(), WIN)}`);
      break;
    }
    console.log(`\n[搜索] ${g.name}: ${g.kw}`);
    const bucket = [];
    buckets.push({ name: g.name, items: bucket });

    for (let page = 1; page <= pages; page++) {
      guardTick();
      const args = ["hr", "candidates", g.kw, "--city", String(cfg.bossCityCode || "-2"), "--page", String(page)];
      const F = cfg.bossFilters || {};
      if (F.experience) args.push("--experience", F.experience);
      if (F.degree) args.push("--degree", F.degree);
      if (F.activeness) args.push("--activeness", F.activeness);
      if (F.salary) args.push("--salary", F.salary);

      chargeQuota();
      let r;
      try {
        r = runBoss(args, { bin: cfg.bossBin, logger });
      } catch (e) {
        if (e instanceof RateLimited) {
          console.log("  ⚠️ 触发平台频率限制，本轮搜索提前结束");
          consecutiveErrors = cfg.maxConsecutiveErrors;
          break;
        }
        if (e instanceof FatalError || e instanceof LoginExpired || e instanceof VerificationRequired) {
          throw e; // 红线错误直接上抛
        }
        consecutiveErrors++;
        console.log(`  搜索失败（${e.message}），累计错误 ${consecutiveErrors}`);
        continue;
      }

      if (!r.ok) {
        consecutiveErrors++;
        console.log(`  搜索返回 ok=false（${r.code || "未知"}），累计错误 ${consecutiveErrors}`);
        continue;
      }
      consecutiveErrors = 0;

      const list = pickList(r.envelope);
      if (!list.length) {
        console.log(`  第 ${page} 页无结果`);
        break;
      }
      let added = 0;
      for (const item of list) {
        const ids = pickIds(item);
        const key = ids.geekId || ids.name;
        if (!key || seen.has(key)) continue;
        // 三段式：缺少 jobId/securityId 的卡片无法抓简历（下方简历循环会跳过并提示），此处照常入池；跳过属正常现象
        seen.add(key);
        bucket.push({ id: key, group: g.name, ids, raw: ids.raw });
        added++;
      }
      console.log(`  第 ${page} 页命中 ${list.length} 条，新增去重后 ${added} 条`);
      if (page < pages) await randSleep(cfg.intervals.betweenSearches, "搜索翻页");
    }
    console.log(`  本组累计 ${bucket.length} 条`);
    if (g !== groups[groups.length - 1]) await randSleep(cfg.intervals.betweenSearches, "搜索组间");
  }

  // 跨组轮询，避免第一组吃光简历配额
  const candidates = [];
  {
    const maxLen = buckets.reduce((m, b) => Math.max(m, b.items.length), 0);
    for (let i = 0; i < maxLen; i++) {
      for (const b of buckets) if (b.items[i]) candidates.push(b.items[i]);
    }
  }

  if (mode === "search-only") {
    saveJson(path.join(DATA, "last-search.json"), candidates);
    console.log(`\n[仅搜索] 已保存 ${candidates.length} 名候选到 data/last-search.json`);
    if (guard) guard.stop();
    return;
  }

  await randSleep(cfg.intervals.longBreak, "阶段切换");

  // 2. 简历详情阶段：hr resume <geek_id> --job-id --security-id
  const results = [];
  const resumeLimit = Number(process.env.RESUME_LIMIT || cfg.maxResumesPerRun);
  // 岗位今日剩余浏览额度：全局硬顶与画像 dailyResumeQuota（未指定则只受全局约束）
  const jobQuota = Number(cfg.dailyResumeQuota) > 0 ? Number(cfg.dailyResumeQuota) : Infinity;
  let jobLeft = Math.min(
    gq.remainingToday(GQ_DIR, cfg.globalMaxResumeViewsPerDay),
    jobQuota - gq.jobViewsToday(GQ_DIR, JOB_KEY)
  );
  const batch = candidates.slice(0, resumeLimit);
  console.log(`\n[简历] 待查看 ${batch.length} 份（去重后） · 取文通道：${TEXT_MODE === "shot" ? `截图采集 + ${OCR_ON ? "本机 RapidOCR 识别（v2.10.0 默认，零 token；未过校验者走 AI 转写兜底）" : "AI 会话转写（BOSS_OCR=0 已关断本机识别）"}` : "拖选-复制（BOSS_TEXT_MODE=drag 回退）"}`);
  let shotPending = 0; // 本轮结束仍待转写的份数（收尾指引用；缓存命中未转写者也计）

  for (const [i, c] of batch.entries()) {
    guardTick();
    if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
      throw new FatalError("连续 3 次一般错误，熔断");
    }
    const cacheFile = path.join(DATA, "resumes", `${c.id}.json`);
    let text = "";
    let structured = null;
    let fetchedAt = ""; // 简历抓取时刻（报告「抓取时间」列；旧缓存无此字段则留空显示「—」）
    let viewedThisRun = false; // 本轮是否真实浏览（v2.7.0 起落盘进 last-results：greet 阶段只对本轮真实浏览的 S/A 打招呼；缓存/历史不补打）
    const { geekId, jobId, securityId } = c.ids || {};

    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      text = cached.text || "";
      structured = cached.structured || null;
      fetchedAt = cached.fetchedAt || "";
      if (!String(cached.text || "").trim() && Array.isArray(cached.images) && cached.images.length) shotPending++; // 截图待转写的缓存命中（判据与其余四处统一：text trim 后为空）
      console.log(`  (${i + 1}/${batch.length}) ${c.ids.name || c.id} [${c.group}] (缓存)`);
    } else {
      if (!geekId || !jobId || !securityId) {
        console.log(
          `  (${i + 1}/${batch.length}) ${c.ids.name || c.id} [${c.group}] 缺少 geek_id/job_id/security_id，跳过`
        );
        continue;
      }
      console.log(`  (${i + 1}/${batch.length}) ${c.ids.name || c.id} [${c.group}]`);
      // 全局浏览配额软停止（缓存/被拒/缺三元组不占额度，逐份检查精确停在边界；与熔断 exit 3 不同，这是正常收尾）
      const gLeft = gq.remainingToday(GQ_DIR, cfg.globalMaxResumeViewsPerDay);
      if (gLeft <= 0) {
        console.log(`    [全局配额] 今日浏览额度已用完（${gq.viewsToday(GQ_DIR)}/${cfg.globalMaxResumeViewsPerDay}），本轮简历阶段提前结束（次日自动恢复）`);
        break;
      }
      if (jobLeft <= 0) {
        console.log(`    [岗位日限] ${JOB_KEY} 今日浏览已达 dailyResumeQuota（${cfg.dailyResumeQuota}），本轮简历阶段提前结束`);
        break;
      }
      // 工作时间窗口软停止（运行中跨界；与配额软停止同款：break 而非 throw，正常收尾出报告、退出码 0）
      if (process.env.SCREENER_ANYTIME !== "1" && !ww.isWithinWindow(new Date(), WIN)) {
        console.log(`    [窗口] 已到 ${cfg.workingWindow[1]}（工作时间窗外），本轮简历阶段提前收尾（正常结束）；下次窗口 ${ww.describeNextOpen(new Date(), WIN)}`);
        break;
      }
      chargeQuota();
      // v2.8.0：hr resume 底层接口已被平台下线（ENDPOINT_DEPRECATED，2026-10-29 实测，上游追踪
      // boss-agent-cli#472）——骨架改由候选卡片字段构建（搜索/推荐卡同构，与来源无关），
      // 正文仍走 fetch-text 的 canvas 通道；取文失败即中止的语义不变（用户拍板，不降级无开关）。
      const gc = (c.ids && c.ids.raw && c.ids.raw.geekCard) || {};
      structured = cardToStructured(gc);
      if (TEXT_MODE === "shot") {
        // v2.10.0 截图通道：截图存 data/扫描图/ → 本机 RapidOCR 立即识别（内联主通道，零 token）；
        // 识别不过校验/环境不可用 → text 留空走 AI 会话转写兜底（ocr-batch 链路，report 退出码 7 拦截）。
        // 「images 非空 + text 空」= 待转写判据（全链路统一）。
        const cap = await captureResumeShots({ geekId, jobId, securityId, outDir: DATA, logger });
        let ocrText = "";
        let ocrMeta = {};
        if (OCR_ON) {
          const o = await runLocalOcr(cap.images.map((rel) => path.join(DATA, rel)), { logger });
          if (o) {
            const v = validateText(o.text);
            if (v.ok) {
              ocrText = o.text;
              ocrMeta = { ocrAt: new Date().toISOString(), transcribedBy: "rapidocr-local" };
            } else {
              console.log(`    [OCR] 本地识别未过校验（${v.why.join("；")}）→ 留给 AI 会话转写兜底`);
            }
          }
        } else {
          console.log("    [OCR] BOSS_OCR=0 已关断本地识别 → 本份走 AI 会话转写");
        }
        text = ocrText;
        if (!ocrText) shotPending++;
        fetchedAt = new Date().toISOString();
        gq.chargeGlobalView(GQ_DIR, JOB_KEY, cfg.globalMaxResumeViewsPerDay);
        jobLeft--;
        saveJson(cacheFile, { id: c.id, group: c.group, ids: c.ids, structured, text, images: cap.images, bossInsight: cap.bossInsight || "", fetchedAt, ...ocrMeta });
      } else {
        const bodyText = await fetchResumeText({ geekId, jobId, securityId, logger });
        // v2.9.2 超短正文完整性警告（缺口②，2026-10-30 真机实测：弹层一屏即完时正文仅 365 字 vs 常规
        // 2–5k，后续打分/精细评估只能基于可见部分且无任何提示）。不熔断不重试（不做粗糙兜底），只如实
        // 标记——想重取该份：删对应缓存文件后重跑（缓存存在不会重新取文）。
        if (bodyText && bodyText.length < 500) {
          console.log(`    ⚠️ 正文异常简短（${bodyText.length} 字，常规 2–5k）——弹层可能未完整渲染，打分与评估将基于可见部分；如需重取：删除 data/resumes/${c.id}.json 后重跑`);
        }
        text = `${bodyText}\n${flattenResume(structured)}`;
        fetchedAt = new Date().toISOString();
        gq.chargeGlobalView(GQ_DIR, JOB_KEY, cfg.globalMaxResumeViewsPerDay);
        jobLeft--;
        saveJson(cacheFile, { id: c.id, group: c.group, ids: c.ids, structured, text, fetchedAt });
      }
      viewedThisRun = true;
      consecutiveErrors = 0;
    }

    const s = scoreResume(text, cfg.scoring, cfg.gradeBands);
    results.push({ id: c.id, group: c.group, ids: c.ids, search: c.raw, structured, fields: extractFields(structured), score: s, fetchedAt, viewedThisRun });
    processed.ids.push(c.id);
    // v2.7.0：自动收藏已弃用（弹层收藏按钮对未沟通候选人被平台权限拦截，2026-10-28 证伪）；
    // 旧 favorites.json 留档不读不写。S/A 触达改由 run.js 在 rescore 之前 spawn greet.js（授权制）。
    // 2026-10-29 修复（BUG 文档缺陷三，账号风险最高）：旧判定用「缓存文件是否存在」，而缓存恰在本轮
    // 刚写完 → 条件恒 false → 简历间隔从未执行（实测 20 份以 7–8s/份机器节奏跑完）。改用 viewedThisRun：
    // 真实浏览过才歇，缓存命中不歇。
    if (viewedThisRun && i < batch.length - 1) {
      await randSleep(cfg.intervals.betweenResumes, "简历间");
    }
  }

  saveJson(path.join(DATA, "processed.json"), processed);
  saveJson(path.join(DATA, "last-results.json"), results);

  // v2.7.0：本轮真实浏览的候选池快照（供 greet 阶段）。⚠️ 不能让 greet 读 last-results：
  // rescore() 从缓存重建 last-results 时会丢 search.geekCard（expectId/lid 在里面）和
  // viewedThisRun（缓存不含这些字段），故在此把打招呼所需全量（5 参数 + 话术渲染变量）单独落盘。
  // 等级过滤留给 greet 按最终口径（llm-scores 优先）判，这里只存真实浏览过的。
  const greetPool = results
    .filter((r) => r.viewedThisRun === true)
    .map((r) => {
      const gc = (r.search && r.search.geekCard) || {};
      const greetVars = { dims: {} };
      Object.entries(cfg.scoring || {}).forEach(([key, d], idx) => {
        const hits = (((r.score.parts || {})[key] || {}).hits || []).join("/");
        greetVars[`dim${idx + 1}`] = hits;
        greetVars.dims[d.label || key] = hits;
      });
      greetVars.regionHits = greetVars.dim1 || "";
      greetVars.carrierHits = greetVars.dim2 || "";
      return {
        id: r.id,
        geekId: (r.ids && r.ids.geekId) || "",
        jobId: (r.ids && r.ids.jobId) || "",
        securityId: (r.ids && r.ids.securityId) || "",
        expectId: gc.expectId != null ? String(gc.expectId) : "",
        lid: gc.lid != null ? String(gc.lid) : "",
        name: (r.ids && r.ids.name) || "",
        grade: (r.score && r.score.grade) || "C",
        total: (r.score && r.score.total) || 0,
        group: r.group,
        greetVars,
      };
    });
  // 多城市语义（v2.7.0）：run.js 对同一数据目录逐城 spawn screener，池子必须**按 runId 跨城累积**
  // （同 id 以最新覆盖），否则后一城落盘会覆盖掉前几城的 S/A 候选池；runId 变化（新一次运行）→ 重置，
  // 保证「本轮真实浏览」不跨运行泄漏。手动直跑 screener（无 runId env）用 pid 兜底，每次进程即新一轮。
  {
    const RUN_ID = String(process.env.SCREENER_RUN_ID || process.pid);
    const poolPath = path.join(DATA, "greet-pool.json");
    const prev = loadJson(poolPath, null);
    const prevList = prev && prev.runId === RUN_ID && Array.isArray(prev.entries) ? prev.entries : [];
    const byId = new Map(prevList.map((e) => [e.id, e]));
    for (const e of greetPool) byId.set(e.id, e);
    saveJson(poolPath, { runId: RUN_ID, savedAt: new Date().toISOString(), entries: [...byId.values()] });
    console.log(`[greet 池] 本轮真实浏览累计 ${byId.size} 份（本城新增 ${greetPool.length}）已落盘 data/greet-pool.json`);
    // v2.9.0：轮次标识另落 data/run-meta.json——report 的「同轮重出不跳过」识别读它
    // （BUG-2026-10-30 BUG-2：重出报告曾被去重索引整池拦掉出空表）。rescore 不写（同轮语义）。
    saveJson(path.join(DATA, "run-meta.json"), { runId: RUN_ID, savedAt: new Date().toISOString() });
  }

  const sa = results.filter((r) => ["S", "A"].includes(r.score.grade)).length;
  if (shotPending > 0) {
    console.log(`\n[完成] 本轮浏览 ${results.length} 份，其中 ${shotPending} 份已截图、待 AI 转写（转写前评分恒为 0/C，不作数）`);
  } else {
    console.log(`\n[完成] 已评分 ${results.length} 份，S/A 级 ${sa} 份`);
  }
  console.log(gq.summarizeToday(GQ_DIR, cfg.globalMaxResumeViewsPerDay));
  // v2.9.0：收尾指引按评估档位分流（BUG-2026-10-30 根因 4——旧指引把 AI 一律引向 report，
  // 精细评估档被整段跳过）。v2.10.0：截图链路多一步「转写」在最前（无文本则一切下游无从谈起）。
  // 机器兜底：report 退出码 7（转写未完成）/ 6（精细评估未完成）。
  const detailed = (cfg.userSettings && cfg.userSettings.scoringPreference) === "detailed" && process.env.SCREENER_FORCE_FAST !== "1";
  if (shotPending > 0) {
    console.log(`下一步：截图转写 ${shotPending} 份——node ocr-batch.js next → AI 会话读图转写为纯文本 → node ocr-batch.js save <转写.json>（循环至 status 完成）→ node screener.js rescore 重算评分`);
    if (detailed) console.log("转写并 rescore 后：精细评估——node llm-batch.js next → AI 会话批内输出全部评估 JSON → node llm-batch.js save <文件>，循环至 status 全部已评 → node report.js（退出码 6/7 拦截未完成链路）");
    else console.log("然后：node report.js 生成 Excel 推荐报告");
  } else if (detailed) {
    console.log("下一步：精细评估——node llm-batch.js next → AI 会话批内输出全部评估 JSON → node llm-batch.js save <文件>，循环至 status 全部已评 → node report.js（未完成前 report 以退出码 6 拒出报告）");
  } else {
    console.log("下一步：node report.js 生成 Excel 推荐报告");
  }
  // v2.7.0：打招呼配置状态可见提示（机器兜底——AI 直接调脚本时没有 run.bat 的首问环节，
  // 用户可能不知道有这功能；已拒绝（enabled:false）不打扰，尊重"不再追问"）
  const gset = cfg.userSettings && cfg.userSettings.greet;
  if (process.env.SCREENER_SKIP_USER_CONTEXT !== "1") {
    if (!gset) {
      console.log("[提示] 自动打招呼未配置：开启后本轮 S/A 候选会在报告前自动发首条招呼（每天≤20 条、同一人全局只发一次）。");
      console.log("       开启：双击 run.bat 跑 BOSS 时会问你 / run.bat --setup-greet / 直接对 AI 说「开启自动打招呼」。不开启保持只读。");
    } else if (gset.enabled === true) {
      console.log("[提示] 自动打招呼已开启：手动编排序列 = screener → greet.js → report.js（本轮候选池已快照，见上）。");
    }
  }
  if (guard) guard.stop(); // 关守护 WebSocket（不关会挂住进程退出）
}

// ---------- BOSS 结构化简历 → 可打分全文 ----------
// boss-agent-cli 的 parse_resume 输出结构（实测 v3.0.0，2026-10-16，见 services/resume_parser.py
// 与真实返回 `hr resume <id> --job-id ... --security-id ...`）：
//   {basic:{name,gender,age,degree,work_years,active_status,avatar},
//    expectation:{position,salary,city},
//    work_experience:[{company,position,department,start,end,duration,responsibility,...}],
//    project_experience:[...], education:[...], competitive_analysis:[...], certifications:[...]}
// ⚠️ 键名是**复数/长名**（basic / expectation / work_experience / project_experience /
//    competitive_analysis），不是早期假设的 base / expect / works / projects / competitive。
//    两套都保留，避免 CLI 升级后字段名再变时静默失效。
function flattenResume(structured) {
  if (!structured || typeof structured !== "object") return String(structured || "");
  if (typeof structured === "string") return structured;
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === "object") Object.values(v).forEach(push);
    else parts.push(String(v));
  };
  // 优先收集经历/项目/自我评价等"含业务描述"的字段（打分依赖这些）
  const KNOWN = [
    // 实测键名（v3.0.0）
    "basic", "expectation", "work_experience", "project_experience",
    "education", "competitive_analysis", "certifications",
    // 兼容旧/备用键名
    "base", "expect", "works", "projects", "competitive", "skills", "selfEvaluation", "summary",
  ];
  KNOWN.forEach((k) => push(structured[k]));
  // 兜底：结构里有未列出的字段也一并纳入（避免新版本字段名变化导致漏打分）
  Object.keys(structured).forEach((k) => {
    if (!KNOWN.includes(k)) push(structured[k]);
  });
  return parts.join("\n");
}

function extractFields(structured) {
  if (!structured || typeof structured !== "object") return {};
  // ⚠️ 实测（v3.0.0）：键名 basic / expectation / work_experience（非 base / expect / works）。
  const b = structured.basic || structured.base || {};
  const e = structured.expectation || structured.expect || {};
  const firstWork = (structured.work_experience || structured.works || [])[0] || {};
  return {
    name: b.name || "",
    company: firstWork.company || "",
    title: firstWork.position || e.position || "",
    city: e.city || "",
    age: b.age || "",
    degree: b.degree || "",
    gender: b.gender || "",
    workYears: b.work_years || "",
  };
}

// ---------- rescore：基于本地缓存零网络重算 ----------
function rescore() {
  const dir = path.join(DATA, "resumes");
  if (!fs.existsSync(dir)) {
    console.log("无本地缓存，先跑一轮筛选");
    return;
  }
  const results = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    // v2.10.0：截图待转写缓存（images 非空 + text 空）保持空文本 → 评分 0/C，不拿卡片骨架冒充正文；
    // 旧时代无 text 缓存维持骨架兜底原行为（拖选通道失败前的历史数据）
    const text = c.text || (Array.isArray(c.images) && c.images.length ? "" : flattenResume(c.structured));
    const s = scoreResume(text, cfg.scoring, cfg.gradeBands);
    results.push({ id: c.id, group: c.group, ids: c.ids, search: c.search, structured: c.structured, fields: extractFields(c.structured), score: s, fetchedAt: c.fetchedAt });
  }
  saveJson(path.join(DATA, "last-results.json"), results);
  const sa = results.filter((r) => ["S", "A"].includes(r.score.grade)).length;
  console.log(`[rescore] 基于 ${results.length} 份缓存重新打分完成，S/A 级 ${sa} 份`);
}

const mode = process.argv[2] || "full";
if (mode === "rescore") {
  rescore();
} else {
  main().catch((e) => {
    if (e instanceof LoginExpired) {
      console.error(`\n[登录失效] ${e.message}`);
      process.exit(2);
    }
    if (e instanceof VerificationRequired) {
      console.error(`\n[需人工验证] ${e.message}`);
      process.exit(4);
    }
    if (e instanceof rg.RiskSignalError) {
      console.error(`\n[风控守护] ${e.message}`);
      process.exit(3);
    }
    if (e instanceof RiskControlError) {
      // CLI 风控错误码（ACCOUNT_RISK 等）：与刷新/登录环同源同纪律，也落本地锁（2026-10-27）
      rg.writeRiskLock(GQ_DIR, "boss-stop-code", e.message);
      console.error(`\n[熔断·风控] ${e.message}`);
      console.error(`[风控守护] 已落本地风控锁：${rg.lockPath(GQ_DIR)}（与 CLI 的 cdp_risk_lock 是两把锁，解锁见 SKILL.md）`);
      process.exit(3);
    }
    console.error(`\n[熔断] ${e.message}`);
    process.exit(3);
  });
}
