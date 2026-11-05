// 猎聘自动筛选编排器 — 只读筛选 + 人工触达
// 红线：绝不执行 liepin greet；退出码 3 / 连续 3 次错误 / 超日配额 → 熔断
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const { checkCliUpdate } = require("./check-cli-update");
const { scoreResume } = require("./scoring");
const gq = require("./quota-global");
const ww = require("./working-window");
const { cleanupHistory } = require("./cleanup");
const rg = require("./refresh-guard");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
const DATA = path.join(ROOT, "data");
const LOGS = path.join(ROOT, "logs");
const REPORTS = path.join(ROOT, "reports");

// 首次运行时 data/ logs/ reports/ 可能都不存在；不先建目录的话
// saveJson(quota.json) 会以 ENOENT 直接崩掉（历史 bug）
[DATA, LOGS, REPORTS, path.join(DATA, "resumes")].forEach((d) => {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
});

// 全局浏览配额（跨岗位共享，按平台记账）：目录解析见 quota-global.js
const GQ_DIR = gq.resolveGlobalQuotaDir(DATA);
const JOB_KEY = gq.jobKeyFromProfileEnv(cfg.jobTitle);
console.log(`[全局配额] 岗位=${JOB_KEY} · 今日已浏览 ${gq.viewsToday(GQ_DIR)}/${cfg.globalMaxResumeViewsPerDay} · 记账 ${gq.globalQuotaPath(GQ_DIR)}`);

// ---------- 风控守护（刷新/登录环，2026-10-27 引入；全程只读红线不变）----------
let guard = null; // main() 里 start() 成功后非空；tick() 在命令边界与休息切片里检查
const guardTick = () => { if (guard) guard.tick(); };
const logger = { append: (s) => fs.appendFileSync(path.join(LOGS, `run-${today()}.log`), s) };

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

// 执行 liepin 命令：剥离代理 env（猎聘封境外 IP），统计配额，解析退出码
function liepin(args) {
  guardTick(); // 风控守护检查点：触发过（刷新环/登录环）就不该再发下一条命令
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  env.NO_PROXY = "*";
  let quota = loadJson(path.join(DATA, "quota.json"), { date: today(), count: 0 });
  if (quota.date !== today()) quota = { date: today(), count: 0 };
  if (quota.count >= cfg.maxRequestsPerDay) {
    throw new FatalError(`日配额已用尽 (${quota.count}/${cfg.maxRequestsPerDay})，今日停止`);
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
    if (code === 3) {
      // 平台风控与刷新/登录环同源同纪律（2026-10-27 事故后）：也落锁，防带热度重跑
      rg.writeRiskLock(GQ_DIR, "cli-exit-3", `liepin ${args} 退出码 3（平台风控）`);
      throw new FatalError("风控触发（退出码 3）：立即停止全部自动化，请人工在浏览器完成验证；已落本地风控锁（" + rg.lockPath(GQ_DIR) + "），确认账号恢复并冷却后删锁重跑");
    }
    if (code === 2) throw new LoginExpired("登录态失效（退出码 2）：请重新 liepin login");
  }
  fs.appendFileSync(path.join(LOGS, `run-${today()}.log`), `\n$ liepin ${args}\n[exit ${code}]\n${stdout}\n`);
  return { code, stdout, quota };
}

class FatalError extends Error {}
class LoginExpired extends Error {}

// 从输出中容忍式抽取 JSON（CLI 可能混有非 JSON 前后缀行）
function extractJson(text) {
  const trimmed = (text || "").trim();
  try { return JSON.parse(trimmed); } catch {}
  const start = Math.min(
    ...["[", "{"].map((c) => { const i = trimmed.indexOf(c); return i === -1 ? Infinity : i; })
  );
  if (start === Infinity) return null;
  for (let end = trimmed.length; end > start; end--) {
    const slice = trimmed.slice(start, end);
    try { return JSON.parse(slice); } catch {}
  }
  return null;
}

const loadJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; } };
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));


// 简历详情为 key: value 文本格式，正则抽取展示字段
function parseResumeText(text) {
  const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : ""; };
  return {
    name: grab(/^name:\s*(.+)$/m) || grab(/^姓名[：:]\s*(.+)$/m),
    company: grab(/^current_company:\s*(.+)$/m) || grab(/^当前公司[：:]\s*(.+)$/m),
    title: grab(/^title:\s*(.+)$/m) || grab(/^职位[：:]\s*(.+)$/m),
    city: grab(/^city:\s*(.+)$/m) || grab(/^城市[：:]\s*(.+)$/m),
  };
}

