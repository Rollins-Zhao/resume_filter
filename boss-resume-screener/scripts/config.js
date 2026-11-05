// BOSS 直聘自动筛选配置
// 结构对齐 liepin-resume-screener/scripts/config.js，便于同一份岗位画像两平台复用。
// 差异：CLI 是 Python 的 boss-agent-cli（uv tool 安装），不是 npm 包。
//
// 岗位画像放在 skill 外部的 profiles/（与猎聘共用同一套画像文件）。
// 用法：JOB_PROFILE="profiles/海外仓运营经理.json" node scripts/screener.js
const fs = require("fs");
const path = require("path");

// ---- BOSS 城市名 → cityCode 映射（照抄 CLI 内置 endpoints.CITY_CODES，api/boss.yaml）----
// `hr candidates --city` 只认数字编码；这里让人只写中文名，脚本自动翻译。
// 不在表里的一律回落到 "-2"（全国），避免传错编码导致搜索空结果。
const BOSS_CITY_CODE_MAP = {
  北京: "101010100", 上海: "101020100", 广州: "101280100", 深圳: "101280600",
  杭州: "101210100", 成都: "101270100", 南京: "101190100", 武汉: "101200100",
  西安: "101110100", 苏州: "101190400", 长沙: "101250100", 郑州: "101180100",
  重庆: "101040100", 天津: "101030100", 合肥: "101220100", 厦门: "101230200",
  济南: "101120100", 青岛: "101120200", 大连: "101070200", 宁波: "101210400",
  福州: "101230100", 东莞: "101281600", 珠海: "101280700", 佛山: "101280800",
  昆明: "101290100", 贵阳: "101260100", 太原: "101100100", 南昌: "101240100",
  南宁: "101300100", 石家庄: "101090100", 哈尔滨: "101050100", 长春: "101060100",
  沈阳: "101070100", 海口: "101310100", 兰州: "101160100", 乌鲁木齐: "101130100",
  无锡: "101190200", 常州: "101191100", 温州: "101210700", 惠州: "101280300",
};

/**
 * 把城市输入解析成 BOSS 招聘者端要的 cityCode。
 * 支持三种写法（优先级：显式编码 > 中文城市名 > 全国兜底）：
 *   1. 纯数字 → 直接当编码用（如 "101020100"、"101280600"）
 *   2. "_2" / "-2" → 全国
 *   3. 中文名 → 查表（如 "深圳"）
 *   表外中文名 → "-2"（全国），避免把无效编码静默发给服务端导致空结果。
 */
function resolveBossCityCode() {
  const raw = String(process.env.SCREENER_CITY_CODE || process.env.SCREENER_CITY || "北京").trim();
  if (/^-?\d+$/.test(raw)) return raw;          // 已经是编码（含负号形式 -2/-1）
  if (raw === "_2" || raw === "-2") return "-2"; // 全国
  return BOSS_CITY_CODE_MAP[raw] || "-2";
}

// ---- boss-agent-cli 可执行文件探测（与 boss.js 保持同一策略）----
function resolveBossBin() {
  if (process.env.BOSS_BIN) return process.env.BOSS_BIN;
  const os = require("os");
  const home = os.homedir();
  const names = process.platform === "win32" ? ["boss.exe", "boss.cmd", "boss.bat"] : ["boss"];
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "uv", "tools", "boss-agent-cli", "Scripts"),
    path.join(home, "AppData", "Roaming", "Python", "Scripts"),
  ];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return "boss";
}

// 全局跨岗位"成功浏览简历"日硬顶（quota-global.js 记账，data/_quota/boss.json）
const DEFAULT_GLOBAL_VIEWS = 1000;

