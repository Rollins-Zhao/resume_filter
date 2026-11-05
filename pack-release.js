#!/usr/bin/env node
/**
 * pack-release.js —— 把 skill 打成可分发的压缩包
 *
 * 用法（在项目根目录）：
 *   node pack-release.js
 *   node pack-release.js --out "D:/somewhere"       # 自定义输出目录
 *   node pack-release.js --version 1.0.3            # 不改源码就换版本号（链式分发用）
 *
 * 产出：
 *   release/liepin-resume-screener-<版本>.zip
 *
 * 设计原则：
 *  - **白名单收集**，绝不整目录打包 —— 杜绝把 data/ reports/ logs/ node_modules/
 *    里的真实候选人数据或上一台的绝对路径带出去。
 *  - **profiles/ 只收模板**（见 PROFILES_ALLOWLIST）—— 真实岗位画像属业务数据，
 *    打包出去的是「工具」，不是「用户的招聘策略」。
 *  - **自带 ZIP 写入器**（Node 内置 zlib，无第三方依赖），文件名按 UTF-8 写入并置
 *    bit 11 标志位，中文文件名在各平台解压都正常；不依赖 PowerShell / zip 命令。
 *  - **链式可分发**：脚本自身（连同 pack-release.bat / README.md）也在白名单里，
 *    所以对方解压后能自己再打一个同样干净的包转发给下一个人（A→B→C）。
 *    这正是「不能右键压缩整个文件夹」的原因 —— 那会把对方的真实数据带出去。
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const OUT_DIR = (() => {
  const i = process.argv.indexOf("--out");
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, "release");
})();

// 包名：自 v1.1.0 起包含「猎聘 + BOSS直聘」两个通道，故不再用 liepin 前缀。
// 仍保留 liepin-login.bat 等猎聘专属文件（BOSS 无需登录启动器）。
// 兼容说明：老版本产出的包名为 liepin-resume-screener-*.zip，新包名不同，不会互相覆盖。
const NAME = "resume-screener";

// 版本号：默认取下面的 DEFAULT_VERSION；用 `--version 2.0.1` 可覆盖，
// 让接手的人不必改源码就能换个号，避免链式分发时新旧包同名混淆。
// 2.0.0 = 开源化改造：统一 run.bat 入口、setup 双平台安装、推荐去重索引、移除 html 卡片产出。
// 2.1.0 = 用户背景档案 profiles/_user.json（run.bat 首次引导 + {company} 话术占位符）。
// 2.2.0 = 全局每日简历浏览配额（每平台 1000 硬顶，多岗位均分剩余额度，画像可指定 dailyResumeQuota）。
// 2.3.0 = 工作时间窗口（默认 8:00-20:00 软停止）+ 已发布岗位直连（joblist）+ README 场景手册。
// 2.3.1 = BOSS 直达简历链接（拼 token+搜索串双保险）+ 背景档案缺失机器兜底提示 + SKILL.md 契约第 0 步与版本戳。
// 2.3.2 = 背景档案硬门槛（退出码 4）+ AI-GUIDE 权威契约 + ai-guide-sync 平台记忆同步机制（默认 workbuddy，可扩展任意平台）。
// 2.4.0 = BOSS 报告链接诚实化（搜索串/抓取时间可见列、链接降级辅助）+ open-candidate.js 现搜现开（重搜刷新令牌 + CDP 登录浏览器开标签）+ 首跑引导可选补充问与平台记忆衔接契约（AI-GUIDE 二节）。
// 2.4.1 = 双击即达打开候选人：根目录 打开候选人.bat（= node run.js open）——选岗位→最近一轮清单前 20→搜索直达（仅 BOSS）。
//         （注：打开候选人.bat / open-candidate.js 链路已于 2026-10-21 晚整体移除——Excel 搜索直达链接已是主路径。）
//         链接方案定案（当日真机证伪旧直链 web/geek?securityId：从来不是有效页面）：报告「BOSS简历」列与
//         open-candidate 均改为沟通页搜索直达 query=<姓名|公司+职位>（无时效、目标人排最前、零平台 API）。
//         另含真机修复：boss.js PYTHONUTF8=1（GBK 生僻字崩→假 NETWORK_ERROR）、config.js 画像 bossCity 翻译自锁
//         （恒搜北京池）、screener 预检登录自愈（boss login --cdp 免扫码）、Chrome 136 /json/new 忽略 url→Page.navigate、
//           脱敏姓名降级（***→公司+职位）、CDP 9333→9222 自探测（两个登录器都适配）。
// 2.5.0 = BOSS 简历正文取回 fetch-text.js（平台 2026-10-22 下线旧简历接口、正文 canvas 化后走「拖选+复制+读剪贴板」通道；
//         无开关默认启用、失败即 FatalError 中止不降级——用户拍板。真机 2229 字符/份多次稳定。
//         运行前提：登录浏览器沟通页开着 + BOSS_CDP_URL 指对端口 + Node≥22；取文期间短暂占用系统剪贴板并自动恢复）。
// 2.5.1 = 沟通页标签机器强制预检（无则 Target.createTarget 自动开、开不了即中止）+ ENDPOINT_DEPRECATED
//         立即停止不再吃满 3 次熔断——2026-10-26 事故：沟通页没开整轮空跑并疑似触发账户风控（铁律 9 补课）。
// 2.5.2 = 2026-10-27 首次 BOSS 真机跑通后的修复批次（交接文档 docs/2026-10-27-BOSS筛选链路修复记录.md）：
//         fetch-text 五处真机修复回移（chat/index 收紧判定 / 最小化窗口自动还原 / 关弹层点 close-btn /
//         拖选起点钳视口+滚回顶部 / 取文同弹层重试一次）+ 弹层未就绪重开再试（R-03）+
//         风控锁预检（R-01）+ 熔断仍出报告（R-02）+ exceljs 依赖自检（R-06）+ dry-run 端口真探测（R-07）+
//         S/A 级自动收藏（用户拍板新特性，仅 BOSS）+ 画像指南 contextWords 专题（R-05）。
// 2.6.0 = LLM 精细评估（双引擎可选）：AI 会话逐份读简历工作内容打分（不接任何模型 API，用的就是当前会话的
//         模型）；llm-batch.js（两侧镜像）管批次/校验/落盘（20 份隔离单元防对话滚动平方级烧 token、规则分
//         降序好苗子先评、中断不亏）；report.js 两侧镜像支持 LLM 口径（等级/评分按精细评估 + 规则对照列 +
//         匹配依据列，未评估规则分兜底）；首跑引导加评估方式一问（settings.scoringPreference，自然语言可切）；
//         config.js 两行加载提示改 stderr（llm-batch next 的 stdout 保持纯 JSON）；画像 evaluationCriteria 字段。
// 2.6.1 = 2026-10-27 猎聘风控事故（浏览 20 份第 15 份触发风控、期间网页频繁刷新；WorkBuddy 诊断=浏览频率
//         过高，用户拍板）双管齐下：① 刷新/登录环守护 refresh-guard.js（两侧镜像，check-mirrors 收编）——
//         CDP 只读侦听常驻浏览器主帧导航，20s 滑窗 ≥6 次导航或落到登录页即 process.exit(3) 立即全停并落
//         本地风控锁 data/_quota/<平台>.risk-lock.json（带锁启动拒跑，人工确认恢复后删锁解锁；猎聘 CLI
//         exit 3 / BOSS ACCOUNT_RISK 等也落锁）；CDP 不可达即拒跑（机器强制，测试 SCREENER_SKIP_REFRESH_GUARD=1）。
//         ② 猎聘节奏放缓：简历间 10–25s→25–55s、搜索间 15–30s→20–40s、阶段切换 30–90s→60–150s，
//         新增每连看 5 份歇口气 60–180s（restEvery/restBreak）；BOSS 节奏不动。
// 2.7.0 = BOSS 自动打招呼（授权制）+ 弃用自动收藏（2026-10-28 用户拍板；收藏按钮对未沟通候选人被
//         平台权限拦截证伪，路线判死）。新 greet.js：settings.greet 显式开启（首跑 BOSS 两问 /
//         --setup-greet；退出码 5=未授权机器强制）后对本轮真实浏览且最终 S/A 的候选人自动发首条招呼
//         （话术=报告建议话术列或用户固定话术；5 参数走 greet-pool.json 快照——rescore 重建 last-results
//         会丢 search.geekCard/viewedThisRun）；greet-ledger.js 全局账本 data/_quota/boss-greet.json
//         （日顶 20 画像不可覆盖 + geek 级跨岗位去重）；间隔 60–180s、单次≤10、连续 2 败熔断、风控落锁；
//         report.js 加「打招呼」状态列（boss 单侧合法差异，镜像基线 135→169 重录）；红线口径全线改写
//         「默认不打招呼，需显式开启」（README/AI-GUIDE/两 SKILL/CLAUDE.md，AI-GUIDE 新增三·五节）。
// 2.7.1 = 2026-10-29 打招呼「假成功」事故止血（BUG-2026-10-29-boss-greet-未投递.md）：实测搜索来源
//         （hr candidates 卡片）参数 hr greet 回执 sent:true 但平台不投递不落会话。两道闸：① 搜索来源
//         （lid 含 lookupsearchgeek / securityId 回退污染）一律 manual-required（报告「未发(需手动)」）；
//         ② 任何回执成功必须 hr chat 回查到会话才记账（NOT_DELIVERED/UNVERIFIED 不入账可重试）；报告
//         sent 标签改「已发送(已核验)」。病因三假设（参数上下文 H1/开聊卡 H2/登录令牌 H3）与 T1/T2
//         区分实验决策树见 BUG 文档§11，定案前不承诺搜索来源自动发送。
// 2.8.0 = 推荐牛人管线 + 双源架构改造（2026-10-29 用户拍板「绕开付费搜索开聊」）：screener 新增推荐源
//         （BOSS_SOURCE=both 默认/reco/search；hr jobs list 按 jobTitle 解析职位加密 ID 或画像写
//         bossJobEncryptId；已聊过/好友跳过；最多 6 页/轮）——推荐来源 greet 免费且已实证投递（T1），
//         自动打招呼对推荐来源 S/A 生效；搜索来源维持 v2.7.1 止血闸（需手动）。同批：hr resume 接口
//         退役（wapi/zpjob/view/geek/info 下线，boss-agent-cli#472）→ 双源统一「卡片骨架
//         （cardToStructured）+ 弹层 canvas 正文」，denied.json 停写留档。
// 2.8.1 = 来源默认值翻转（用户拍板）：BOSS_SOURCE 默认 both → **reco（仅推荐牛人）**——搜索来源开聊
//         需手动/付费搜索畅聊卡，不默认烧浏览额度；要搜索显式 BOSS_SOURCE=both|search。文档同步。
// 2.8.2 = ①来源偏好进首跑引导（settings.bossSource：reco/both/search 三选一 + 畅聊卡成本提示，
//         --setup-greet 顺带重问；优先级 env BOSS_SOURCE > settings > 默认 reco）；
//         ②报告链接修复：frame/search 直达的卡片不可交互（用户实测点名字/联系均无反应，平台只读化）
//         → 改沟通页搜索入口 web/chat/search + 「搜索串」列粘贴，备注附平台收费提示。
// 2.8.3 = 成本提示防概括（2026-10-29 用户实证：workbuddy AI 把来源问题的畅聊卡成本提示概括成
//         「联系方式是否收费」，关键信息丢失——铁律 9 同款病根）：AI-GUIDE 三·五改为**必须逐字包含**
//         「推荐免费」「搜索来源需按人头购买搜索畅聊卡约 ¥10+/人」两句原文；run.js 非交互提示行
//         同样带全文案（要求 AI 逐字引用工具输出，不给概括空间）。
// 2.8.4 = 成本写进选项文字本身（用户拍板「能不能加在标题里」）：三选项逐字为 ①仅推荐牛人（打招呼免费）
//         ②推荐+搜索（搜索来源打招呼需消耗『搜索畅聊卡』，按人头扣 1–5 次、约 ¥10+/人）
//         ③仅搜索（打招呼需消耗『搜索畅聊卡』）——run.bat 引导/非交互提示/AI 契约（AI-GUIDE 三·五）
//         三处同款文案，禁止 AI 挪到题干或概括。
// 2.9.0 = BUG-2026-10-30 三连修（P0+两 P1，夹具全绿）：① 评估档位机器强制——scoringPreference
//         "detailed" 不再是死配置：llm-scores 未覆盖本轮候选池时 report 退出码 6 拒出报告
//         （SCREENER_FORCE_FAST=1 单次降级）；screener 收尾指引分流；run.js 筛选后断点交互；
//         AI-GUIDE 第 0 步清单+新「三·六」节；报告首行固定标注「评估方式」自证口径。
//         ② greet UNKNOWN 回执回查（greet-receipt.js）：GREET_RESULT_UNKNOWN 与 ok 同路 hr chat
//         回查，查到会话即入账（防漏账→对同一人重发）。③ report 同轮重出：screener 落
//         run-meta.json，去重索引记 runId——同轮重出覆盖不跳过，跨轮才跳过（重出不再空表）。
// 2.9.1 = 两项产品修正（10-30 真机审计后用户拍板）：① 报告默认全量收录（minReportGrade 默认 A→C，
//         画像仍可钉 A/S 收紧，模板/示例/文档同步）；② BOSS 来源升级为开工必问（settings.bossSource
//         未落档必须问询落档，禁止打印选项走默认——AI-GUIDE 契约与两侧 SKILL.md 第 0 步清单双补）。
// 2.9.2 = 三缺口修复（10-30 真机审计发现，用户确认立项）：① report.js 依赖自检——缺 exceljs
//         时直调路径此前抛裸 MODULE_NOT_FOUND 栈，现给出「跑 setup.bat / npm install」指引（两侧）；
//         ② 超短正文完整性警告——弹层取文 <500 字时 screener 如实标记（不熔断不兜底），llm-batch next
//         对 <800 字简历打 shortTexts 标记提醒评估侧证据面窄；③ SKILL.md 手动命令统一补
//         SCREENER_REPORTS_DIR（手动跑 report 不再落进数据目录深处）。
// 2.9.3 = joblist 适配 boss-agent-cli v3.1.0（10-30 Edge 真机：hr jobs list 改分页嵌套
//         data.data[]、城市键 locationName、岗位 ID 键 encryptId——旧解析 exit 5，且 encryptId 缺失
//         会断推荐源岗位解析；新旧结构双兼容，离线单测+真机 3 岗位验证，镜像基线重录）。
// 2.9.4 = Edge 轮三修（10-30 深夜，TDD 红→绿+真机验证）：① 缺口④遮挡节流探测——拖选前实测
//         Input 响应（fetch-text assertInputResponsive），>2s 明示「浏览器被遮挡请保持可见」中止
//         （此前 maximized 被遮挡仍节流→必撞 10s 硬超时，报错不说原因）；② joblist --json 纯度——
//         CLI/内核检查提示转 stderr（两侧 check-cli-update，stdout 可整段直解，真机验证）；
//         ③ run.js「从已发布岗位新建」解析——parseJobsPayload 替换取末行（多行 JSON 此前只拿到 ]），
//         附 require 守卫使本文件可被单测 require。
// 2.9.5 = 取文可观测性改进（缺口⑤部分）：GEO_JS 返回 scrollH（内容真实高度），拖选步数
//         由固定 14 改为按 scrollH 动态计算（下限 14），日志带 scrollH。⚠ 同日完整性审计实证：
//         拖选-复制通道存在非确定性（同一份简历两次取文 9309 vs 4989 字符，尾部可截断），
//         教育经历等尾部模块缺失为「候选人未填+取文截断」混合成因——缺口⑤（通道非确定性）
//         未解，待专项调查（弹层 DOM 实测/Ctrl+A 方案/多趟拼接）。
// 2.9.6 = ①提速三件套（用户拍板「10 份 20 分钟不可接受」）：推荐翻页按需早停（凑够浏览预算+5 即停，
//         少翻页=少请求更安全）；BOSS 间隔收紧（翻页 [20,40]→[10,18]、简历间 [15,35]→[10,20]、
//         长休息 [40,100]→[30,60]，仍远高于风控事故节奏；猎聘不动）；boss.js 支持 BOSS_CLI_DELAY
//         全局注入 --delay（screener 列表类调用 8-15s，greet 等主动触达不动 CLI 保守默认）。
//         ②红线补钉：禁止开启 CLI v3.1.0 内置 boss agent / operating_mode:autonomous（含自动交换
//         联系方式，踩红线；用户 2026-10-30 拍板）。③取文缺口⑤调查结论入档：canvas 懒渲染+
//         DOM 无文本层（探针实证 innerText=0）→ 拖选-复制非确定性；两个仓促方案实测更差已回退，
//         保持 v2.9.5 逻辑 + scrollH 可观测性，确定解（分段拼接）待专项。
// 2.9.7 = ①节奏纠偏（用户二次拍板「回到旧节奏而非越快越好」）：CLI v3.1.0 的 30-60s 节流保持
//         官方默认不注入（boss.js 机制保留但无人默认设置）；BOSS 间隔恢复——简历间 [15,35]（浏览
//         不走 CLI，此值即真实节奏）、长休息 [40,100]；翻页 [8,15]（CLI 已含 30-60s，只补随机性）。
//         ②取文分段采集 v1（缺口⑤）：预热滚到底→逐视口短拖选复制→行级重叠去重拼接（mergeSegments
//         单测 8 例全绿）；真机实证完整性改善（候选人A 815→609 但教育经历/资格证书/专业技能从无到
//         有；候选人B 9309→11246）；⚠ 已知局限：滚轮推进不稳定（短简历段重复靠防呆终止）+ 懒渲染高度
//         疑似封顶 ~4600px（超长简历尾部模块仍可能缺）——待专项二轮（键盘翻页/边缘自动滚动路线）。
// 2.9.8 = 取文混合策略+去重三连（用户抓出重复 bug 后的三轮修复，单测 9 例全绿+真机验证）：
//         ① mergeSegments v2——块包含丢弃（滚轮未推进的整段重复）+ 归一化子串丢弃（断行/空白
//         差异的近似段，≥80 字符才启用防误丢）+ 尾头行级重叠拼接；② 采集改混合：整趟拖选先行
//         （大覆盖），缺尾部模块标记再分段补采，按唯一非空行数择优（防重复虚增）；③ 实证结论：
//         iframe 为平台虚拟滚动（scrollTop 恒 0、滚轮推进会振荡），黑盒下无法确定性取全——
//         重复率 62.7%→3.1%，尾部模块短简历可达，超长简历受懒渲染高度疑似封顶限制（待二轮）。
// 2.10.0 = 取文架构 v3（2026-10-31 用户拍板，交接文档 docs/2026-10-31-取文架构交接-截图转写方案.md；
//         同日二轮拍板 OCR 内联）：①正文改「截图 + 本机 RapidOCR 识别」——shot-capture.js 阅读式慢滚
//         截图存 data/扫描图/（截屏前点开「查看全部N份经历/项分析」折叠，实证 8 份经历只展开 1 份），
//         ocr-local.js/py 本机识别（uv spawn rapidocr-onnxruntime，剥 UI/免责声明/mergeSegments 跨图
//         去重（三层：头块剥离/边界拼接/长行首现去重——真机实证滚轮振荡整屏重拍普遍存在），
//         校验过即回填 text——零 token 主通道），AI 会话转写降为兜底（ocr-batch.js next/save/
//         status）；拖选-复制保留为显式回退（BOSS_TEXT_MODE=drag），不逆向 wasm（红线）。②牛人分析器列：
//         开弹层前挂 Network 监听回收 geek/info/v2 的 zpData.jobCompetitive 明文 → 报告「牛人分析」列。
//         ③机器强制：report 退出码 7=转写未完成拒出报告；llm-batch next 跳过未转写；greet 等级口径
//         改 llm-scores > last-results(rescore) > 池快照；run.js 转写断点。单测：mergeSegments 9 例 +
//         shot-capture 纯函数 16 例 + ocr-batch 15 例 + ocr-local 16 例 + report 门槛 12 例 + 导出 13 例
//         （根 tests/，不进包）。同日补丁：④三层去重组装（真机 11 份实证滚轮振荡整屏重拍——头块
//         剥离/边界拼接/≥20字长行首现去重，内容行重复≈0）+⑤截图自动过期清理（已识别 PNG 保留
//         SCREENER_SHOT_RETENTION_DAYS 天默认 7，screener 启动时清；待转写与文本 json 不动）。
//         ⑥doctor.js 环境自检自愈（用户拍板「小白开 workbuddy 说岗位即开跑」）：AI 首次任务开工环节
//         跑 node doctor.js --json——exceljs/liepin-cli/uv/boss-agent-cli/浏览器内核缺了自动装（npm 走
//         shell:true——Node CVE-2024-27980 补丁后直接 spawn .cmd 报 EINVAL，本机实证），修不了的给小白
//         指引；分组就绪（critical/liepin/boss），契约钉在 AI-GUIDE「五」与两侧 SKILL 第 0 步。
// 2.11.0 = 历史文件统一清理（2026-11-02 用户拍板「所有历史文件保留 1 天，做成可配」）：新增两侧镜像
//         cleanup.js——按保留期（settings.retentionDays 默认 1 天，env SCREENER_RETENTION_DAYS，
//         0=关断）清过期日志/简历缓存/结果缓存/截图；报告、去重索引、配额账本永不清理（产品承诺）。
//         run.js 启动全局预扫 + screener 启动清自己 ROOT + CLI（--days/--dry）按需手清；v2.10.0 的
//         SCREENER_SHOT_RETENTION_DAYS 截图 7 天独立清理并入统一保留期（旧 env 退役）。自然语言改法
//         钉在 AI-GUIDE「三·八」与两侧 SKILL settings 第 10 条（对 AI 说「历史文件保留改成 N 天」）。
//         单测：cleanup 21 例（取代 shot-retention 10 例，根 tests/，不进包）。
// 2.12.0 = greet 回查预算适配 + 报告名消毒（BUG-2026-11-03，workbuddy 真机反馈）：① boss 侧回查抽出
//         greet-verify.js——CLI v3.1.0+ RequestBudget 预算层（任何两次派发最小间隔 30s、单进程等待上限
//         30s）与旧节奏（3 轮×5s×60s 超时）结构性不兼容致恒 UNVERIFIED 不记账；新节奏=首轮前等 40s、
//         轮间隔 45s、进程超时 150s、REQUEST_BUDGET_EXHAUSTED 按 retry_after 等；② 发送前预检沟通列表
//         （pending 补记 + 同话术会话跳过，防重复触达硬保险）；③ UNVERIFIED 落账本 pending（不占额度、
//         阻断重发），报告新增「待核实/本轮补记/会话已存在」状态；④ 两侧 config.sanitizeJobLabel——
//         工作表名/文件名裸拼 jobTitle 遇「/」等禁字符崩溃（exceljs 抛错/文件名 ENOENT）。
//         单测：greet-verify 12 例 + greet-ledger 14 例 + report-sanitize 24 例（根 tests/，不进包）。
// 2.13.0 = GitHub 公开仓 + 工具本体自更新（2026-11-04 用户拍板：取代「打包→微信发送→解压覆盖」分发）：
//         ①self-update.js 根脚本——run.bat 启动与 AI 开工契约两路触发，查 GitHub Release 最新版→下载
//         zip 就地覆盖升级（双层取版：API releases/latest 优先、常量名 latest 资产 HEAD 兜底不吃限额），
//         失败单行提示不阻塞；profiles/_user.json、data/reports/logs/.env 等白名单第二道防线永不触碰；
//         ②pack-release --publish 一条命令发版（建 Release + 传版本 zip / 常量名 latest zip / install.bat
//         三资产，token 读 .env github_token）；③install.bat 引导安装器（新同事放进空文件夹双击即装）；
//         ④run.bat 启动接线（run.bat 写 .new 延迟生效，规避 cmd 改运行中批处理的错位坑）；⑤洗掉历史
//         版本注释里的真实候选人姓名（此前随每次分发包外泄，本次一并纠正）。
// 2.13.1 = 一句话装机/升级（2026-11-05 用户提出「请拉取XXX开源项目」）：README 顶部新增「一句话装机」
//         节——给人复制的话术 + 给冷启动 AI 的执行指引（先问装过没有→装过=zip 覆盖解压原文件夹（用户
//         数据目录不在 zip 内）/没装过=新文件夹→curl 稳定地址下载→Expand-Archive 或 System32 tar 解压
//         （注明 git-bash GNU tar 不认 zip）→doctor.js --json 装依赖→引导扫码→告知此后全自动更新）；
//         AI-GUIDE「四」加装机话术行。纯文档级：存量同事的「最后一次手动 zip」也收敛为一句话。
// 2.13.2 = 契约层随更新刷新（2026-11-05 用户问「新对话会不会触发更新检查」时挖出的缺口）：.workbuddy/
//         memory/MEMORY.md 等 ai-guide-sync 同步目标被打包排除、也不随 self-update 刷新——同事新对话
//         自动加载的契约停留在装机版本，「五」的开工三命令等改进到不了位。修复：self-update.js 升级
//         成功后自动 spawn `ai-guide-sync.js --all`（失败不阻塞）；README「一句话装机」AI 指引第 4 步
//         补跑同款命令（覆盖升级旧文件夹时必须）。
// 2.13.3 = 契约刷新时机修正（2.13.2 发布后 E2E 实证缺陷）：刷新只挂"升级成功后"时，旧版升上来的
//         第一跳跑的还是旧 self-update 代码（无刷新逻辑）——永远赶不上。改为**每次运行**都刷
//         （幂等、纯本地毫秒级、失败不阻塞），旧版机器下一次启动即补齐。
const DEFAULT_VERSION = "2.13.3";
const VERSION = (() => {
  const i = process.argv.indexOf("--version");
  if (i === -1) return DEFAULT_VERSION;
  const v = process.argv[i + 1];
  if (!v) {
    console.error("[ERROR] --version 后面要跟版本号，例如 --version 1.0.3");
    process.exit(1);
  }
  if (!/^\d+(\.\d+)*$/.test(v)) {
    console.error(`[ERROR] --version 只接受数字点分格式，例如 1.0.3（收到：${v}）`);
    process.exit(1);
  }
  return v;
})();

// 铁律 2 机器强制：打包前校验两侧镜像文件（结构性漏同步会在这里被拦下）。
// check-mirrors 是开发工具、不进发布包：发布包内（链式分发后）再打包时跳过校验，本仓内强制。
let mirrorCheck;
try {
  mirrorCheck = require("./check-mirrors");
} catch {
  mirrorCheck = null;
  console.log("[提示] 未找到 check-mirrors.js（发布包内属正常），跳过镜像校验。");
}
if (mirrorCheck) mirrorCheck.run({ fatal: true });

// ---------- 打包白名单 ----------
// 整个放进包的目录（这些目录里不含任何真实数据）
const INCLUDE_DIRS = [
  "liepin-resume-screener", // 猎聘通道：SKILL.md + references/ + scripts/
  "boss-resume-screener",   // BOSS 直聘通道：SKILL.md + references/ + scripts/
];

// profiles/ 是「业务数据」目录：里面既有通用模板，也有用户真实在招岗位画像。
// 打包**只允许模板进包**——真实画像含在招岗位、搜索关键词、评分权重等业务信息，
// 一并外发等于把招聘策略交出去。
// 用**允许名单**而不是黑名单：用户将来新增任何岗位画像都会被自动挡住，
// 不会因为"忘了把这个文件名登记进排除表"而泄露。
const PROFILES_DIR = "profiles";
// 允许进包：模板 + example- 开头的通用示例画像（真实岗位画像一律排除）
const PROFILES_ALLOWLIST = (name) => name === "_template.json" || name.startsWith("example-");

// 单独放进包根目录的文件
// ⚠️ pack-release.js / pack-release.bat 必须进包：对方（同事 A）拿到后才可能再打一个
//    干净的包转发给下一个人（A→B→C）。缺了它们，A 只能右键压缩整个文件夹，
//    而那个文件夹里躺着 A 的真实岗位画像和候选人简历数据。
const INCLUDE_FILES = [
  "run.bat",            // 统一双击入口（选平台+岗位，自动自检、出报告）
  "run.js",             // 统一入口本体
  "self-update.js",     // 工具本体自更新（v2.13.0：查 GitHub Release → 下载 zip 就地覆盖升级）
  "doctor.js",          // 环境自检自愈（v2.10.0：AI 首次任务开工环节跑，缺依赖自动装——小白「开对话即用」的闭环件）
  "setup.bat",          // 一次性安装（猎聘 + BOSS 双平台；末尾自动同步 AI 契约到 workbuddy）
  "liepin-login.bat",   // 猎聘登录启动器（自动探测 Chrome/Edge，不写死机器路径）
  "boss-edge-login.bat",   // BOSS 登录启动器（Edge + CDP 9333）
  "boss-zhipin-login.bat", // BOSS 登录启动器（Chrome + CDP 9222）
  "AI-GUIDE.md",        // AI 会话入口契约（权威源；各平台记忆文件由 ai-guide-sync.js 从这里同步）
  "ai-guide-sync.js",   // 契约同步脚本（node ai-guide-sync.js <平台>；--add 注册新平台）
  "ai-guide-targets.json", // 平台注册表（workbuddy/doubao/claude/codex/cursor，可扩展）
  "pack-release.js",    // 打包脚本本体（链式分发的关键）
  "pack-release.bat",   // 打包脚本的双击启动器
  "package.json",       // 根依赖清单（exceljs）
  "README.md",          // 使用说明
  "CLAUDE.md",          // AI 助手的开发/使用约定
  ".gitignore",         // 防止使用者把运行数据误提交到自己的 git 仓库
];

// 明确排除（即使出现在上面的目录里也不打包）—— 双保险
const EXCLUDE_NAMES = new Set([
  "node_modules",
  "data",
  "reports",
  "logs",
  "release",        // 产物目录本身（防御性：万一将来有人把它加进 INCLUDE_DIRS）
  ".pack-staging",
  "tests",           // 开发仓单测（mergeSegments/ocr-batch/report 门槛等）——不随包分发（v2.10.0）
  ".superpowers",    // AI 会话工作台账（开发过程产物，含调试笔记）——不进包
  ".git",
  ".gitignore",     // 根目录单独收进包；目录内出现同名文件时不重复收（见 INCLUDE_FILES）
  ".workbuddy",     // harness 会话记忆（含用户习惯与业务信息）
  "chrome-win64",   // 浏览器内核解压残留（约 400MB，可自动重装）
  ".DS_Store",
  "Thumbs.db",
]);

// ---------- ZIP 写入器（store / deflate，无依赖） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {{name:string,data:Buffer}[]} entries  name 用 / 分隔 */
function buildZip(entries) {
  const local = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const size = e.data.length;
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < size;
    const payload = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    lh.writeUInt16LE(20, 4); // 解压所需版本
    lh.writeUInt16LE(0x0800, 6); // bit 11 = 文件名 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); // 修改时间
    lh.writeUInt16LE(0x21, 12); // 修改日期 = 1980-01-01（合法值）
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    ch.writeUInt16LE(20, 4); // 创建版本
    ch.writeUInt16LE(20, 6); // 解压所需版本
    ch.writeUInt16LE(0x0800, 8); // bit 11 = UTF-8
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centralParts.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + payload.length;
  }

  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...centralParts, eocd]);
}

