// LLM 精细评估·批调度器（v2.6.0，两侧镜像）——「契约在工具侧，执行在 AI 会话侧」
//
// 背景（2026-10-27 用户拍板）：规则引擎（scoring.js）免费快但颗粒度粗；精细评估由 AI 会话
// （workbuddy/豆包/Claude Code 等，用户正在用的模型）逐份读简历工作内容按画像标准打分。
// 本模块不做任何模型调用——只负责：吐批次（按规则分降序，好苗子先评）、校验回收、持久化账本。
// 红线：评估只读本地简历文本，不发任何平台请求；未评估的候选人报告用规则分兜底，不糊弄不阻塞。
//
// 用法（AI 会话按 SKILL.md「精细评估」流程调用）：
//   node llm-batch.js next              # 吐下一批待评简历全文 + 评估标准（JSON 到 stdout）
//   node llm-batch.js save <评估.json>   # 校验一批评估结果并落盘 llm-scores.json
//   node llm-batch.js status            # 只看进度，不出数据
//
// 评估 JSON 格式（AI 会话生成、save 校验；格式不对的条目拒收并指出原因）：
//   [{ "id": "<候选人id>", "total": 82, "grade": "A",
//      "parts": { "<维度key>": { "score": 20, "evidence": ["简历原文摘录…"], "reason": "一句话理由" } },
//      "summary": "一句话总评（可选）" }]
//
// 批量纪律（SKILL.md 硬规矩的机器面）：隔离单元默认 20 份（SCREENER_LLM_BATCH 可调）——
// 对话滚动评估的累计 token 是平方级，隔离单元才是线性；顺序按规则分降序，评到哪算哪、中断不亏。
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
const DATA = path.join(ROOT, "data");
const RESULTS = path.join(DATA, "last-results.json");
const SCORES = path.join(DATA, "llm-scores.json");
const BATCH = Math.max(1, Number(process.env.SCREENER_LLM_BATCH) || 20);
const GRADES = ["S", "A", "B", "C"];