module.exports = {
  // ---- 平台标识（报告/日志里显式写明，避免与猎聘混淆）----
  platform: "boss",
  platformLabel: "BOSS直聘",

  // ---- 岗位信息（默认值仅作通用兜底示例；实际岗位请用 JOB_PROFILE 指向 profiles/<岗位>.json）----
  jobTitle: "销售经理",
  project: "示例项目",
  city: "北京",

  // ---- boss-agent-cli 路径 ----
  bossBin: resolveBossBin(),

  // ---- BOSS 搜索参数 ----
  // ⚠️ 实测结论（2026-10-15，读 v3.0.0 源码 + `boss hr candidates --help`）：
  //    `hr candidates --city` 要的是**数字 cityCode**（帮助原文：「城市筛选（cityCode，如 101020100；-2=全国）」），
  //    与 `boss search --city`（用户端，要中文城市名）**不是同一套取值**。
  //    → 因此这里必须传数字编码。编码表来自 CLI 内置 `endpoints.CITY_CODES`（api/boss.yaml）。
  //    配置侧保持「人只填中文城市名」，由 BOSS_CITY_CODE_MAP 自动翻译，避免手写数字出错。
  //    `-2` = 全国（表外城市的兜底，避免传错编码导致搜索空结果）。
  bossCity: process.env.SCREENER_CITY || process.env.SCREENER_CITY_CODE || "北京",
  bossCityCode: resolveBossCityCode(),

  // 结构化筛选（对应 hr candidates 的选项；留空则不传该参数）
  // experience: "经验区间编码，如 -1,-1（不限）/ -3,-3（应届）"
  // degree:     "学历编码，如 201,201（本科）/ -1,-1（不限）"
  // activeness: "活跃度，如 2"
  bossFilters: {
    experience: process.env.BOSS_EXPERIENCE || "",
    degree: process.env.BOSS_DEGREE || "",
    activeness: process.env.BOSS_ACTIVENESS || "",
    salary: process.env.BOSS_SALARY || "",
  },
  searchLimit: 20,   // 每组搜索翻页上限（每页约 10–15 条，翻 searchLimit/10 页）
  perPage: 10,       // BOSS 候选人搜索每页条数（用于换算页数）

  // ---- 搜索关键词组（默认为通用销售岗示例；实际以画像为准。BOSS 建议 2–4 个词组）----
  keywordGroups: [
    { name: "组1-职能", kw: "销售经理 B2B" },
    { name: "组2-大客户", kw: "大客户销售" },
    { name: "组3-渠道", kw: "渠道销售" },
    { name: "组4-解决方案", kw: "解决方案销售" },
  ],

  // ---- 总量控制（BOSS 风控比猎聘更严，默认值更保守）----
  maxResumesPerRun: 20,    // 单次运行最多查看简历详情数（BOSS 逐份看简历较敏感）
  maxRequestsPerDay: 120,  // 单日请求上限（本岗位所有请求计数，风控兜底层）
  globalMaxResumeViewsPerDay: DEFAULT_GLOBAL_VIEWS, // 全局跨岗位"成功浏览简历"日硬顶（与 maxRequestsPerDay 是两层）
  workingWindow: ["08:00", "20:00"], // 工作时间窗口（本地时间；画像不可覆盖，解析与优先级见下方窗口块）
  maxConsecutiveErrors: 3, // 连续一般错误即熔断

  // ---- 随机间隔（秒，编排层兜底节流）----
  // ⚠️ boss-agent-cli 自带 RequestThrottle（高斯延迟 1.5–3s + 突发惩罚 4–7s），
  //    这里的间隔是在其之上的**额外**编排层等待，两者叠加。默认比猎聘更保守。
  // v2.9.7 节奏纠偏（2026-10-30 用户二次拍板）：不是要快，是要「回到旧节奏」——CLI v3.1.0 的
  // 30-60s 请求节流保持官方默认不动（防识别保护，压小反而像脚本）；本层间隔恢复接近 v2.8.5 原值。
  // 简历浏览不走 CLI（纯 CDP），节奏完全由简历间隔决定 → 恢复原值即与旧节奏一致；
  // 翻页 = CLI 30-60s（内含）+ 本层小间隔做随机化补偿，总体接近旧的 [20,40]+1.5-3s 体感。
  intervals: {
    betweenSearches: [8, 15],    // 搜索/推荐翻页之间（CLI 已内含 30-60s，本层只补随机性；旧值 [20,40]）
    betweenResumes: [15, 35],    // 简历详情之间（恢复 v2.8.5 原值——浏览不走 CLI，此值即真实节奏）
    longBreak: [40, 100],        // 搜索与查看之间长休息（恢复原值）
  },

  // ---- 四维打分模型（满分 100）—— 与猎聘保持一致，同一画像可复用 ----
  // 默认为通用销售岗示例，实际岗位请在画像里覆盖。
  scoring: {
    domain: {
      label: "销售领域",
      weight: 30,
      rules: [
        { label: "大客户/B2B销售", keywords: ["大客户", "KA", "B2B", "To B", "解决方案销售", "企业客户", "key account"], score: 15 },
        { label: "渠道/代理销售", keywords: ["渠道销售", "经销商", "代理商", "渠道拓展", "分销"], score: 10 },
      ],
      combine: "sum-cap",
      other: 0,
    },
    performance: {
      label: "业绩表现",
      weight: 30,
      contextWords: ["完成", "达成", "超额", "实现", "取得", "业绩", "销售额", "回款", "营收", "增长"],
      rules: [
        { label: "业绩突出", keywords: ["超额完成", "销冠", "销售冠军", "年度第一", "排名第一", "翻倍", "120%", "150%"], score: 18 },
        { label: "业绩达标", keywords: ["完成率", "达成率", "完成销售", "达成销售", "销售目标", "回款目标"], score: 12 },
      ],
      weakScore: 6,
      other: 0,
    },
    skills: {
      label: "核心技能",
      weight: 25,
      rules: [
        { label: "客户开发与谈判", keywords: ["新客户开发", "客户开拓", "商务谈判", "谈判", "签约", "拓客", "商机挖掘", "陌拜"], score: 13 },
        { label: "客户关系管理", keywords: ["客户维护", "客户关系", "CRM", "复购", "客户成功", "续约", "售后服务"], score: 12 },
      ],
      combine: "sum-cap",
      other: 0,
    },
    industry: {
      label: "行业背景",
      weight: 15,
      rules: [
        { label: "B2B/企业服务", keywords: ["SaaS", "企业服务", "软件", "制造业", "工业品", "咨询服务", "云计算"], score: 8 },
        { label: "相关行业", keywords: ["互联网", "快消", "零售", "医疗", "金融", "教育"], score: 7 },
      ],
      combine: "sum-cap",
      other: 0,
    },
  },

  gradeBands: [
    { min: 80, grade: "S" },
    { min: 60, grade: "A" },
    { min: 40, grade: "B" },
    { min: 0, grade: "C" },
  ],

  // 报告入表门槛：默认 "C" = 全量收录（2026-10-30 用户拍板「报告不要门槛，都放进来」——
  // 此前默认 "A" 会把 B/C 挡在报告外，用户以为漏筛）。画像可钉 "A"/"S" 收紧。
  minReportGrade: "C",

  // 推荐去重：true = 同一候选人可再次进推荐报告（默认 false，同一岗位只推荐一次）
  allowDuplicateRecommendations: false,

  // 打招呼话术模板（报告「建议打招呼话术」列的生成源；v2.7.0 起 settings.greet 开启且 mode="job"
  // 时，greet.js 用同一渲染自动发送（授权制，见 greet.js）；实际岗位请在画像里覆盖）
  greetTemplate: (c) => {
    const m = module.exports;
    return `您好，看到您有${c.dim1 || "相关行业"}方向的${c.dim2 || "丰富"}经验。我们是${m.project || "我们公司"}，正在${m.city}招聘${m.jobTitle}，想和您进一步沟通，方便的话期待您的回复。`;
  },
};

