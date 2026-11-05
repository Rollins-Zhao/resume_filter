// Task 3 测试：ocr-batch.js 转写契约（next/save/status）——夹具 + 临时数据目录，零网络零浏览器。
// 跑法：node tests/ocr-batch.test.js
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SCRIPT = path.join(__dirname, "..", "boss-resume-screener", "scripts", "ocr-batch.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-batch-test-"));

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + extra}`);
  if (!cond) failed++;
};

function run(args, stdin) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, SCREENER_DATA_DIR: TMP },
    ...(stdin ? { input: stdin } : {}),
  });
}

// ---------- 夹具 ----------
function setupFixtures() {
  const data = path.join(TMP, "data");
  fs.mkdirSync(path.join(data, "resumes"), { recursive: true });
  // last-results：A 分高待转写、B 分低待转写、C 已有正文（拖选时代缓存）、D 无缓存（理论不该有）
  fs.writeFileSync(path.join(data, "last-results.json"), JSON.stringify([
    { id: "candA", score: { total: 0, grade: "C" }, ids: { name: "甲" } },
    { id: "candB", score: { total: 0, grade: "C" }, ids: { name: "乙" } },
    { id: "candC", score: { total: 55, grade: "B" }, ids: { name: "丙" } },
    { id: "candD", score: { total: 0, grade: "C" }, ids: { name: "丁" } },
  ]));
  const mk = (id, obj) => fs.writeFileSync(path.join(data, "resumes", `${id}.json`), JSON.stringify(obj));
  mk("candA", { id: "candA", images: ["扫描图/candA-01.png", "扫描图/candA-02.png"], text: "", structured: { basic: { name: "甲" } } });
  mk("candB", { id: "candB", images: ["扫描图/candB-01.png"], text: "" });
  mk("candC", { id: "candC", text: "拖选时代的正文，无需转写" });
  fs.mkdirSync(path.join(data, "扫描图"), { recursive: true });
  ["candA-01.png", "candA-02.png", "candB-01.png"].forEach((f) =>
    fs.writeFileSync(path.join(data, "扫描图", f), "fakepng"));
}

try {
  setupFixtures();

  // ---------- next ----------
  const r1 = run(["next"]);
  check("next 退出码 0", r1.status === 0, r1.stderr);
  let out1 = null;
  try { out1 = JSON.parse(r1.stdout); } catch (e) { check("next 输出合法 JSON", false, String(e.message)); }
  if (out1) {
    check("next 只吐待转写（candA/candB）", Array.isArray(out1.batch) && out1.batch.length === 2 && out1.batch[0].id === "candA" && out1.batch[1].id === "candB", JSON.stringify(out1.batch));
    check("next 带图片绝对路径清单", out1.batch.every((b) => Array.isArray(b.images) && b.images.length && b.images.every((p) => path.isAbsolute(p))));
    check("next 进度口径 = total - 待转写（candC 已有正文、candD 无缓存 → 2/4）", out1.progress && out1.progress.done === 2 && out1.progress.total === 4);
    check("next 报告无缓存条目", Array.isArray(out1.skippedNoResumeCache) && out1.skippedNoResumeCache.includes("candD"));
    check("next 附转写契约说明", typeof out1.note === "string" && out1.note.length > 20);
  }

  // ---------- save：校验与回填 ----------
  const goodText = "基本资料：张三，5年销售经验。\n工作经历\n2019-2023 某公司 大客户销售\n负责华东区KA客户开发与维护，年销售额3000万，超额完成率130%，连续两年获得年度销售冠军。\n2017-2019 某某科技公司 销售代表\n从零开发华东区制造业客户共计86家，建立经销商分销网络，第一年即完成团队120%的业绩目标。\n教育经历\n某大学 市场营销 本科\n专业技能\nCRM系统、商务谈判、大客户管理、渠道拓展、销售预测";
  const transFile = path.join(TMP, "trans.json");
  fs.writeFileSync(transFile, JSON.stringify([
    { id: "candA", text: "  " + goodText + "  " }, // 前后空白 → 应 trim 后入库
    { id: "candB", text: "太短" },                // 长度不足 → 拒收
    { id: "candX", text: goodText },              // 未知 id → 拒收
    { id: "candC", text: goodText },              // 无截图（已有正文）→ 拒收
    { id: "candA", text: goodText },              // 重复 id（同文）→ 幂等，不重复计数
  ]));
  const r2 = run(["save", transFile]);
  check("save 有拒收项时退出码 2", r2.status === 2, `status=${r2.status}`);
  check("save 拒收理由逐条给出", /candB/.test(r2.stderr) && /candX/.test(r2.stderr) && /candC/.test(r2.stderr), r2.stderr);
  const savedA = JSON.parse(fs.readFileSync(path.join(TMP, "data", "resumes", "candA.json"), "utf8"));
  check("save 回填 text（已 trim）并保留 images/structured", savedA.text === goodText.trim() && Array.isArray(savedA.images) && savedA.images.length === 2 && savedA.structured && !!savedA.transcribedAt);
  const savedB = JSON.parse(fs.readFileSync(path.join(TMP, "data", "resumes", "candB.json"), "utf8"));
  check("save 拒收者 text 保持为空", savedB.text === "");

  // 章节标记缺失的文本 → 拒收
  const noMarkFile = path.join(TMP, "trans2.json");
  fs.writeFileSync(noMarkFile, JSON.stringify([{ id: "candB", text: "某人的简历内容没有任何章节标记，只是很长的叙述文字，".repeat(10) }]));
  const r3 = run(["save", noMarkFile]);
  check("save 缺章节标记拒收（退出码 2）", r3.status === 2 && /章节/.test(r3.stderr), r3.stderr);

  // ---------- status ----------
  const r4 = run(["status"]);
  check("status 显示进度 3/4（A 已回填，B/D 仍待）", r4.status === 0 && /3\/4/.test(r4.stdout), r4.stdout);

  // ---------- next：转写后只剩未转写者 ----------
  const r5 = run(["next"]);
  let out5 = null;
  try { out5 = JSON.parse(r5.stdout); } catch {}
  check("next 转写后只剩 candB", out5 && out5.batch.length === 1 && out5.batch[0].id === "candB");

  // ---------- 全部转写完 → next 空批 + 指引 ----------
  fs.writeFileSync(path.join(TMP, "data", "resumes", "candB.json"), JSON.stringify({ id: "candB", images: ["扫描图/candB-01.png"], text: goodText }));
  const r6 = run(["next"]);
  check("next 全部完成后退出码 0 且空批", r6.status === 0 && /"batch": \[\]/.test(r6.stdout.replace(/\s+/g, " ")), r6.stdout);

  // ---------- 无 last-results → exit 1 ----------
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-batch-empty-"));
  const r7 = spawnSync(process.execPath, [SCRIPT, "next"], { encoding: "utf8", env: { ...process.env, SCREENER_DATA_DIR: TMP2 } });
  check("无 last-results 时 next 退出码 1 并指引先筛选", r7.status === 1 && /last-results/.test(r7.stderr), r7.stderr);
  fs.rmSync(TMP2, { recursive: true, force: true });
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄残留重试一次 */ try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
}

process.exit(failed ? 1 : 0);
