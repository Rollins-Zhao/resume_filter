// 生成 Excel 精简版推荐报告（单表全字段，按评分降序）
// 用法：node report.js  [输出文件名.xlsx]
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
const DATA = path.join(ROOT, "data");
// 报告落点：SCREENER_REPORTS_DIR 统一收集到项目根 reports/（不设则落在数据目录下，保持旧行为）
const REPORTS = process.env.SCREENER_REPORTS_DIR || path.join(ROOT, "reports");
try { fs.mkdirSync(REPORTS, { recursive: true }); } catch {}
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

// ---- 推荐去重索引：同一岗位同一候选人只进一次推荐报告 ----
// 作用域 = 当前数据目录（一岗一目录）；键 = "<平台>:<候选人ID>"。
// 与 screener 的 processed.json 职责正交：processed 防"重复请求"，本索引防"重复推荐"。
// 开关：画像/配置 allowDuplicateRecommendations（true=允许重复），环境变量 SCREENER_ALLOW_DUPLICATES=1/0 最高优先。
const PLATFORM = cfg.platform || "liepin";
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

// ---- 业绩量化检测（用户要求：简历有业绩完成情况的标为重点关注）----
// 纯本地文本匹配，零网络。刻意要求「业绩词 + 量化语境」同时出现，
// 避免仅泛泛提到"业绩"二字就被误标（销售简历几乎人人写着"业绩"）。
// 按信息量从强到弱排序：命中即用第一个，量化数据优先于泛泛的"完成率"。
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
// 年龄兜底：搜索卡片无 age 时，从简历原文里抓「35岁」/「年龄：35」
function pickAge(searchObj, text) {
  const fromCard = String((searchObj && searchObj.age) || "").match(/\d{2}/);
  if (fromCard) return fromCard[0] + "岁";
  const m = (text || "").match(/(?:年龄[：:\s]*)?(\d{2})\s*岁/);
  return m ? m[1] + "岁" : "—";
}

// ---- 可选硬筛 + 统招风险提示（仅当画像定义了 reportFilters 时生效，不影响其他岗位）----
// 背景：猎聘搜索没有「本科及以上」语义——实测 `--degree 本科` 是「仅本科」，
// 会把硕士/博士一起滤掉；而「统招」连学历字段都看不出来，只能扫简历原文找负面证据。
// 所以：年龄仍交给搜索层（--age，已验证可靠），学历与必须命中的维度放到报告层过滤。
const DEGREE_RANK = {
  "博士": 5, "硕士": 4, "MBA/EMBA": 4, "本科": 3, "大专": 2,
  "中专/中技": 1, "中专": 1, "中技": 1, "高中": 1, "初中及以下": 0,
};
// 只在简历里出现"非统招"字样时提示核实；不把「专升本」算进来（统招专升本本身是全日制本科）
const NON_QUANTONG = /自考|成教|成人教育|函授|夜大|网络教育|远程教育|电大|非全日制|在职研究生|在职硕士/;
function quantongRisk(text) {
  const m = String(text || "").match(NON_QUANTONG);
  return m ? `非统招?${m[0]}` : "";
}

// 从原始字段中尽力抽取展示字段（字段名以实际返回为准，做多键兼容）
const pick = (obj, keys) => {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return "";
};

