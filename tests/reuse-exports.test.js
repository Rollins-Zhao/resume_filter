// Task 1 测试：fetch-text.js 须导出 S1（截图采集器）复用的构件。
// 这些构件原本是模块内部函数/常量，shot-capture.js 需要它们（交接文档「复用：openPopupJs /
// GEO_JS / MEASURE_JS / assertInputResponsive（均已导出或可导出）」）。跑法：node tests/reuse-exports.test.js
const assert = require("assert");
const ft = require("../boss-resume-screener/scripts/fetch-text");

const REQUIRED = [
  "fetchResumeText",
  "extractFromOpenPopup",
  "ensureChatTab",
  "assertInputResponsive",
  "mergeSegments",
  // S1 复用件（v2.10.0 起导出）
  "openPopupJs",
  "GEO_JS",
  "MEASURE_JS",
  "DIALOG_JS",
  "closePopupIfOpen",
  "waitForCanvas",
  "attachChatPage",
];

let failed = 0;
for (const name of REQUIRED) {
  const ok = typeof ft[name] === "function" || typeof ft[name] === "string";
  console.log(`${ok ? "PASS" : "FAIL"} export ${name} (${typeof ft[name]})`);
  if (!ok) failed++;
}

// attachChatPage 返回的会话对象须支持事件订阅（Network.responseReceived 监听用）
if (typeof ft.attachChatPage === "function") {
  // 不真连浏览器：只校验源码里实现了 on 分发（连真浏览器属 Task 8 真机验证）
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "boss-resume-screener", "scripts", "fetch-text.js"), "utf8");
  const hasOn = /const on = \(method, fn\)/.test(src) && /evListeners\.has\(m\.method\)/.test(src);
  console.log(`${hasOn ? "PASS" : "FAIL"} attachChatPage 事件订阅（源码面）`);
  if (!hasOn) failed++;
}

process.exit(failed ? 1 : 0);