// ---------- 收集文件 ----------
const packed = [];
const skipped = [];

/**
 * @param {(name:string)=>boolean} [allowFile] 可选的文件级过滤；返回 false 则排除并记入 skipped
 */
function walk(absDir, relDir, allowFile) {
  for (const name of fs.readdirSync(absDir)) {
    if (EXCLUDE_NAMES.has(name)) {
      skipped.push(path.posix.join(relDir, name));
      continue;
    }
    const abs = path.join(absDir, name);
    const rel = path.posix.join(relDir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, rel, allowFile);
    else if (st.isFile()) {
      if (allowFile && !allowFile(name)) {
        skipped.push(rel);
        continue;
      }
      packed.push({ abs, rel, size: st.size });
    }
  }
}

for (const d of INCLUDE_DIRS) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) {
    console.error(`[ERROR] 缺少目录：${d}`);
    process.exit(1);
  }
  walk(abs, d);
}

// profiles/：只收允许名单里的文件（默认仅 _template.json），真实岗位画像一律排除。
// 目录不存在不视为致命错误——用「自然语言生成画像」的工作流本来就不需要它。
const profilesAbs = path.join(ROOT, PROFILES_DIR);
if (fs.existsSync(profilesAbs)) {
  walk(profilesAbs, PROFILES_DIR, (name) => PROFILES_ALLOWLIST(name));
} else {
  console.warn(`[WARN] 找不到 ${PROFILES_DIR}/，包内将不含岗位画像模板`);
}

