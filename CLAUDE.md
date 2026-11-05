<!-- AI-GUIDE (由 ai-guide-sync.js 维护，改契约请改 AI-GUIDE.md 后重新同步) BEGIN -->

# AI-GUIDE —— 本项目的 AI 会话入口契约（权威源）

> 本文件是**平台无关的权威契约**。各 AI 平台的记忆/规则文件（workbuddy 的 `.workbuddy/memory/MEMORY.md`、豆包等的 `AGENTS.md`、Claude Code 的 `CLAUDE.md`）由 `ai-guide-sync.js` 从本文件同步生成——**改契约只改这里**，然后重新同步。

## 一、招聘任务入口（用户提到招人/筛简历/找候选人时）

**必须先读对应 skill 的说明书再动手，不允许凭目录里的模板文件自行发挥：**

- 猎聘 → 读 `liepin-resume-screener/SKILL.md` 的「二·五、标准调用话术」
- BOSS直聘 → 读 `boss-resume-screener/SKILL.md` 的「二·五、标准调用话术」

## 二、硬性第 0 步：用户背景档案（profiles/_user.json）

**生成任何岗位画像或运行筛选之前，必须确认 `profiles/_user.json` 存在。**

- **不存在** → 先问用户四个问题：① 公司/项目名 ② 所属行业 ③ 一句话业务方向 ④ 常用招聘城市（多个用顿号分隔）。四项确认后，可再问**一个可选补充问**：「还有什么想补充的背景吗？如主要产品、目标客户、招聘偏好（没有则跳过）」。确认后写入：

```json
{
  "_说明": "用户背景档案。改内容让 AI 改或记事本编辑；删掉后 run.bat 会重新引导。",
  "companyName": "", "industry": "", "businessSummary": "", "commonCities": [],
  "updatedAt": "<当前时间>", "history": []
}
```

- **补充问的存放规则（不新增字段）**：补充内容以「；补充：<内容>」追加到 `businessSummary` 末尾（原方向为空时写「补充：<内容>」）；跳过就不加。run.bat 首跑引导（`--setup-user`）同口径。
- **评估方式偏好（settings.scoringPreference，开工环节主动问一次）**：确认档案存在的同时，检查 `settings.scoringPreference` 是否已落档——没落档就问一次：「简历评估方式：1 快速（默认——免费、速度快，关键词规则打分，颗粒度较粗） 2 精细（AI 逐份读简历工作内容打分，更准并附匹配依据，消耗模型积分/token）」。**BOSS 侧正文由截图+本机 RapidOCR 自动识别（零 token，v2.10.0 起，见「三·七」）；档位差异仅在评估深度**。选择写入档案（跳过/拒绝 → 写 "fast"，不再追问）。**选了精细的硬性后果见「三·六」**。
- **平台记忆只是预填建议，不是事实来源**：AI 平台自身记忆（全局记忆、其他会话摘要等）里留有用户公司/行业等背景时，**不得直接采信写入档案**——只能当预填建议，逐项向用户复述、确认后才能写入；用户说「沿用之前的」也必须逐项过一遍。示例话术：
  「我在其他会话里记得你的公司是讯流国际（跨境物流）。档案『公司/项目名』填『讯流国际』、『所属行业』填『跨境物流』，对吗？业务方向和常用招聘城市也请逐项确认一下。」
- **存在但用户话语与档案冲突**（如换了公司/行业）→ 列出差异确认后更新，旧值追加进 `history`。用户只说"**这个岗位**不限行业"→ 只改该岗位画像，不动档案。
- 用户拒绝回答 → 写一个空档案（四项留空），不再追问。

## 三、退出码 4 = 背景档案门槛

screener 在 `profiles/_user.json` 不存在时**拒绝筛选**（退出码 4）。遇到它：按上面第 0 步问四项、建档案、重跑——**不要绕过、不要重复硬跑**。测试环境可用环境变量 `SCREENER_SKIP_USER_CONTEXT=1` 跳过。

## 三·五、BOSS 自动打招呼授权（settings.greet；退出码 5 = 未授权）

