// 生成 Excel 推荐报告（BOSS 直聘版，单表全字段，按评分降序）
// 与猎聘版的差异：平台标识、简历链接格式、字段来源（BOSS 是结构化 JSON）
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
const DATA = path.join(ROOT, "data");
// 报告落点：SCREENER_REPORTS_DIR 统一收集到项目根 reports/（不设则落在数据目录下，保持旧行为）
const REPORTS = process.env.SCREENER_REPORTS_DIR || path.join(ROOT, "reports");
try {
  fs.mkdirSync(REPORTS, { recursive: true });
} catch {
  /* exists */
}
// v2.9.2 依赖自检（缺口①，2026-10-30 真机实测）：run.js 入口有 R-06 友好指引，但 AI/用户直调本脚本的
// 路径此前抛裸 MODULE_NOT_FOUND 栈 exit 1——首跑没装依赖时用户只看到崩溃，不知道该跑 setup.bat。
let ExcelJS;
try {
  ExcelJS = require("exceljs");
} catch (e) {
  console.error(`[错误] 缺少依赖 exceljs（${e && e.code === "MODULE_NOT_FOUND" ? "未安装" : e.message}）。生成 Excel 报告必需。`);
  console.error("  请先在项目根目录跑 node doctor.js（自动安装依赖，见其输出），或手动 npm install 后重跑；仍失败双击 setup.bat。");
  process.exit(1);
}

const gradeRank = { S: 0, A: 1, B: 2, C: 3 };
const GRADES_SET = new Set(["S", "A", "B", "C"]); // 精细评估账本里 grade 的合法集（防手写脏值进报告）
const PLATFORM_LABEL = cfg.platformLabel || "BOSS直聘";

// ---- 推荐去重索引：同一岗位同一候选人只进一次推荐报告 ----
// 作用域 = 当前数据目录（一岗一目录）；键 = "<平台>:<候选人ID>"。
// 与 screener 的 processed.json 职责正交：processed 防"重复请求"，本索引防"重复推荐"。
// 开关：画像/配置 allowDuplicateRecommendations（true=允许重复），环境变量 SCREENER_ALLOW_DUPLICATES=1/0 最高优先。
const PLATFORM = cfg.platform || "boss";
const INDEX_PATH = path.join(ROOT, "recommended-index.json");
const JOB_KEY = process.env.JOB_PROFILE
  ? path.basename(process.env.JOB_PROFILE).replace(/\.json$/i, "")
  : (cfg.jobTitle || "default");

function loadIndex() {
  try {
    const idx = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    if (idx && typeof idx === "object" && idx.entries && typeof idx.entries === "object") return idx;
    throw new Error("结构不符");
  } catch (e) {
    if (fs.existsSync(INDEX_PATH)) {
      const quarantine = INDEX_PATH.replace(/\.json$/i, `.corrupt-${Date.now()}.json`);
      try { fs.renameSync(INDEX_PATH, quarantine); } catch {}
      console.warn(`[去重] recommended-index.json 无法解析（${e.message}），已隔离为 ${path.basename(quarantine)}，从空索引重建`);
    }
    return { version: 1, jobKey: JOB_KEY, updatedAt: "", entries: {} };
  }
}
function saveIndex(idx) {
  idx.updatedAt = new Date().toISOString();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2));
}

// ---- 业绩量化检测（与猎聘版一致，用户要求：有业绩完成情况的标为重点关注）----
const PERF_PATTERNS = [
  { label: "业绩量化数据", re: /(销售业绩|业绩|销售额|销售目标|回款|营收|毛利)[^。；;\n]{0,25}?\d+(\.\d+)?\s*(万|亿|%|倍)/ },
  { label: "销冠/第一名", re: /销冠|销售冠军|年度第一|排名第一|冠军/ },
  { label: "超额完成", re: /超额/ },
  { label: "增长数据", re: /(同比增长|增长率|翻倍)[^。；;\n]{0,15}?\d/ },
  { label: "完成率/达成率", re: /(完成率|达成率|完成度)[^。；;\n]{0,20}?\d/ },
  { label: "优秀员工/标杆", re: /优秀员工|最佳销售|标杆/ },
  { label: "top sales", re: /top\s?sales|topsales/i },
];
function perfFlag(text) {
  const t = text || "";
  for (const p of PERF_PATTERNS) if (p.re.test(t)) return p.label;
  return "";
}