(async () => {
  const results = JSON.parse(fs.readFileSync(path.join(DATA, "last-results.json"), "utf8"));

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

  // 派生字段预计算（年龄/学历/业绩标记/统招风险）——纯本地读缓存，零网络
  const enriched = fresh.map((r) => {
    const f = r.fields || {};
    const s = r.search || {};
    let rtext = "";
    try { rtext = JSON.parse(fs.readFileSync(path.join(DATA, "resumes", `${r.id}.json`), "utf8")).text || ""; } catch {}
    return {
      r, f, s, rtext,
      age: pickAge(s, rtext),
      degree: pick(s, ["degree", "eduLevelName", "eduLevel"]) || "—",
      perf: perfFlag(rtext),
      risk: quantongRisk(rtext),
    };
  });

  // 可选硬筛（画像 opt-in）
  const dropped = [];
  const rows = !RF ? enriched : enriched.filter((e) => {
    const why = [];
    if (RF.ageMax) {
      const a = parseInt(e.age, 10);
      if (a && a > RF.ageMax) why.push(`年龄${a}>${RF.ageMax}`);
    }
    if (RF.minDegree) {
      const need = DEGREE_RANK[RF.minDegree] ?? 3;
      if ((DEGREE_RANK[String(e.degree).trim()] ?? 0) < need) why.push(`学历${e.degree}<${RF.minDegree}`);
    }
    if (RF.requireDimHits) {
      for (const [dim, labels] of Object.entries(RF.requireDimHits)) {
        const hits = (e.r.score.parts?.[dim]?.hits) || [];
        const ok = Array.isArray(labels) && labels.length ? labels.some((l) => hits.includes(l)) : hits.length > 0;
        if (!ok) why.push(`未命中硬性维度 ${dim}`);
      }
    }
    if (why.length) { dropped.push(`${e.f.name || e.r.id}（${why.join("、")}）`); return false; }
    return true;
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(cfg.sanitizeJobLabel(`${cfg.jobTitle}推荐`)); // v2.12.0：jobTitle 含 / 等禁字符会让 exceljs 抛错

  // 表头（维度列由 config.scoring 动态生成，支持任意岗位）
  const dims = Object.entries(cfg.scoring || {}).map(([key, d]) => ({ key, label: d.label || key }));
  // LLM 模式插两列：「规则对照」在评分后（后续列右移 off=1），「匹配依据」在维度列后
  const off = hasLlm ? 1 : 0;
  const header = [
    "排名", "等级", "评分",
    ...(hasLlm ? ["规则对照(快速)"] : []),
    "姓名", "直达简历", "当前公司", "现任职位", "城市",
    "年龄", "学历", "重点关注", "统招风险(需核实)",
    ...dims.map((d) => `${d.label}（${cfg.scoring[d.key].weight}分）`),
    ...(hasLlm ? ["匹配依据(精细评估)"] : []),
    "来源关键词",
    "建议打招呼话术（复制到猎聘官网手动发送）",
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
  hRow.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5597" } }; c.alignment = { vertical: "middle", horizontal: "center" }; });
  ws.mergeCells(1, 1, 1, 8); // 档位自证行合并前 8 列（与冻结窗格 ySplit=2 配套）

  rows.forEach((e, i) => {
    const { r, f, s, age, degree, perf, risk } = e;
    const name = f.name || pick(s, ["name"]) || "（详见猎聘）";
    const company = f.company || pick(s, ["company", "companyName"]) || "—";
    const title = f.title || pick(s, ["current_title", "title"]) || "—";
    const city = f.city || pick(s, ["city", "workCity"]) || cfg.city;
    const p = r.score.parts || {};
    const dimHits = (k) => ((p[k] && p[k].hits) || []).join("、") || "—";
    // 话术变量：dim1..dimN 按维度顺序；regionHits/carrierHits 兼容旧模板（= 第1/第2个维度）
    const greetVars = { dims: {} };
    dims.forEach((d, idx) => {
      const hits = ((p[d.key] && p[d.key].hits) || []).join("/");
      greetVars[`dim${idx + 1}`] = hits;
      greetVars.dims[d.label] = hits;
    });
    greetVars.regionHits = greetVars.dim1 || "";
    greetVars.carrierHits = greetVars.dim2 || "";
    const greet = typeof cfg.greetTemplate === "function" ? cfg.greetTemplate(greetVars) : String(cfg.greetTemplate || "");
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
      name, "", company, title, city,
      age, degree, perf ? `★ ${perf}` : "—", risk ? `⚠ ${risk}` : "—",
      ...dims.map((d) => dimHits(d.key)),
      ...(hasLlm ? [llmBasis] : []),
      r.group || "",
      greet,
    ]);
    // 「直达简历」超链接：点开即到该候选人简历页（页内可收藏 + 打招呼，均为人工操作）
    const resumeId = r.id || pick(s, ["resume_id", "resumeId"]);
    if (resumeId) {
      const linkCell = row.getCell(5 + off);
      linkCell.value = {
        text: "打开简历",
        hyperlink: `https://lpt.liepin.com/cvview/showresumedetail?resIdEncode=${resumeId}`,
      };
      linkCell.font = { color: { argb: "FF0563C1" }, underline: true };
      linkCell.alignment = { vertical: "middle", horizontal: "center" };
    }
    // 等级着色：S 红 / A 橙（中国股市习惯：红=优）
    const gCell = row.getCell(2);
    gCell.font = { bold: true, color: { argb: finalGrade(r) === "S" ? "FFC00000" : "FFE36C09" } };
    // 重点关注：命中业绩量化的单元格标红加粗；统招风险标橙提示核实
    if (perf) row.getCell(11 + off).font = { bold: true, color: { argb: "FFC00000" } };
    if (risk) row.getCell(12 + off).font = { bold: true, color: { argb: "FFE36C09" } };
    row.alignment = { vertical: "middle" };
  });

  // 列宽（前 8 列固定 → 年龄/学历/重点关注/统招风险 → 维度列 → 来源关键词/话术）
  const baseWidths = [5, 6, 6, 10, 12, 24, 22, 8, 8, 8, 16, 16];
  const widths = [
    ...baseWidths.slice(0, 3), ...(hasLlm ? [12] : []), ...baseWidths.slice(3),
    ...dims.map(() => 20), ...(hasLlm ? [40] : []), 16, 60,
  ];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
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
    : path.join(REPORTS, `${new Date().toISOString().slice(0, 10)}_${cfg.platformLabel || "猎聘"}_${cfg.sanitizeJobLabel(cfg.jobTitle)}_推荐报告.xlsx`);
  await wb.xlsx.writeFile(out);

  // ---- 写索引：报告成功生成后才记录（报告失败则下次重跑会重新收录，失败模式安全）----
  // 同轮重出时刷新既有条目（runId/等级/评分/报告名），firstRecommendedAt 保留首推时间（BUG-2026-10-30 BUG-2）。
  rows.forEach((e) => {
    const key = `${PLATFORM}:${e.r.id}`;
    const ex = index.entries[key];
    index.entries[key] = {
      id: e.r.id,
      name: e.f.name || (e.s && e.s.name) || e.r.id,
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
  if (hasLlm) {
    const n = rows.filter((e) => llmOf(e.r.id)).length;
    console.log(`[报告] 精细评估口径：${n}/${rows.length} 名入表候选人有 LLM 评估，其余按规则分（匹配依据列已标注）。`);
  }
  console.log(`共 ${rows.length} 名候选人（S ${rows.filter(e=>finalGrade(e.r)==="S").length} / A ${rows.filter(e=>finalGrade(e.r)==="A").length} / B ${rows.filter(e=>finalGrade(e.r)==="B").length} / C ${rows.filter(e=>finalGrade(e.r)==="C").length}）`);
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