BOSS 侧 v2.7.0 起支持「显式开启的自动打招呼」：筛选后对**本轮真实浏览且最终 S/A 级**的候选人自动发首条招呼（全局同一人只发一次、每日本地硬顶 20 条、话术发送前校验）。**默认不开启；猎聘侧永远没有此功能。**

> ⚠️ **2026-10-29 起搜索来源暂停自动发送（v2.7.1 止血）**：实测平台对搜索来源参数「假成功」（回执 sent:true 但不投递、不落会话）。现在搜索来源候选人一律标「未发(需手动)」，任何发送必须回查沟通列表核实才算成功。定案前**不要向用户承诺会自动发**——如实说明当前状态，引导用报告「BOSS简历」列链接手动打招呼。病因与实验进展见仓库 `BUG-2026-10-29-boss-greet-未投递.md`。

- 授权存于 `profiles/_user.json` 的 `settings.greet`：`{enabled, mode:"job"|"fixed", fixedText, askedAt, updatedAt}`。
- **主动问（2026-10-29 补，用户实测踩中的缺口）**：AI 发起 BOSS 筛选任务的**开工环节**（与档案/画像确认同一时机），检查 `settings.greet` 是否已落档——**没有就问一次下面那两问**（用户拒绝也写入 `enabled:false` 落档，之后不再追问）。不能只等退出码 5：AI 直接调脚本的编排路径不会 spawn greet.js，退出码 5 永远不出现，用户就永远没机会被问到。
- **已开启时的 AI 手动编排**：`settings.greet.enabled=true` 时，BOSS 侧手动序列为 **screener（截图+OCR 内联）→（有 OCR 未过的份则 ocr-batch 转写 → rescore，见「三·七」）→ greet.js → report.js**（greet 在报告前，报告才有「打招呼」状态列）；档案评估偏好=精细时在最后一步 report 前插入 llm-batch 评估：**screener → llm-batch → greet.js → report.js**（见「三·六」）。greet.js 无参数按档案真发，试水用 `--dry` / `--only <id>`，`BOSS_GREET=0` 临时关断。
- **greet 节奏与「待核实」状态（v2.12.0）**：回查已对齐 CLI 请求预算层（任何两次派发最小间隔 30s）——**单人发送→核实典型约 1 分钟（消息落库延迟时最坏 2.5-4 分钟），不是卡死**，不要因慢而杀进程/重跑。报告「打招呼」列出现**「待核实(已防重发,请人工确认)」**= 发送回执 ok 但回查失败（消息很可能已送达，2026-11-03 实证），工具已落 pending 阻断自动重发——引导用户人工在沟通列表确认即可；**不要对同一人重跑 greet 重发**。
- **AI 遇到 greet.js 退出码 5（未授权）**：说明用户没开启过自动打招呼，按下面两问向用户确认后写入档案、再跑（**不要绕过、不要重复硬跑**，与退出码 4 同款纪律）：
  ① 「要不要开启 BOSS 自动打招呼？范围是本轮 S/A 级候选人（主动触达：消耗平台额度、有账号风控风险；每天本地最多 20 条、同一人全局只发一次；不开启则保持只读筛选，之后不再追问）」
  ② 同意后再问「话术来源：**按岗位建议话术**（报告『建议打招呼话术』列，各岗位可不同，未配用内置默认）/ **固定话术**（你自己写一段，可基于预填占位符草稿改或从零写）」——选固定话术时把草稿/用户口述的话术**全文复述确认**后录入 `fixedText`。
