// 简历截图转写·批调度器（v2.10.0）——「契约在工具侧，执行在 AI 会话侧」（仿 llm-batch.js）
//
// 背景（2026-10-31 用户拍板）：BOSS 简历正文改为「截图 + AI 转写」——screener 浏览时用
// shot-capture.js 截图存 data/扫描图/<id>-NN.png（resumes/<id>.json 的 text 留空、images 记路径），
// 文本由 AI 会话（正在用的模型）逐份读图转写，经本模块校验后回填 text——下游打分/报告/
// llm-batch/去重零改动。PII 不出「本机 + AI 会话」边界，不接外部 OCR API（红线）。
//
// 用法（AI 会话按 SKILL.md「截图转写」流程调用；SCREENER_DATA_DIR 同 screener）：
//   node ocr-batch.js next              # 吐下一批待转写候选人的图片路径清单（JSON 到 stdout）
//   node ocr-batch.js save <转写.json>   # 校验一批转写文本并回填 resumes/<id>.json 的 text
//   node ocr-batch.js status            # 只看进度，不出数据
//
// 转写 JSON 格式（AI 会话生成、save 校验；格式不对的条目拒收并指出原因）：
//   [{ "id": "<候选人id>", "text": "整份简历的转写纯文本（保留章节标题行）" }]
//
// 回填后链路：node screener.js rescore 重算规则分 → （精细档）llm-batch → report。
// report.js 有退出码 7 机器兜底：还有待转写者时拒绝出报告。
const fs = require("fs");
const path = require("path");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
const DATA = path.join(ROOT, "data");
const RESULTS = path.join(DATA, "last-results.json");
const RESUMES = path.join(DATA, "resumes");
const BATCH = Math.max(1, Number(process.env.SCREENER_OCR_BATCH) || 20);
const TEXT_MIN = 120;   // 与 fetch-text 的 TEXT_MIN_LEN 同口径（正常简历全文 ≥ 数百字）
const TEXT_MAX = 20000; // 异常巨文（AI 粘错内容）拒收，防脏数据进打分
const SECTION_MARK = /(工作经历|项目经历|项目经验|教育经历|实习经历|在校经历|专业技能|自我评价|所获荣誉|资格证书|求职期望|个人优势)/;

function loadResults() {
  return JSON.parse(fs.readFileSync(RESULTS, "utf8"));
}

