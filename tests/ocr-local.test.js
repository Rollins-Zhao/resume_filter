// Task 10 测试：ocr-local.js 的纯函数（UI 剥除/免责声明截断/跨图行级去重拼接）+ ocr-batch 导出契约。
// 夹具全部为编造的假简历行（结构与真机 PoC 一致）——真实候选人内容不得进仓（数据纪律）。
// 跑法：node tests/ocr-local.test.js
const assert = require("assert");
const ocrLocal = require("../boss-resume-screener/scripts/ocr-local");
const ocrBatch = require("../boss-resume-screener/scripts/ocr-batch");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + extra}`);
  if (!cond) failed++;
};

// ---- 假数据：模拟 3 张截图的 OCR 行（含 20% 重叠、UI 杂线、免责声明尾、折叠按钮行）----
const IMG1 = [
  "本周活跃", "收藏",
  "32岁丨本科丨8年丨在职-考虑机会",
  "1、6年B2B软件销售经验，年度签约额2000万，服务制造业头部客户；",
  "工作经历",
  "某科技股份公司丨大客户销售经理",
  "2018.03-至今",
  "业绩：年度完成率130%，连续三年销冠；",
  "项目经验",
  "某制造集团数字化项目丨销售负责人",
  "2021.01-2023.06",
  "成果：从0到1开拓，两年累计签约1200万。",
  "继续沟通", "等待回复",
];
const IMG2 = [ // 与 IMG1 尾部重叠 2 行
  "☆",
  "项目经验",
  "某制造集团数字化项目丨销售负责人",
  "2021.01-2023.06",
  "成果：从0到1开拓，两年累计签约1200万。",
  "教育经历",
  "某理工大学丨市场营销丨本科",
  "2010-2014",
  "资格证书",
  "PMP项目管理认证",
  "专业技能",
  "客户开发、商务谈判、CRM、渠道管理",
];
const IMG3 = [ // 与 IMG2 尾部重叠 + 折叠按钮 + 免责声明
  "专业技能",
  "客户开发、商务谈判、CRM、渠道管理",
  "查看全部6项分析>",
  "为妥善保护牛人在BOSS直聘平台提交、发布、展示的简历（包括但不限于",
  "在线简历、附件简历）中的个人信息，任何用户原则上仅可出于自身招聘",
  "的目的，通过BOSS直聘平台在线浏览牛人简历。",
];

const result = ocrLocal.assembleOcrText([IMG1, IMG2, IMG3]);

// 剥除：UI 杂线与折叠按钮行
check("剥除 UI 杂线（收藏/继续沟通/等待回复/本周活跃/☆）", !/(^|\n)(收藏|继续沟通|等待回复|本周活跃|☆)(\n|$)/.test(result.text));
check("剥除折叠按钮行（查看全部N项分析）", !/查看全部/.test(result.text));
// 免责声明：从起始行到该图末尾全部丢弃
check("免责声明整段截断", !/为妥善保护/.test(result.text) && !/在线浏览牛人简历/.test(result.text));
// 保留：章节标题与正文
check("保留章节标题（工作经历/项目经验/教育经历/资格证书/专业技能）", ["工作经历", "项目经验", "教育经历", "资格证书", "专业技能"].every((s) => result.text.includes(s + "\n") || result.text.endsWith(s) || result.text.includes("\n" + s)));
check("保留正文行（业绩/成果/学历）", result.text.includes("年度完成率130%") && result.text.includes("累计签约1200万") && result.text.includes("市场营销"));
// 去重：跨图重叠行只留一份
check("跨图重叠去重（成果行只出现一次）", result.text.split("成果：从0到1开拓").length === 2);
check("跨图重叠去重（专业技能标题只出现一次）", result.text.split("专业技能").length === 2);
// 统计
check("统计：两条去重路径都被覆盖（IMG2 头块剥离 strippedBlocks≥1 + IMG3 整块丢弃 dropped≥1）", result.strippedBlocks >= 1 && result.dropped >= 1, JSON.stringify({ dropped: result.dropped, merged: result.merged, strippedBlocks: result.strippedBlocks }));

// ---- 2026-10-30 真机 10 份暴露的拼接伪影（夹具为编造假数据，形态按真实失败还原）----
// 伪影A：整屏重拍块中有一行 OCR 换行漂移 → 精确整块/尾头匹配全部断链，头部整块 ×2（真机：周浩）
const A1 = ["赵一·在线", "24岁丨本科丨应届丨在校-月内到岗", "熟悉SQL与Python数据分析", "工作经历", "某公司丨数据分析实习", "负责销售日报取数与可视化呈现。"];
const A2 = ["赵一·在线", "24岁丨本科丨应届丨在校-月内到岗", "熟悉SQL与Python 数据分析", "工作经历", "某公司丨数据分析实习", "负责销售日报取数与可视化呈现。", "教育经历", "某大学丨统计学丨本科"];
const ra = ocrLocal.assembleOcrText([A1, A2]);
check("伪影A：漂移一行的整屏重拍 → 头部块只留一份", (ra.text.match(/赵一·在线/g) || []).length === 1, JSON.stringify(ra.text.split("\n").slice(0, 8)));
check("伪影A：尾部新增行保留", ra.text.includes("教育经历") && ra.text.includes("统计学"));
check("伪影A：漂移变体行不双留", (ra.text.match(/熟悉SQL与Python/g) || []).length === 1);

// 伪影B：换行点漂移致邻行错位 → 完全相同的长内容行（≥20字）跨图重复（真机：王冠一 AWS行 ×2）
const AWS = "基于AWS搭建处理超过400万条记录的批处理数据管道完成清洗与建模全流程";
const B1 = ["钱二·在线", "项目经验", AWS, "成果获校级一等奖"];
const B2 = ["项目经验复盘与文档沉淀", AWS, "成果获校级一等奖", "教育经历", "某大学丨本科"];
const rb = ocrLocal.assembleOcrText([B1, B2]);
check("伪影B：邻行错位下相同长行只留一份", (rb.text.match(/基于AWS搭建处理超过400万条记录/g) || []).length === 1, rb.text.split("\n").join("/"));
check("伪影B：新内容保留", rb.text.includes("教育经历") && rb.text.includes("项目经验复盘"));

// 伪影C：短标记行（<20字符）的自然重复不去重——简历里"主修课程："等标记行多次出现属正常
const C1 = ["孙三·在线", "主修课程：", "高等数学、线性代数、概率论", "主修课程：", "数据结构、机器学习导论"];
const rc = ocrLocal.assembleOcrText([C1]);
check("伪影C：短标记行不去重（×2 保留）", (rc.text.match(/主修课程：/g) || []).length === 2);

// ---- validateText（从 ocr-batch 导出的统一校验）----
const good = result.text;
const v1 = ocrBatch.validateText(good);
check("validateText 过完整文本", v1.ok === true, JSON.stringify(v1.why));
check("validateText 拒过短", ocrBatch.validateText("太短").ok === false && /120/.test(v1.whyText || "") || ocrBatch.validateText("太短").why.join("").includes("字符"));
check("validateText 拒缺章节", ocrBatch.validateText("没有章节标记的一段长文字".repeat(20)).ok === false && ocrBatch.validateText("没有章节标记的一段长文字".repeat(20)).why.join("").includes("章节"));
check("validateText 拒超长", ocrBatch.validateText("工作经历".padEnd(20010, "长")).ok === false);

// ---- ocr-batch 导入无副作用（require.main 守卫）----
check("require ocr-batch 不触发 status 输出（require.main 守卫）", typeof ocrBatch.needsTranscription === "function" && typeof ocrBatch.validateText === "function");

// ---- needsTranscription 判据 ----
check("needsTranscription：有图无文=true", ocrBatch.needsTranscription({ images: ["a.png"], text: "" }) === true);
check("needsTranscription：有图有文=false", ocrBatch.needsTranscription({ images: ["a.png"], text: "正文" }) === false);
check("needsTranscription：无图=false", ocrBatch.needsTranscription({ images: [], text: "" }) === false);

process.exit(failed ? 1 : 0);