- **写入前必须逐项向用户确认**（与背景档案同款纪律：平台记忆只是预填建议，不得直接采信写入）；用户拒绝 → 写 `enabled:false`（记住"拒绝"，不再追问）。修改/关闭随时可做：让用户跑 `run.bat --setup-greet`，或用户口头要求时 AI 改（同样先确认并复述新值）。
- **简历来源偏好（v2.8.4；v2.9.1 起为开工必问项；成本必须写在选项文字本身）**：`settings.bossSource`（`reco`/`both`/`search`）。未落档时在 BOSS 任务开工环节**必须问**——与 `settings.greet`、`settings.scoringPreference` 同一轮问询落档，**不允许只打印选项就走默认**（2026-10-30 实测：AI 打印三选项后自行按默认 reco 跑，用户根本没被问到——同类「该问没问」缺陷）。**选项文案逐字如下**——畅聊卡成本嵌在每个选项里，禁止挪到题干说明或概括掉（2026-10-29 两次实证均因此丢失关键信息）：
  ① 「仅推荐牛人（打招呼免费）」
  ② 「推荐+搜索（搜索来源打招呼需消耗『搜索畅聊卡』，按人头扣 1–5 次、约 ¥10+/人）」
  ③ 「仅搜索（打招呼需消耗『搜索畅聊卡』）」
  用户选择后写入档案；跳过/拒绝 → 写 "reco" 落档，不再追问；修改用 `run.bat --setup-greet`（顺带重问）或用户口头要求时 AI 改（先复述确认）。env `BOSS_SOURCE` 显式指定时以 env 为准（仅供用户本人/测试）。
- **不要替用户拍板**：没有授权不要调 `boss hr greet`，不要擅自设 `BOSS_GREET=1`（env 覆盖仅供用户本人显式使用）。演练/试水用 `--dry`（零发送）。测试环境 `SCREENER_SKIP_USER_CONTEXT=1` 自动跳过该阶段。
- 节奏/记账/试水参数/未验证点见 `boss-resume-screener/SKILL.md`「四·六」。

## 三·六、评估档位门槛（settings.scoringPreference；退出码 6 = 精细评估未完成）

档案 `settings.scoringPreference: "detailed"`（精细评估）是**硬约束，不是偏好信号**（v2.9.0 起。2026-10-30 P0 实证：修复前它是死配置——选了精细的用户拿到的全是关键词分，报告还无任何标注）。

- **AI 必须执行的顺序**：screener →（BOSS 且有个别 OCR 未过的份：**`ocr-batch.js` 转写兜底见「三·七」→ `screener.js rescore`**）→ **精细评估（`llm-batch.js`：`next` 吐批 → 会话内批内输出全部评估 JSON → `save` 落账，循环至 `status` 全部已评）** → （BOSS 且已开启打招呼）greet.js → report.js。流程与批量纪律（20 份隔离单元等）见两侧 SKILL.md「精细评估」节。
- **机器面**：评估未覆盖本轮候选池时 `report.js` **退出码 6 拒绝出报告**。遇到它：按上面流程完成 llm-batch 评估后重跑 report——**不要绕过、不要重复硬跑**（与退出码 4/5 同款纪律）。本次显式降级快速档用 `SCREENER_FORCE_FAST=1`（不改档案）；长期改用快速档 → 把档案 `scoringPreference` 改为 "fast"（先向用户复述确认）。
- 报告首行固定标注「评估方式：快速/精细…」，终端同步打印——用户必须能一眼看出分数口径。

## 三·七、BOSS 取文架构（v2.10.0 起正文=截图 + 本机 RapidOCR 识别；退出码 7 = 转写未完成）

BOSS 简历正文被平台加密画进 canvas（DOM 无文字、拖选复制非确定），v2.10.0 起取文 = **截图 → 本机 RapidOCR 内联识别（主通道，零 token、纯本地，PII 不出机）→ 校验不过的个别份由 AI 会话读图转写兜底**（用户 2026-10-30 拍板；不接外部 OCR API）。