// ---- 硬筛（画像 opt-in）----
const DEGREE_RANK = {
  博士: 5, 硕士: 4, "MBA/EMBA": 4, 本科: 3, 大专: 2, "中专/中技": 1, 中专: 1, 中技: 1, 高中: 1, "初中及以下": 0,
};
const NON_QUANTONG = /自考|成教|成人教育|函授|夜大|网络教育|远程教育|电大|非全日制|在职研究生|在职硕士/;
function quantongRisk(text) {
  const m = String(text || "").match(NON_QUANTONG);
  return m ? `非统招?${m[0]}` : "";
}

// 抓取时间显示（ISO → 本地 YYYY-MM-DD HH:mm；缺失/非法 → 「—」，旧缓存无此字段时兼容）
function fmtFetchedAt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- BOSS 简历「搜索直达」链接（2026-10-21 终验；搜索词口径同时用于「搜索串」列）----
// 直达地址 = 搜索 iframe：/web/frame/search/?keywords=…（冷加载即已搜索，目标人通常第 1）。
// 通用精准化（URL 参数，适配所有岗位，2026-10-21 实证编码）：按候选人自身属性附加过滤——
//   学历 &degree=203,203（本科）/ 204,204（硕士）；应届/在校 &experience=-3,-3（大公司热门词下
//   应届会被社招挤到后面，如 腾讯+数据分析师；学历过滤同理进一步收窄）。未实证的编码一律不加，宁缺毋滥。
const bossNameUsable = (name) =>
  !!name && name !== "（详见BOSS）" && !/^[\s*＊·—–-]+$/.test(name);
// 脱敏称呼剥星取「人名词」：冯**→冯、欧阳**→欧阳（1–3 个纯汉字；「某」开头或含「先生/女士」
// 不采用，防「某先生」类形态污染搜索词）。***、（详见BOSS）、— 等形态剥不出 → ""。
const bossNameToken = (name) => {
  const t = String(name || "").replace(/[*＊·\s]/g, "");
  return /^[一-龥]{1,3}$/.test(t) && !/^某/.test(t) && !/先生|女士/.test(t) ? t : "";
};
const bossCleanCompany = (company) =>
  String(company || "")
    .replace(/[（(][^）)]*[）)]/g, "") // 去括号段（（深圳）/（Suzhou）等）
    // 去公司后缀——⚠️ 完整公司名（含"有限公司"）会触发搜索的"公司直达"模式，experience 参数被吞
    //（2026-10-21 对照实证：腾讯科技有限公司+经验+学历→应届被滤掉；腾讯科技+同参数→正常）
    .replace(/(股份有限公司|有限责任公司|有限公司|集团有限公司|集团)$/, "")
    .replace(/\s+/g, " ").trim();