// 画像评分标准的指纹：scoring 变了（改画像/换权重），旧评估就基于旧标准——next/save 时提示，不自动作废
function scoringHash() {
  const s = JSON.stringify(cfg.scoring || {});
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function loadScores() {
  try {
    return JSON.parse(fs.readFileSync(SCORES, "utf8"));
  } catch {
    return null;
  }
}

function pendingList() {
  const results = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  const done = loadScores();
  const doneIds = done && done.entries ? new Set(Object.keys(done.entries)) : new Set();
  // 规则分降序：好苗子先被精细评估，随时可停、停了不亏
  return results
    .filter((r) => !doneIds.has(r.id))
    .sort((a, b) => (b.score && b.score.total || 0) - (a.score && a.score.total || 0));
}

function readResumeCache(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, "resumes", `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

function readResumeText(id) {
  const c = readResumeCache(id);
  if (!c) return null;
  // 超长保底截断（正常简历全文 2–4k 字；异常巨文防批次爆掉）
  return String(c.text || "").slice(0, 20000);
}

function next() {
  if (!fs.existsSync(RESULTS)) {
    console.error("没有 last-results.json——先跑一轮筛选（screener），再精细评估。");
    process.exit(1);
  }
  const all = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  const pending = pendingList();
  const done = loadScores();
  const batch = [];
  const skippedNoCache = [];
  const pendingTrans = []; // v2.10.0：截图待转写（images 非空 + text 空）——文本没有，评估无从谈起
  const shortTexts = []; // v2.9.2：正文 <800 字的候选人（弹层取文不完整，评估基于可见部分、evidence 可能不足）
  for (const r of pending) {
    if (batch.length >= BATCH) break;
    const cache = readResumeCache(r.id);
    if (cache == null) {
      skippedNoCache.push(r.id); // 无简历缓存（理论不该有：last-results 都来自浏览/缓存）——跳过并如实报告
      continue;
    }
    if (Array.isArray(cache.images) && cache.images.length && !String(cache.text || "").trim()) {
      pendingTrans.push(r.id); // 截图模式未转写——先走 ocr-batch 链路
      continue;
    }
    const text = String(cache.text || "").slice(0, 20000);
    if (text.length < 800) shortTexts.push({ id: r.id, len: text.length }); // v2.9.2：超短正文标记（screener 侧已警告；评估侧须知证据面窄）
    batch.push({ id: r.id, name: (r.ids && r.ids.name) || "", ruleTotal: (r.score && r.score.total) || 0, text });
  }
  if (!batch.length && pendingTrans.length) {
    console.error(`本轮 ${pendingTrans.length} 份简历已截图但尚未转写（截图取文模式）——先完成转写：node ocr-batch.js next → AI 读图转写 → save → node screener.js rescore，再回来精细评估。`);
    process.exit(1);
  }
  const hashNow = scoringHash();
  const hashWarn = done && done.scoringHash && done.scoringHash !== hashNow
    ? `⚠ 画像评分标准已变更（评估账本记录的标准指纹 ${done.scoringHash} ≠ 当前 ${hashNow}）：旧评估基于旧标准，如需按新标准重评，删除 ${path.relative(process.cwd(), SCORES)} 后重跑。`
    : null;
  const out = {
    progress: { done: all.length - pending.length + skippedNoCache.length, total: all.length, batchNo: done && done.batches ? done.batches + 1 : 1, batchSize: batch.length },
    scoringHash: hashNow,
    hashWarn,
    criteria: cfg.evaluationCriteria || null, // 画像里的自然语言评估标准（LLM 模式主标准，见画像指南）
    scoring: cfg.scoring || {}, // 关键词规则（criteria 缺席时的推导来源：把各维度 rules/weight 翻译成评估标准）
    note: "批内一次性输出全部评估 JSON（逐份问答=违规）；维度 parts 的 key 用 scoring 里的维度 key；evidence 必须摘简历原文。",
    batch,
  };
  if (skippedNoCache.length) out.skippedNoResumeCache = skippedNoCache;
  if (pendingTrans.length) out.pendingTranscription = pendingTrans; // ⚠ 这些尚未转写，本批不含；转写链路见 stderr/契约
  if (shortTexts.length) out.shortTexts = shortTexts; // ⚠ 这些简历正文异常简短——打分时按可见证据评，勿因文本少而臆造 evidence
  console.log(JSON.stringify(out, null, 1));
}

function save(file) {
  if (!fs.existsSync(RESULTS)) {
    console.error("没有 last-results.json——先跑一轮筛选，再精细评估。");
    process.exit(1);
  }
  if (!file || !fs.existsSync(file)) {
    console.error("用法：node llm-batch.js save <评估结果.json>");
    process.exit(1);
  }
  let incoming;
  try {
    incoming = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`评估文件不是合法 JSON（${e.message}）。请让 AI 按 schema 重新生成后再 save。`);
    process.exit(1);
  }
  if (!Array.isArray(incoming)) {
    console.error("评估文件顶层必须是数组（每项一个候选人）。");
    process.exit(1);
  }
  const known = new Set(JSON.parse(fs.readFileSync(RESULTS, "utf8")).map((r) => r.id));
  const done = loadScores() || { entries: {}, batches: 0 };
  const errs = [];
  const merged = done.entries || {};
  let okCount = 0;
  for (const [i, item] of incoming.entries()) {
    const why = [];
    if (!item || typeof item !== "object") why.push("非对象");
    else {
      if (!known.has(item.id)) why.push(`id 不在本轮结果里（${String(item.id).slice(0, 24)}）`);
      if (typeof item.total !== "number" || item.total < 0 || item.total > 100) why.push("total 需为 0-100 数字");
      if (!GRADES.includes(item.grade)) why.push(`grade 需为 ${GRADES.join("/")}`);
      if (!item.parts || typeof item.parts !== "object" || Array.isArray(item.parts)) why.push("parts 需为对象");
    }
    if (why.length) {
      errs.push(`第 ${i + 1} 项：${why.join("；")}`);
      continue;
    }
    merged[item.id] = {
      total: item.total,
      grade: item.grade,
      parts: item.parts,
      summary: typeof item.summary === "string" ? item.summary : "",
      evaluatedAt: new Date().toISOString(),
    };
    okCount++;
  }
  if (okCount) {
    done.entries = merged;
    done.batches = (done.batches || 0) + 1;
    done.scoringHash = scoringHash();
    done.updatedAt = new Date().toISOString();
    fs.writeFileSync(SCORES, JSON.stringify(done, null, 1));
  }
  const total = JSON.parse(fs.readFileSync(RESULTS, "utf8")).length;
  console.log(`[llm-batch] 已收 ${okCount}/${incoming.length} 条 → llm-scores.json（累计 ${Object.keys(merged).length}/${total} 份已精细评估）`);
  if (errs.length) {
    console.error(`以下 ${errs.length} 条格式不符被拒收（可修正后重新 save，已收部分不受影响）：\n  ` + errs.join("\n  "));
    process.exit(2);
  }
}

function status() {
  if (!fs.existsSync(RESULTS)) {
    console.log("没有 last-results.json——还没跑过筛选。");
    return;
  }
  const all = JSON.parse(fs.readFileSync(RESULTS, "utf8")).length;
  const done = loadScores();
  const n = done && done.entries ? Object.keys(done.entries).length : 0;
  console.log(`[llm-batch] 精细评估进度：${n}/${all} 份${done && done.scoringHash ? `（标准指纹 ${done.scoringHash}${done.scoringHash !== scoringHash() ? " ⚠ 与当前画像不一致" : ""}）` : ""}`);
  console.log(n >= all ? "全部已评。下一步：node report.js 出报告。" : `剩余 ${all - n} 份，下一批：node llm-batch.js next`);
}

const mode = process.argv[2] || "status";
if (mode === "next") next();
else if (mode === "save") save(process.argv[3]);
else status();