function readCache(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RESUMES, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** 待转写判据（全链路统一）：缓存有截图且 text 为空 —— shot-capture 落盘、report exit 7、
 *  llm-batch next 跳过、本模块 next/save、screener 内联 OCR 分流都用同一判据，勿在别处另造 */
const needsTranscription = (cache) =>
  !!cache && Array.isArray(cache.images) && cache.images.length > 0 && !String(cache.text || "").trim();

/** 转写文本校验（统一口径）：screener 内联 OCR 与 save 共用。@returns {{ok:boolean, why:string[]}} */
function validateText(text) {
  const t = typeof text === "string" ? text.trim() : "";
  const why = [];
  if (!t) why.push("text 为空");
  else {
    if (t.length < TEXT_MIN) why.push(`text 仅 ${t.length} 字符（< ${TEXT_MIN}，疑未识别/转写完整）`);
    if (t.length > TEXT_MAX) why.push(`text ${t.length} 字符超上限 ${TEXT_MAX}（疑粘错内容）`);
    if (!SECTION_MARK.test(t)) why.push("text 缺章节标记（工作经历/教育经历等——疑只识别/转写了片段）");
  }
  return { ok: why.length === 0, why };
}

function pendingList() {
  const results = loadResults();
  const pending = [];
  const skippedNoResumeCache = [];
  for (const r of results) {
    const cache = readCache(r.id);
    if (!cache) { skippedNoResumeCache.push(r.id); continue; } // 无简历缓存（理论不该有）——如实报告
    if (needsTranscription(cache)) pending.push({ r, cache });
  }
  // 规则分降序（与 llm-batch 同款）：转写前分数多为 0，稳定排序保持原顺序
  pending.sort((a, b) => (b.r.score && b.r.score.total || 0) - (a.r.score && a.r.score.total || 0));
  return { results, pending, skippedNoResumeCache };
}

function next() {
  if (!fs.existsSync(RESULTS)) {
    console.error("没有 last-results.json——先跑一轮筛选（screener），再截图转写。");
    process.exit(1);
  }
  const { results, pending, skippedNoResumeCache } = pendingList();
  const batch = pending.slice(0, BATCH).map(({ r, cache }) => ({
    id: r.id,
    name: (r.ids && r.ids.name) || "",
    ruleTotal: (r.score && r.score.total) || 0,
    images: cache.images.map((rel) => path.join(DATA, rel)), // 绝对路径，AI 会话直接读图
  }));
  const out = {
    progress: { done: results.length - pending.length, total: results.length, batchNo: Math.floor((results.length - pending.length) / BATCH) + 1, batchSize: batch.length },
    note:
      "逐份读图转写为纯文本简历：按图片顺序拼接；相邻图重叠内容只保留一份；保留章节标题行（工作经历/教育经历等）；" +
      "忽略照片、头像、按钮、页面框架文字；不要臆造图中没有的内容；必须读到最后一张图（末图应含尾部模块：教育经历/资格证书/专业技能等，缺则该份可能没截全，如实转写可见部分）。" +
      "批内一次性输出全部转写 JSON：[{id, text}]。",
    batch,
  };
  if (skippedNoResumeCache.length) out.skippedNoResumeCache = skippedNoResumeCache;
  if (!batch.length && pending.length === 0) out.note = "全部候选人已具备正文（转写完成）。下一步：node screener.js rescore 重算评分 → report 出报告（精细档先 llm-batch）。";
  console.log(JSON.stringify(out, null, 1));
}

function save(file) {
  if (!fs.existsSync(RESULTS)) {
    console.error("没有 last-results.json——先跑一轮筛选，再截图转写。");
    process.exit(1);
  }
  if (!file || !fs.existsSync(file)) {
    console.error("用法：node ocr-batch.js save <转写结果.json>");
    process.exit(1);
  }
  let incoming;
  try {
    incoming = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`转写文件不是合法 JSON（${e.message}）。请让 AI 按 schema 重新生成后再 save。`);
    process.exit(1);
  }
  if (!Array.isArray(incoming)) {
    console.error("转写文件顶层必须是数组（每项一个候选人：{id, text}）。");
    process.exit(1);
  }
  const known = new Set(loadResults().map((r) => r.id));
  const errs = [];
  const accepted = new Map(); // id → text（重复 id 后条覆盖，幂等）
  for (const [i, item] of incoming.entries()) {
    const why = [];
    if (!item || typeof item !== "object") why.push("非对象");
    else {
      if (!known.has(item.id)) why.push(`id 不在本轮结果里（${String(item.id).slice(0, 24)}）`);
      const text = typeof item.text === "string" ? item.text.trim() : "";
      const v = validateText(text);
      why.push(...v.why);
      if (known.has(item.id) && v.ok) {
        const cache = readCache(item.id);
        if (!cache) why.push("无简历缓存（理论不该有）");
        else if (!needsTranscription(cache)) why.push(cache.text && cache.text.trim() ? "该简历已有正文（无需转写）" : "该简历无截图（不适用转写通道）");
        else accepted.set(item.id, text);
      }
    }
    if (why.length) errs.push(`第 ${i + 1} 项（${String(item && item.id).slice(0, 24)}）：${why.join("；")}`);
  }
  // 回填：保留缓存原有字段（images/structured/bossInsight/...），只写 text + transcribedAt
  for (const [id, text] of accepted) {
    const p = path.join(RESUMES, `${id}.json`);
    const cache = JSON.parse(fs.readFileSync(p, "utf8"));
    cache.text = text;
    cache.transcribedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(cache, null, 2));
  }
  const { pending } = pendingList();
  console.log(`[ocr-batch] 已收 ${accepted.size}/${incoming.length} 条 → 回填 resumes/<id>.json 的 text（剩余待转写 ${pending.length} 份）`);
  if (accepted.size && !pending.length) console.log("[ocr-batch] 转写全部完成。下一步：node screener.js rescore 重算评分，再 report 出报告（精细档先 llm-batch）。");
  if (errs.length) {
    console.error(`以下 ${errs.length} 条被拒收（可修正后重新 save，已收部分不受影响）：\n  ` + errs.join("\n  "));
    process.exit(2);
  }
}

function status() {
  if (!fs.existsSync(RESULTS)) {
    console.log("没有 last-results.json——还没跑过筛选。");
    return;
  }
  const { results, pending, skippedNoResumeCache } = pendingList();
  const done = results.length - pending.length;
  console.log(`[ocr-batch] 截图转写进度：${done}/${results.length} 份已具备正文${skippedNoResumeCache.length ? `（另有 ${skippedNoResumeCache.length} 份无缓存，不计）` : ""}`);
  console.log(done >= results.length ? "全部已具备正文。下一步：node screener.js rescore → （精细档）llm-batch → report。" : `剩余 ${pending.length} 份待转写，下一批：node ocr-batch.js next`);
}

// CLI 分发（require.main 守卫：screener/ocr-local 以模块复用 validateText/needsTranscription，
// 不触发命令分发——被 require 时不打印任何东西）
if (require.main === module) {
  const mode = process.argv[2] || "status";
  if (mode === "next") next();
  else if (mode === "save") save(process.argv[3]);
  else status();
}

module.exports = { needsTranscription, validateText };