// 常见复姓表（真名→姓 提取用；覆盖绝大多数场景，表外复姓按单姓取首字，公司+职位仍能缩池）
const COMPOUND_SURNAMES = ["欧阳","司马","上官","诸葛","东方","夏侯","皇甫","尉迟","公孙","长孙","慕容","司徒","司空","申屠","令狐","宇文","轩辕","呼延","端木","南宫"];
function surnameOf(name) {
  const t = String(name || "").replace(/\s+/g, "");
  if (!/^[一-龥]{2,4}$/.test(t)) return "";
  if (COMPOUND_SURNAMES.includes(t.slice(0, 2))) return t.slice(0, 2);
  return t.slice(0, 1);
}
// 搜索词构造（2026-10-29 收敛为单一实证格式：姓 + 清洗公司 + 职位）：
//   称呼带星 → 姓（剥星）；真名（推荐来源）→ 姓（复姓取前两字）——此前真名走「姓名+职位」分支，
//   2026-10-29 用户实测该形态在沟通页搜索**搜不到人**（v2.8.2 还误标"真名直用更好搜"，未实测的错判，
//   已纠正）；剥不出人名 → 清洗公司 + 职位（兜底）。
function bossSearchQuery(name, title, company) {
  const t = String(title || "").trim();
  if (/[*＊]/.test(String(name || ""))) {
    const tok = bossNameToken(name);
    if (tok) return [tok, bossCleanCompany(company), t].filter(Boolean).join(" ");
  } else if (bossNameUsable(name)) {
    const tok = surnameOf(name);
    if (tok) return [tok, bossCleanCompany(company), t].filter(Boolean).join(" ");
  }
  return `${bossCleanCompany(company)} ${t}`.trim();
}

const pick = (obj, keys) => {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return "";
};