// ---- 话术占位符渲染（v2.7.0 抽出导出）：画像字符串 greetTemplate 与 _user.json settings.greet.fixedText
//      共用同一套语义（{dim1..9} / {维度label} / {company} / {regionHits} / {carrierHits}），勿在别处另造替换 ----
function renderGreetPlaceholders(tpl, c = {}) {
  let out = tpl;
  for (let i = 1; i <= 9; i++) out = out.split(`{dim${i}}`).join(c[`dim${i}`] || "");
  Object.keys(c.dims || {}).forEach((label) => {
    out = out.split(`{${label}}`).join(c.dims[label] || "");
  });
  out = out.split("{company}").join(module.exports.project || "我们公司");
  out = out.split("{regionHits}").join(c.regionHits || "");
  out = out.split("{carrierHits}").join(c.carrierHits || "");
  return out;
}

// ---- 报告工作表名/文件名消毒（v2.12.0，BUG-2026-11-03 附带 bug）----
// 岗位原名常含 exceljs 工作表名禁字符（* ? : \ / [ ]）与 Windows 文件名禁字符（< > " | 等），
// 裸拼 jobTitle 会让 addWorksheet 抛错、文件名里的「/」被当目录分隔符。统一替换为「-」并按
// Excel 工作表名上限截 31 字符；两侧 report.js 的工作表名与报告文件名都走这里。
function sanitizeJobLabel(s) {
  return String(s ?? "")
    .replace(/[*?:\\/\[\]<>"|\x00-\x1f]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-\s]+|[-\s]+$/g, "")
    .slice(0, 31)
    .replace(/[-\s]+$/, "");
}

// ---- 用户背景档案：profiles/_user.json（run.bat 首次引导或 AI 会话生成；与猎聘共用）----
// 存在时：公司名替换内置默认 project（随后画像 Object.assign 会自然覆盖 → 画像 > 档案 > 内置示例），
// 并暴露 cfg.userContext 供画像生成/AI 参考。找不到或 JSON 损坏一律静默回落（用户会拿记事本手改）。
try {
  const ucPaths = [
    path.resolve(process.cwd(), "profiles", "_user.json"),
    path.resolve(__dirname, "..", "..", "profiles", "_user.json"),
    path.resolve(__dirname, "..", "profiles", "_user.json"),
  ];
  const ucPath = ucPaths.find((f) => fs.existsSync(f));
  if (ucPath) {
    const uc = JSON.parse(fs.readFileSync(ucPath, "utf8"));
    if (uc && typeof uc === "object") {
      const companyName = typeof uc.companyName === "string" ? uc.companyName.trim() : "";
      if (companyName) module.exports.project = companyName;
      module.exports.userContext = {
        companyName,
        industry: typeof uc.industry === "string" ? uc.industry : "",
        businessSummary: typeof uc.businessSummary === "string" ? uc.businessSummary : "",
        commonCities: Array.isArray(uc.commonCities) ? uc.commonCities.map(String) : [],
      };
      module.exports.userSettings = uc.settings && typeof uc.settings === "object" ? uc.settings : {};
      if (companyName) console.error(`[config] 已加载用户背景: ${companyName}`);
    }
  }
} catch { /* 档案损坏则静默回落内置默认 */ }

// ---- 多岗位支持：JOB_PROFILE 指向岗位画像 JSON（与猎聘共用 profiles/ 目录）----
try {
  const raw = process.env.JOB_PROFILE;
  if (raw) {
    const base = path.basename(raw);
    const candidates = [
      path.resolve(raw),
      path.resolve(process.cwd(), "profiles", base),
      path.resolve(__dirname, "..", "..", raw),
      path.resolve(__dirname, "..", "..", "profiles", base),
      path.resolve(__dirname, "..", raw),
    ];
    const p = candidates.find((f) => fs.existsSync(f));
    if (p) {
      const prof = JSON.parse(fs.readFileSync(p, "utf8"));
      Object.assign(module.exports, prof);
      // 画像里话术模板写作字符串时，支持占位符 {dim1}..{dimN} / {company} / {regionHits} / {carrierHits}
      if (typeof module.exports.greetTemplate === "string") {
        const tpl = module.exports.greetTemplate;
        module.exports.greetTemplate = (c = {}) => renderGreetPlaceholders(tpl, c);
      }
      // 画像可带 bossCity / bossCityCode / bossFilters 覆盖平台默认值
      // ⚠️ 2026-10-21 真机修复：旧实现用「当前 bossCityCode 是否数字」当护栏——默认值本就是数字
      //    （北京 101010100），导致画像只写中文 bossCity 时翻译分支永远走不到，不设 SCREENER_CITY
      //    的路径（AI 手动命令）一直在**北京池**里搜（run.bat 因逐城设 env 不受影响）。
      //    新逻辑：画像写了数字 bossCityCode → 直接用；写了 bossCity（中文）→ 必须重新翻译；都没写 → 保持默认。
      if (prof.bossCityCode && /^-?\d+$/.test(String(prof.bossCityCode))) {
        module.exports.bossCityCode = String(prof.bossCityCode);
      } else if (prof.bossCity) {
        const _name = String(prof.bossCity).trim();
        module.exports.bossCityCode = BOSS_CITY_CODE_MAP[_name] || "-2";
        if (!BOSS_CITY_CODE_MAP[_name]) {
          console.warn(`[config] 画像 bossCity="${_name}" 不在城市表，城市码回落 -2（全国）`);
        }
      }
      console.error(`[config] 已加载岗位画像: ${p}`);
    } else {
      console.warn(`[config] 未找到岗位画像 "${raw}"，改用默认配置。已查找以下位置:`);
      candidates.forEach((c) => console.warn(`  - ${c}`));
      const dir = path.resolve(__dirname, "..", "..", "profiles");
      if (fs.existsSync(dir)) {
        const list = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        if (list.length) console.warn(`  可用画像（${dir}）: ${list.join("、")}`);
      }
    }
  }
} catch (e) {
  console.warn(`[config] 加载岗位画像失败: ${e.message}，改用默认配置`);
}

// ---- 全局浏览配额：全局项画像不可覆盖（画像误写同名字段时强制回钉默认值）----
module.exports.globalMaxResumeViewsPerDay = DEFAULT_GLOBAL_VIEWS;
{
  const _v = Number(process.env.SCREENER_GLOBAL_DAILY_VIEWS);
  if (Number.isFinite(_v) && _v > 0) module.exports.globalMaxResumeViewsPerDay = Math.floor(_v);
}

// ---- 工作时间窗口：风控类全局项，画像不可覆盖（回钉，同上范式）----
// 优先级：env SCREENER_WORKING_WINDOW > _user.json settings.workingWindow > 默认 08:00–20:00。
// 非法值一律回落默认并 warn（宁紧勿松，绝不放宽到全天）。按本地时间（边界：起始含端、结束不含端）。
{
  const ww = require("./working-window");
  module.exports.workingWindow = [...ww.DEFAULT_WINDOW];
  const fromUser = module.exports.userSettings && module.exports.userSettings.workingWindow;
  if (fromUser) {
    const p = ww.parseWorkingWindow(fromUser);
    if (p.ok) module.exports.workingWindow = [p.start, p.end];
    else console.warn(`[config] _user.json 的 settings.workingWindow 非法（${JSON.stringify(fromUser)}：${p.reason}），回落默认 ${ww.DEFAULT_WINDOW.join("–")}`);
  }
  if (process.env.SCREENER_WORKING_WINDOW) {
    const pe = ww.parseWorkingWindow(process.env.SCREENER_WORKING_WINDOW);
    if (pe.ok) module.exports.workingWindow = [pe.start, pe.end];
    else console.warn(`[config] SCREENER_WORKING_WINDOW 非法（${pe.reason}），忽略`);
  }
}

// ---- 历史文件保留期（v2.11.0）：清理类全局项，画像不可覆盖（回钉，同上范式）----
// 优先级：env SCREENER_RETENTION_DAYS > _user.json settings.retentionDays > 默认 1 天；0=关断。
// 清理范围与永不清理清单见 cleanup.js（报告/去重索引/配额账本不动）；screener 启动时执行。
{
  const cl = require("./cleanup");
  const fromUser = module.exports.userSettings && module.exports.userSettings.retentionDays;
  if (fromUser !== undefined && cl.parseRetentionDays(fromUser) === null) console.warn(`[config] _user.json 的 settings.retentionDays 非法（${JSON.stringify(fromUser)}），回落默认 ${cl.DEFAULT_RETENTION_DAYS} 天`);
  if (process.env.SCREENER_RETENTION_DAYS !== undefined && cl.parseRetentionDays(process.env.SCREENER_RETENTION_DAYS) === null) console.warn(`[config] SCREENER_RETENTION_DAYS 非法（${JSON.stringify(process.env.SCREENER_RETENTION_DAYS)}），忽略`);
  module.exports.retentionDays = cl.resolveRetentionDays({ env: process.env, settings: module.exports.userSettings }).days;
}

// ---- 城市覆盖：SCREENER_CITY（中文名）已在 bossCity/bossCityCode 处解析；此处只同步显示名 ----
if (process.env.SCREENER_CITY) module.exports.city = process.env.SCREENER_CITY;

// ---- project 终检：画像留空/占位未改时回落用户背景的公司名 ----
// （手填 _template.json 不改 project 的用户，占位长文本会原样打进话术——这里兜住）
{
  const _p = String(module.exports.project || "").trim();
  if ((!_p || _p.startsWith("（")) && module.exports.userContext && module.exports.userContext.companyName) {
    module.exports.project = module.exports.userContext.companyName;
  }
}

// ---- 推荐去重开关：环境变量最高优先（1=强制允许重复 / 0=强制去重），否则用画像或默认值 ----
if (process.env.SCREENER_ALLOW_DUPLICATES === "1") module.exports.allowDuplicateRecommendations = true;
else if (process.env.SCREENER_ALLOW_DUPLICATES === "0") module.exports.allowDuplicateRecommendations = false;

// ---- 维度显示名兜底 ----
const DIM_LABEL_FALLBACK = {
  domain: "销售领域",
  performance: "业绩表现",
  skills: "核心技能",
  industry: "行业背景",
};
Object.entries(module.exports.scoring || {}).forEach(([key, dim]) => {
  if (dim && !dim.label) dim.label = DIM_LABEL_FALLBACK[key] || key;
});

// 城市码表导出（joblist.js 反查城市中文名用）
module.exports.bossCityCodeMap = BOSS_CITY_CODE_MAP;
// 话术占位符渲染导出（greet.js 对 settings.greet.fixedText 渲染复用）
module.exports.renderGreetPlaceholders = renderGreetPlaceholders;
module.exports.sanitizeJobLabel = sanitizeJobLabel;
