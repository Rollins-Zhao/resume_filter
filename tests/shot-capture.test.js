// Task 2 测试：shot-capture.js 纯函数（离线可测的部分）。
// CDP I/O 部分（开弹层/截图/滚轮/网络监听）属 Task 8 真机验证，不在此mock。
// v2.15.0（BUG-2026-11-05 弹层跳动/重绘错位）：步长 45%、真实到底判定（scrollTop+clientH）、
// 重绘就绪 JPEG 字节稳定判定、重复帧裁决。
// 跑法：node tests/shot-capture.test.js
const assert = require("assert");
const sc = require("../boss-resume-screener/scripts/shot-capture");

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
};

// ---- parseInsightBody：geek/info/v2 响应体 → 牛人分析器明文 ----
const body = JSON.stringify({
  code: 0,
  zpData: {
    encryptGeekDetailInfo: "x".repeat(1024), // 密文（截图方案的盲区，网络层也拿不到明文）
    jobCompetitive: "  牛人38分钟前浏览过职位，其通常活跃时间为2-6pm  ",
    geekCard: { name: "张三" },
  },
});
const p1 = sc.parseInsightBody(body);
check("parseInsightBody 提取 jobCompetitive 并 trim", p1.insight === "牛人38分钟前浏览过职位，其通常活跃时间为2-6pm");
check("parseInsightBody 顺带报告 zpData 明文键（开放问题2：字段全量清单）", Array.isArray(p1.plainKeys) && p1.plainKeys.includes("jobCompetitive"));
check("parseInsightBody 超长截断 500", sc.parseInsightBody(JSON.stringify({ zpData: { jobCompetitive: "长".repeat(600) } })).insight.length === 500);
check("parseInsightBody 非法 JSON 容错", sc.parseInsightBody("not json{").insight === "");
check("parseInsightBody 无 zpData 容错", sc.parseInsightBody("{}").insight === "");
check("parseInsightBody jobCompetitive 非字符串容错", sc.parseInsightBody(JSON.stringify({ zpData: { jobCompetitive: 42 } })).insight === "");

// ---- scrollBottomReached：到底判定（v2.15.0 双保险：真实到底 优先，屏数覆盖回退） ----
// 常规：内容 3000px、视口 900、步 404 → 需 1+ceil(2100/404)=7 屏
check("到底：真实滚动位置覆盖内容高（scrollTop+clientH≥scrollH-2）", sc.scrollBottomReached({ stable: 2, scrollH: 3000, scrollTop: 2100, clientH: 900, viewH: 900, step: 404, shotsTaken: 3 }) === true);
check("到底：稳定且覆盖足够屏数（scrollTop 不可用时回退）", sc.scrollBottomReached({ stable: 2, scrollH: 3000, viewH: 900, step: 720, shotsTaken: 4 }) === true);
check("未到底：真实位置未覆盖且屏数不够（懒渲染封顶假象时不误停）", sc.scrollBottomReached({ stable: 2, scrollH: 3000, scrollTop: 800, clientH: 900, viewH: 900, step: 720, shotsTaken: 3 }) === false);
check("未到底：scrollH 仍在增长（stable<2）——即使位置已到底（懒渲染高度还可能涨）", sc.scrollBottomReached({ stable: 1, scrollH: 3000, scrollTop: 2100, clientH: 900, viewH: 900, step: 720, shotsTaken: 9 }) === false);
check("到底：短简历一屏即完（scrollTop=0 但 clientH 已盖过 scrollH）", sc.scrollBottomReached({ stable: 2, scrollH: 800, scrollTop: 0, clientH: 900, viewH: 900, step: 720, shotsTaken: 1 }) === true);
check("scrollH 远超视口时的需屏数（1+ceil(3300/720)=6 屏）", sc.scrollBottomReached({ stable: 2, scrollH: 4200, viewH: 900, step: 720, shotsTaken: 6 }) === true && sc.scrollBottomReached({ stable: 2, scrollH: 4200, viewH: 900, step: 720, shotsTaken: 5 }) === false);
check("真实到底对 2px 容差（scrollTop+clientH=scrollH-2）", sc.scrollBottomReached({ stable: 2, scrollH: 3000, scrollTop: 2098, clientH: 900, viewH: 900, step: 404, shotsTaken: 2 }) === true);

// ---- shotFileName：文件名 <id>-NN.png ----
check("shotFileName 两位序号", sc.shotFileName("ab12", 3) === "ab12-03.png");
check("shotFileName 序号进位", sc.shotFileName("ab12", 12) === "ab12-12.png");

// ---- planShots：步长与轮次上限参数（v2.15.0：0.8→0.45 视口，24→48 屏） ----
// BUG-2026-11-05：719px 单跳让虚拟画布整屏重绘、中间态可见（内容压扁+空白）；拆小步长+双滚轮减半重绘面积。
const plan = sc.planShots({ canvasH: 900 });
check("planShots 步长=45%视口（重绘面积减半）", plan.step === 405);
check("planShots 上限 48 屏（步长变小后承接张数增多）", plan.maxShots === 48);
check("planShots 视口缺失回落 897", sc.planShots({}).step === Math.round(897 * 0.45));
check("planShots 步长下限 160（小视口防御）", sc.planShots({ canvasH: 250 }).step === 160);

// ---- jpegSizeStable：重绘就绪探测的字节稳定判定（P0-2） ----
check("jpegSizeStable：两次字节数相对变化≤1% 视为稳定", sc.jpegSizeStable(700000, 702000) === true);
check("jpegSizeStable：变化超 1% 不稳定", sc.jpegSizeStable(700000, 750000) === false);
check("jpegSizeStable：双双为空视为稳定（无数据不阻塞）", sc.jpegSizeStable(0, 0) === true);
check("jpegSizeStable：其一为空不稳定（刚出画面）", sc.jpegSizeStable(0, 700000) === false);
check("jpegSizeStable：小图下限 1 字节容差", sc.jpegSizeStable(30, 31) === true);

// ---- judgeDuplicateFrame：重复帧裁决（P1-3，防「静默拍 N 张同图 OCR 缺正文不报错」） ----
check("judgeDuplicateFrame：字节不同 → 正常继续", sc.judgeDuplicateFrame({ sameBytes: false, prevPos: 0, curPos: 404 }) === null);
check("judgeDuplicateFrame：字节相同且滚动已推进 → 卡死中止", sc.judgeDuplicateFrame({ sameBytes: true, prevPos: 0, curPos: 400 }) === "dup-stuck");
check("judgeDuplicateFrame：字节相同且滚动未推进 → 到底收尾", sc.judgeDuplicateFrame({ sameBytes: true, prevPos: 400, curPos: 400 }) === "dup-bottom");
check("judgeDuplicateFrame：位置缺失按到底收尾（防御，不误杀）", sc.judgeDuplicateFrame({ sameBytes: true, prevPos: undefined, curPos: undefined }) === "dup-bottom");

process.exit(failed ? 1 : 0);