- **主通道自动完成，AI 无需介入**：screener 浏览时逐份截图存 `data/扫描图/` → 本机识别剥 UI 杂线/免责声明并跨图去重 → `validateText` 校验（≥120 字符、含章节标记）通过即回填 `text`、当场打分。**快速档筛完直接出报告**。
- **兜底链（仅个别 OCR 未过的份，机器面会明示）**：`ocr-batch.js`：`next` 吐图片路径清单 → 会话内逐份读图转写为纯文本（保留章节标题行、重叠内容只留一份、忽略照片/UI 文字、不臆造、末图须含尾部模块）→ `save <转写.json>` 回填 → `screener.js rescore`。细节见 boss SKILL.md「四·五」。
- **机器面**：还有待转写者时 `report.js` **退出码 7 拒绝出报告**；`llm-batch.js next` 跳过未转写者（全批未转写时退出码 1 指向 ocr-batch）。遇到它们：按兜底链转写后重跑——**不要绕过、不要重复硬跑，转写无降级选项**。
- **红线**：不逆向 wasm/不读 canvas 像素提取明文；截图仅落本机、报告不嵌图、测试产物测完即删、不外发。截图通道故障的人工回退 = `BOSS_TEXT_MODE=drag`（拖选-复制），不要自动跨通道兜底；`BOSS_OCR=0` 可关断本地识别（全量走 AI 转写）。

## 三·八、历史文件自动清理（settings.retentionDays，默认保留 1 天）

历史文件不无限堆积（2026-11-02 用户拍板）：**run.bat 启动时与两侧 screener 启动时自动清理超过保留期的历史文件**，保留期默认 **1 天**、存于 `profiles/_user.json` 的 `settings.retentionDays`（非负整数，`0` = 关断清理；画像不可覆盖；env `SCREENER_RETENTION_DAYS` 仅供测试/用户本人覆盖）。

- **清理范围（按文件 mtime 超期才删）**：日志（`logs/` 与 `data/` 树下任意 `.log`）、简历缓存（`resumes/*.json`，含 PII 正文）、结果缓存（`last-results.json` / `llm-scores.json` / `greet-pool.json`）、BOSS 截图（`扫描图/*.png`，v2.10.0 的 7 天独立清理已并入本统一保留期）。
- **永不清理（产品承诺，非「历史文件」）**：`reports/` 报告、去重索引（`processed.json` / `recommended-index.json`）、配额与记账（`data/_quota/` 全家、各岗位 `quota.json`）。
- **自然语言改法（本节存在的意义）**：用户说「历史文件保留改成 N 天 / 清理关掉」，AI 就改 `settings.retentionDays`（先复述确认新值，同 `workingWindow` 口径），改完即生效（下次启动按新保留期执行）。当前值随时可看：`profiles/_user.json`。
- **AI 按需手动清理**：`node <skill>/scripts/cleanup.js`（项目根运行；`--days N` 单次指定保留期，`--dry` 只计数不实删）。
- **后果须知**：保留期内的当日数据不受影响（筛选→评估→报告同日完成不受任何影响）；**隔天**的缓存数据会被清——隔天想补出报告/重新评估（rescore、llm-batch）需重筛，属预期行为不是故障。待转写截图超期同样清（隔天即视为弃案）。

## 四、常用入口

- **推荐用户用**：双击项目根 `run.bat`（菜单选平台和岗位；首跑会自动引导建立背景档案，4 问 + 1 个可选补充问）。
- **AI 会话快速调用话术**（用户复制即可）：
  > 我需要招一个【岗位名称】，要求是【城市/年限/关键要求】，请你用【猎聘招聘 SKILL / BOSS直聘 SKILL】帮我筛选简历。
  > （只报岗位名也行：「我在猎聘上招销售经理，帮我筛简历。」）
- AI 会话内手动命令：见各 SKILL.md 第三节（数据目录用 `SCREENER_DATA_DIR` 按 岗位/平台 隔离）。
- 新同事装机 / 存量旧版升级：发 README「一句话装机」节的话术（给 AI 的执行指引也在该节）——AI 下载 Release zip 解压（旧版=覆盖原文件夹，用户数据目录不在 zip 内不会被碰）+ `doctor.js` 装依赖，全程无需用户懂 git/GitHub。
- 手动转发压缩包（备用路径）：只用 `pack-release.bat` 打包，不要右键压缩整个文件夹（会把真实数据带出去）。

## 五、环境自检（doctor）与 CLI 必查必升（所有 AI 平台通用铁律）

