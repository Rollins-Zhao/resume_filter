// 终端打印评分明细（BOSS 直聘版）
// 用法：node show-scores.js [数量，默认 30]
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const ROOT = process.env.SCREENER_DATA_DIR || process.cwd();
const file = path.join(ROOT, "data", "last-results.json");
if (!fs.existsSync(file)) {
  console.log("未找到 data/last-results.json，请先跑一轮筛选");
  process.exit(0);
}
const results = JSON.parse(fs.readFileSync(file, "utf8"));
const top = Number(process.argv[2] || 30);

const dims = Object.entries(cfg.scoring || {}).map(([key, d]) => ({ key, label: d.label || key }));
const sorted = results.sort((a, b) => b.score.total - a.score.total).slice(0, top);

console.log(`\n=== ${cfg.platformLabel || "BOSS直聘"} · ${cfg.jobTitle} · 评分明细（前 ${sorted.length}）===\n`);
for (const [i, r] of sorted.entries()) {
  const f = r.fields || {};
  const p = r.score.parts || {};
  const dimStr = dims.map((d) => `${d.label} ${(p[d.key] && p[d.key].score) || 0}`).join("  ");
  console.log(`${String(i + 1).padStart(3)}. [${r.score.grade}] ${String(r.score.total).padStart(3)}分  ${f.name || r.id}`);
  console.log(`      ${f.company || "-"} · ${f.title || "-"} · ${f.city || cfg.city}`);
  console.log(`      ${dimStr}`);
  const hits = dims.map((d) => ((p[d.key] && p[d.key].hits) || []).join("/")).filter(Boolean).join(" | ");
  if (hits) console.log(`      命中: ${hits}`);
}
console.log("");
