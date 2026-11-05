// v2.14.0 平台预筛 + 学历缺失不误剔：
// ① boss.js withPlatformFilter：画像 platformFilter → hr candidates 参数透传（纯函数）
// ② report.js：卡片/接口缺学历时不再被 minDegree 硬筛误剔，学历列明示「未知(卡片缺失)」
//    （v2.10.0 遗留缺口：BOSS 搜索卡 geekDegree 缺失，"—" 被当最低档剔掉，即使文本写着本科）
// 跑法：node tests/platform-prefilter.test.js
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + extra}`);
  if (!cond) failed++;
};

// ---------- ① withPlatformFilter 纯函数 ----------
const { withPlatformFilter } = require(path.join(ROOT, "boss-resume-screener", "scripts", "boss.js"));
const base = ["hr", "candidates", "销售", "--city", "-2", "--page", "1"];
const withPf = withPlatformFilter(base, { degree: "203,203", age: "25,35", experience: "-1,-1", salary: "-1,3", schoolLevel: "", activeness: undefined });
check("透传：degree/age/experience/salary 按序追加", JSON.stringify(withPf.slice(-8)) === JSON.stringify(["--degree", "203,203", "--age", "25,35", "--experience", "-1,-1", "--salary", "-1,3"]), JSON.stringify(withPf));
check("透传：空串/undefined 的筛选项跳过", !withPf.includes("--school-level") && !withPf.includes("--activeness"));
check("透传：不修改原数组", base.length === 7);
check("透传：pf 缺省 → 原样返回", withPlatformFilter(base, undefined).length === 7);
check("透传：键名用驼峰（schoolLevel → --school-level）", withPlatformFilter([], { schoolLevel: "1101" }).join(" ") === "--school-level 1101");

// ---------- ② report 学历缺失不误剔（夹具集成） ----------
const SCRIPTS = path.join(ROOT, "boss-resume-screener", "scripts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-"));
const text = "基本资料：李某，8年B2B销售。\n工作经历\n2016-2024 某科技公司 大客户销售总监\n负责SaaS产品销售。\n教育经历\n某大学 工商管理 本科\n专业技能\n大客户开发";
try {
  const data = path.join(TMP, "data");
  fs.mkdirSync(path.join(data, "resumes"), { recursive: true });
  // candA 有学历；candB 卡片缺学历（v2.10.0 实证形态：fields 无 degree 键）
  fs.writeFileSync(path.join(data, "last-results.json"), JSON.stringify([
    { id: "candA", group: "推荐", ids: { name: "甲", geekId: "g1", jobId: "j1" }, fields: { name: "甲", company: "某公司", title: "销售", city: "北京", age: "32", degree: "本科", workYears: "8年" }, score: { total: 60, grade: "B" }, fetchedAt: new Date().toISOString(), viewedThisRun: true },
    { id: "candB", group: "搜索", ids: { name: "乙", geekId: "g2", jobId: "j2" }, fields: { name: "乙", company: "某公司B", title: "大客户销售", city: "北京", age: "29" }, score: { total: 55, grade: "B" }, fetchedAt: new Date().toISOString(), viewedThisRun: true },
  ]));
  fs.writeFileSync(path.join(data, "resumes", "candA.json"), JSON.stringify({ id: "candA", text, fetchedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(data, "resumes", "candB.json"), JSON.stringify({ id: "candB", text: text.replace("李某", "王某"), fetchedAt: new Date().toISOString() }));
  const profile = path.join(TMP, "profile.json");
  fs.writeFileSync(profile, JSON.stringify({ jobTitle: "平台预筛测试", city: "北京", reportFilters: { minDegree: "本科" } }));

  const run = (script, args, extraEnv = {}) =>
    spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, SCREENER_DATA_DIR: TMP, SCREENER_REPORTS_DIR: path.join(TMP, "reports"), JOB_PROFILE: profile, ...extraEnv },
    });
  const r = run("report.js", []);
  check("report 退出码 0", r.status === 0, r.stderr && r.stderr.slice(0, 300));
  const files = fs.readdirSync(path.join(TMP, "reports")).filter((f) => f.endsWith(".xlsx"));

  (async () => {
    check("报告文件生成", files.length === 1, JSON.stringify(files));
    if (!files.length) return;
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(TMP, "reports", files[0]));
    const ws = wb.worksheets[0];
    const hArr = [...ws.getRow(2).values].map((v) => String(v || ""));
    const degIdx = hArr.findIndex((h) => h.includes("学历"));
    check("表头含「学历」列", degIdx > 0, JSON.stringify(hArr));
    if (degIdx < 0) return;
    let hasA = false;
    let hasB = false;
    ws.eachRow((row, rn) => {
      if (rn < 3) return;
      const cells = [...row.values].map((v) => String(v || ""));
      if (cells.some((c) => c.includes("本科")) && degIdx && String(row.getCell(degIdx).value) === "本科") hasA = true;
      if (String(row.getCell(degIdx).value) === "未知(缺失)") hasB = true;
    });
    check("有学历者（本科）在报告中", hasA);
    check("缺学历者未被误剔且明示「未知(缺失)」", hasB); // 修复前：candB 被 minDegree 硬筛剔掉 → 此处 FAIL
  })().catch((e) => check("xlsx 读取", false, String(e.message)))
    .then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} console.log(failed ? `\n${failed} FAILED` : "\nALL PASS"); process.exit(failed ? 1 : 0); });
} catch (e) {
  console.log("FAIL 夹具异常", e.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