// ---------- 主流程 ----------
async function main() {
  const mode = process.argv[2] || "full"; // full | search-only | rescore
  console.log(`=== 猎聘自动筛选 · ${cfg.jobTitle} · ${cfg.city} · ${today()} ===`);
  const WIN = ww.parseWorkingWindow(cfg.workingWindow);
  if (process.env.SCREENER_ANYTIME === "1") console.log("[窗口] 已用 SCREENER_ANYTIME=1 越过工作时间限制");
  else console.log(`[窗口] 工作时间 ${cfg.workingWindow.join("–")}（本地时间，到点自动收尾）`);
  // v2.11.0 历史文件统一清理（2026-11-02 用户拍板「保留 1 天可配」）：按 cfg.retentionDays 清过期
  // logs/简历缓存/结果缓存（本 ROOT 范围）；报告、去重索引、配额账本永不清理（产品承诺）。
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

  // 0.3 风控锁预检（2026-10-27 猎聘风控事故引入）：上一轮触发过风控信号（刷新环/登录环/CLI
  //     exit 3）会留下平台级本地锁；带锁 = 账号疑似仍在风控态，拒绝再跑（重试不会解除平台侧风控）。
  {
    const lock = rg.readRiskLock(GQ_DIR);
    if (lock && lock.locked) {
      throw new rg.RiskSignalError(
        `检测到本地风控锁（${lock.reason || "原因未知"}，${lock.at || "时间未知"}）。` +
          `请先人工在浏览器确认账号正常（能手动搜索、浏览简历），冷却一段时间后删除锁文件解锁：\n  ${rg.lockPath(GQ_DIR)}\n删除后重跑。不要反复重试。`
      );
    }
  }

  // 0. 启动自检：liepin-cli 必查版本，不是最新版就自动升级（用户铁律：每次使用必查必升）。
  //    升级失败（registry 不可达等）只提示、不阻塞；应急关断 LIEPIN_CLI_AUTOUPDATE=0。
  await checkCliUpdate({ autoUpdate: process.env.LIEPIN_CLI_AUTOUPDATE !== "0" });

  // 0.5 预检：低成本命令验证登录态
  const pre = liepin("joblist");
  if (pre.code !== 0) throw new LoginExpired("预检失败，需重新登录");
  console.log("[预检] 登录态正常");

  // 0.7 风控守护（2026-10-27 用户拍板）：侦听常驻浏览器主帧导航，频繁刷新/落到登录页
  //     立即全停并落锁。机器强制（铁律 9）：CDP 连不上 = 守护失效 = 不跑；测试环境可跳过。
  if (process.env.SCREENER_SKIP_REFRESH_GUARD === "1") {
    console.log("[守护] SCREENER_SKIP_REFRESH_GUARD=1，刷新/登录环侦听已跳过（仅限测试）");
  } else {
    guard = rg.createGuard({ lockDir: GQ_DIR, logger });
    await guard.start();
  }

  const processed = loadJson(path.join(DATA, "processed.json"), { ids: [] });
  const denied = loadJson(path.join(DATA, "denied.json"), { ids: [] }); // 无权限查看的简历
  const seen = new Set([...processed.ids, ...denied.ids]);
  let consecutiveErrors = 0;
  let viewedStreak = 0; // 本轮连续成功浏览计数（每 restEvery 份歇一口气，2026-10-27 风控事故调参）

  // 1. 搜索阶段（KW_GROUPS="1,3" 可只跑指定组；RESUME_LIMIT 覆盖详情上限）
  const kwFilter = (process.env.KW_GROUPS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x) - 1);
  const groups = kwFilter.length
    ? cfg.keywordGroups.filter((_, i) => kwFilter.includes(i))
    : cfg.keywordGroups;
  // 候选池按「组」分桶，稍后跨组轮询——否则第 1 组会吃光全部简历配额（历史坑）
  const buckets = [];
  for (const g of groups) {
    guardTick();
    if (consecutiveErrors >= cfg.maxConsecutiveErrors) throw new FatalError("连续 3 次一般错误，熔断");
    // 工作时间窗口软停止（搜索阶段同样受限：避免起跑于窗口尾段时越界继续发搜索请求）
    if (process.env.SCREENER_ANYTIME !== "1" && !ww.isWithinWindow(new Date(), WIN)) {
      console.log(`  [窗口] 已到 ${cfg.workingWindow[1]}（工作时间窗外），搜索阶段提前收尾（正常结束）；下次窗口 ${ww.describeNextOpen(new Date(), WIN)}`);
      break;
    }
    console.log(`\n[搜索] ${g.name}: ${g.kw}`);
    // 画像可配 searchAge（如 "20,40"）→ 透传猎聘 --age，搜索阶段就滤掉超龄，省简历配额
    const ageArg = cfg.searchAge ? ` --age "${cfg.searchAge}"` : "";
    const r = liepin(`search "${g.kw}" --city ${cfg.city} --limit ${cfg.searchLimit}${ageArg} --json`);
    const bucket = [];
    buckets.push({ name: g.name, items: bucket });
    if (r.code !== 0) { consecutiveErrors++; continue; }
    consecutiveErrors = 0;
    const data = extractJson(r.stdout);
    const list = Array.isArray(data) ? data : data?.data || data?.list || data?.items || [];
    if (!Array.isArray(list) || list.length === 0) { console.log("  无结果"); continue; }
    console.log(`  命中 ${list.length} 条`);
    for (const c of list) {
      const id = String(c.resumeId || c.resume_id || c.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      bucket.push({ id, group: g.name, raw: c });
    }
    console.log(`  新增去重后 ${bucket.length} 条`);
    if (g !== groups[groups.length - 1]) await randSleep(cfg.intervals.betweenSearches, "搜索间");
  }

  // 跨组轮询：第 1 轮每组取 1 人，第 2 轮再每组取 1 人……保证每组都有人进入简历阶段
  const candidates = [];
  {
    const maxLen = buckets.reduce((m, b) => Math.max(m, b.items.length), 0);
    for (let i = 0; i < maxLen; i++) {
      for (const b of buckets) if (b.items[i]) candidates.push(b.items[i]);
    }
  }

  if (mode === "search-only") { saveJson(path.join(DATA, "last-search.json"), candidates); if (guard) guard.stop(); return; }

  // 2. 搜索与查看之间：长随机休息
  await randSleep(cfg.intervals.longBreak, "阶段切换");

  // 3. 简历详情阶段（单次 ≤ maxResumesPerRun 份；已缓存简历不再重复请求）
  const results = [];
  const resumeLimit = Number(process.env.RESUME_LIMIT || cfg.maxResumesPerRun);
  // 岗位今日剩余浏览额度：全局硬顶与画像 dailyResumeQuota（未指定则只受全局约束）
  const jobQuota = Number(cfg.dailyResumeQuota) > 0 ? Number(cfg.dailyResumeQuota) : Infinity;
  let jobLeft = Math.min(
    gq.remainingToday(GQ_DIR, cfg.globalMaxResumeViewsPerDay),
    jobQuota - gq.jobViewsToday(GQ_DIR, JOB_KEY)
  );
  const batch = candidates.slice(0, resumeLimit);
  const batchDist = batch.reduce((m, c) => ((m[c.group] = (m[c.group] || 0) + 1), m), {});
  console.log(
    `\n[简历] 待查看 ${batch.length} 份（去重后）；组分布: ${Object.entries(batchDist).map(([k, v]) => `${k}×${v}`).join("、") || "无"}`
  );
  for (const [i, c] of batch.entries()) {
    guardTick();
    if (consecutiveErrors >= cfg.maxConsecutiveErrors) throw new FatalError("连续 3 次一般错误，熔断");
    const cacheFile = path.join(DATA, "resumes", `${c.id}.json`);
    let text = "";
    let viewedThisRun = false; // 2026-10-29 修复（BUG 文档缺陷三）：真实浏览才歇间隔，缓存命中不歇
    if (fs.existsSync(cacheFile)) {
      text = JSON.parse(fs.readFileSync(cacheFile, "utf8")).text;
      console.log(`  (${i + 1}/${batch.length}) resume ${c.id} [${c.group}] (缓存)`);
    } else {
      console.log(`  (${i + 1}/${batch.length}) resume ${c.id} [${c.group}]`);
      // 全局浏览配额软停止（缓存/被拒不占额度，逐份检查精确停在边界；与熔断 exit 3 不同，这是正常收尾）
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
      const r = liepin(`resume ${c.id}`);
      if (r.code !== 0) {
        // 拒访（简历不存在/无权限）是正常现象：跳过并记入 denied，不触发熔断
        if (/简历不存在|flag[^\d]{0,3}0|无权限|不在.*(人才库|范围内)/.test(r.stdout)) {
          console.log(`    无权限查看，已跳过`);
          denied.ids.push(c.id);
          saveJson(path.join(DATA, "denied.json"), denied);
          continue;
        }
        consecutiveErrors++;
        continue;
      }
      consecutiveErrors = 0;
      // 成功浏览 1 份：全局记账 +1（denied/失败/缓存分支都不计）
      gq.chargeGlobalView(GQ_DIR, JOB_KEY, cfg.globalMaxResumeViewsPerDay);
      jobLeft--;
      viewedStreak++;
      text = r.stdout; // 简历详情为文本格式，全文参与打分
      saveJson(cacheFile, { id: c.id, group: c.group, search: c.raw, fields: parseResumeText(text), text });
      viewedThisRun = true;
    }
    const s = scoreResume(text + JSON.stringify(c.raw), cfg.scoring, cfg.gradeBands);
    results.push({ id: c.id, group: c.group, search: c.raw, fields: parseResumeText(text), score: s });
    processed.ids.push(c.id);
    if (viewedThisRun && i < batch.length - 1) {
      await randSleep(cfg.intervals.betweenResumes, "简历间");
      // 连看歇口气（2026-10-27 风控事故调参：15/20 份触发风控、诊断=频率过高；画像若钉了
      // 旧 intervals 会缺 restBreak，回落默认值不中断）
      if (viewedStreak > 0 && viewedStreak % (cfg.restEvery || 5) === 0) {
        await randSleep(cfg.intervals.restBreak || [60, 180], `连看 ${viewedStreak} 份歇口气`);
      }
    }
  }
  saveJson(path.join(DATA, "processed.json"), processed);
  saveJson(path.join(DATA, "last-results.json"), results);
  // v2.9.0：轮次标识落 data/run-meta.json——report 的「同轮重出不跳过」识别读它
  // （BUG-2026-10-30 BUG-2：重出报告曾被去重索引整池拦掉出空表）。rescore 不写（同轮语义）。
  // 与 BOSS 侧 greet-pool 的 RUN_ID 同款：run.js 每次运行注入 SCREENER_RUN_ID，手动直跑用 pid 兜底。
  saveJson(path.join(DATA, "run-meta.json"), { runId: String(process.env.SCREENER_RUN_ID || process.pid), savedAt: new Date().toISOString() });

  console.log(`\n[完成] 已评分 ${results.length} 份，S/A 级 ${results.filter((r) => ["S", "A"].includes(r.score.grade)).length} 份`);
  console.log(gq.summarizeToday(GQ_DIR, cfg.globalMaxResumeViewsPerDay));
  // v2.9.0：收尾指引按评估档位分流（BUG-2026-10-30 根因 4——旧指引把 AI 一律引向 report，
  // 精细评估档被整段跳过）。detailed 且未显式降级 → 指到 llm-batch；report 侧另有 exit 6 机器兜底。
  if ((cfg.userSettings && cfg.userSettings.scoringPreference) === "detailed" && process.env.SCREENER_FORCE_FAST !== "1") {
    console.log("下一步：精细评估——node llm-batch.js next → AI 会话批内输出全部评估 JSON → node llm-batch.js save <文件>，循环至 status 全部已评 → node report.js（未完成前 report 以退出码 6 拒出报告）");
  } else {
    console.log("下一步：node report.js 生成 Excel 推荐报告");
  }
  if (guard) guard.stop(); // 关守护 WebSocket（不关会挂住进程退出）
}

