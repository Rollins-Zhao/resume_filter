// v2.12.0：报告工作表名/文件名消毒（BUG-2026-11-03 附带 bug）
// 现象：jobTitle 含「/」（如「海外仓销售经理/主管」）时 exceljs 抛
//   Worksheet name cannot include any of the following characters: * ? : \ / [ ]
// 且文件名里的「/」会被 path.join 当目录分隔符 → ENOENT。
// 这里测两侧 config.js 镜像提供的 sanitizeJobLabel（工作表名禁字符与 Windows 文件名禁字符的并集）。
// 跑法：node tests/report-sanitize.test.js
const assert = require("assert");

const sides = [
  { label: "boss", cfg: require("../boss-resume-screener/scripts/config") },
  { label: "liepin", cfg: require("../liepin-resume-screener/scripts/config") },
];

let failed = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : ` —— ${detail}`}`);
  if (!cond) failed++;
}

for (const { label, cfg } of sides) {
  const fn = cfg.sanitizeJobLabel;
  check(`[${label}] 导出 sanitizeJobLabel`, typeof fn === "function", `typeof=${typeof fn}`);
  if (typeof fn !== "function") continue;

  check(`[${label}] 正常标题原样保留`, fn("销售经理推荐") === "销售经理推荐", fn("销售经理推荐"));
  check(
    `[${label}] 实证字符「/」消毒`,
    fn("海外仓销售经理/主管推荐") === "海外仓销售经理-主管推荐",
    fn("海外仓销售经理/主管推荐")
  );
  // exceljs 工作表名禁字符 ∪ Windows 文件名禁字符
  check(`[${label}] exceljs 禁字符 * ? : \\ / [ ]`, !/[*?:\\\/\[\]]/.test(fn("a*b?c:d\\e/f[g]h")), fn("a*b?c:d\\e/f[g]h"));
  check(`[${label}] Windows 文件名禁字符 < > " |`, !/[<>|"]/.test(fn('a<b>c"d|e')), fn('a<b>c"d|e'));
  check(`[${label}] 控制字符消毒`, !/[\x00-\x1f]/.test(fn("a\x00b\x1fc")), JSON.stringify(fn("a\x00b\x1fc")));
  check(`[${label}] 连续禁字符合并`, fn("a//b??c") === "a-b-c", fn("a//b??c"));
  check(`[${label}] 首尾连接符修剪`, fn("/销售经理/") === "销售经理", fn("/销售经理/"));
  // Excel 工作表名硬上限 31 字符（默认）
  const long = "销".repeat(40);
  check(`[${label}] 默认截断到 31 字符`, fn(long).length === 31, `len=${fn(long).length}`);
  check(`[${label}] 空串安全`, typeof fn("") === "string" && fn("") === "", JSON.stringify(fn("")));
  check(`[${label}] 非字符串入参安全`, fn(null) === "" && fn(123) === "123", `${fn(null)} / ${fn(123)}`);
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