for (const f of INCLUDE_FILES) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) {
    console.warn(`[WARN] 跳过不存在的文件：${f}`);
    continue;
  }
  packed.push({ abs, rel: f, size: fs.statSync(abs).size });
}

if (packed.length === 0) {
  console.error("[ERROR] 没有任何文件被打包，请检查白名单");
  process.exit(1);
}

// ---------- 写入 zip ----------
const outName = `${NAME}-${VERSION}.zip`;
const outPath = path.join(OUT_DIR, outName);
fs.mkdirSync(OUT_DIR, { recursive: true });

const entries = packed.map((p) => ({ name: p.rel, data: fs.readFileSync(p.abs) }));
const zipBuf = buildZip(entries);
fs.writeFileSync(outPath, zipBuf);

// ---------- 报告 ----------
const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(`\n=== 打包完成 ===`);
console.log(`输出：${outPath}`);
console.log(`大小：${kb(zipBuf.length)}（原始 ${kb(packed.reduce((s, p) => s + p.size, 0))}）`);
console.log(`文件数：${entries.length}\n`);

const byTop = {};
for (const p of packed) {
  const top = p.rel.includes("/") ? p.rel.split("/")[0] + "/" : "(根目录)";
  byTop[top] = (byTop[top] || 0) + 1;
}
console.log("包含：");
for (const [k, v] of Object.entries(byTop)) console.log(`  ${k}  ${v} 个文件`);
console.log("\n清单：");
for (const p of packed.sort((a, b) => a.rel.localeCompare(b.rel))) {
  console.log(`  ${p.rel}  (${kb(p.size)})`);
}

