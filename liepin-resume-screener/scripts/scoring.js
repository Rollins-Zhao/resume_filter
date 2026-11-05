// 四维打分内核（平台无关）——与 boss-resume-screener/scripts/scoring.js 保持一致
// 维度与权重完全由 config.scoring / 岗位画像决定，本文件不含任何岗位数据。
//
// 设计要点（勿改）：
//  - 普通维度：规则命中累加，封顶 weight
//  - 上下文维度：关键词必须与 contextWords 同句才算强命中，防"泛提即得分"误报
//  - 分句按 。；;\n 切分，不按逗号切（中文简历逗号密集，会把关键词拆散）

function scoreText(dimension, text) {
  const hits = [];
  let score = 0;
  for (const rule of dimension.rules || []) {
    if (rule.keywords.some((k) => text.toLowerCase().includes(k.toLowerCase()))) {
      hits.push(rule.label);
      score += rule.score;
    }
  }
  score = Math.min(score, dimension.weight);
  if (hits.length === 0) score = dimension.other || 0;
  return { score, hits };
}

function scoreWithContext(dimension, text) {
  const t = text.toLowerCase();
  const segs = t.split(/[。；;\n]+/);
  const hitSet = new Set();
  let strongHit = false;
  for (const seg of segs) {
    const hasCtx = (dimension.contextWords || []).some((w) => seg.includes(w.toLowerCase()));
    if (!hasCtx) continue;
    for (const rule of dimension.rules || []) {
      if (rule.keywords.some((k) => seg.includes(k.toLowerCase()))) {
        hitSet.add(rule.label);
        strongHit = true;
      }
    }
  }
  let score = 0;
  if (strongHit) {
    score = Math.min(
      dimension.weight,
      [...hitSet].reduce(
        (s, label) => s + (dimension.rules.find((r) => r.label === label) || {}).score,
        0
      )
    );
  } else if ((dimension.rules || []).some((r) => r.keywords.some((k) => t.includes(k.toLowerCase())))) {
    score = dimension.weakScore || 0;
  }
  return { score, hits: [...hitSet] };
}

/** 按 config.scoring 对一段文本打分，返回 { total, grade, parts } */
function scoreResume(text, scoring, gradeBands) {
  const parts = {};
  for (const [key, dim] of Object.entries(scoring || {})) {
    parts[key] =
      dim.contextWords && dim.contextWords.length ? scoreWithContext(dim, text) : scoreText(dim, text);
  }
  const total = Object.values(parts).reduce((s, p) => s + p.score, 0);
  const grade = (gradeBands || []).find((b) => total >= b.min)?.grade || "C";
  return { total, grade, parts };
}

module.exports = { scoreText, scoreWithContext, scoreResume };
