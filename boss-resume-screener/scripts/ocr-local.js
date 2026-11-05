// RapidOCR 本地识别·Node 侧（v2.10.0，BOSS 截图取文主通道）——spawn uv 跑 ocr-local.py，
// 收行级 JSON → 剥 UI 杂线/截断免责声明 → mergeSegments 跨图行级去重 → 返回整份纯文本。
// PII 纯本地（RapidOCR 离线推理）；不接任何外部 OCR API（红线）。
//
// 依赖：uv（boss-agent-cli 本就要求）+ rapidocr-onnxruntime（uv run --with 首次自动装，模型随包）。
// 失败语义：环境不可用/识别异常返回 null（不抛）——调用方（screener）把该份留给 AI 会话转写兜底
// （ocr-batch 链路），不熔断不硬跑。
const { spawnSync } = require("child_process");
const path = require("path");
const { mergeSegments } = require("./fetch-text");

// UI 杂线词表（真机 PoC 实证：弹层右侧动作条/徽标，截图通道独有；新增词需真机证据）
const DROP_EXACT = new Set([
  "", "☆", "W", "★",
  "收藏", "继续沟通", "等待回复", "沟通中", "本周活跃", "热搜", "热招",
  "VIP专享", "VIP专属", "下载简历", "交换微信", "更多", "举报",
]);
// 折叠按钮（「查看全部N份经历/N项分析>」——shot-capture 已尽力点开，残留行剥除）
const DROP_RE = [/^查看全部/, /^展开全部/];
// 平台免责声明起始行：从该行起截断到本图末尾（尾部整段是法务文案非简历内容）
const DISCLAIMER_START = "为妥善保护牛人";

/** 纯函数：单图行数组 → 清洗后的文本段（剥 UI/折叠钮/免责声明；保留章节标题与正文）
 *  @returns {{cleanLines: string[], disclaimerCut: boolean}} */
function cleanImageLines(lines) {
  const out = [];
  let disclaimerCut = false;
  for (const l of lines) {
    const t = String(l || "").trim();
    if (t.startsWith(DISCLAIMER_START)) { disclaimerCut = true; break; }
    if (DROP_EXACT.has(t)) continue;
    if (DROP_RE.some((re) => re.test(t))) continue;
    out.push(t);
  }
  return { cleanLines: out, disclaimerCut };
}

/** 纯函数：多图行数组（阅读序）→ 整份简历纯文本。
 *  v2.10.0 真机 10 份实证（2026-10-30）：除常规 20% 重叠外还有两类拼接伪影——
 *  ① 整屏重拍（滚轮未推进/短简历一屏即完）：后图头部=前图头部整块，块内个别行换行漂移致精确匹配断链；
 *  ② 换行点漂移致邻行错位：完全相同的长内容行跨图重复。
 *  组装策略（三层，行级，归一化比较=剥空白）：
 *  A. 头块剥离：把「与已累积内容中任一连续块匹配」的段头部块剥掉（精确块 k≥2 / 容错块 k≥3 且错行≤max(1,15%)）；
 *  B. 边界拼接：剩余部分与累积尾部做精确尾-头重叠拼接（mergeSegments 形态②同款）；
 *  C. 长行去重：≥20 归一化字符的重复行只留首现（短标记行如「主修课程：」的自然重复保留）。 */
const normLine = (l) => String(l || "").replace(/\s+/g, "");

function assembleOcrText(perImageLines) {
  const images = [];
  let disclaimerCut = 0;
  for (const lines of perImageLines || []) {
    const c = cleanImageLines(lines || []);
    if (c.disclaimerCut) disclaimerCut++;
    if (c.cleanLines.length) images.push(c.cleanLines);
  }
  let accLines = [];
  let dropped = 0;
  let merged = 0;
  let strippedBlocks = 0;
  for (const seg of images) {
    let rest = seg.slice();
    // A. 头块剥离（可多轮：一段里可能含多个重拍块）
    for (let guard = 0; guard < 4 && rest.length >= 2; guard++) {
      const k = matchHeadBlock(rest, accLines);
      if (!k) break;
      rest = rest.slice(k);
      strippedBlocks++;
    }
    if (!rest.length) { dropped++; continue; }
    if (!accLines.length) { accLines = rest; continue; }
    // B. 边界拼接：累积尾部 vs 剩余头部的精确重叠（k≥1，归一化相等）
    let best = 0;
    for (let k = Math.min(accLines.length, rest.length); k >= 1; k--) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (normLine(rest[j]) !== normLine(accLines[accLines.length - k + j]) || !normLine(rest[j])) { ok = false; break; }
      }
      if (ok) { best = k; break; }
    }
    if (best > 0) { accLines = accLines.concat(rest.slice(best)); merged++; }
    else accLines = accLines.concat([""], rest);
  }
  // C. 长行去重（≥20 归一化字符，只留首现）
  const seen = new Set();
  const out = [];
  let longDropped = 0;
  for (const l of accLines) {
    const n = normLine(l);
    if (l === "" ) { out.push(l); continue; }
    if (n.length >= 20) {
      if (seen.has(n)) { longDropped++; continue; }
      seen.add(n);
    }
    out.push(l);
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, dropped, merged, longDropped, strippedBlocks, disclaimerCut, imageCount: (perImageLines || []).length };
}

