// Task 4/5 集成测试：report.js 转写门槛（exit 7）→ 回填 → rescore → 报告含「牛人分析」列。
// 夹具 + 临时数据目录，零网络零浏览器。跑法：node tests/report-gate.test.js
// （注：集成胶水层为事后行为验证，非严格 TDD；断言先走负路径 exit 7 再走正路径，防假绿。）
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "boss-resume-screener", "scripts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "report-gate-test-"));

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + extra}`);
  if (!cond) failed++;
};

function run(script, args, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, SCREENER_DATA_DIR: TMP, SCREENER_REPORTS_DIR: path.join(TMP, "reports"), ...extraEnv },
  });
}

const goodResume = "基本资料：李某，8年B2B销售。\n工作经历\n2016-2024 某科技公司 大客户销售总监\n负责SaaS产品对制造业客户的直接销售与团队管理，年合同额5000万，连续三年超额完成目标。\n教育经历\n某大学 工商管理 本科\n专业技能\n大客户开发、解决方案销售、团队管理、CRM";

try {
  // ---------- 夹具：1 份已截图未转写 + 1 份已转写 ----------
  const data = path.join(TMP, "data");
  fs.mkdirSync(path.join(data, "resumes"), { recursive: true });
  fs.writeFileSync(path.join(data, "last-results.json"), JSON.stringify([
    { id: "candShot", group: "推荐", ids: { name: "李四", geekId: "g1", jobId: "j1" }, structured: null, fields: { name: "李四", company: "某公司", title: "销售", city: "北京", age: "32", degree: "本科", workYears: "8年" }, score: { total: 0, grade: "C" }, fetchedAt: new Date().toISOString(), viewedThisRun: true },
    { id: "candDone", group: "推荐", ids: { name: "王五", geekId: "g2", jobId: "j2" }, structured: null, fields: { name: "王五", company: "某公司B", title: "大客户销售", city: "北京" }, score: { total: 42, grade: "B" }, fetchedAt: new Date().toISOString(), viewedThisRun: true },
  ]));
  fs.writeFileSync(path.join(data, "resumes", "candShot.json"), JSON.stringify({ id: "candShot", images: ["扫描图/candShot-01.png"], text: "", bossInsight: "牛人3小时前浏览过职位，其通常活跃时间为2-6pm", fetchedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(data, "resumes", "candDone.json"), JSON.stringify({ id: "candDone", text: goodResume, fetchedAt: new Date().toISOString() }));

  // ---------- 负路径：未转写 → report 拒出（exit 7），指引含 ocr-batch ----------
  const r1 = run("report.js", []);
  check("未转写时 report 退出码 7", r1.status === 7, `status=${r1.status}`);
  check("exit 7 指引指向 ocr-batch", /ocr-batch/.test(r1.stderr), r1.stderr);
  const files1 = fs.readdirSync(path.join(TMP, "reports")).filter((f) => f.endsWith(".xlsx"));
  check("exit 7 时不产生报告文件", files1.length === 0, JSON.stringify(files1));

  // ---------- 正路径：回填（模拟 ocr save）→ rescore → report ----------
  const cache = JSON.parse(fs.readFileSync(path.join(data, "resumes", "candShot.json"), "utf8"));
  cache.text = goodResume.replace("李某", "李四");
  cache.transcribedAt = new Date().toISOString();
  fs.writeFileSync(path.join(data, "resumes", "candShot.json"), JSON.stringify(cache));
  const r2 = run("screener.js", ["rescore"]);
  check("rescore 退出码 0", r2.status === 0, r2.stderr);
  const rescored = JSON.parse(fs.readFileSync(path.join(data, "last-results.json"), "utf8"));
  const shot = rescored.find((x) => x.id === "candShot");
  check("rescore 后已转写者有真实评分（>0）", shot && shot.score && shot.score.total > 0, JSON.stringify(shot && shot.score));

  const r3 = run("report.js", []);
  check("转写完成后 report 退出码 0", r3.status === 0, r3.stderr);
  const files3 = fs.readdirSync(path.join(TMP, "reports")).filter((f) => f.endsWith(".xlsx"));
  check("报告文件生成", files3.length === 1, JSON.stringify(files3));
  check("终端输出含牛人分析口径提示或正常完成", /已生成/.test(r3.stdout), r3.stdout);

  // ---------- 报告内容：牛人分析列 + 内容 ----------
  if (files3.length) {
    (async () => {
      const ExcelJS = require("exceljs");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(path.join(TMP, "reports", files3[0]));
      const ws = wb.worksheets[0];
      const headerRow = ws.getRow(2).values;
      const hArr = [...headerRow].map((v) => String(v || ""));
      const colIdx = hArr.findIndex((h) => h.includes("牛人分析"));
      check("表头含「牛人分析」列", colIdx > 0, JSON.stringify(hArr));
      if (colIdx > 0) {
        let found = false;
        ws.eachRow((row, rn) => { if (rn >= 3 && String(row.getCell(colIdx).value || "").includes("2-6pm")) found = true; });
        check("李四行牛人分析内容正确", found);
        let dash = false;
        ws.eachRow((row, rn) => { if (rn >= 3 && row.getCell(colIdx).value === "—") dash = true; });
        check("无分析者显示「—」", dash);
      }
      // 尾部列未被挤坏：建议打招呼话术仍是最后一列
      check("末列仍为话术列", hArr[hArr.length - 1].includes("打招呼话术"), hArr[hArr.length - 1]);
    })().catch((e) => { check("xlsx 读取", false, String(e.message)); process.exit(failed ? 1 : 0); })
      .then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(failed ? 1 : 0); });
  } else {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(failed ? 1 : 0);
  }
} catch (e) {
  console.error("FIXTURE ERROR:", e.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
