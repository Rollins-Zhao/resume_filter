// 猎聘自动筛选配置（这里是默认岗位；多岗位请用 JOB_PROFILE 指向 profiles/<岗位名>.json）
// 策略依据：只读筛选 + 人工触达（greet 一律由用户在官网手动完成）

const fs = require("fs");
const path = require("path");
const os = require("os");

// ---- liepin-cli 可执行文件探测 ----
// 不写死本机路径，整个项目文件夹搬给别人也能直接跑。
// 优先级：LIEPIN_BIN 环境变量 → 项目内 node_modules/.bin → 脚本上级 node_modules/.bin
//        → WorkBuddy 托管 node 工作区 → 交给系统 PATH 解析 "liepin"
function resolveLiepinBin() {
  if (process.env.LIEPIN_BIN) return process.env.LIEPIN_BIN;
  const names = process.platform === "win32" ? ["liepin.cmd", "liepin.exe", "liepin.bat"] : ["liepin"];
  const dirs = [
    path.resolve(process.cwd(), "node_modules", ".bin"),
    path.resolve(__dirname, "..", "node_modules", ".bin"),
    path.join(os.homedir(), ".workbuddy", "binaries", "node", "workspace", "node_modules", ".bin"),
  ];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* 忽略探测异常 */
      }
    }
  }
  return "liepin";
}

// 全局跨岗位"成功浏览简历"日硬顶（quota-global.js 记账，data/_quota/liepin.json）
const DEFAULT_GLOBAL_VIEWS = 1000;

module.exports = {
  // ---- 平台标识（报告/日志里显式写明，避免与 BOSS 混淆）----
  platform: "liepin",
  platformLabel: "猎聘",

  // ---- 岗位信息（默认值仅作通用兜底示例；实际岗位请用 JOB_PROFILE 指向 profiles/<岗位>.json）----
  jobTitle: "销售经理",
  project: "示例项目",
  city: "北京",

  // ---- liepin-cli 路径（自动探测，可用 LIEPIN_BIN 覆盖）----
  liepinBin: resolveLiepinBin(),

  // ---- 搜索关键词组（默认为通用销售岗示例；实际以画像为准）----
  keywordGroups: [
    { name: "组1-职能", kw: "销售经理 B2B" },
    { name: "组2-大客户", kw: "大客户销售" },
    { name: "组3-渠道", kw: "渠道销售" },
    { name: "组4-解决方案", kw: "解决方案销售" },
    { name: "组5-核心动作", kw: "客户开发" },
  ],
  searchLimit: 20, // 每组搜索返回条数上限

  // ---- 总量控制 ----
  maxResumesPerRun: 30,   // 单次运行最多查看简历详情数
  maxRequestsPerDay: 200, // 单日请求上限（本岗位所有请求计数，风控兜底层）
  globalMaxResumeViewsPerDay: DEFAULT_GLOBAL_VIEWS, // 全局跨岗位"成功浏览简历"日硬顶（与 maxRequestsPerDay 是两层）
  workingWindow: ["08:00", "20:00"], // 工作时间窗口（本地时间；画像不可覆盖，解析与优先级见下方窗口块）
  maxConsecutiveErrors: 3,// 连续一般错误即熔断

  // ---- 随机间隔（秒，编排层兜底节流）----
  // 2026-10-27 猎聘风控事故调参（浏览 20 份在第 15 份触发风控，WorkBuddy 诊断=浏览频率过高）：
  // 简历间放慢约 2.4 倍，另加「每 restEvery 份歇一口气」，拉长单轮总时长换稳定性。
  intervals: {
    betweenSearches: [20, 40],   // 搜索之间
    betweenResumes: [25, 55],    // 简历详情之间（原 [10, 25]）
    betweenPages: [20, 35],      // 翻页之间
    longBreak: [60, 150],        // 搜索与查看之间穿插长休息（原 [30, 90]）
    restBreak: [60, 180],        // 每连续成功浏览 restEvery 份后的「歇口气」
  },
  restEvery: 5, // 连看 N 份歇一口气（与 intervals.restBreak 配套）

  // ---- 四维打分模型（满分 100；默认为通用销售岗示例，实际岗位请在画像里覆盖）----
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
      weakScore: 6, // 整篇提及业绩词但无成果语境
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

  // 分级阈值
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

  // 打招呼话术模板（仅供用户复制到猎聘官网，脚本绝不自动发送；实际岗位请在画像里覆盖）
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

// ---- 用户背景档案：profiles/_user.json（run.bat 首次引导或 AI 会话生成）----
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

// ---- 多岗位支持：JOB_PROFILE 指向岗位画像 JSON ----
// 岗位画像存放在 skill 外部（随工作目录一起迁移），skill 包内不含任何岗位数据。
// 用法：JOB_PROFILE="profiles/海外仓运营经理.json" node <skill>/scripts/screener.js
// 查找顺序：① 绝对/相对当前目录 ② skill 上级目录 ③ skill 目录 ④ 上述位置的 profiles/ 子目录
try {
  const fs = require("fs");
  const path = require("path");
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
      Object.assign(module.exports, JSON.parse(fs.readFileSync(p, "utf8")));
      // 画像中话术模板写作字符串，支持占位符：
      //   {dim1}..{dimN} —— 按 scoring 维度顺序（通用，推荐）
      //   {company} —— 用户背景档案的公司名（profiles/_user.json；画像未写 project 时取档案值）
      //   {regionHits} / {carrierHits} —— 兼容旧模板（= 第 1 / 第 2 个维度）
      if (typeof module.exports.greetTemplate === "string") {
        const tpl = module.exports.greetTemplate;
        module.exports.greetTemplate = (c = {}) => renderGreetPlaceholders(tpl, c);
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

// ---- 城市覆盖：SCREENER_CITY 环境变量优先级最高（高于画像与默认值）----
// 用途：同一份画像跑多个城市时避免复制多份内容相同的画像文件
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

// ---- 维度显示名兜底：画像未定义 label 时用内置映射，保证报告列名可读 ----
const DIM_LABEL_FALLBACK = {
  domain: "销售领域",
  performance: "业绩表现",
  skills: "核心技能",
  industry: "行业背景",
};
Object.entries(module.exports.scoring || {}).forEach(([key, dim]) => {
  if (dim && !dim.label) dim.label = DIM_LABEL_FALLBACK[key] || key;
});

// 话术占位符渲染导出（与 boss 侧镜像；猎聘侧话术仍仅供手动发送，本导出保持结构对齐）
module.exports.renderGreetPlaceholders = renderGreetPlaceholders;
module.exports.sanitizeJobLabel = sanitizeJobLabel;