**环境自检（v2.10.0 起，首次任务必做）**：每个平台的**首次招聘任务开工环节**（与背景档案确认同时），先跑 `node doctor.js --json`——它会自检并**自动安装**能装的依赖（exceljs / liepin-cli / uv / boss-agent-cli / 浏览器内核，镜像优先），修不了的（Node 缺失、需扫码登录）会给小白可执行的指引。按 `DOCTOR_JSON` 输出处理：`criticalReady=false` → 让用户按 userActions 处理后再跑；本次任务平台的分组（`liepinReady`/`bossReady`）必须 ✅ 再开跑筛选。**不要跳过、不要凭"上次跑过"假设环境还在**（用户可能换机器/重装/覆盖更新过文件夹——覆盖更新会丢 node_modules，2026-10-30 实证）。

**CLI 版本必查必升**：

**新开任何 AI 会话、以及每次动手调用本工具前，先检查两侧 CLI 版本，不是最新版就立刻升级：**

```bash
node liepin-resume-screener/scripts/check-cli-update.js   # 默认即检查 + 自动升级
node boss-resume-screener/scripts/check-cli-update.js     # 默认即检查 + 自动升级（无人值守）
node self-update.js                                       # 工具本体自更新（v2.13.0；项目根有本文件才跑，skill 单独外置时跳过）
```

- 升级失败（registry/PyPI 不可达）只提示、不阻塞；`LIEPIN_CLI_AUTOUPDATE=0` / `BOSS_CLI_AUTOUPDATE=0` 仅应急关断，不是常规路径。
- **工具本体同样自动更新（v2.13.0 起）**：`node self-update.js` 查 GitHub Release 最新版并下载就地升级（run.bat 每次启动也自动跑）；失败单行提示不阻塞；`SCREENER_SELF_UPDATE=0` 仅应急关断。只升级代码文件，用户数据（profiles/_user.json、data/、reports/、.env）白名单防线永不触碰；**每次运行自动刷新契约层**（`ai-guide-sync.js --all`——`.workbuddy/` 等同步目标不随 zip 走，v2.13.3 起，否则用户新对话自动加载的还是旧契约）。
- Claude Code 会话已由 SessionStart hook 机器强制（每次新会话自动跑上面三条）；其他平台 AI 请把这三条命令当作会话开工第一步，**不要问用户要不要升级**。
- 升级 liepin-cli 后必须 `liepin quit` 杀掉旧版拉起的常驻浏览器再重新登录，否则新代码配旧实例照旧。

<!-- AI-GUIDE END -->

# CLAUDE.md —— AI 助手工作约定（本项目）

这是猎聘 + BOSS直聘简历筛选工具的仓库。AI 助手（Claude Code / WorkBuddy / 豆包等）在本项目里工作时遵守以下约定。

## 项目定位