// rescore：仅基于本地简历缓存重新打分（改打分模型/关键词后零网络重算）
function rescore() {
  const dir = path.join(DATA, "resumes");
  if (!fs.existsSync(dir)) { console.log("无本地缓存，先跑一轮筛选"); return; }
  const results = [];
  const processed = loadJson(path.join(DATA, "processed.json"), { ids: [] });
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const s = scoreResume(c.text + JSON.stringify(c.search), cfg.scoring, cfg.gradeBands);
    results.push({ id: c.id, group: c.group, search: c.search, fields: parseResumeText(c.text), score: s });
  }
  saveJson(path.join(DATA, "processed.json"), processed);
  saveJson(path.join(DATA, "last-results.json"), results);
  console.log(`[rescore] 基于 ${results.length} 份缓存重新打分完成，S/A 级 ${results.filter((r) => ["S", "A"].includes(r.score.grade)).length} 份`);
}

const mode = process.argv[2] || "full"; // full | search-only | rescore
if (mode === "rescore") { rescore(); } else { main().catch((e) => {
  if (e instanceof LoginExpired) {
    console.error(`\n[登录失效] ${e.message}`);
    process.exit(2);
  }
  if (e instanceof rg.RiskSignalError) {
    console.error(`\n[风控守护] ${e.message}`);
    process.exit(3);
  }
  console.error(`\n[熔断] ${e.message}`);
  process.exit(3);
}); }