(async () => {
  const results = JSON.parse(fs.readFileSync(path.join(DATA, "last-results.json"), "utf8"));

  // ---- 截图转写门槛（v2.10.0，退出码 7）：待转写者回填文本前拒出报告 ----
  // 判据与 ocr-batch/llm-batch 同款：缓存 images 非空且 text 为空。截图模式下未转写者评分恒 0/C，
  // 出报告只会误导——与 exit 6 精评门槛同款纪律：前置条件不满足就拒绝，不静默降级。
  {
    const pend = [];
    for (const r of results) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(DATA, "resumes", `${r.id}.json`), "utf8"));
        if (Array.isArray(c.images) && c.images.length && !String(c.text || "").trim()) pend.push(r.id);
      } catch { /* 无缓存按旧逻辑走（enrich 阶段留空） */ }
    }
    if (pend.length) {
      console.error(`[转写未完成] 本轮 ${pend.length} 份简历已截图但尚未转写（${pend.slice(0, 5).join("、")}${pend.length > 5 ? "…" : ""}）——此时评分全为 0/C，按契约不出报告。`);
      console.error(`  先完成转写：node ocr-batch.js status 看进度 → next 吐批 → AI 会话读图转写为纯文本 → save 落盘，循环至完成；`);
      console.error(`  然后：node screener.js rescore 重算评分 → 重跑本命令出报告。`);
      process.exit(7);
    }
  }

  // ---- LLM 精细评估账本（可选，v2.6.0）：llm-batch.js save 落盘 ----
  // 有则「等级/评分」按精细评估口径（过滤与排序同口径），规则分降为「规则对照」列；
  // 未评估的候选人用规则分兜底（匹配依据列标「未精细评估」），不糊弄不阻塞。
  const LLM_SCORES = (() => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA, "llm-scores.json"), "utf8"));
      return d && d.entries && Object.keys(d.entries).length ? d : null;
    } catch {
      return null;
    }
  })();
  const hasLlm = !!LLM_SCORES;
  const llmOf = (id) => (hasLlm && LLM_SCORES.entries[id]) || null;
  const finalGrade = (r) => {
    const e = llmOf(r.id);
    return e && GRADES_SET.has(e.grade) ? e.grade : r.score.grade;
  };
  const finalTotal = (r) => {
    const e = llmOf(r.id);
    return e && typeof e.total === "number" ? e.total : r.score.total;
  };

  // ---- 评估档位机器强制（v2.9.0，BUG-2026-10-30 P0）：档案选了精细，不许静默降级出报告 ----
  // 与档案缺失 exit 4 / 打招呼未授权 exit 5 同款纪律：前置条件不满足就拒绝（退出码 6），
  // 不依赖"AI 应该会跑 llm-batch"的假设——该假设已被 2026-10-30 实证证伪（选精细的用户拿到全规则分）。
  const prefDetailed = (cfg.userSettings && cfg.userSettings.scoringPreference) === "detailed";
  const llmCovered = hasLlm ? results.filter((r) => llmOf(r.id)).length : 0;
  if (prefDetailed && process.env.SCREENER_FORCE_FAST !== "1" && llmCovered < results.length) {
    console.error(`[精细评估未完成] 档案评估方式=精细（settings.scoringPreference="detailed"），本轮 ${results.length} 份中仅 ${llmCovered} 份完成 LLM 评估——按契约不静默降级为关键词分出报告。`);
    console.error(`  先完成评估：node llm-batch.js status 看进度 → next 吐批 → AI 会话批内输出全部评估 JSON → save 落账（详见 SKILL.md「精细评估」节），循环至全部已评后重跑本命令。`);
    console.error(`  或显式降级（不推荐、不改档案）：SCREENER_FORCE_FAST=1；或把档案 settings.scoringPreference 改为 "fast"。`);
    process.exit(6);
  }

  // ---- 打招呼运行账本（可选，v2.7.0）：greet.js 每轮落盘 data/greet-run.json，无则整列为空 ----
  const GREET_RUN = (() => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA, "greet-run.json"), "utf8"));
      return d && Array.isArray(d.results) ? d : null;
    } catch {
      return null;
    }
  })();
  const greetRunOf = (id) => (GREET_RUN ? GREET_RUN.results.find((o) => o.id === id) || null : null);
  const GREET_STATUS_LABEL = {
    sent: "已发送(已核验)",
    "sent-backfill": "已发送(上轮待核实·本轮补记)",
    unverified: "待核实(已防重发,请人工确认)",
    "dup-existing": "跳过·会话已存在",
    dry: "演练(未发送)",
    "manual-required": "未发(需手动)",
    dup: "跳过·已打过招呼",
    "no-msg": "跳过·话术未配置",
    "invalid-msg": "跳过·话术校验未过",
    "over-limit": "超限未发",
    failed: "失败",
    stop: "本轮未发",
    skip: "跳过·参数不全",
  };
  const greetStatusOf = (id) => {
    const o = greetRunOf(id);
    if (!o) return "";
    const label = GREET_STATUS_LABEL[o.status] || o.status;
    return o.code ? `${label}(${o.code})` : o.note ? `${label}：${o.note}` : label;
  };

  const reportable = results
    .filter((r) => gradeRank[finalGrade(r)] <= gradeRank[cfg.minReportGrade])
    .sort((a, b) => finalTotal(b) - finalTotal(a));

  // ---- 同轮重出识别（v2.9.0，BUG-2026-10-30 BUG-2）：screener 每轮落盘 data/run-meta.json ----
  // 去重索引给每条记录记 runId：同一轮筛选重出报告（改话术/补数据）覆盖不跳过；新一轮才跳过已推荐者。
  // 旧索引条目无 runId / run-meta 缺失 → 一律视为"非本轮"，跳过（保持跨轮去重，不误放旧人）。
  const currentRunId = (() => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(DATA, "run-meta.json"), "utf8"));
      return m && m.runId != null ? String(m.runId) : undefined;
    } catch {
      return undefined;
    }
  })();

  // ---- 推荐去重过滤：已进过推荐报告的候选人不再出现（放在 enrich 前，省去为旧人读缓存）----
  const index = loadIndex();
  const allowDup = cfg.allowDuplicateRecommendations === true;
  const skippedDup = [];
  const fresh = allowDup
    ? reportable
    : reportable.filter((r) => {
        const old = index.entries[`${PLATFORM}:${r.id}`];
        if (old && old.runId !== currentRunId) { skippedDup.push({ r, old }); return false; }
        return true;
      });

  const RF = cfg.reportFilters || null;

  const enriched = fresh.map((r) => {
    let cache = null;
    try {
      cache = JSON.parse(fs.readFileSync(path.join(DATA, "resumes", `${r.id}.json`), "utf8"));
    } catch {
      /* 无缓存则留空 */
    }
    const rtext = (cache && cache.text) || "";
    // v2.10.0：牛人分析器（geek/info/v2 的 zpData.jobCompetitive 明文，截图采集时网络层回收）
    const insight = (cache && String(cache.bossInsight || "").trim()) || "";
    const f = r.fields || {};
    return {
      r,
      f,
      rtext,
      insight,
      age: f.age || "—",
      // v2.14.0：学历缺失明示（BOSS 搜索卡 geekDegree 常缺，v2.10.0 实证）；硬筛不误剔未知者
      degree: String(f.degree || "").trim() || "未知(缺失)",
      perf: perfFlag(rtext),
      risk: quantongRisk(rtext),
    };
  });

  const dropped = [];
  const rows = !RF
    ? enriched
    : enriched.filter((e) => {
        const why = [];
        if (RF.ageMax) {
          const a = parseInt(e.age, 10);
          if (a && a > RF.ageMax) why.push(`年龄${a}>${RF.ageMax}`);
        }
        if (RF.minDegree) {
          const need = DEGREE_RANK[RF.minDegree] ?? 3;
          // 学历未知不参与硬筛：宁保留人工判断，不误剔（v2.10.0 遗留缺口 v2.14.0 修复）
          if (e.degree !== "未知(缺失)" && (DEGREE_RANK[String(e.degree).trim()] ?? 0) < need) why.push(`学历${e.degree}<${RF.minDegree}`);
        }
        if (RF.requireDimHits) {
          for (const [dim, labels] of Object.entries(RF.requireDimHits)) {
            const hits = (e.r.score.parts?.[dim]?.hits) || [];
            const ok = Array.isArray(labels) && labels.length ? labels.some((l) => hits.includes(l)) : hits.length > 0;
            if (!ok) why.push(`未命中硬性维度 ${dim}`);
          }
        }
        if (why.length) {
          dropped.push(`${e.f.name || e.r.id}（${why.join("、")}）`);
          return false;
        }
        return true;
      });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(cfg.sanitizeJobLabel(`${cfg.jobTitle}推荐`)); // v2.12.0：jobTitle 含 / 等禁字符会让 exceljs 抛错

  const dims = Object.entries(cfg.scoring || {}).map(([key, d]) => ({ key, label: d.label || key }));
  // LLM 模式插两列：「规则对照」在评分后（后续列右移 off=1），「匹配依据」在维度列后
  const off = hasLlm ? 1 : 0;
  const header = [
    "排名", "等级", "评分",
    ...(hasLlm ? ["规则对照(快速)"] : []),
    "称呼", "BOSS简历(搜索直达)", "搜索串(沟通页搜索)", "抓取时间",
    "当前公司", "现任职位", "期望城市", "年龄", "学历", "年限", "牛人分析", "重点关注", "统招风险(需核实)",
    ...dims.map((d) => `${d.label}（${cfg.scoring[d.key].weight}分）`),
    ...(hasLlm ? ["匹配依据(精细评估)"] : []),
    "来源关键词",
    "打招呼",
    `建议打招呼话术（${PLATFORM_LABEL}）`,
  ];
  // 首行档位自证（v2.9.0，BUG-2026-10-30 修复C）：分数口径必须一眼可辨——快速/精细/混合各自标明，
  // 杜绝"以为拿到的是精细分"。口径按实际覆盖数算（不由偏好宣称），FORCE_FAST 降级时见终端提示。
  const tierText = results.length && llmCovered === results.length
    ? `精细（LLM 语义评估 ${llmCovered}/${results.length} 份）`
    : llmCovered > 0
      ? `精细+规则兜底（LLM 语义评估 ${llmCovered}/${results.length} 份，其余按关键词规则分）`
      : `快速（关键词规则引擎）`;
  const tierRow = ws.addRow([`评估方式：${tierText}`]);
  tierRow.getCell(1).font = { bold: true };

  const hRow = ws.addRow(header);
  hRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  hRow.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00A6A7" } }; // BOSS 品牌青色
    c.alignment = { vertical: "middle", horizontal: "center" };
  });
  ws.mergeCells(1, 1, 1, 8); // 档位自证行合并前 8 列（与冻结窗格 ySplit=2 配套）

  rows.forEach((e, i) => {
    const { r, f, age, degree, perf, risk, insight } = e;
    const company = f.company || "—";
    const title = f.title || "—";
    const city = f.city || cfg.city;
    const p = r.score.parts || {};
    const dimHits = (k) => ((p[k] && p[k].hits) || []).join("、") || "—";
    const greetVars = { dims: {} };
    dims.forEach((d, idx) => {
      const hits = ((p[d.key] && p[d.key].hits) || []).join("/");
      greetVars[`dim${idx + 1}`] = hits;
      greetVars.dims[d.label] = hits;
    });
    greetVars.regionHits = greetVars.dim1 || "";
    greetVars.carrierHits = greetVars.dim2 || "";
    // v2.7.0：开启了自动打招呼且选固定话术时，本列渲染 fixedText（列内容 = 实际发送内容，
    // 同一占位符语义）；未开启/按岗位建议话术时维持原样（画像 greetTemplate / 内置默认）。
    const greet = (() => {
      const g = cfg.userSettings && cfg.userSettings.greet;
      if (g && g.enabled === true && g.mode === "fixed" && String(g.fixedText || "").trim()) {
        return cfg.renderGreetPlaceholders(g.fixedText, greetVars);
      }
      return typeof cfg.greetTemplate === "function" ? cfg.greetTemplate(greetVars) : String(cfg.greetTemplate || "");
    })();

    // 「称呼」= 搜索卡片上的名字（如 冯**）——简历接口的姓名是 ***（平台脱敏，删除该列只留称呼）。
    // 在搜索结果里按「称呼+年限+年龄」对照卡片定位目标人（搜索排序由平台决定，不承诺排最前）。
    const cardName = (r.ids && r.ids.name) || "—";
    // ⚠️ 搜索词以「称呼」为人名来源（详情接口姓名恒 ***，从它永远拼不出人名）：
    //    带星剥姓 → 姓+清洗公司+职位（bossSearchQuery 三分支，与链接同词）。
    const searchStr = bossSearchQuery(cardName, title, company);
    const workYears = (r.fields && r.fields.workYears) || (r.structured && r.structured.basic && r.structured.basic.work_years) || "—";
    // 精细评估呈现（v2.6.0）：等级/评分用最终口径；规则对照列；匹配依据 = 各维理由+首条原文摘录+总评
    const llm = llmOf(r.id);
    const llmBasis = (() => {
      if (!hasLlm) return "";
      if (!llm) return "未精细评估（按规则分）";
      const segs = dims
        .map((d) => {
          const p = llm.parts && llm.parts[d.key];
          if (!p || typeof p !== "object") return "";
          const ev = Array.isArray(p.evidence) && p.evidence[0] ? `「${String(p.evidence[0]).slice(0, 60)}」` : "";
          return `${d.label}：${p.reason || ""}${ev}`;
        })
        .filter(Boolean)
        .join("；");
      return (segs ? segs + (llm.summary ? `｜总评：${llm.summary}` : "") : llm.summary || "（评估未含依据文本）").slice(0, 400);
    })();
    const row = ws.addRow([
      i + 1, finalGrade(r), finalTotal(r),
      ...(hasLlm ? [`${r.score.grade} ${r.score.total}`] : []),
      cardName, "", searchStr, fmtFetchedAt(r.fetchedAt),
      company, title, city, age, degree, workYears,
      insight ? insight.slice(0, 200) : "—", // 牛人分析器（平台明文，含活跃时间/浏览行为等）
      perf ? `★ ${perf}` : "—", risk ? `⚠ ${risk}` : "—",
      ...dims.map((d) => dimHits(d.key)),
      ...(hasLlm ? [llmBasis] : []),
      r.group || "",
      greetStatusOf(r.id),
      greet,
    ]);

    // 「BOSS简历」列（第 5 列，LLM 模式右移 off）：沟通页搜索入口。v2.8.2：旧 frame/search 直达链接
    // 的卡片不可交互（2026-10-29 用户实测：点名字不弹在线简历、点「联系」无反应——平台把内嵌搜索做成
    // 只读展示），改为直达沟通页搜索（web/chat/search 卡片可点开简历/可联系），配合「搜索串」列粘贴。
    const linkCell = row.getCell(5 + off);
    const ids = r.ids || {};
    linkCell.value = { text: "去沟通页搜索", hyperlink: `https://www.zhipin.com/web/chat/search` };
    linkCell.font = { color: { argb: "FF0563C1" }, underline: true };
    linkCell.alignment = { vertical: "middle", horizontal: "center" };
    // 末列备注：搜索步骤 + 对照确认 + 收费提示 + 原始 ID
    row.getCell(header.length).note =
      `点「去沟通页搜索」打开 BOSS 沟通页搜索（需浏览器已登录 BOSS）\n` +
      `把搜索串「${searchStr}」粘进搜索框回车（结果太少可删去公司名再搜）\n` +
      `按「称呼 ${cardName} + 年限 ${workYears} + 年龄 ${age}」对照卡片确认，点卡片可看在线简历、点「联系」可沟通\n` +
      `⚠️ 平台规则：对搜索找到的人点「联系」会弹「搜索畅聊卡」购买（约 ¥10+/人）；推荐来源的候选人免费\n` +
      `geek_id=${ids.geekId || "-"}  job_id=${ids.jobId || "-"}`;

    const gCell = row.getCell(2);
    gCell.font = { bold: true, color: { argb: finalGrade(r) === "S" ? "FFC00000" : "FFE36C09" } };
    if (perf) row.getCell(15 + off).font = { bold: true, color: { argb: "FFC00000" } };
    if (risk) row.getCell(16 + off).font = { bold: true, color: { argb: "FFE36C09" } };
    row.alignment = { vertical: "middle" };
  });

  const baseWidths = [5, 6, 6, 10, 14, 22, 16, 24, 22, 10, 8, 8, 8, 28, 16, 16];
  const widths = [
    ...baseWidths.slice(0, 3), ...(hasLlm ? [12] : []), ...baseWidths.slice(3),
    ...dims.map(() => 20), ...(hasLlm ? [40] : []), 16, 18, 60,
  ];
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
  ws.views = [{ state: "frozen", ySplit: 2 }]; // 2 = 档位自证行 + 表头（v2.9.0 起首行为档位标注）

  // 第二工作表：本次因去重跳过的候选人明细（方便核对"为什么某人没出现"）
  if (skippedDup.length) {
    const ws2 = wb.addWorksheet("已推荐过(本次跳过)");
    const h2 = ws2.addRow(["姓名", "等级", "评分", "首次推荐时间", "来源报告"]);
    h2.font = { bold: true };
    skippedDup.forEach((d) => ws2.addRow([
      d.r.fields?.name || d.r.id,
      d.old.grade || d.r.score.grade,
      d.old.score ?? d.r.score.total,
      (d.old.firstRecommendedAt || "").replace("T", " ").slice(0, 16),
      d.old.reportFile || "",
    ]));
    [12, 8, 8, 18, 44].forEach((w, i) => { ws2.getColumn(i + 1).width = w; });
  }

  const out = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(REPORTS, `${new Date().toISOString().slice(0, 10)}_${PLATFORM_LABEL}_${cfg.sanitizeJobLabel(cfg.jobTitle)}_推荐报告.xlsx`);
  await wb.xlsx.writeFile(out);

  // ---- 写索引：报告成功生成后才记录（报告失败则下次重跑会重新收录，失败模式安全）----
  // 同轮重出时刷新既有条目（runId/等级/评分/报告名），firstRecommendedAt 保留首推时间（BUG-2026-10-30 BUG-2）。
  rows.forEach((e) => {
    const key = `${PLATFORM}:${e.r.id}`;
    const ex = index.entries[key];
    index.entries[key] = {
      id: e.r.id,
      name: e.f.name || (e.r.ids && e.r.ids.name) || e.r.id,
      platform: PLATFORM,
      jobKey: JOB_KEY,
      grade: finalGrade(e.r), // 推荐索引记最终口径（精细评估优先，无则规则）——去重看人不看口径
      score: finalTotal(e.r),
      firstRecommendedAt: (ex && ex.firstRecommendedAt) || new Date().toISOString(),
      lastRecommendedAt: new Date().toISOString(),
      reportFile: path.basename(out),
      runId: currentRunId, // 最后一次进报告的轮次：同轮重出不跳过、跨轮才跳过
    };
  });
  saveIndex(index);

  console.log(`已生成: ${out}`);
  console.log(`[报告] 评估方式：${tierText}`);
  if (prefDetailed && process.env.SCREENER_FORCE_FAST === "1") {
    console.log("[报告] 注意：档案偏好为精细，本次被 SCREENER_FORCE_FAST=1 显式降级为快速档（一次性，不改档案）。");
  }
  console.log("提示：「BOSS简历」列点开即直达搜索结果（已登录 BOSS 的浏览器），目标人通常排第 1——按 称呼+年限 对照点卡片。");
  if (GREET_RUN) {
    const n = GREET_RUN.results.filter((o) => o.status === "sent").length;
    console.log(`[报告] 打招呼：本轮已自动发送 ${n} 条${GREET_RUN.dry ? "（演练模式，未真发）" : ""}，逐人状态见「打招呼」列；全局账本 data/_quota/boss-greet.json。`);
  }
  if (hasLlm) {
    const n = rows.filter((e) => llmOf(e.r.id)).length;
    console.log(`[报告] 精细评估口径：${n}/${rows.length} 名入表候选人有 LLM 评估，其余按规则分（匹配依据列已标注）。`);
  }
  console.log(
    `共 ${rows.length} 名候选人（S ${rows.filter((e) => finalGrade(e.r) === "S").length} / A ${rows.filter((e) => finalGrade(e.r) === "A").length} / B ${rows.filter((e) => finalGrade(e.r) === "B").length} / C ${rows.filter((e) => finalGrade(e.r) === "C").length}）`
  );
  if (dropped.length) {
    console.log(`已按画像硬筛剔除 ${dropped.length} 人：`);
    dropped.slice(0, 30).forEach((d) => console.log(`  - ${d}`));
    if (dropped.length > 30) console.log(`  …还有 ${dropped.length - 30} 人`);
  }
  if (skippedDup.length) {
    console.log(`已跳过 ${skippedDup.length} 条已推荐过的简历（同一岗位同一候选人只推荐一次）：`);
    skippedDup.slice(0, 10).forEach((d) =>
      console.log(`  - ${d.r.fields?.name || d.r.id}（${d.old.grade || "?"}级，首次推荐 ${(d.old.firstRecommendedAt || "").slice(0, 10)}）`));
    if (skippedDup.length > 10) console.log(`  …还有 ${skippedDup.length - 10} 条`);
    console.log(`  如需重复推荐：岗位画像里加 "allowDuplicateRecommendations": true，或设环境变量 SCREENER_ALLOW_DUPLICATES=1`);
  }
})();