- 给非开发用户（HR/招聘）的简历筛选工具：搜索 → 打分 → Excel 推荐报告 →（BOSS 可选）授权制自动打招呼。**默认绝不自动打招呼/群发/交换联系方式**；唯一例外 = BOSS 侧 `settings.greet` 显式开启后的 S/A 首条招呼（授权 + 全局记账 + 日硬顶，2026-10-28 用户拍板，详见两份 SKILL.md 红线节与 boss「四·六」）。猎聘侧无此例外、保持纯只读。
- 用户优先走 `run.bat`（统一入口）；AI 会话内手动命令的语义见各 skill 的 SKILL.md。
- 岗位画像（profiles/*.json）与用户背景档案（profiles/_user.json，公司/行业信息）是用户业务数据：不提交、不打包、不外传；`_template.json` 和 `example-*.json` 除外。改用户背景必须先经用户确认（契约见两份 SKILL.md「用户背景档案」节）。

## 开发铁律

1. **skill 自包含**：`liepin-resume-screener/` 与 `boss-resume-screener/` 各自独立可用（用户可能只复制其中一个到 `~/.workbuddy/skills/`）。**禁止跨 skill 目录 require**；公共逻辑接受两边各存一份。
2. **两侧同步**：`report.js` / `config.js` / `show-scores.js` / `scoring.js` / `quota-global.js` / `joblist.js` / `working-window.js` / `check-cli-update.js` / `cleanup.js` 的结构性改动必须两边同步改（去重索引、报告列、开关等已刻意保持镜像）。**机器强制**：`node check-mirrors.js` 对上述文件做归一化 diff（剥注释与平台词），超 `check-mirrors.baseline.json` 基线即 exit 1；pack-release 打包前强制跑——漏同步会被拦下，确为合法差异用 `--update-baseline` 重录。**三处镜像家族**：全局配额（两侧 quota-global.js + run.js 内嵌 reader）、工作时间窗口（两侧 working-window.js + run.js 内联 ww 系列函数）——改一处必须同步另两处。打分内核在 `scripts/scoring.js`（参数化 `scoreResume(text, scoring, gradeBands)`），改模型优先改画像而不是默认值。
3. **不动操作节奏**：screener.js 的随机间隔、熔断、缓存机制是风控调参，两平台数值差异是有意的（BOSS 更保守），没有实测验证不要统一或调整。**配额是两层**：全局浏览硬顶 `data/_quota/<平台>.json`（每平台每日 1000 份成功浏览，quota-global.js 记账，画像不可覆盖）与每岗位请求配额 `data/<岗位>/<平台>/data/quota.json`（风控兜底）——职责正交，均分逻辑只在编排层（run.js），screener 只做逐份硬校验软停止（退出码 0，区别于熔断 exit 3）。**工作时间窗口**（默认 8:00–20:00 本地时间，`_user.json` settings.workingWindow / env `SCREENER_WORKING_WINDOW`，画像不可覆盖回钉）：run.js 启动硬拦截（`--anytime`/`SCREENER_ANYTIME=1` 越过）+ 平台/城市循环边界检查 + screener 搜索与简历双层软停止（break 非 throw）。
4. **CLI 必查必升（用户反复强调的铁律，2026-10-21 再次重申）**：每次使用必须检查 liepin-cli / boss-agent-cli 版本，**不是最新版就自动升级**——这是两侧 screener 启动自检的默认行为，不需要任何开关（旧文「只读、不阻塞」是对这条铁律的失真记录，曾导致默认只提示不升级，已纠正）。升级失败（registry/PyPI 不可达）只提示、不阻塞主流程；`LIEPIN_CLI_AUTOUPDATE=0` / `BOSS_CLI_AUTOUPDATE=0` 仅作应急关断，不是常规路径。`check-cli-update.js` 同时承担 BOSS 浏览器内核的镜像安装（run.js / setup.bat 复用 `--install-browsers`）。
5. **推荐去重**：`recommended-index.json` 在报告层（report.js），与请求层的 `processed.json` 职责正交，互不改写。开关三级：config 默认 → 画像 → 环境变量 `SCREENER_ALLOW_DUPLICATES`。
6. **数据纪律**：`data/` `reports/` `logs/` 含真实候选人 PII。测试用临时目录与假数据（参考 `_template.json` 结构），**测试完删除全部临时产物**；绝不把真实数据写进仓库文件。
7. **发布只信 pack-release.js**：白名单打包。新增根目录文件时同步更新 `INCLUDE_FILES`；转发给用户的话术永远是「用 pack-release.bat，别右键压缩」。
9. **契约放对层 + 机器强制**（v2.3.2 教训）：面向终端用户 AI 会话的行为约束，权威源放 AI-GUIDE.md，经 ai-guide-sync.js 同步到各平台自动加载的记忆文件（workbuddy=.workbuddy/memory/MEMORY.md，注册表 ai-guide-targets.json 可扩展）；关键前置条件必须配机器强制（如档案缺失退出码 4），不依赖"AI 应该会读某文件"的假设——假设必须实证。
8. **特性开发完**：同步更新 README.md（用户视角）和受影响 skill 的 SKILL.md（AI 视角），再跑一遍 `node --check` 所有改动的 js。版本号共 **五处**：两侧 SKILL.md frontmatter、两侧 SKILL.md 正文第 8 行的「本文件 version」（2026-10-27 交接实证的第 5 处，漏改会提示用户降级）、package.json、**pack-release.js 的 DEFAULT_VERSION（打包包名唯一来源，不读 package.json——2026-10-26 实证：漏改它打出了挂着 2.4.1 名字的 2.5.0 包）**；顺手在 pack-release.js DEFAULT_VERSION 上方版本历史注释补一行；grep 版本号时别用 `grep -v release` 一刀切（会连 pack-release.js 文件名一起排掉）。
10. **根目录 .bat 一律 CRLF 换行**（2026-10-20 实证教训）：pack-release.bat 曾是 LF 换行，双击启动时 cmd 解析多行结构直接崩（闪退、无 pause、无产物），转 CRLF 即愈。其余 .bat 目前也是 LF 但实测能跑（run.bat 等），**能用就不动**；哪个 .bat 再出现「点了没反应/闪退」，转 CRLF 即可。新建/编辑任何 .bat 后用 `head -c 12 <文件> | od -A d -t x1` 抽查首行应含 `0d 0a`。

## 常用命令

```bash
node --check <改动的js>                              # 语法检查
node run.js boss 销售经理 --dry-run                   # 干跑：验证命令与环境组装
SCREENER_WORKING_WINDOW="<未来10-20分钟>" node run.js liepin 销售经理 --dry-run
                                                     # 测窗口拦截（env 动态窗口，勿引入假时钟钩子）
node liepin-resume-screener/scripts/joblist.js --raw  # 真机适配第一步：核对在招岗位输出字段
JOB_PROFILE=profiles/example-销售经理.json \
SCREENER_DATA_DIR=<临时目录> node liepin-resume-screener/scripts/report.js <临时.xlsx>
                                                     # 用夹具测报告生成与去重
node pack-release.js --out <临时目录>                  # 打包验证（检查清单无 PII）
```

## 结构速查

- `run.js`：编排器（spawn 各 skill 脚本，不 require skill 模块；启动时 spawn 一侧 cleanup.js 做历史文件全局预清理，dry-run 语义下跳过）。
- `self-update.js`（v2.13.0）：工具本体自更新——查 GitHub Release（双层取版：API releases/latest → 常量名 `resume-screener-latest.zip` 资产 HEAD 的**重定向 Location tag**；版本只在 Location、Content-Disposition 只有资产名，评审实证纠偏过）→ curl(--fail)/Node https 下载 zip → 自研零依赖 zip 读取器 → `isProtectedEntry` 白名单第二道防线（拒运行数据目录/任何 .env/非白名单 profiles；含 Win32 尾点/尾空格/冒号归一化绕过加固）→ 覆盖应用（run.js 倒数第二、package.json 压轴当版本标记；`--from-bat` 时 run.bat 只写 `run.bat.new`，run.bat 每次启动无条件 move 自愈、非 bat 上下文 applyPendingBat 自愈；检测到 `.git` 判开发仓跳过防已发布包回滚工作区）。退出码 0/10/11，`SCREENER_SELF_UPDATE=0` 应急关断，失败单行提示不阻塞；**每次运行自动 `ai-guide-sync.js --all` 刷新契约层**（同步目标不随 zip 走；v2.13.3 定稿为每次运行而非升级后——旧版升上来的第一跳跑的是旧代码，只挂升级后永远赶不上）。`install.bat` = 新同事引导安装器（下载常量名资产解压；不进 zip，作 Release 资产分发）。维护者发版：**先 git push、再 `pack-release.bat --publish`**（打包→建 Release→传 版本zip/latest.zip/install.bat 三资产，token 读 `.env` 的 `github_token`；顺序反了 tag 打在旧代码上）。
- `<skill>/scripts/`：screener.js（BOSS 侧 v2.8.x 起推荐牛人为主源：**BOSS_SOURCE=reco 默认**（v2.8.1 用户拍板，仅推荐——开聊免费；both|search 显式指定才并入搜索）；**hr resume 接口已退役**（boss-agent-cli#472）→ 统一「卡片骨架 cardToStructured + 取文通道」；**v2.10.0 取文架构 v3**：默认 **shot-capture.js 截图采集**（阅读式慢滚 + Page.captureScreenshot 存 `data/扫描图/`，折叠按钮点开，开弹层前挂 Network 监听回收 geek/info/v2 的 jobCompetitive → bossInsight）+ **ocr-local.js/py 本机 RapidOCR 内联识别**（uv spawn，剥 UI/免责声明，三层去重组装：头块剥离/边界拼接/长行首现去重，校验过即回填 text——零 token 主通道；2026-10-30 真机 11 份实证滚轮振荡重拍普遍，三层组装后内容行重复≈0）+ **ocr-batch.js AI 转写兜底**（仅 OCR 未过的份；判据「images 非空+text 空」全链路统一；report 退出码 7=转写未完成拒出报告）；拖选通道 fetch-text.js 保留为显式回退 **BOSS_TEXT_MODE=drag**，不逆向 wasm（红线）、不自动跨通道兜底）、report.js（xlsx+去重索引+打招呼状态列+**牛人分析列**）、show-scores.js、check-cli-update.js；boss 侧另有 boss.js（CLI 封装）、greet.js（v2.7.0 授权制自动打招呼：退出码 5=未授权机器强制；等级口径 v2.10.0 起 llm-scores > last-results(rescore) > 池快照；推荐来源免费自动发，搜索来源 v2.7.1 起止血标「需手动」待搜索畅聊卡定案；**v2.12.0 回查预算适配**：回查抽出 greet-verify.js（CLI v3.1.0+ RequestBudget 预算层 30s 最小派发间隔——旧 3 轮×5s×60s 超时恒 UNVERIFIED 不记账；新节奏 40s 预热/45s 轮隔/150s 进程超时/预算错误按 retry_after 等）+ 发送前沟通列表预检 + UNVERIFIED 落账本 pending 防重发，见 BUG-2026-11-03）与 greet-ledger.js（全局账本 `data/_quota/boss-greet.json`：日顶 20 + geek 级去重 + pending 待核实语义）；两侧共享 scoring.js 结构。自动收藏已 v2.7.0 弃用（平台权限拦截证伪）。
- `tests/`（开发仓根，不进发布包）：mergeSegments 9 例 / shot-capture 纯函数 16 例 / ocr-batch 夹具 15 例 / report 转写门槛 12 例 / cleanup 历史清理 21 例 / self-update 31 例——`node tests/<名>.test.js` 逐个跑，改取文/契约相关代码后必须全绿。
- `<skill>/scripts/cleanup.js`（两侧镜像，v2.11.0）：历史文件统一清理——保留期 `settings.retentionDays`（默认 1 天，`0`=关断，env `SCREENER_RETENTION_DAYS`，画像不可覆盖）；按 mtime 清过期 logs/简历缓存/结果缓存（last-results/llm-scores/greet-pool）/截图；**报告、去重索引、配额账本永不清理**（契约见 AI-GUIDE「三·八」）。挂载点：run.js 启动全局预扫 + screener 启动清自己 ROOT + CLI（`--days N`/`--dry`）。v2.10.0 的 SCREENER_SHOT_RETENTION_DAYS 独立截图清理已并入（旧 env 退役）。
- `<skill>/references/`：给 AI 的深度文档（策略/打分模型/画像指南/CLI 笔记）。
- 登录态：猎聘 `%USERPROFILE%\.liepin-cli\user-data`（CDP 53471）；BOSS `~/.boss-agent/`（CDP 9333 Edge / 9222 Chrome）。登录窗口必须由用户双击 .bat 打开并保持开着。
- BOSS 报告链接口径（2026-10-21 终案）：geek 令牌直链与外层 `chat/search?query=` 均证伪/无效；**唯一直达 = 搜索 iframe 地址** `web/frame/search/?keywords=<姓名|姓+公司+职位|公司+职位>`（称呼带星剥姓走三词缩池——2026-10-21 用户实测大公司下目标排前；冷加载即已搜索、目标人通常第 1）；猎聘链接稳定属有意不对称（详见 boss SKILL.md「六、输出物」链接定案）。
