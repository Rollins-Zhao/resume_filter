// Task 2 测试：shot-capture.js 纯函数（离线可测的部分）。
// CDP I/O 部分（开弹层/截图/滚轮/网络监听）属 Task 8 真机验证，不在此mock。
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

// ---- scrollBottomReached：到底判定 ----
// 常规：内容 3000px、视口 900、步 720 → 需 1+ceil(2100/720)=4 屏；稳定 2 次且拍了 4 屏 → 到底
check("到底：稳定且覆盖足够屏数", sc.scrollBottomReached({ stable: 2, scrollH: 3000, viewH: 900, step: 720, shotsTaken: 4 }) === true);
check("未到底：稳定但屏数不够（懒渲染封顶假象时不误停）", sc.scrollBottomReached({ stable: 2, scrollH: 3000, viewH: 900, step: 720, shotsTaken: 3 }) === false);
check("未到底：scrollH 仍在增长（stable<2）", sc.scrollBottomReached({ stable: 1, scrollH: 3000, viewH: 900, step: 720, shotsTaken: 9 }) === false);
check("到底：短简历一屏即完", sc.scrollBottomReached({ stable: 2, scrollH: 800, viewH: 900, step: 720, shotsTaken: 1 }) === true);
check("scrollH 远超视口时的需屏数（1+ceil(3300/720)=6 屏）", sc.scrollBottomReached({ stable: 2, scrollH: 4200, viewH: 900, step: 720, shotsTaken: 6 }) === true && sc.scrollBottomReached({ stable: 2, scrollH: 4200, viewH: 900, step: 720, shotsTaken: 5 }) === false);

// ---- shotFileName：文件名 <id>-NN.png ----
check("shotFileName 两位序号", sc.shotFileName("ab12", 3) === "ab12-03.png");
check("shotFileName 序号进位", sc.shotFileName("ab12", 12) === "ab12-12.png");

// ---- planShots：步长与轮次上限参数 ----
const plan = sc.planShots({ canvasH: 900 });
check("planShots 默认步长=80%视口", plan.step === 720);
check("planShots 默认上限 24 屏", plan.maxShots === 24);
check("planShots 视口缺失回落 897", sc.planShots({}).step === Math.round(897 * 0.8));

process.exit(failed ? 1 : 0);