if (skipped.length) {
  console.log("\n已排除（双重保险，防止真实数据外带）：");
  for (const s of [...new Set(skipped)]) console.log(`  ${s}`);
}

console.log(`\nprofiles/ 只放模板与 example- 示例画像，真实岗位画像已全部排除。`);
console.log(`包内两个通道：liepin-resume-screener/（猎聘，Node）、boss-resume-screener/（BOSS直聘，Python/uv）。`);
console.log(`下一步：把 ${outName} 发给对方，解压后按 README.md 三步走：setup.bat → 登录器扫码 → run.bat。`);
console.log(`这个包自身可再分发：对方解压后双击 pack-release.bat 即可再打一个同样干净的包给下一个人。`);

// ---------- GitHub 发版（--publish，v2.13.0）：打包后一条命令建 Release + 传资产 ----------
// 维护者专用。前置：.env 配 github_token=<GitHub classic PAT，勾 public_repo scope>（env GITHUB_TOKEN 可临时覆盖）。
// 注意：创建 Release 会在默认分支上自动打 tag v<版本> —— **先 git push 再 --publish**，否则 tag 落在旧代码上。
// 资产三件：resume-screener-<版本>.zip / resume-screener-latest.zip（常量名：self-update tier2 与 install.bat
// 依赖的稳定地址）/ install.bat（引导安装器，缺则 WARN 不阻塞）。
if (process.argv.includes("--publish")) {
  const https = require("https");

  // .env 极简解析（全仓唯一消费方，不引 dotenv）：取首个 github_token=<值>
  const readEnvToken = () => {
    try {
      const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8").replace(/^﻿/, "");
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*github_token\s*=\s*(\S+)\s*$/i.exec(line);
        if (m) return m[1];
      }
    } catch {
      /* .env 不存在走下面的报错 */
    }
    return null;
  };
  const TOKEN = process.env.GITHUB_TOKEN || readEnvToken();
  if (!TOKEN) {
    console.error("[ERROR] 未配置 github_token：在项目根 .env 加一行 github_token=<classic PAT（勾 public_repo）>，或临时设环境变量 GITHUB_TOKEN。");
    process.exit(1);
  }

  // 仓址单一来源：优先 env，其次取 self-update.js 导出的 REPO（同一常量两处用），最后兜底占位
  let REPO_SLUG = process.env.SCREENER_SELF_UPDATE_REPO || "";
  if (!REPO_SLUG) {
    try {
      REPO_SLUG = require("./self-update").REPO;
    } catch {
      REPO_SLUG = "Rollins-Zhao/resume_filter";
    }
  }

  /** 维护者界面：错误要响亮（与 self-update 的「失败不阻塞」哲学相反——发布失败必须停下看） */
  const ghRequest = (method, host, urlPath, bodyBuf, extraHeaders = {}) =>
    new Promise((resolve, reject) => {
      const headers = {
        Authorization: `token ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "resume-screener-packer",
        ...extraHeaders,
      };
      if (bodyBuf) {
        headers["Content-Type"] = extraHeaders["Content-Type"] || "application/json";
        headers["Content-Length"] = bodyBuf.length;
      }
      const req = https.request({ host, path: urlPath, method, headers, timeout: 60000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body });
          else reject(new Error(`GitHub ${method} ${urlPath} → HTTP ${res.statusCode}：${body.split(/\r?\n/)[0].slice(0, 300)}`));
        });
      });
      req.on("timeout", () => req.destroy(new Error("请求超时（60s）")));
      req.on("error", reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  const j = (o) => Buffer.from(JSON.stringify(o), "utf8");

  (async () => {
    const force = process.argv.includes("--force");
    console.log(`\n=== 发布到 GitHub：${REPO_SLUG} · v${VERSION} ===`);

    // 1) 建 Release；422（tag 已有 Release）默认硬报错，--force 删同名资产后复用重传
    let rel;
    try {
      rel = JSON.parse(
        (
          await ghRequest("POST", "api.github.com", `/repos/${REPO_SLUG}/releases`, j({
            tag_name: `v${VERSION}`,
            name: `v${VERSION}`,
            body: `resume-screener ${VERSION}。变更明细见包内 pack-release.js 版本注释与 README 更新日志。`,
          }))
        ).body
      );
      console.log(`Release 已创建：${rel.html_url}`);
    } catch (e) {
      if (!/HTTP 422/.test(e.message)) throw e;
      if (!force) throw new Error(`v${VERSION} 的 Release 已存在。提升版本号，或加 --force 删旧资产后重传。\n  原因：${e.message}`);
      rel = JSON.parse((await ghRequest("GET", "api.github.com", `/repos/${REPO_SLUG}/releases/tags/v${VERSION}`)).body);
      const latestName = `${NAME}-latest.zip`;
      for (const a of rel.assets || []) {
        if (a.name === outName || a.name === latestName || a.name === "install.bat") {
          await ghRequest("DELETE", "api.github.com", `/repos/${REPO_SLUG}/releases/assets/${a.id}`);
          console.log(`--force 已删旧资产：${a.name}`);
        }
      }
      console.log(`复用已有 Release：${rel.html_url}`);
    }

    // 2) 传三资产（同 Buffer 双名上传：版本名 + 常量名 latest）
    const uploads = [
      { name: outName, data: zipBuf, type: "application/zip" },
      { name: `${NAME}-latest.zip`, data: zipBuf, type: "application/zip" },
    ];
    const installBat = path.join(ROOT, "install.bat");
    if (fs.existsSync(installBat)) uploads.push({ name: "install.bat", data: fs.readFileSync(installBat), type: "text/plain" });
    else console.warn("[WARN] 根目录无 install.bat，本版不上传该资产");
    for (const u of uploads) {
      const r = await ghRequest(
        "POST",
        "uploads.github.com",
        `/repos/${REPO_SLUG}/releases/${rel.id}/assets?name=${encodeURIComponent(u.name)}`,
        u.data,
        { "Content-Type": u.type }
      );
      console.log(`资产已上传：${u.name}（HTTP ${r.status}）`);
    }

    console.log(`\n=== 发布完成 ===`);
    console.log(`稳定下载地址（发给同事 / install.bat 用，永远指向最新版）：`);
    console.log(`  https://github.com/${REPO_SLUG}/releases/latest/download/${NAME}-latest.zip`);
    console.log(`同事装好 v2.13.0 后，run.bat 启动与 AI 开工都会自动升级到本版，无需再发 zip。`);
  })().catch((e) => {
    console.error(`[ERROR] 发布失败：${e.message}`);
    process.exit(1);
  });
}