/** 变体行判定：两行归一化后是「同一内容的重渲染」（长行包含关系，短行不算——防新内容被当变体吞掉） */
function similarLine(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length < 10 || b.length < 10) return false;
  return a.includes(b) || b.includes(a);
}

/** 段头部块在累积行中的最大匹配长度（归一化比较）：精确块 k≥2（全等）；容错块 k≥3 且覆盖段≥40%
 *  （允许 ≤max(1,⌊k×15%⌋) 个「变体行」=长行包含关系；硬不同行直接断配）。0=无匹配 */
function matchHeadBlock(seg, accLines) {
  if (!accLines.length || seg.length < 2) return 0;
  for (let k = seg.length; k >= 2; k--) {
    const fuzzyOK = k >= 3 && k >= seg.length * 0.4;
    const maxMiss = fuzzyOK ? Math.max(1, Math.floor(k * 0.15)) : 0;
    for (let j = 0; j + k <= accLines.length; j++) {
      let miss = 0;
      let hard = false;
      for (let t = 0; t < k; t++) {
        const a = normLine(accLines[j + t]);
        const b = normLine(seg[t]);
        if (!b || a === b) continue;
        if (similarLine(a, b)) { if (++miss > maxMiss) { hard = true; break; } }
        else { hard = true; break; }
      }
      if (!hard) return k;
    }
  }
  return 0;
}

/** spawn uv 跑本地 OCR。@returns {Promise<{text,dropped,merged,ms,imageCount}|null>} null=环境不可用/全失败 */
function runLocalOcr(absImagePaths, { logger = null, note = (s) => console.log(s) } = {}) {
  const log = (s) => {
    note(s);
    if (logger) logger.append(s + "\n");
  };
  return new Promise((resolve) => {
    if (!Array.isArray(absImagePaths) || !absImagePaths.length) return resolve(null);
    const t0 = Date.now();
    // shell:false 下 Windows 需要精确可执行名；uv/uv.exe 都试（PATH 解析交给 spawn）
    const run = (cmd) =>
      spawnSync(cmd, ["run", "--with", "rapidocr-onnxruntime", "python", path.join(__dirname, "ocr-local.py"), ...absImagePaths], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 300000, // 首次运行 uv 要装依赖+模型（~1-2 分钟），之后秒级
        maxBuffer: 32 * 1024 * 1024,
      });
    let r = run("uv");
    if ((r.error && r.error.code === "ENOENT") || (r.status === null && !r.stdout)) r = run("uv.exe");
    if (r.error || typeof r.status !== "number") {
      log(`    [OCR] 本地 OCR 不可用（uv 启动失败：${r.error ? r.error.code || r.error.message : "无退出码"}）→ 本份留给 AI 会话转写兜底`);
      return resolve(null);
    }
    if (r.status === 2) {
      log(`    [OCR] rapidocr 依赖不可用（${String(r.stdout || r.stderr || "").slice(0, 120)}）→ 本份留给 AI 会话转写兜底`);
      return resolve(null);
    }
    if (r.status !== 0) {
      log(`    [OCR] 本地 OCR 进程失败（exit ${r.status}：${String(r.stderr || "").slice(0, 120)}）→ 本份留给 AI 会话转写兜底`);
      return resolve(null);
    }
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      log(`    [OCR] 输出不可解析（${e.message}）→ 本份留给 AI 会话转写兜底`);
      return resolve(null);
    }
    if (parsed && parsed.error) {
      log(`    [OCR] ${String(parsed.error).slice(0, 120)} → 本份留给 AI 会话转写兜底`);
      return resolve(null);
    }
    const imgs = Array.isArray(parsed) ? parsed : [];
    const okImgs = imgs.filter((x) => x && x.ok && Array.isArray(x.lines));
    if (!okImgs.length) return resolve(null);
    const assembled = assembleOcrText(okImgs.map((x) => x.lines.map((l) => l.text)));
    log(`    [OCR] 本地识别完成：${okImgs.length}/${imgs.length} 图 · ${assembled.text.length} 字符（弃重叠 ${assembled.dropped} 图段${assembled.disclaimerCut ? "，截断免责声明" : ""}）· ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    resolve({ ...assembled, ms: Date.now() - t0 });
  });
}

/** 截图过期清理已并入统一历史清理（v2.11.0 cleanup.js，保留期 settings.retentionDays），
 *  本文件不再承担清理职责（2026-11-02 用户拍板：所有历史文件统一保留期，默认 1 天）。 */

module.exports = { assembleOcrText, cleanImageLines, runLocalOcr, DROP_EXACT, DISCLAIMER_START };
