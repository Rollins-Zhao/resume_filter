// mergeSegments 回归测试（v2.9.8 分段拼接 v2 的 9 例，v2.10.0 重建保留——上会话临时脚本已按 PII 纪律删除）。
// 三形态：① 整块重复丢弃 ①' 归一化子串丢弃（≥80 字符才启用）② 尾-头行级重叠拼接。
// 跑法：node tests/merge-segments.test.js
const assert = require("assert");
const { mergeSegments } = require("../boss-resume-screener/scripts/fetch-text");

let failed = 0;
const case_ = (n, name, segs, expect) => {
  try {
    const got = mergeSegments(segs);
    const ok = (expect.text === undefined || got.text === expect.text) &&
      (expect.merged === undefined || got.merged === expect.merged) &&
      (expect.dropped === undefined || got.dropped === expect.dropped);
    console.log(`${ok ? "PASS" : "FAIL"} 例${n} ${name}`);
    if (!ok) { console.log(`  got    : ${JSON.stringify(got)}`); console.log(`  expect : ${JSON.stringify(expect)}`); failed++; }
  } catch (e) {
    console.log(`FAIL 例${n} ${name} — 异常 ${e.message}`);
    failed++;
  }
};

// 例1 空输入
case_(1, "空数组 → 空文本", [], { text: "", merged: 0, dropped: 0 });
// 例2 单段原样
case_(2, "单段 → 原样返回", ["A\nB\nC"], { text: "A\nB\nC", merged: 0, dropped: 0 });
// 例3 形态①：后段整块已包含于前段（滚轮未推进的从头复制）→ 丢弃
case_(3, "整块重复 → 丢弃", ["A\nB\nC", "A\nB\nC"], { text: "A\nB\nC", merged: 0, dropped: 1 });
// 例4 形态①'：断行/空白差异的同内容长段（≥80 归一化字符）→ 丢弃
case_(4, "归一化子串包含（长段）→ 丢弃",
  ["工作经历\n" + "负责华东区大客户开发与维护，年销售额持续增长。".repeat(6) + "\n教育经历\n某大学", "工作经历" + "负责华东区大客户开发与维护，年销售额持续增长。".repeat(6) + "教育经历某大学"],
  { dropped: 1 });
// 例5 形态②：尾-头行级重叠 → 去重拼接
case_(5, "尾-头重叠 1 行 → 拼接", ["A\nB\nC", "C\nD\nE"], { text: "A\nB\nC\nD\nE", merged: 1, dropped: 0 });
// 例6 无重叠多段 → 直连（段间空行）
case_(6, "无重叠 → 直连", ["A\nB", "C\nD"], { text: "A\nB\n\nC\nD", merged: 0, dropped: 0 });
// 例7 三段混合：整块重复 + 正常推进
case_(7, "混合：重复1段+重叠1段", ["A\nB\nC", "A\nB\nC", "C\nD"], { text: "A\nB\nC\nD", merged: 1, dropped: 1 });
// 例8 全部为同一段的重复 → 只留第一份
case_(8, "全重复 → 单份", ["X\nY", "X\nY", "X\nY"], { text: "X\nY", merged: 0, dropped: 2 });
// 例9 短段不做归一化包含丢弃（<80 字符，防短通用段误丢）→ 保留直连
case_(9, "短段近似不误丢（80 下限保护）", ["AB\nCD", "AB CD"], { merged: 0, dropped: 0 });

console.log(failed ? `\n${failed} 例失败` : "\n9/9 全绿");
process.exit(failed ? 1 : 0);
