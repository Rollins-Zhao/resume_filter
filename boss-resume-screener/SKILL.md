---
name: boss-resume-screener
version: 2.13.2
description: This skill should be used when bulk-screening candidates or resumes on BOSS直聘 (BOSS Zhipin / zhipin) recruiter platform — searching candidates by keyword groups via `boss hr candidates`, viewing structured resumes via `boss hr resume`, scoring them with the same customizable multi-dimension model as the Liepin skill, and generating a downloadable Excel recommendation report with per-job recommendation dedup (recommended-index.json keeps the same candidate from entering the report twice, skipped ones listed in a second worksheet; the report's BOSS简历 column links to the recruiter's search-results frame URL, keywords = surname+cleaned-company+title). It also covers the unified run.bat entry (platform menu, CDP detection, browser-kernel auto-install), boss-agent-cli (Python/uv) installation, version self-check, login-state recovery, quota discipline and circuit-breaker handling. Read-only by default; since v2.7.0 an explicit opt-in greet phase auto-sends first greetings only to S/A-grade candidates viewed this run, after the user enables settings.greet via two onboarding questions (first BOSS run or --setup-greet; geek-level global dedup, 20/day local cap); it never auto-sends replies, messages, resume requests or contact-exchange requests. Triggers include BOSS筛选, BOSS直聘筛选, 用BOSS筛简历, boss-agent-cli, BOSS候选人推荐报告, BOSS推荐去重, 重复推荐, 已推荐过, 销售经理招聘, BOSS链接打不开.
agent_created: true
---

> 本文件 `version: 2.13.2`（对应发布包版本）。项目根会经 run.bat / `self-update.js` 自动升级（v2.13.0 起，查 GitHub Release）；本 skill 若被单独复制到 `~/.workbuddy/skills/` 等位置、版本低于项目根包内版本时，提醒用户从项目根复制刷新。

# BOSS直聘简历自动筛选（只读筛选 + 授权触达）

> **本 skill 是「BOSS直聘」专用通道**，与 `liepin-resume-screener`（猎聘）并列。
> 两者**共用同一套打分模型与岗位画像**（`profiles/*.json`），但**调用不同的 CLI、走不同的平台**。
> ⚠️ **使用前必须先看清：本次要用哪个平台。** 见下方「第〇节」。

## 〇、平台选择（最重要 · 每次必读）

用户发指令时**必须显式说明平台**，否则不要动手：

| 用户说法 | 用哪个 skill | CLI |
|---|---|---|
| 「用**猎聘**筛」「猎聘…」 | `liepin-resume-screener` | `liepin`（Node/npm） |
| 「用 **BOSS** 筛」「BOSS直聘…」 | **`boss-resume-screener`（本 skill）** | `boss`（Python/uv） |
| 「**两个平台都跑**」 | 两个 skill **依次各跑一遍**，分别出报告 | 两个 CLI |

**为什么必须显式声明**：两个平台的 CLI 完全不同（语言、安装方式、命令、字段、退出码、风控节奏），
混用会直接报错或静默跑错。且两边的报告、数据目录、配额记账相互独立，混跑会污染统计。

**两个平台都跑时的正确姿势**：推荐直接双击项目根 `run.bat` 选「两个都跑」——数据目录自动按
`data/<岗位>/<平台>/` 隔离，报告统一收进项目根 `reports/`。AI 会话内手动跑则：先猎聘、再 BOSS
（各自传独立的 `SCREENER_DATA_DIR`），最后在对话里把两份报告并列交付，**报告文件名已带平台前缀**，不要合并成一份。

**本 skill 与猎聘 skill 的差异速查**：

| 维度 | 猎聘（liepin-resume-screener） | BOSS（本 skill） |
|---|---|---|
| CLI | `@viyzhu/liepin-cli`（npm） | **`boss-agent-cli`（PyPI / uv）** |
| 版本源 | npm registry | **PyPI (`pypi.org/pypi/boss-agent-cli/json`)** |
| 安装 | `npm install` | **`uv tool install boss-agent-cli` + 内核走镜像装** |
| 搜人 | `liepin search` | **`boss hr candidates <关键词>`** |
| 看简历 | `liepin resume <id>` | **`boss hr resume <geek_id> --job-id --security-id`** |
| 输出 | 文本/JSON 混杂 | **统一 JSON 信封** `{ok,data,pagination,error,hints}` |
| 退出码 | `0/1/2/3`（3=风控） | **只有 `0/1`**；语义在 `error.code` |
| 内置节流 | **无**（责任全在编排层） | **有**（高斯延迟 + 突发惩罚；搜索另有跨进程预算） |
| 数据源 | 关键词搜人 | **三段式**：搜人 → 拿三 ID → 逐个看简历 |

## 一、首要红线（绝对不可违反）

1. **默认不打招呼；唯一授权例外是「首条招呼」（v2.7.0 用户拍板）**：`profiles/_user.json` 的
   `settings.greet.enabled=true`（首跑 BOSS 两问授权或 `run.bat --setup-greet` 设置）时，greet.js
   可对**本轮真实浏览且最终 S/A 级**的候选人自动发送**首条招呼**（话术=报告「建议打招呼话术」列
   或用户录入的固定话术；每日本地硬顶 20 条、全局 geek 级去重，详见「四·六」）。**除此之外的一切
   主动触达仍禁止**：`boss hr reply`、`boss hr request-resume`、`boss hr accept-resume`、
   `boss hr resume --exchange`、`boss batch-greet`、`boss apply` 全部禁用——回复、求简历、
   换联系方式一律由用户在 BOSS 官网/App 手动完成。**同时禁止开启 CLI v3.1.0 的内置自动化**
   （`boss agent` 及 `operating_mode:"autonomous"`/`automation` 配置）：其 allowed_actions 含
   自动发问卷/跟进/**交换联系方式**/创建面试线索（auto_execute_threshold 0.82 即自动执行），
   踩本工具「绝不自动交换联系方式」红线——本框架任何代码不得调用，也不建议用户手动开启
   （2026-10-30 用户拍板钉入红线）。
2. **允许的"写"仅两种**：① `boss hr download-resume`：仅下载候选人**已经发来**的附件简历到本地归档，
   且**不自动同意**任何请求；② `boss hr greet`：**仅 greet.js** 在 settings.greet 授权下调它
   （`--yes` 的语义="操作者已批准该候选人与话术" = 首跑两问授权 + 话术已配置）。**自动收藏已于
   v2.7.0 弃用**（弹层收藏按钮对未沟通候选人被平台权限拦截——事件到达、零网络请求、状态不变，
   2026-10-28 实测证伪；旧 favorites.json 留档不读不写）。除此之外不新增任何写操作。
3. **绝不交换联系方式、绝不群发**。
4. **遇风控立即全停**：错误码为 `ACCOUNT_RISK` / `ENVIRONMENT_RISK` / `LOGIN_RISK_CONTROL` /
   `PLATFORM_VERIFICATION_REQUIRED` → **立即终止全部自动化**，通知用户人工处理，**不得重试**、不得换通道重试。
5. **登录受阻立即停手**：需人工扫码/验证时停下交给用户，**不要反复重登**（反复重登是账号被判异常的主因）。
6. **只读命令白名单**：`boss status`、`boss hr candidates`、`boss hr resume`（不带 `--exchange`）、
   `boss hr applications`、`boss hr recommendations`、`boss hr chat`、`boss hr chatmsg`、`boss hr jobs list`
   （参数/输出未实测——已发布岗位直连用，见「二·七」）、`boss schema`、`boss doctor`。
7. **BOSS 内置节流存在但不足以免责**：CLI 自带 `RequestThrottle`（高斯延迟 + 突发惩罚），
   搜索还有 SQLite 跨进程 5–10s 预算。**本 skill 仍在其之上叠加额外随机间隔**（双层兜底），
   合规责任仍在编排层，**不要因为"CLI 有节流"就调快间隔**。
8. **不逆向平台内容保护（v2.10.0 钉入）**：简历正文密文（wasm 解密）**不逆向、不提取内存明文、
   不读 canvas 像素**——取文只走「截图 + AI 会话转写」（真人等价动作）与平台给真人留的复制手势。
   截图含更多 PII（含照片）：仅落本机 `data/扫描图/`、报告不嵌图、测试产物测完即删、不外发。

## 二、适用场景

- 为某个岗位批量筛选 BOSS 直聘候选人（如「销售经理」，填好的示例画像见 `profiles/example-销售经理.json`）
- 需要按**与猎聘一致**的自定义多维度给候选人打分排序（维度名/关键词/权重全部来自画像 JSON）
- 需要输出可下载的 Excel 推荐报告（同一岗位同一候选人只推荐一次，重复的自动跳过并单列明细）
- 需要给出可直接复制的个性化打招呼话术（默认手动粘贴；开启自动打招呼后由工具自动发送，见「四·六」）

## 二·五、标准调用话术（用户可直接复制）

> 我需要招一个【岗位名称】，要求是【……】，请你用 **BOSS直聘 SKILL** 帮我筛选简历。

**只报岗位名也行**（已发布岗位直连，见「二·七」）：

> 我在 BOSS 上招**销售经理**，帮我筛简历。

展开示例：

> 我需要招一个**销售经理**，要求是：北京（可多城市）、5 年以上 B2B 销售经验、有大客户开拓与业绩达成、熟悉 CRM 客户管理。请你用 **BOSS直聘 SKILL** 帮我筛选简历。

**两平台都要**：

> 用**猎聘和 BOSS 两个平台**都跑一遍**销售经理**，要求同上，最后给我两份报告。

AI 收到后的动作：

0. **【硬性第一步，不允许跳过】生成画像前必须确认 `profiles/_user.json` 存在**（查找路径见「用户背景档案」节）；不存在 → 先问用户公司名/行业/业务方向/常用城市四项，**确认后写入档案**，再继续第 1 步。四项确认后可再问**一个可选补充问**（并入 `businessSummary`，见该节第 8 条）；平台自身记忆里已有用户背景时只能当**预填建议**、逐项确认后写入（第 9 条）。screener 启动时若打出"[提示] 尚未建立用户背景档案"，也按本步骤补建。
   **环境自检顺带（v2.10.0）**：同一开工环节先跑 `node doctor.js --json`（首次任务必做；能自动装的当场装——exceljs/uv/boss-agent-cli/浏览器内核/liepin-cli，详见 AI-GUIDE「五」）——`criticalReady=false` 或 `bossReady` 未 ✅ 时先按输出处理，不开跑（覆盖更新过文件夹会丢 node_modules，2026-10-30 实证）。同一环节项目根存在 `self-update.js` 时先跑 `node self-update.js`（工具本体自更新，v2.13.0 起；失败单行提示不阻塞）。
   **BOSS 任务顺带（v2.7.0，2026-10-29 补）**：同一开工环节检查 `settings.greet` 是否落档，没落档就按 AI-GUIDE「三·五」问一次「是否开启自动打招呼 + 话术来源」（拒绝也落档、不再追问）——AI 直接调脚本的路径不会触发 run.bat 的首问，不在这里问用户就永远没机会被问到。已开启时手动序列 = screener → **greet.js** → report.js。
   **评估档位顺带（v2.9.0，2026-10-30 补；v2.10.0 措辞更新）**：同一开工环节检查 `settings.scoringPreference` 是否落档，没落档就问一次「简历评估方式：1 快速（默认——免费、速度快，关键词规则打分，颗粒度较粗） 2 精细（AI 逐份读简历工作内容打分，更准并附匹配依据，消耗模型积分/token）」。**两档正文都由截图+本机 RapidOCR 自动识别（零 token）**；档位差异仅在评估深度——快速档筛完直接出报告，精细档多一步 AI 逐份精评（消耗模型积分）。选择写入档案（跳过/拒绝 → 写 "fast"，不再追问；措辞与 AI-GUIDE「二」一致）。**顺序强制**：screener（截图+OCR 内联）→（有个别 OCR 未过的份：ocr-batch 转写兜底 → rescore，见四·五节）→（精细档）**llm-batch 精细评估（五·一节）** → greet.js（已开启时）→ report.js——未完成转写 report 退出码 7、未完成评估退出码 6 拒出报告（`SCREENER_FORCE_FAST=1` 仅可单次降级精评，**转写无降级**）。
   **BOSS 来源必问（v2.9.1，2026-10-30 补）**：同一开工环节检查 `settings.bossSource` 是否落档，没落档就**必须问**（与 greet/评估档位同轮，不允许像 v2.9.0 实测那样「打印三选项后自行走默认」），**选项文案逐字**（成本嵌在选项里，禁止挪题干或概括）：① 仅推荐牛人（打招呼免费）② 推荐+搜索（搜索来源打招呼需消耗『搜索畅聊卡』，按人头扣 1–5 次、约 ¥10+/人）③ 仅搜索（打招呼需消耗『搜索畅聊卡』）。选择写入档案（跳过/拒绝 → 写 "reco"，不再追问）；env `BOSS_SOURCE` 显式指定时以 env 为准。
1. **用户只给岗位名** → 先跑 `node <skill>/scripts/joblist.js --json` 查已发布岗位（匹配：精确 → 唯一子串）：命中 → 用岗位字段（名称/城市/薪资）+ `_user.json` 背景 +画像指南起草画像，**列出要点等用户确认**再跑；未命中/多个 → 列出在招岗位让用户挑；列表拿不到（退出码 5，`hr jobs list` 输出未实测）或为空 → 降级为描述流程，不阻塞
2. 按 `references/job-profile-guide.md`（可复用猎聘 skill 的同名文档）生成/复用 `<项目根>/profiles/<岗位名>.json`
3. 告知运行方式（用户双击项目根 `run.bat` 优先；AI 会话内手动跑则**显式写明平台**，命令见第三节）
4. 执行筛选 → （已开启自动打招呼则对 S/A 自动发首条招呼，见「四·六」）→ 出 Excel 报告（含去重跳过明细与「打招呼」状态列）→ 未开启的提醒用户去 BOSS 官网/App 手动打招呼；报告「BOSS简历」列为**搜索直达链接**（点开即到沟通页搜索、目标人排最前，见「六、输出物」的链接定案）

## 二·六、统一入口 run.bat（用户双击优先；AI 会话内手动命令见第三节）

项目根的 `run.bat`（本体 `run.js`）是猎聘 + BOSS 的**统一双击入口**，应优先引导用户用它：

- **菜单选平台**（猎聘 / BOSS直聘 / 两个都跑）+ **菜单选岗位画像**（`profiles/` 下模糊匹配，
  也支持命令行直给：`run.bat boss 销售经理`）。
- **BOSS 自检全自动**：探测登录浏览器 CDP 端口（Edge 9333 → Chrome 9222，探测到就自动设
  `BOSS_CDP_URL`）→ 浏览器内核缺失时自动调本 skill 的 `check-cli-update.js --install-browsers`
  走镜像安装 → screener 内部还会再做 `boss status` 登录预检。**不需要人工装内核。**
- **逐城市跑**：画像里的 `cities` 数组逐城循环（城市间休整 300s）；`--city=上海` 可临时只跑单城。
- **收尾自动 rescore + report**：报告统一落项目根 `reports/`（内部经 `SCREENER_REPORTS_DIR`），
  结束时列出本次新生成的报告文件。
- 常用旗标：`--city=<城市>`、`--limit N`（单轮简历上限）、`--kw 1,3`（只跑指定关键词组）、
  `--dup`（允许重复推荐，等价 `SCREENER_ALLOW_DUPLICATES=1`）、`--report-only`（不搜索，基于缓存重算出报告）、
  `--from-published [岗位名]`（已发布岗位直连，见「二·七」）、`--anytime`（越过工作时间窗口，见「六·七」）、
  `--dry-run`（只打印将执行的命令与环境变量）。岗位菜单里选 `0` 可从已发布岗位新建画像。
- 数据目录约定 `data/<岗位>/<平台>/`，推荐去重索引也在其中（见「六·五」）。
- **岗位是"点播"不是"订阅"**：每次运行只处理用户指定的那一个岗位，历史岗位不会自动重跑；用户要求"所有岗位都跑"时才逐个执行。重跑老岗位 = 增量模式（processed.json 已看过的人不再请求，recommended-index 已推荐的人不再进报告）；新岗位首次运行 = 全量。各岗位数据目录/去重/报告完全隔离，仅全局浏览额度共享（按画像总数均分，当天不跑的岗位也占分母，见「六·六」）。

> `setup.bat` 已能一次装齐两个平台：猎聘 npm 依赖 + **询问式安装 BOSS 组件**（Python ≥ 3.10 检查 →
> pip 装 uv（清华镜像）→ `uv tool install boss-agent-cli` → 内核预下载）。新机器顺序就是：
> `setup.bat` → 双击登录器扫码（窗口保持开着）→ `run.bat`。

## 二·七、已发布岗位直连（joblist）

用户只报岗位名即可开跑：工具读取 BOSS 上已发布的在招岗位做匹配，画像起草零手填。

- **脚本**：`node <skill>/scripts/joblist.js [--json] [--raw]`。退出码：`0` 成功（含 0 条）｜`2` 登录失效｜`3` 风控/配额｜`5` 输出格式未识别（跑 `--raw` 看原始输出，把结果交给维护者适配字段映射）。
- **归一化条目**：`{name, city, salary, status, jobId, source, raw}`；cityCode 自动反查城市中文名。⚠️ `boss hr jobs list` 的参数与输出**未经真机实测**（schema 证实 hr.jobs 存在、命令形态已验证可达鉴权层）——真机适配入口是 `--raw`，适配前该功能可能一直走退出码 5 降级，属预期。
- **匹配规则**（与 run.js matchProfile 同款）：精确名称 → 唯一子串；未命中/多个 → 列出在招岗位让用户挑；确实没有 → 走"描述岗位要求"新建，不阻塞。
- **画像草稿约定**：jobTitle=岗位名、city=列表城市（缺省回落 `_user.json` commonCities → 北京）、`greetTemplate` 用 `{company}` 占位符、**不写 scoring**（内置默认）——草稿 `_说明` 注明"建议让 AI 按岗位要求定制打分"。
- **数据敏感**：在招岗位清单属于招聘策略，向外部粘贴时只贴字段适配所需的最小片段。
- joblist 调用消耗 1 次岗位请求配额、受工作时间窗口约束（`--anytime`/`SCREENER_ANYTIME=1` 可越过）；仅取第一页。

## 三、快速开始

### 步骤 0：环境要求

- Node.js ≥ 20（跑本 skill 的编排脚本）
- **Python ≥ 3.10**（boss-agent-cli 是 Python 工具）
- `uv`（推荐）或 `pipx`；本机 Chrome/Edge（登录窗口用）
- ⚠️ BOSS 对**境外 IP 与异常环境**敏感：如无必要不要挂代理；脚本默认剥离代理环境变量
  （`BOSS_KEEP_PROXY=1` 可保留，但需确认代理可用）
- 依赖 `exceljs`（生成 Excel 报告；项目根已有则无需重复安装）

### 步骤 1：安装 boss-agent-cli

**禁止 `npm install`**（这是 Python 包）。**优先用项目根 `setup.bat`**：它已包含下面 1)2)3)
全部步骤（会询问是否安装 BOSS 组件），不写死任何机器的 Python 路径。AI 会话内手动安装：

```bash
# 1) 装 uv（若尚未安装；注意镜像源可能没有 uv 的 wheel，用官方源）
python -m pip install uv

# 2) 装 CLI（用国内镜像加速）
python -m uv tool install boss-agent-cli \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple

# 3) 装浏览器内核（登录通道依赖 patchright）
#    ⚠️ 不要用官方 `patchright install chromium` —— 国内网络会反复断连（见下方「内核镜像」）
node "<本skill目录>/scripts/check-cli-update.js" --install-browsers
```

装完可执行文件通常落在 **`%USERPROFILE%\.local\bin\boss.exe`**（即 `~/.local/bin`，`uv tool` 默认落点）。
若该目录不在 PATH，本 skill 的脚本会**自动探测**（`BOSS_BIN` 环境变量 → `~/.local/bin`
→ `~/.local/share/uv/tools/boss-agent-cli/Scripts` → 系统 PATH），一般无需手动配置。

> **Python 版本要求 ≥ 3.10**（`setup.bat` 安装 BOSS 组件前会先检查）。

> **`pipx` 替代方案**（没有 uv 时）：
> ```bash
> python -m pip install pipx && python -m pipx install boss-agent-cli
> ```
> 落点同样是 `~/.local/bin`，脚本一样能探测到。

#### 内核镜像（⚠️ 实测踩坑，2026-10-15）

**现象**：官方 `patchright install chromium` 从 `cdn.playwright.dev`（→ `storage.googleapis.com`）
拉 ~196MB，国内网络下**反复 `server closed connection`** —— 进度到 80~90% 断，重试从 0% 开始，
30+ 分钟永远不成功。

**根因**：CDN 链路不稳，且官方下载器**不支持断点续传**（失败即从头来）。

**解法**：改用 **npmmirror 镜像**（同版本、支持 `Accept-Ranges` 断点续传，实测 11 秒下完）。
本 skill 的 `check-cli-update.js --install-browsers` 已内置此逻辑。

**必须装两个内核**（`headless=True` 用的是独立包，不是 chromium 本体）：

| 内核 | 目录名 | 可执行文件 |
|---|---|---|
| chromium（有头/通用） | `chromium-1243` | `chrome-win64/chrome.exe` |
| headless shell（无头） | `chromium_headless_shell-1243` | `chrome-headless-shell-win64/chrome-headless-shell.exe` |

目录名规则（来自 playwright core `registry/index.js`）：
`path.join(registryDirectory, name.replace(/-/g,"_") + "-" + revision)`
→ `chromium` → `chromium-1243`；`chromium-headless-shell` → `chromium_headless_shell-1243`。
落地后**必须写 `INSTALLATION_COMPLETE` 标记文件**，否则 playwright 仍判定"未下载"。

```bash
# 检查内核是否就绪
node "<本skill目录>/scripts/check-cli-update.js"

# 缺失则走镜像自动安装（curl 断点续传 + tar 解压 + 写标记）
node "<本skill目录>/scripts/check-cli-update.js" --install-browsers
```

手动兜底（脚本不可用时）：
```bash
V="153.0.8010.12"   # Chrome for Testing 版本，由 patchright 的 browsers.json 决定
B="$LOCALAPPDATA/ms-playwright"   # 即 %LOCALAPPDATA%\ms-playwright
curl -L --retry 20 -C - -o /tmp/c.zip \
  "https://cdn.npmmirror.com/binaries/chrome-for-testing/$V/win64/chrome-win64.zip"
mkdir -p "$B/chromium-1243" && tar -xf /tmp/c.zip -C "$B/chromium-1243"
echo "$V" > "$B/chromium-1243/INSTALLATION_COMPLETE"
```

> `boss doctor` 的 `patchright_chromium` 项会直接报「已安装 ... chromium-1243 与
> chromium_headless_shell-1243」，是验证内核是否就绪最省事的办法。

> **沙箱限制**：Agent 会话内 `chrome-headless-shell.exe` 直接运行会因**无 GPU** 导致
> GPU 进程反复崩溃（`GPU process isn't usable. Goodbye.`）——这是沙箱硬件限制，
> **不影响你本机使用**。用户本机双击 bat 运行正常。

### 步骤 2：版本自检（⚠️ 用户硬性要求：每次使用前必查）

> **明确要求**：和猎聘一样，**每次使用之前需要检查 CLI 版本有没有更新，有更新就要更新。**

```bash
# 检查 + 自动升级（默认，无人值守）
node "<skill目录>/scripts/check-cli-update.js"

# 只检查不升级（手动排查）
node "<skill目录>/scripts/check-cli-update.js" --check-only
```

- 版本源是 **PyPI**（`https://pypi.org/pypi/boss-agent-cli/json`），不是 npm registry —— 这是与猎聘最大的实现差异。
- `screener.js` **每次启动自动检查，不是最新版就直接升级**（用户铁律；升级失败只提示、不阻塞）。
  仅应急时设 `BOSS_CLI_AUTOUPDATE=0`（或 `SCREENER_CLI_AUTOUPDATE=0`）关断。
- 退出码：`0` 已最新/已升级/检查失败（不阻塞）｜`10` 有新版本待更新（仅 `--check-only` 或关断时）｜`11` 已升级。
- 已实测：**v3.0.0** 即 PyPI 最新版。

### 步骤 3：登录

> 推荐双击项目根的登录启动器打开登录窗口：`boss-edge-login.bat`（Edge，CDP 9333）或
> `boss-zhipin-login.bat`（Chrome，CDP 9222）——在该窗口扫码登录 zhipin.com 后**窗口保持开着**
> （关窗=掉登录）。`run.bat` 靠这两个端口探测登录窗口；本 skill 调 CLI 时会自动带上 `--cdp-url`
> （`BOSS_CDP_URL`，默认 9333，run.bat 探测到哪个就用哪个）。AI 会话内手动登录：

```bash
export PATH="$HOME/.local/bin:$PATH"   # uv tool 默认落点（%USERPROFILE%\.local\bin）
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
boss login      # 按提示扫码；登录招聘者端（部分登录态时改用 `boss login --cdp`，见下方）
boss status     # 验证登录态（退出码 0 且 ok=true 才算正常）
```

**boss-agent-cli 的登录态检查比猎聘细致得多**：`boss status` 会返回一个 `checks` 数组，
逐项给出 `credential_file` / `cookie_presence` / `wt2_presence` / `stoken_presence` /
`recruiter_read_health` 等状态。**排查登录问题先看这个数组**，比反复重登高效得多。

> ⚠️ **关窗即失效**（与猎聘同款坑）：BOSS 登录态同样依赖会话。若 `boss status` 报
> `stoken_presence` 为 error（`__zp_stoken__` 缺失），属**部分登录态**，通常需要：
> 以 Chrome CDP 远程调试端口启动浏览器后运行 `boss login --cdp`（上游文档明确推荐此路径）。
> **不要用 `boss logout && boss login` 反复冲刷**——这正是招致风控的典型模式。
>
> **退出码陷阱**：`boss` 的退出码**只有 0 和 1**。未登录（`AUTH_REQUIRED`）的退出码也是 **1**，
> 与"一般错误""风控"完全无法区分 → **必须读 `error.code`**，绝不能靠退出码判断风控。
> 本 skill 的脚本已按错误码分类处理，勿改成看退出码。

### 步骤 4：配置岗位（画像与猎聘共用）

**架构约定**：skill 包内**不存放任何岗位数据**——画像统一放在 skill 外部的 `profiles/` 目录，
**与猎聘 skill 共用同一批画像文件**（同一岗位两平台复用，改一次两边都生效）。

```
<你的项目文件夹>/
├── liepin-resume-screener/     # 猎聘通道
├── boss-resume-screener/       # BOSS 通道（本 skill）
├── run.bat / run.js            # 统一入口（选平台 + 岗位）
├── setup.bat                   # 一次性安装（含 BOSS 组件）
└── profiles/                   # 岗位画像（两平台共用；真实画像不入库）
    ├── _template.json
    ├── _user.json              # 用户背景档案（run.bat 首次引导生成；本地数据不入库不打包）
    └── example-销售经理.json    # 填好的通用示例（可复制改名）
```

BOSS 专属可选字段（写进画像 JSON 即可覆盖默认值）：

| 字段 | 作用 | 示例 |
|---|---|---|
| `bossCity` | **中文城市名**（推荐；脚本自动翻译成编码） | `"北京"` |
| `bossCityCode` | 数字城市编码（想手动指定时才用） | `"101010100"`（北京） |
| `cities` | **多城市数组**（统一入口 run.bat 逐城循环跑；不填则只用 `city` 单城） | `["北京", "上海"]` |
| `allowDuplicateRecommendations` | 推荐去重开关（默认 `false`，详见「六·五」） | `false` |
| `bossFilters.experience` | 经验要求 | `"-1,-1"`（不限） |
| `bossFilters.degree` | 学历要求 | `"201,201"`（本科） |
| `bossFilters.activeness` | 活跃度 | `"2"` |
| `bossFilters.salary` | 薪资范围 | `"-1,3"` |

#### 用户背景档案（profiles/_user.json）——生成画像前必读

用户的公司/行业背景记在 `profiles/_user.json`（**与猎聘共用同一份档案**；字段：`companyName` / `industry` / `businessSummary` / `commonCities[]` / `history[]`；由 run.bat 首次引导自动生成，或 AI 会话生成）。涉及画像生成或"我们是谁"类信息时：

1. **先读档案**（查找路径与 JOB_PROFILE 一致：当前目录 `profiles/` → skill 上两级 `profiles/` → skill 上级 `profiles/`）。不存在 → 向用户问一次公司名/行业/业务方向/常用城市，**确认后**写入 `profiles/_user.json`（`updatedAt` 记当前时间）。
2. **生成画像时**：`project` 缺省取 `companyName`；`greetTemplate` 写 `我们是{company}` 占位符（脚本在生成报告时替换为最终 project）；`scoring.industry` 维度种子词参考 `industry` / `businessSummary`；`city` / `cities` 缺省建议 `commonCities`（BOSS 侧城市再按城市编码表自动翻译）。
3. **变更检测**：用户话语中的公司/行业与档案不一致（如换了公司、业务转向）→ **列出差异向用户确认，确认后才更新**档案，旧值追加进 `history[]`（含 `changedAt`）。绝不未经确认直接改写。**区分长期变更与单岗位调整**：用户明确说"我们/公司换行业了"这类长期表达 → 走本条更新档案；用户只说"**这个岗位**不限行业/跨行业招/重点看 XX 行业" → **只调整该岗位画像的 scoring.industry，不动档案**（画像本就优先于档案），也不要为此发起档案确认。
4. **优先级**：岗位画像字段 > 用户档案 > 内置默认。多公司/多项目场景在画像里显式写 `project` / `greetTemplate` 覆盖档案。
5. 档案缺失或 JSON 损坏时脚本静默回落内置默认——AI 不要因档案问题阻塞招聘任务，按第 1 条补建即可。
6. **settings 块（全局设置，如 `settings.workingWindow` 工作时间窗口）**：修改同样走"列出差异 → 用户确认 → 更新"契约，且有三条防护——①用户没主动提时间/窗口话题时**不得**主动改；②要改得比默认 08:00–20:00 更宽（起更早/收更晚/全天）时，必须复述"窗口越宽，自动化特征越明显，被平台风控注意到的风险越高"并**二次确认**；③任何修改都要在回复中回显新旧值供用户核对。格式非法（非 `HH:MM-HH:MM` 两个时刻）应拒绝写入并说明正确格式。
7. **换 AI 平台使用**：本项目的 AI 入口契约在 `AI-GUIDE.md`（权威源），各平台记忆文件由 `node ai-guide-sync.js <平台>` 同步（预设 workbuddy/doubao/claude/codex/cursor，注册表 `ai-guide-targets.json` 可扩展）。用户说"我要换 X 平台用"→ 查注册表；没有 X → 问一句"X 平台的 AI 自动读项目里哪个文件？"→ `node ai-guide-sync.js --add X=<路径>` 注册并同步。
8. **可选补充问（不新增字段）**：四项问完确认后，可再问一句可选补充——「还有什么想补充的背景吗？如主要产品、目标客户、招聘偏好（没有则跳过）」。补充内容以「；补充：<内容>」并入 `businessSummary` 末尾（原方向为空时写「补充：<内容>」）；跳过则不再追问。run.bat 引导（`--setup-user`）同口径。
9. **平台记忆只是预填建议**：AI 平台自身记忆（全局记忆/其他会话摘要）里的用户背景**只能当预填建议**——逐项向用户复述、确认后才可写入档案；用户说「沿用之前的」也必须逐项过一遍。示例话术：「我在其他会话里记得你的公司是讯流国际（跨境物流）。档案『公司/项目名』填『讯流国际』、『所属行业』填『跨境物流』，对吗？业务方向和常用招聘城市也请逐项确认一下。」（契约原文见 `AI-GUIDE.md` 第二节）
10. **历史文件保留期（`settings.retentionDays`，v2.11.0）**：用户说「历史文件保留改成 N 天 / 把自动清理关掉」→ **复述新值确认后**改 `settings.retentionDays`（非负整数天，`0`=关断，默认 1）。清理范围与永不清理清单见 AI-GUIDE「三·八」（报告、去重索引、配额账本永不清理）；改完下次启动生效。格式非法（非非负整数）应拒绝写入并说明正确格式。

#### ⚠️ 城市参数：两个命令取值不同（实测踩坑，2026-10-15）

**这是最容易搞错的一处** —— 同一个 CLI 里两条命令的 `--city` 要的东西不一样：

| 命令 | `--city` 取值 | 依据 |
|---|---|---|
| `boss search`（求职者端） | **中文城市名**，如 `北京` | 帮助原文：「城市名称（如 北京、上海）」，走 `CITY_CODES` 白名单校验 |
| **`boss hr candidates`（招聘者端，本 skill 用）** | **数字 cityCode**，如 `101020100` | 帮助原文：「城市筛选（cityCode，如 101020100；-2=全国）」 |

**配置时只写中文名即可** —— `config.js` 内置 `BOSS_CITY_CODE_MAP`（照抄 CLI 的
`endpoints.CITY_CODES`）会自动翻译：

```js
bossCity:     "北京",          // 人写这个
bossCityCode: "101010100",     // 脚本自动算出来（也可手写覆盖）
```

翻译表覆盖 40 个主要城市：北京 上海 广州 深圳 杭州 成都 武汉 南京 天津 西安
重庆 苏州 长沙 郑州 青岛 宁波 东莞 佛山 厦门 福州 合肥 济南 大连 沈阳 哈尔滨
长春 石家庄 太原 南昌 昆明 贵阳 南宁 海口 兰州 乌鲁木齐 无锡 常州 温州 珠海 惠州。
**不在表内 → 回落到 `-2`（全国）**，避免传错编码导致搜索空结果。

> 想换城市：`SCREENER_CITY="上海"` 或 `SCREENER_CITY_CODE="101020100"`。
> 常用编码：深圳 `101280600`、上海 `101020100`、北京 `101010100`、
> 广州 `101280100`、杭州 `101210100`、全国 `-2`。

**方式一 · 自然语言（推荐）**：把岗位要求告诉 AI，由 AI 生成 `profiles/<岗位名>.json`：

```bash
JOB_PROFILE="profiles/销售经理.json" node "<skill目录>/scripts/screener.js"   # 现成示例：profiles/example-销售经理.json
```

**方式二 · 填模板**：复制 `profiles/_template.json` 改名填写。
**方式三 · 改默认值**：直接编辑 `scripts/config.js`（仅单岗位长期使用时）。

### 步骤 5：运行

```bash
cd <你的工作目录>                        # 数据与报告会生成在这里（统一入口约定：data/<岗位>/<平台>/）
export JOB_PROFILE="profiles/<岗位名>.json"   # screener 之后的每个脚本都要传！见下方警告
export SCREENER_DATA_DIR="./data/<岗位>/boss" # 与统一入口约定一致；与猎聘数据目录天然隔离
export SCREENER_REPORTS_DIR="./reports"       # v2.9.2：手动跑 report.js 必带（run.js 会自动设）——不设报告会落数据目录深处，用户难找
node "<skill目录>/scripts/screener.js"   # 全量：搜索 + 简历截图采集（v2.10.0 起正文=截图，text 待转写回填）
node "<skill目录>/scripts/ocr-batch.js" next  # AI 转写兜底链（默认无需手动跑——screener 已内联本机 RapidOCR；仅 OCR 未过的个别份）：next 吐图片清单 → AI 读图转写 → save <转写.json> 回填，详见「四·五」
node "<skill目录>/scripts/screener.js" rescore  # 转写后重算评分（零网络；未转写者评分恒 0/C 不作数）
node "<skill目录>/scripts/greet.js"      # 自动打招呼（授权制，BOSS 专属）：settings.greet.enabled=true 才真发；--dry 演练零发送 / --only <id> 单人（见「四·六」）。必须排在 report 之前（报告的「打招呼」列读它的运行产物）
node "<skill目录>/scripts/report.js"     # 生成 Excel 推荐报告（含去重跳过明细 + 打招呼状态列 + 牛人分析列；未完成转写以退出码 7 拒出）
node "<skill目录>/scripts/show-scores.js" # 终端打印评分明细
node "<skill目录>/scripts/check-cli-update.js"              # 检查；有新版本则自动升级（默认）
node "<skill目录>/scripts/check-cli-update.js" --check-only # 只检查不升级（手动排查）
node "<skill目录>/scripts/cleanup.js"           # 历史文件统一清理（v2.11.0）：按 settings.retentionDays（默认 1 天，0=关断）清过期日志/简历缓存/结果缓存/截图；--days N 单次指定保留期 / --dry 只计数不实删。报告、去重索引、配额账本永不清理
```

> ⚠️ **`JOB_PROFILE` 必须对 report.js / show-scores.js 也生效**（用 `export` 或每个命令前都带上）。
> 只给 screener.js 传的话，报告标题/文件名/话术会回退成默认岗位。

常用环境变量：

| 变量 | 作用 | 示例 |
|---|---|---|
| `KW_GROUPS` | 只跑指定关键词组（序号，逗号分隔） | `KW_GROUPS="2"` |
| `RESUME_LIMIT` | 覆盖单次简历详情上限 | `RESUME_LIMIT=15` |
| `JOB_PROFILE` | 指定岗位画像 JSON | `JOB_PROFILE="profiles/销售经理.json"` |
| `SCREENER_DATA_DIR` | 指定数据目录（默认 = 当前工作目录） | 统一入口约定 `data/<岗位>/<平台>/` |
| `SCREENER_REPORTS_DIR` | 报告统一收集目录（统一入口传项目根 `reports/`；不设则落数据目录下 `reports/`） | `SCREENER_REPORTS_DIR="./reports"` |
| `SCREENER_ALLOW_DUPLICATES` | 推荐去重开关：`1`=允许重复 / `0`=强制去重（**最高优先**，见「六·五」） | `SCREENER_ALLOW_DUPLICATES=1` |
| `SCREENER_GLOBAL_QUOTA_DIR` | 全局浏览配额记账目录（run.bat 自动传项目根 `data/_quota/`；AI 手动跑建议也传） | `SCREENER_GLOBAL_QUOTA_DIR=<项目根>/data/_quota` |
| `SCREENER_GLOBAL_DAILY_VIEWS` | 全局每日浏览硬顶覆盖（>0 整数；默认 1000） | `SCREENER_GLOBAL_DAILY_VIEWS=500` |
| `SCREENER_WORKING_WINDOW` | 工作时间窗口覆盖（`HH:MM-HH:MM`；默认 08:00-20:00，按本地时间） | `SCREENER_WORKING_WINDOW=09:00-18:00` |
| `SCREENER_ANYTIME` | `1` = 越过工作时间窗口（run.bat 的 `--anytime` 即此） | `SCREENER_ANYTIME=1` |
| `SCREENER_SKIP_REFRESH_GUARD` | `1` = 跳过刷新/登录环守护（**仅限测试**，默认机器强制，见「三·五」） | 测试环境 |
| `SCREENER_CITY_CODE` | 覆盖 BOSS 城市编码 | `SCREENER_CITY_CODE="101020100"` |
| `BOSS_BIN` | 覆盖 boss 可执行文件路径 | 自动探测失败时用 |
| `BOSS_CLI_AUTOUPDATE` | `0` = 应急关断自动升级（默认必查必升） | 升级故障排查时 |
| `BOSS_CLI_AUTOCONFIRM` | `0` = 恢复升级前人工确认 | 仅应急排查用 |
| `BOSS_GREET` | 打招呼总开关：`1` = 显式授权执行（跳过 settings 判定）/ `0` = 强制关断；默认按 `settings.greet.enabled`（见「四·六」） | `BOSS_GREET=0` |
| `BOSS_GREET_DRY` | `1` = 只演练不发送（打印名单与话术，零网络） | run.bat 的 `--greet-dry` |
| `BOSS_GREET_LIMIT` | 打招呼每日硬顶覆盖（>0 整数；默认 20，画像不可覆盖） | `BOSS_GREET_LIMIT=5` |
| `BOSS_SOURCE` | 候选来源（v2.8.2 优先级：env > `_user.json` 的 `settings.bossSource`（首跑引导问过）> 默认 `reco`）：`reco`（仅推荐牛人，开聊免费、自动打招呼生效）/ `both`（推荐+搜索）/ `search`（仅搜索；其 S/A 仍标「需手动」） | `BOSS_SOURCE=both` |
| `BOSS_TEXT_MODE` | 取文通道（v2.10.0）：默认 `shot`（截图 → 本机 RapidOCR 识别回填，正文存 `data/扫描图/`）；`drag` = 回退到拖选-复制通道（截图通道系统性故障时的人工回退，勿常规使用） | `BOSS_TEXT_MODE=drag` |
| `BOSS_OCR` | 截图模式下的本机识别开关（v2.10.0）：默认开（零 token）；`0` = 关断，全部走 AI 会话转写兜底 | `BOSS_OCR=0` |
| `SCREENER_RETENTION_DAYS` | 历史文件保留天数（v2.11.0 统一清理，用户拍板「保留 1 天可配」）：优先级 env > `_user.json` 的 `settings.retentionDays` > 默认 `1`；`0` = 关断。清理范围与永不清理清单见 AI-GUIDE「三·八」/ cleanup.js（报告、去重索引、配额账本不动） | `SCREENER_RETENTION_DAYS=7` |

其他模式：`node screener.js rescore` 基于本地缓存**零网络重算**（改打分模型后必用）；
`node screener.js search-only` 只搜人不出简历。
screener.js 退出码：`0` 正常｜`2` 登录失效（重新扫码）｜`3` 熔断（含风控，立即停）｜`4` 需人工验证；
greet.js 另有 `5` = 打招呼未授权（机器强制，见「四·六」）；
report.js 另有 `6` = 精评未完成拒出报告（见「五·一」）｜`7` = **转写未完成拒出报告**（截图已拍未转写，评分全 0/C，见「四·五」）；
ocr-batch.js：`next/save/status`，save 对格式不符条目退出码 `2`（拒收理由逐条打印，已收部分不受影响）。
`run.bat` 就是按这几个码提示用户的。

## 三·五、风控守护（刷新/登录环立即停 + 本地风控锁；2026-10-27 引入，与猎聘侧镜像）

猎聘侧风控事故（浏览 20 份在第 15 份触发、期间网页频繁自动刷新）后用户拍板的全局纪律，BOSS 侧同步兼容（**节奏参数不动**，BOSS 本就更保守）：

- **机制**：预检通过后用 `BOSS_CDP_URL`（与 CLI、取文同一登录浏览器）**只读侦听**所有 zhipin.com 标签的主帧导航。**刷新风暴**（20s 滑窗内 ≥6 次主帧导航）或**落到登录页**（/login、passport、/web/user 特征 URL）→ 事件回调里 `process.exit(3)` 立即全停，并写本地风控锁 `data/_quota/boss.risk-lock.json`；**带锁启动直接拒跑**。
- **CLI 风控错误码同样落锁**（2.6.1 起）：`ACCOUNT_RISK` / `ENVIRONMENT_RISK` / `LOGIN_RISK_CONTROL` 触发 `RiskControlError` → 全停 + 落锁。
- **两把锁别混淆**：本工具的锁 = 删 `data/_quota/boss.risk-lock.json` 文件解锁；CLI 自己的 `cdp_risk_lock` = `boss clean --risk-lock` 清。解锁前提都是**人工确认账号恢复正常并冷却**。
- **机器强制**：CDP 连不上 = 守护失效 = 拒绝开跑；测试环境 `SCREENER_SKIP_REFRESH_GUARD=1`。需 Node ≥ 22。守护纯只读（`Page.enable` + 收事件），不发任何输入。

## 四、工作流

```
预检（boss status 低成本探测登录态）
  ↓
推荐牛人分页拉取（boss hr recommendations --job-id <职位加密ID>，开聊免费；已聊过/好友跳过，最多 6 页/轮）——**v2.8.1 起默认唯一来源**
  ↓
多关键词组搜索（boss hr candidates，组间随机 20–40s）——仅 BOSS_SOURCE=both|search 时并入（两源去重、推荐优先）
  ↓ 长随机休息 40–100s
简历详情抓取（fetch-text 拖选取正文 + 候选卡片字段构建骨架——hr resume 接口已退役（boss-agent-cli#472），v2.8.0 起双源同构；逐份随机 15–35s，单次 ≤20 份，已缓存跳过）
  ↓
四维打分（维度与权重来自画像；默认示例：销售领域 30 + 业绩表现 30 + 核心技能 25 + 行业背景 15）——与猎聘同一模型
  ↓
Excel 推荐报告（推荐去重：已推荐过的不重复进报告，跳过者单列明细工作表；含「打招呼」状态列）
  ↓
用户在 BOSS 官网/App 手动查看（报告「BOSS简历」列=搜索直达链接）→ 打招呼（粘贴话术；
已开启自动打招呼的，S/A 级首条招呼已由工具在报告生成前自动发送，见「四·六」）
```

**三段式数据流（BOSS 的核心差异，务必理解）**：

```
boss hr candidates <关键词> --city <code> --page <n>
      ↓ 返回候选人卡片列表
      ↓ 每张卡片需含 geek_id + job_id + security_id
boss hr resume <geek_id> --job-id <job_id> --security-id <security_id>
      ↓ 返回**结构化 JSON**（非文本）
      ↓ 扁平化为全文 → 打分
```

> ⚠️ `security_id` 是**动态令牌**（会上轮换）。因此**不能**像猎聘那样"先搜完再离线看简历"，
> 必须**搜索后尽快串联抓取**。若某张卡片缺任一 ID，脚本会跳过并提示，这是正常现象，不是 bug。
> 若大面积缺 ID，说明上游返回结构有变，请对照 `boss schema` 检查，不要硬改字段名猜。

## 四·五、简历正文取回（v2.10.0 起截图 + AI 转写；拖选-复制为显式回退）

**架构定案（2026-10-31 用户拍板）**：正文密文由前端 wasm 解密后画进 c-resume iframe 的 canvas，DOM 永远无字；拖选-复制通道经 9 轮真机迭代仍非确定性取全（同一份简历 815/408/9309/4989 字符多态，懒渲染疑似封顶 ~4600px）。**不逆向 wasm（红线）**，改走「截图 + AI 会话转写」：工具只做真人等价动作（开弹层、阅读式慢滚、截图），文本由 AI 会话读图转写后回填——PII 不出「本机 + AI 会话」边界（与 llm-batch 同一信任模型），**不接外部 OCR API**。

**采集链路（`scripts/shot-capture.js`，默认通道）**：

```
screener 浏览循环内（同一次浏览动作，配额不额外计费）
  ↓ Network.enable 挂监听（开弹层前——弹层打开瞬间发 geek/info/v2）
  ↓ iBossRoot.resume.newChatResumeViewer 开弹层（15s 未就绪清场重开一次）
  ↓ 滚回顶 → 循环：Page.captureScreenshot（PNG，裁剪弹层矩形，不含会话列表）
    → 滚轮推进一屏-20% 重叠（~1s/屏 阅读式节奏）→ 测 scrollH
  ↓ 到底判定：高度连续 2 次不增长 且 屏数已覆盖内容高（高度仍在涨绝不停）
  ↓ 回收 geek/info/v2 的 zpData.jobCompetitive（牛人分析器明文）→ 关弹层
  ↓ resumes/<id>.json 落盘 {images:[相对路径], text, bossInsight} → 图片在 data/扫描图/<id>-NN.png
    （text 默认由本机 RapidOCR 内联识别回填，见下；识别未过校验者 text 留空走 AI 转写兜底）
```

**转写主通道（v2.10.0 同轮拍板）：本机 RapidOCR 内联识别（零 token、纯本地）**。screener 截图完成后立即 spawn `uv run --with rapidocr-onnxruntime`（`scripts/ocr-local.py`）逐图识别 → `scripts/ocr-local.js` 剥 UI 杂线/截断平台免责声明 → **三层去重组装**（头块剥离=滚轮未推进的整屏重拍块，容错变体行=长行包含关系；边界尾-头精确拼接；≥20 字长行首现去重——2026-10-30 真机 11 份实证滚轮振荡重拍普遍存在，三层组装后内容行重复≈0，残余行重复均为简历自然短词）→ `validateText` 校验（≥120 字符、含章节标记、≤20000）通过即直接回填 `text` ——**快速档筛完直接打分出报告，无转写断点**。首次运行 uv 自动装依赖+模型（~1-2 分钟一次），此后 ~5s/图。`BOSS_OCR=0` 可关断（或 uv/依赖不可用时自动降级）。

**转写兜底（`scripts/ocr-batch.js`，AI 会话执行）**——仅本地识别失败/未过校验的个别份走此链：

```
node ocr-batch.js next          # 吐待转写者的图片绝对路径清单 + 转写契约
  ↓ AI 会话逐份读图 → 转写为纯文本（保留章节标题行；相邻图重叠内容只留一份；忽略照片/UI 文字；不臆造；末图应含尾部模块）
node ocr-batch.js save <转写.json>  # 校验后回填 text——下游打分/报告/llm-batch/去重零改动
node screener.js rescore        # 重算评分（未转写者保持 0/C）
（精细档）node llm-batch.js next → … → report
```

**机器强制（铁律 9）**：`report.js` 退出码 `7` = 待转写者未回填文本，拒出报告（此时评分恒 0/C，出报告只会误导）；`llm-batch.js next` 跳过未转写者并在全批未转写时退出码 1 指向 ocr-batch；`run.js` 在 greet/report 前设转写断点。**判据全链路统一**：`images` 非空且 `text` trim 后为空 = 待转写。

**回退通道（`BOSS_TEXT_MODE=drag`，人工显式使用）**：截图通道系统性故障时的人工回退——走 v2.9.8 混合策略拖选-复制（fetch-text.js 原样保留：整趟拖选先行 → 缺尾部标记分段补采 → mergeSegments v2 去重拼接）。**不做运行中自动跨通道兜底**（失败即中止，防掩盖故障+弹层开合翻倍）。

**运行前提**（与拖选通道同款）：CDP 登录浏览器开着 + 沟通页 `web/chat/index` 标签存在（机器强制预检，自动开）；**窗口不可最小化/被完全遮挡**（渲染节流下滚轮事件 >10s 必熔断，assertInputResponsive 实测预检）；`BOSS_CDP_URL` 指对端口（Edge 9333 / Chrome 9222）；Node ≥ 22（原生 WebSocket）。截图通道无需 PowerShell 剪贴板。

**PII 纪线（截图新增）**：截图含更多 PII（含照片）——仅落本机 `data/扫描图/`、**报告不嵌图**、临时/测试产物测完即删、不外发。**自动过期清理（v2.11.0 起并入统一历史清理）**：截图、简历缓存（resumes json 含 PII 正文）、结果缓存与日志按统一保留期 `settings.retentionDays`（默认 1 天，`0`=关断）由 screener 启动时自动清理；报告、去重索引、配额账本永不清理（契约见 AI-GUIDE「三·八」）。

**牛人分析列（S3，零 token）**：弹层打开时的 `geek/info/v2` 响应里 `zpData.jobCompetitive` 是明文（"牛人38分钟前浏览过职位，其通常活跃时间为2-6pm"…），截图采集时网络层顺手回收 → `resumes/<id>.json` 的 `bossInsight` 字段 → 报告「牛人分析」列（无则显示 —）。正文密文（encryptGeekDetailInfo）**拿不到也不去拿**（红线）。

### 四·六、自动打招呼（2026-10-28 用户拍板，v2.7.0 起；授权制）

**自动收藏已弃用**（弹层收藏按钮对未沟通候选人被平台权限拦截——事件到达、零网络请求、状态不变，
2026-10-28 实测证伪；绕搜索页收藏 7 中丢 3）。S/A 触达改为**显式开启的自动打招呼**：

- **⚠️ 2026-10-29 实测事故（v2.7.1 止血中）**：搜索来源（`hr candidates` 卡片）参数被平台「假成功」——
  CLI 回执 `ok/sent:true` 但消息**不投递、不落会话**（证据链与病因分析见仓库 `BUG-2026-10-29-boss-greet-未投递.md`）。
  止血两道闸：① 搜索来源（lid 含 `lookupsearchgeek`，或 securityId 被回退填成 expectId）一律
  `manual-required`（报告标「未发(需手动)」），**不自动发**；② 任何回执成功都必须 `hr chat` 回查到
  会话才记账（`NOT_DELIVERED` / `UNVERIFIED` 不入账、可重试）。推荐来源参数（lid 含 `f1:common.`、
  开聊免费）理论可用但未实测（T1 实验项）。**病因定案前不要向用户承诺搜索来源能自动发送**。
- **v2.8.0 更新（推荐源上线，2026-10-29 T1 已实证投递）**：screener 新增「推荐牛人」来源——
  **v2.8.1 起 `BOSS_SOURCE=reco`（仅推荐）为默认**（用户拍板：搜索来源开聊需手动/付费，不默认烧浏览额度），
  `both` / `search` 显式指定才并入搜索；推荐池优先入池、已聊过/好友的人跳过；职位加密 ID 由
  `hr jobs list` 按 jobTitle 自动解析（画像可显式写 `bossJobEncryptId` 跳过匹配），最多 6 页/轮。
  **v2.8.2–v2.8.4**：来源成为首跑引导问题之一（`settings.bossSource`，`--setup-greet` 可重问；优先级 env > settings > 默认 reco）。⚠️ 问法的**选项文字本身必须带成本**（① 仅推荐牛人（打招呼免费）② 推荐+搜索（搜索来源打招呼需消耗『搜索畅聊卡』，按人头扣 1–5 次、约 ¥10+/人）③ 仅搜索（打招呼需消耗『搜索畅聊卡』））——2026-10-29 两次实证：AI 把成本挪到题干或概括成「是否收费」都会丢信息，见 AI-GUIDE 三·五。
- **v2.8.5 三缺陷修复**（`BUG-2026-10-29-resume-popup-zero-geometry.md`，workbuddy 会话检出并真机验证 20/20）：① fetch-text 几何尺寸闸——弹层 iframe 0×0（布局未完成）不再被当"已就绪"，防起拖点落遮罩点掉弹层致整轮熔断；② greet 回查非 ok 也重试满 3 轮——瞬时限流不再造成"已投递却判失败"的假阴性（漏记账=重复打扰风险）；③ **两侧 screener 简历间隔判定改 `viewedThisRun`**——原「缓存文件是否存在」在本轮刚写完缓存后恒 false，简历间隔/连看休整从未执行（实测 7–8s/份机器节奏，账号风险最高一条；猎聘侧补 `viewedThisRun` 变量）。**遗留待拍板**：BOSS 连看休整（restEvery/restBreak 对齐猎聘）与单轮上限下调——铁律 3 要求先让修好的间隔真实生效观察，再调参。
  **推荐来源的 greet 参数平台真实投递且免费 → 自动打招呼对推荐来源的 S/A 候选人生效**；
  搜索来源仍受上一条止血闸（manual-required）管束，待「搜索畅聊卡」到位并补 T2 定案后另行放开。
  同批架构改造：**hr resume 接口退役**（`wapi/zpjob/view/geek/info` 下线，上游追踪 boss-agent-cli#472）
  ——双源统一改为「候选卡片字段构建骨架（cardToStructured）+ 弹层 canvas 取正文」，denied.json 停写留档。
- **v2.9.0 三连修**（`BUG-2026-10-30-精细评估未被触发.md`，P0+两 P1，夹具全绿）：① **评估档位机器强制（P0）**
  ——档案 `scoringPreference="detailed"` 从死配置变硬约束：llm-scores 未覆盖本轮候选池时 report **退出码 6
  拒出报告**（`SCREENER_FORCE_FAST=1` 单次显式降级）；screener 收尾指引按档位分流；run.js 筛选后加断点
  （交互问停下评估/降级，非交互 exit 6）；AI-GUIDE 第 0 步清单补档位问；**报告首行固定标注「评估方式：
  快速/精细…」自证口径**。② **greet UNKNOWN 回执回查（BUG-3）**——`GREET_RESULT_UNKNOWN` 不再直接判
  失败不记账（实测该回执下消息可能已送达），统一走 `greet-receipt.js` 裁决：与 ok 同路 `hr chat` 回查，
  查到会话即视为送达并入账（防漏账→下轮对同一人重发）。③ **report 同轮重出（BUG-2）**——screener 每轮
  落 `data/run-meta.json`，去重索引条目记 `runId`：同轮重出报告（改话术/补数据）覆盖不跳过，跨轮才跳过。
- **v2.9.1 两项产品修正（2026-10-30 真机审计后用户拍板，两侧同步）**：① **报告默认全量收录**——
  `minReportGrade` 默认 "A" → **"C"**（真机 10 份候选 6 份被默认门槛挡在报告外，用户以为漏筛；画像仍可钉
  "A"/"S" 收紧，模板与示例同步）；② **BOSS 来源升级为开工必问**——AI 会话检查 `settings.bossSource`
  未落档时必须问询落档（三选项逐字带成本），v2.9.0 实测中 AI 只打印选项就走默认 reco，属同类「该问没问」
  缺陷（AI-GUIDE 契约与第 0 步清单双补）。
- **v2.9.3 joblist 适配 boss-agent-cli v3.1.0（2026-10-30 Edge 真机）**：CLI 自动升级后 `hr jobs list` 输出改分页嵌套 `data.data[]`、城市键 `locationName`、岗位 ID 键 `encryptId`——旧解析 exit 5，且 encryptId 缺失会断推荐源岗位解析。新旧结构双兼容，离线单测 + 真机 3 岗位验证，镜像基线重录。
- **v2.9.4 Edge 轮三修（2026-10-30 深夜，TDD+真机验证）**：① **缺口④遮挡节流探测**——`fetch-text.js` 新增 `assertInputResponsive`：拖选前实测一次零副作用 mouseMoved（可见时 ~17ms），>2s 判定浏览器被完全遮挡（windowState 仍 maximized 的类最小化节流，两次真机熔断实证）→ 明示「保持窗口可见」后中止，不再撞 10s 硬超时报无名错；② **joblist --json 纯度**——CLI/内核检查提示转 stderr（两侧 check-cli-update），stdout 整段直解（真机验证）；③ **run.js「从已发布岗位新建」解析修复**——`parseJobsPayload` 替换取末行（多行 pretty JSON 此前只拿到 `]`，路径实际是坏的），附 require 守卫使 run.js 可被单测 require。
- **v2.9.2 三缺口修复（2026-10-30 真机审计发现，实测验证）**：① **report.js 依赖自检**——缺 exceljs 时
  直调路径此前抛裸 MODULE_NOT_FOUND 栈（真机踩到：副本没跑 setup.bat），现在给出「先跑 setup.bat /
  npm install」一句话指引（两侧镜像）；② **超短正文完整性警告**——弹层取文 <500 字时 screener 如实标记
  「正文异常简短，打分与评估基于可见部分 + 重取方法」（真机案例：周浩 365 字 vs 常规 2–5k），llm-batch
  `next` 对 <800 字简历输出 `shortTexts` 标记提醒评估侧证据面窄（两侧）；③ **手动命令报告落点统一**——
  两侧 SKILL.md 手动命令块补 `export SCREENER_REPORTS_DIR="./reports"`（此前手动跑 report 报告落在
  数据目录深处，用户找不到；run.js 路径不受影响）。
- **v2.12.0 greet 回查预算适配（`BUG-2026-11-03-boss-greet-UNVERIFIED-request-budget.md`，根因源码级定案）**：
  workbuddy 真机撞上 CLI **v3.1.0 引入的 RequestBudget 跨进程预算层**（任何两次 CLI 派发最小间隔 30s、
  单进程等待上限 30s 即 `REQUEST_BUDGET_EXHAUSTED`、限流反馈写 cooldown、API/browser 通道共享同一
  sqlite）——发送实际送达但回查被拦死 → 恒 UNVERIFIED 不记账 → 重复发送风险。修复四件：① 回查抽出
  `greet-verify.js`：首轮前等 40s、轮间隔 45s、进程超时 60s→150s（旧值会把预算内排队的 CLI 进程杀掉）、
  预算错误按 `retry_after_seconds` 等；② 发送前预检沟通列表（账本 pending 命中即补记、同话术会话已存在
  者跳过 `dup-existing`——防重复触达硬保险）；③ UNVERIFIED 落账本 pending（`markPending`：不占日额度、
  命中去重阻断重发，存话术前 24 字供下轮匹配）；④ 回查匹配 snippet 12→24 字。新节奏预期：单人
  发送→核实典型 ≈ 1 分钟、最坏 ≈ 2.5-4 分钟。**遗留**：`hr chat` 回包结构无存档样本，匹配仍是列表全文含 snippet（同模板
  同 dim 组合撞词局限），下次真机存样本后升级为按 geek 身份定位。

- **授权（机器强制，不靠 AI 自觉）**：`profiles/_user.json` 的
  `settings.greet = { enabled, mode:"job"|"fixed", fixedText, askedAt, updatedAt }`。
  首次跑 BOSS 时 run.js 问两问（① 是否开启——附风险说明（主动触达、额度消耗、风控风险）；
  ② 话术来源），落档后不再追问（拒绝也记住），`run.bat --setup-greet` 随时重问/关闭。
  greet.js 无授权且无 `BOSS_GREET=1` → **退出码 5 拒发**；`BOSS_GREET=0` /
  `SCREENER_SKIP_USER_CONTEXT=1` 强制跳过（测试永不真发）。
- **触发范围**：本轮**真实浏览**（screener 落盘 `data/greet-pool.json` 快照——rescore 重建
  last-results 会丢 search.geekCard/viewedThisRun，故专用池；**多城市时按 run.js 传的
  SCREENER_RUN_ID 跨城累积**（同 id 覆盖、换运行重置——后一城不会覆盖掉前几城的池子））且
  **最终等级 S/A**（llm-scores 精细评估优先、规则分兜底，与报告 finalGrade 同口径）；S 优先、分高在前。
- **话术**：job 模式 = 报告「建议打招呼话术」列同一渲染（画像 `greetTemplate`，未配用内置默认）；
  fixed 模式 = `settings.greet.fixedText`（预填占位符草稿，可改可从零写；占位符语义
  `{dim1}..{dim9}` / `{维度label}` / `{company}`；**开启后报告话术列也渲染 fixedText——列内容
  = 实际发送内容**）。发送前硬校验：≤120 字、无链接/联系方式——命中即跳过该条并记原因，不静默截断。
- **发送**：`boss hr greet --geek-id --job-id --security-id --expect-id --lid --message --yes`
  （5 参数全来自搜索结果快照；⚠️ `encryptExpectId` 恒 null 勿用）。真发前 `boss status` +
  沟通页标签预检（`ensureChatTab`）+ **沟通列表快照预检**（v2.12.0：账本 pending 命中会话即补记
  占额度；sendList 已有同话术会话者跳过 `dup-existing`——UNVERIFIED 时代的防重复触达硬保险；
  快照失败仅提示不阻塞）。
- **节奏与守护**（feature-greet.md §5，比浏览更保守）：间隔 60–180s 随机、单次运行 ≤10（`--limit n`）、
  连续 2 次失败熔断、工作时间窗外软停止、`RATE_LIMITED` 结束本轮不重试（不落锁）、风控错误码 → 写本地
  风控锁（与 screener 共锁 `data/_quota/boss.risk-lock.json`）+ exit 3；**刷新/登录环守护全程覆盖
  greet 阶段**（同 screener 的 refresh-guard：CDP 不可达拒跑，测试 `SCREENER_SKIP_REFRESH_GUARD=1`）。
  **回查节奏（v2.12.0，对齐 CLI 预算层）**：发送后首轮回查前等 40s、轮间隔 45s、单次 `hr chat` 进程
  超时 150s、`REQUEST_BUDGET_EXHAUSTED` 按 `retry_after_seconds` 等待——单人发送→核实典型 ≈ 1 分钟
  （消息落库延迟需 3 轮回查时最坏 2.5-4 分钟），40s 预热是预算层（任何两次派发最小间隔 30s）下的必要
  代价，不要为提速调小（详见 greet-verify.js 头注）。
- **记账（两层，职责正交）**：全局账本 `data/_quota/boss-greet.json`（`{date, sentToday, cap,
  perJob, geeks}`；每日硬顶 20 仅 `BOSS_GREET_LIMIT` 可调、画像不可覆盖；`geeks` 名单 **geek 级
  去重**——数据目录按岗位隔离，同一人跨岗位只打扰一次；条目带 `status`（v2.12.0）：`sent`=已核实
  占额度 ｜ `unverified`=待核实**不占额度但阻断重发**，下轮预检命中会话自动补记，未命中提示人工确认）
  + 每轮状态 `data/greet-run.json`（报告「打招呼」列读取：已发送(已核验) / 已发送(上轮待核实·本轮补记) /
  待核实(已防重发,请人工确认) / 跳过·会话已存在 / 演练 / 跳过·已打过招呼 / 跳过·话术校验未过 /
  失败(码) / 超限未发 / 本轮未发）。
- **编排位置**：run.js 在城市循环后、rescore 前 spawn（`node <skill>/scripts/greet.js`）；任何
  失败只警告不阻断报告。试水参数：`--dry`（零发送零网络，打印名单+参数+话术）、`--only <id>`
  （单人）、env `BOSS_GREET_DRY=1`；run.bat 透传旗标 `--greet-dry` / `--greet-only <id>`。
- **未验证点（M2 单人真发闭环前勿当事实用）**：`hr greet` 是否受理搜索来源候选人、「已打过招呼」
  幂等返回码（当前一律按失败记账不 charge、可重试）。

## 五、打分模型

四维加权，满分 100；**维度名/关键词/权重全部来自画像 JSON**（默认与 `config.js` 示例为
销售领域 30 / 业绩表现 30 / 核心技能 25 / 行业背景 15）。**机制与猎聘完全一致**
（同一份 `profiles/*.json` 可两边复用），详细说明见
`liepin-resume-screener/references/scoring-model.md`。

关键设计（避免误判，勿改）：
- 带 `contextWords` 的上下文维度（如业绩维度）需**关键词与上下文词同句**才算强命中
  （销售画像上下文词如"完成/达成/超额/销售额/回款"等），只泛提关键词只给该维度的
  `weakScore`（如 6 分背景分），防止"提到就算命中"的误报。
- **易被"泛泛提及"的维度建议都配 contextWords**（2026-10-27 真机实证：不配时自我评价里一句
  「具备数据质量保障意识」也能拿满治理分——立场当经历）。代价是表述不规范的真经历会漏判
  （「数据质量保障是我的日常」无动作词 → weakScore）；拿不准就复制两份画像 A/B 对照跑一轮
  （rescore 零网络，改画像后基于缓存重算即可对比），用法详见
  `liepin-resume-screener/references/job-profile-guide.md` 的 contextWords 专题节。
- 分句按 `。[；;\n]` 切分，**不按逗号切**（中文简历逗号密集，会把同句语义拆散）。
- 普通维度：命中规则分数累加、**封顶该维度权重**（`combine: "sum-cap"`）；整维无命中给 `other`（默认 0）。
- 分级：S ≥ 80，A ≥ 60，B ≥ 40，C < 40（`gradeBands` 可在画像覆盖）；**报告默认全量收录所有等级**
  （v2.9.1 起 `minReportGrade` 默认 "C"——2026-10-30 用户拍板「报告不要门槛，都放进来」），画像可钉
  `"A"`/`"S"` 收紧。放宽分级后旧 B 升 A 会重新进报告，属正常，见「六·五」。

### 五·一、精细评估（LLM 语义评估，v2.6.0 可选档）

**定位**：规则引擎（快速档）之外的评估方式，由 **AI 会话本身**（正在对话的模型）逐份读简历工作内容、
按画像标准打分并附原文依据。**不配置任何模型 API——用的就是当前会话的模型**。触发：档案
`settings.scoringPreference: "detailed"`（run.bat 首跑引导会问，回车默认快速），或用户当次明说（当次指令优先于档案偏好）。

**机器强制（v2.9.0，BUG-2026-10-30 P0 修复）**：档案=精细且本轮候选池未全部评估时，`report.js`
**退出码 6 拒绝出报告**（与档案 exit 4 / 打招呼 exit 5 同款纪律——「AI 会自觉跑 llm-batch」的假设
已被 2026-10-30 实证证伪：选了精细的用户拿到的是全规则分且报告无标注）。本次显式降级：
`SCREENER_FORCE_FAST=1`（不改档案）。BOSS 侧顺序强制为 screener → llm-batch 评估 → greet → report
（greet 的最终等级读 llm-scores，未评估就发=按规则分发错人）；run.bat 双击路径在筛选完成后会出现
断点交互（停下交给 AI 评估 / 本次降级快速）。报告首行固定标注「评估方式：…」自证分数口径。

**取舍口径（告知用户的标准话术）**：快速=免费、秒级、关键词匹配颗粒度粗；精细=评估更准并附
匹配依据，消耗模型积分/token（每份简历约 3k token 量级，20 份一轮 ≈ 10 万级）。

**流程（契约在工具侧 `scripts/llm-batch.js`，执行在会话侧——工具不做任何模型调用）**：
1. 前置：`data/<岗位>/<平台>/data/last-results.json` 存在（先跑完筛选）
2. `node <skill>/scripts/llm-batch.js status` 看进度
3. `node <skill>/scripts/llm-batch.js next` → stdout 纯 JSON：进度 + 评估标准 + 一批简历全文（v2.10.0：未转写的截图简历会被跳过并列入 `pendingTranscription`——全批未转写时退出码 1 指向 ocr-batch，先转写再回来）
   （按规则分降序——好苗子先评；标准优先取画像 `evaluationCriteria` 自然语言字段，缺席则从
   `scoring` 各维度 rules/weight 推导）
4. 按下述纪律评估，把评估 JSON 写临时文件
5. `node <skill>/scripts/llm-batch.js save <文件>` → 工具校验（id/total/grade/parts 不符的条目
   拒收并指出原因，已收部分不受影响），落盘 `llm-scores.json`
6. 重复 3–5 至 status 显示全部已评 → `node report.js` 出报告（等级/评分按精细评估口径，
   附「规则对照」「匹配依据」列；档案=精细时必须全部已评 report 才放行，见上「机器强制」）

**评估 JSON schema（save 的机器校验面）**：

```json
[{ "id": "<候选人id>", "total": 82, "grade": "A",
   "parts": { "<画像scoring的维度key>": { "score": 20, "evidence": ["简历原文摘录≤60字"], "reason": "一句话理由" } },
   "summary": "一句话总评（可选）" }]
```

**批量纪律（硬规矩，不靠自觉）**：
- **隔离单元 = 20 份**（工具按此切批）：对话滚动评估的累计 token 是**平方级**（每评一批、前面全部
  简历跟着重算一遍），隔离单元才是线性——1000 份场景两者差 ~50 倍（1.75 亿 vs 350 万）
- **批内一次读入、一次输出**全部评估 JSON；逐份问答=违规
- 中断随时可停、停了不亏：已评的用 LLM 分，未评的规则分兜底
- **每评 2–3 批提示用户换新对话说「继续评估」**（评估状态在 llm-scores.json 文件里、不在会话里，
  新对话无缝续）；平台支持 subagent 时可用 subagent 逐批评估（每批一个干净上下文，自动接力），
  不支持则多对话接力——两条路径共用同一套 next/save 命令
- `next` 会带 `scoringHash`：画像评分标准变更后旧评估基于旧标准，工具警告提示（重评=删
  llm-scores.json 重跑，rescore 规则重算不影响已评缓存）

**切换话术（AI 收到后照做，改配置前向用户复述确认，同背景档案规矩）**：
- 「以后都用精细/快速评估」→ 改档案 `profiles/_user.json` 的 `settings.scoringPreference`（"detailed"/"fast"）
- 「这批候选人精细评估一下」→ 当次直接走上述流程，不改档案
- 精细评估对**没选偏好**的用户不是必经环节：用户没选偏好、没提要求时，默认只跑快速档（规则引擎）+ 出报告；但档案已选精细后，report 会被 exit 6 拦到评估完成为止（本次降级用 `SCREENER_FORCE_FAST=1`）

**红线**：精细评估只读本地简历缓存文本（next 吐的就是缓存全文），不向平台发任何请求；
未评估的候选人按规则分如实呈现，**不得虚构评估结果**。

## 六、输出物

| 文件 | 内容 |
|---|---|
| `reports/YYYY-MM-DD_BOSS直聘_<岗位>_推荐报告.xlsx` | 主表：排名/等级/评分/称呼/BOSS简历(搜索直达)/搜索串/抓取时间/公司/职位/城市/年龄/学历/年限/重点关注/统招风险/四维命中明细/来源关键词/建议话术。⚠️ 无「姓名」列（简历接口姓名是平台脱敏的 ***）；「称呼」列 = 搜索卡片上的名字（如 冯**），配合「公司/职位」在搜索结果里对照定位目标人（排序由平台决定，不承诺排最前）。⚠️ **「年龄/学历/年限」三列自 BOSS 下线旧简历接口后恒空**（hr resume 只回骨架，平台不再返回该三字段，2026-10-27 真机实证 18/18 份；非抓取故障，有意不做正文兜底解析——拿不到就如实空着，用户点链接在在线简历里看） |
| 同文件第二工作表「已推荐过(本次跳过)」 | 本次因**推荐去重**被跳过的候选人：姓名/等级/评分/首次推荐时间/来源报告（本次没有跳过时不出此表，详见「六·五」） |

**报告落点**：设 `SCREENER_REPORTS_DIR` → 落该目录（统一入口 `run.bat` 用它把两平台报告统一收进
项目根 `reports/`）；不设 → 落**数据目录**下的 `reports/`（旧行为）。
**文件名带 `BOSS直聘` 前缀**，与猎聘报告天然区分，便于两平台并列交付。

**关于简历链接（2026-10-21 定案 → 2026-10-29 v2.8.2 修订）**：
- 旧直链 `web/geek/{encryptGeekId}?securityId=…` **已真机证伪**——秒级新鲜令牌 + 在签发它的同一登录浏览器里打开，仍是「Oops 页面不存在」：该 URL **从来不是招聘端的有效页面**，与令牌时效无关。不要再尝试任何「拼令牌直链」方案。
- ~~frame/search 搜索直达~~ **已于 v2.8.2 弃用**：2026-10-29 用户实测，该内嵌搜索（`web/frame/search/?keywords=…`）的卡片**不可交互**——点名字不弹在线简历、点「联系」无反应（平台把 iframe 搜索做成了只读展示）。
- **现行（v2.8.2 链接 / v2.8.5 搜索串）**：报告「BOSS简历」列链接到**沟通页搜索入口** `https://www.zhipin.com/web/chat/search`（该页卡片可点开在线简历、可点「联系」），配合「搜索串」列粘贴回车。搜索串 v2.8.5 起统一收敛为**「姓 + 清洗公司 + 职位」**（称呼带星→剥星取姓；**真名→取姓（复姓取前两字）**——原「姓名+职位」分支被推荐来源真名触发后，2026-10-29 用户实测在沟通页搜索**搜不到人**，v2.8.2 曾误标"真名直用更好搜"系未实证错判，已纠正；剥不出人名→公司+职位兜底）。对照确认用「称呼+年限+年龄」。
- ⚠️ **平台收费规则**：对**搜索找到的人**点「联系」会弹「搜索畅聊卡」购买（普通 1 次 / 热搜 2–3 次 / 稀缺 5 次，约 ¥10+/人）——推荐来源的候选人免费（工具对其自动打招呼已生效，通常无需手动联系）。
- 公司名自动去掉「（苏州）」类括号后缀（2026-10-21 实测：带括号搜不到，去括号目标人排第 1）。
- ⚠️ **BOSS 简历详情返回的姓名是脱敏的（`basic.name = "***"`）**——搜索词的人名一律取自**搜索卡片称呼**（`ids.name`，如 冯**）：带星剥姓走「姓+清洗公司+职位」三词缩池（2026-10-21 用户实测：大公司下「公司+职位」目标被淹没，三词后目标排前）；剥不出人名（***/（详见BOSS）/—）才降级「当前公司 + 现任职位」。报告「搜索串」列同规则同词。简历姓名显示 "***" 属正常，不是抓取失败。
- 「抓取时间」列记录数据获取时刻（旧缓存无此字段显示「—」）；备注保留 `geek_id` / `job_id` 便于核对。
- 兜底：链接打不开（如未登录）时，复制「搜索串」列到沟通页顶部搜索框手动搜。
- **为何不采「转发简历二维码 / zpurl 短链」**：能转发的前提是先打开该候选人的页面（鸡生蛋）；上游 CLI 无对应只读命令；生成转发内容属写操作，踩第一节红线。

**使用前提**（必须告知用户）：
1. 点链接前浏览器需已登录 BOSS 直聘**招聘者账号**，否则跳登录页
2. 建议在电脑端操作（沟通页 → 打招呼 → 粘贴话术；已开启自动打招呼的，S/A 级首条招呼已由工具在筛选后自动发送，状态见报告「打招呼」列）
3. 节奏控制在真人水平：看完一份再打一个，每天 20–40 人为正常 HR 区间

## 六·五、推荐去重（recommended-index.json）

**语义**：同一岗位、同一候选人**只进一次推荐报告**。report.js 在报告**成功生成后**，把本次上榜者
登记进数据目录顶层的 `recommended-index.json`；下次生成报告前先按索引过滤——已登记的不再进主表，
改列入第二工作表「已推荐过(本次跳过)」，控制台同时打印跳过明细（前 10 条）。

**位置与作用域**：

```
<SCREENER_DATA_DIR>/                      # 数据目录 = 岗位 × 平台（统一入口约定 data/<岗位>/<平台>/）
├── data/                                 # 缓存与过程数据（last-results.json、resumes/、processed.json、greet-pool.json、greet-run.json；denied.json 已随 hr resume 退役停写、favorites.json 已随收藏弃用，均留档不读不写）
├── reports/                              # 未设 SCREENER_REPORTS_DIR 时的报告落点
└── recommended-index.json                # 推荐去重索引（作用域 = 本数据目录 = 岗位 × 平台）
```

- 键：`"<平台>:<候选人ID>"`，BOSS 侧即 `boss:<geekId>`。**作用域 = 数据目录 = 岗位 × 平台**：
  同岗位同平台跨城市、跨天共享一份索引；换岗位、换平台天然互不影响。
- 与 screener 的 `data/processed.json` 职责正交：processed 防「重复抓简历」，本索引防「重复推荐上榜」。

**三级开关**（优先级从高到低）：

1. 环境变量 `SCREENER_ALLOW_DUPLICATES=1`（允许重复）/ `=0`（强制去重）——**最高优先**；
   `run.bat --dup` 等价于 `=1`。
2. 画像 JSON 里 `"allowDuplicateRecommendations": true/false`。
3. `config.js` 默认 `false`（去重开启）。

**如何重置推荐记忆**：

- 只重置推荐、保留简历缓存：删数据目录下的 `recommended-index.json`（下次报告会重新收录所有人）。
- 连缓存一起清：删整个数据目录（`data/<岗位>/<平台>/`）。
- 索引文件损坏时脚本会自动把它隔离为 `recommended-index.corrupt-<时间戳>.json` 并从空索引重建，
  不中断出报告。

**已知取舍（要如实告知用户）**：

- BOSS 个别候选人卡片缺 `geekId` 时，索引键**回落用姓名**——同名候选人会被误判为已推荐而跳过
  （保守方向，宁漏不重）。确认是不同的人：单轮用 `--dup` / `SCREENER_ALLOW_DUPLICATES=1` 放开。
- 放宽 `gradeBands` / `minReportGrade` 后，旧标准下的 B 级（当时没达标没进报告、没登记）在新标准
  升 A 后会正常出现并首次登记——**这是正常行为，不是去重失效**；去重只拦「已进过报告的人」。
- 报告写失败则不写索引，下次重跑会重新收录（失败模式安全）。

## 六·六、全局浏览配额（每日每平台 1000 份硬顶，多岗位均分）

跨岗位共享的"成功浏览简历"日配额（与猎聘各自独立记账，互不共享），防止单个账号一天看太多简历：

- **记账**：`data/_quota/boss.json`（schema `{date, resumeViews, cap, updatedAt, perJob:{<岗位>:份数}}`；目录可由 `SCREENER_GLOBAL_QUOTA_DIR` 指定）。**只计成功浏览的简历详情**：缓存命中、RESUME_NOT_FOUND 等被拒、缺三元组跳过、搜索请求都不占额度。
- **硬顶**：每平台每日 1000 份（`config.globalMaxResumeViewsPerDay`，env `SCREENER_GLOBAL_DAILY_VIEWS` 可调；画像不可覆盖此项）。到顶后简历阶段**软停止**（正常收尾出报告、退出码 0、次日自动清零）——与风控熔断（exit 3）是两回事，不要混淆。
- **均分**：run.bat 按公式 `份额 = 全局剩余 ÷ profiles/ 岗位画像总数` 给每岗位算当日预算（跨多次运行生效；**新增画像自动参与重分**），并把 `min(单轮默认上限, 份额剩余)` 作为 `RESUME_LIMIT` 传给 screener。份额用尽 → 跳过筛选直接出报告。
- **AI 手动串岗位时**：按同款公式算 RESUME_LIMIT（`剩余 = 1000 - 今日已浏览`，查 `data/_quota/boss.json` 的 perJob 得该岗位已用量；画像有 `dailyResumeQuota` 则以它为该岗位日限，仍受全局硬顶）。
- **口径说明**：翻日按 UTC 0 点（北京时间早 8 点），与 quota.json 一致；同平台不要并行开两个窗口跑（记账会互相覆盖）。
- 与每岗位 `data/quota.json`（请求计数）是两层：全局管浏览硬顶，岗位管请求兜底。

## 六·七、工作时间窗口（默认 8:00–20:00，降低自动化识别风险）

工具默认只在每天 **8:00–20:00（按用户电脑的本地时钟）** 执行搜索/看简历；离线操作（rescore/report/--report-only/--setup-user/--dry-run）不受限。BOSS 风控本就更严，窗口是额外保护。

- **双层执行**：run.bat 启动时**硬拦截**（窗外直接退出并提示下次窗口）；screener 运行中**软停止**（到点正常收尾出报告、退出码 0——与风控熔断/人工验证是两回事，不要混淆；搜索与简历阶段都检查）。
- **越过**：`run.bat --anytime` 或 env `SCREENER_ANYTIME=1`（自动化识别风险自担）。
- **修改**（优先级从高到低）：env `SCREENER_WORKING_WINDOW=HH:MM-HH:MM` → `profiles/_user.json` 的 `settings.workingWindow` → 默认 08:00-20:00。**画像里写 workingWindow 无效**（风控类全局项，强制回钉）。非法值一律回落默认并 warn。
- **边界语义**：起始时刻含（8:00:00 可跑），结束时刻不含（20:00:00 整点即停）。支持跨午夜窗口。AI 修改窗口的契约见「用户背景档案」节的 settings 规则。

## 七、故障处理手册

| 现象 | 原因 | 解法 |
|---|---|---|
| 退出码 4：`profiles/_user.json 不存在` | 背景档案门槛（v2.3.2 起为前置条件，防"没问背景就开跑"） | 按提示问四项建档案后重跑；用户不想答就写空档案；测试环境 `SCREENER_SKIP_USER_CONTEXT=1` |
| 退出码 5（greet）：打招呼未授权 | `settings.greet.enabled` 非 true 且无 `BOSS_GREET=1`（机器强制，不靠 AI 自觉） | 首跑 BOSS 时 run.bat 会问两问；或 `run.bat --setup-greet`；AI 会话按 AI-GUIDE「BOSS 打招呼授权」节问用户后写入；测试 `BOSS_GREET=0` 跳过 |
| `[窗口] …提前收尾/在窗口之外` | 工作时间窗口到点或窗外运行（六·七） | 属正常软停止（退出码 0），下次窗口自动恢复；急用加 `--anytime`；改窗口见 `_user.json` settings |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` | 未登录 / 登录态过期（**实测 CLI 会话短命：筛完一轮后短时间内即失效**） | 2.4.1 起 screener 预检**自动从登录浏览器免扫码重导一次**（`boss login --cdp`）；仍失败=登录浏览器未登录或已关，双击登录器扫码即可 |
| `stoken_presence` 为 error（`__zp_stoken__` 缺失） | 部分登录态 | 以 Chrome CDP 调试端口启动浏览器后 `boss login --cdp`（上游推荐路径） |
| `ACCOUNT_RISK` / `ENVIRONMENT_RISK` / `LOGIN_RISK_CONTROL` | **风控拦截** | **立即全停**，人工在浏览器完成验证后再评估；**不得重试、不得换通道**；2.6.1 起同时落本地风控锁（见「三·五」），解锁=确认账号恢复后删 `data/_quota/boss.risk-lock.json`（CLI 侧锁另用 `boss clean --risk-lock` 清，两把都要清） |
| `[风控守护] ⚠️ refresh-storm / login-page …立即停止` | 运行中频繁刷新或落到登录页（「三·五」守护触发，2026-10-27 引入） | 属**有意立即全停**（exit 3）；人工检查账号、冷却后按提示删锁重跑；`SCREENER_SKIP_REFRESH_GUARD=1` 仅限测试 |
| 启动报「检测到本地风控锁」或「CDP 不可达…（守护是硬前置）」 | 上一轮风控锁未清，或登录浏览器没开导致守护无法上线 | 前者：人工确认账号恢复+冷却后删锁文件；后者：双击 boss-edge-login.bat / boss-zhipin-login.bat 开窗再跑；**都不要反复重试** |
| `PLATFORM_VERIFICATION_REQUIRED` | 平台要求人工验证 | **立即终止**，交用户在官方页面处理 |
| `RATE_LIMITED` | 请求频率过高 | 本轮停止，隔时段再跑；**不要调快间隔** |
| `RECRUITER_NOT_AUTHORIZED` | 当前账号非招聘者账号 | 确认用的是 BOSS **招聘者端**账号 |
| `RESUME_NOT_FOUND` / `RESUME_NOT_SHARED` | 候选人未分享 / 简历不可见 | 正常拒访，脚本记入 `data/denied.json` 跳过，**不计入错误**、不重试 |
| 大面积候选人卡片缺 `security_id` | 上游返回结构变更 | 用 `boss schema` 核对；**不要靠猜字段名硬改** |
| `INVALID_PARAM` | 参数校验失败（如 cityCode 写错） | 检查 `bossCityCode` / `bossFilters` 取值 |
| `NOT_SUPPORTED` | 当前平台/版本不支持该能力 | 升级 CLI（见步骤 2），或改走其他能力 |
| `BROWSER_KERNEL_MISSING` | patchright 浏览器内核缺失 | `node "<skill目录>/scripts/check-cli-update.js" --install-browsers`（走镜像，**不要用官方 install**） |
| 找不到 `boss` 命令 | CLI 未装或不在 PATH | 按步骤 1 安装；或设 `BOSS_BIN` 指向实际路径 |
| 上次推荐过的人这次没进报告 | 推荐去重命中（见「六·五」） | 看第二工作表「已推荐过(本次跳过)」；确要重复推荐用 `SCREENER_ALLOW_DUPLICATES=1` 或删 `recommended-index.json` |
| 报告标题/文件名是默认岗位 | `JOB_PROFILE` 没传给 report.js | 用 `export JOB_PROFILE=...`，screener 后续脚本共享 |
| 冒烟测试：`boss status` 通过但 `hr candidates` 失败 | 只读流健康差异 | 看 `checks` 里 `candidate_search_health` / `recruiter_read_health` 的具体项 |
| 报告「BOSS简历」旧链接 404/Oops | 旧版直链格式已被证伪（从来不是有效页面，与令牌无关） | 升级 2.4.1 重新生成报告（列为搜索直达链接）；旧报告用「搜索串」列手动搜 |
| 搜索报 `NETWORK_ERROR` 但手动裸跑能搜通 | 旧版 Windows 下 CLI 按 GBK 写输出，响应含生僻字（如部首 ⽙）即崩（2.4.1 已强制 `PYTHONUTF8=1`） | 升级 2.4.1 |
| 不设 `SCREENER_CITY` 时搜的城市不对（如深圳岗位搜出北京池） | 旧版画像只写中文 `bossCity` 时城市码翻译分支永远走不到（恒为默认北京码；run.bat 因逐城设 env 不受影响，2.4.1 已修） | 升级 2.4.1；临时绕过=显式设 `SCREENER_CITY` |
| `ENDPOINT_DEPRECATED`（旧简历接口已下线） | 沟通页未开导致 CLI 页面兜底失效。v2.5.1 起：预检自动开沟通页 + 该错误码**立即停止**（不再吃满 3 次熔断——2026-10-26 事故教训） | 看浏览器里沟通页是否在位且已登录；确认后重跑；沟通页在位仍报此错=平台前端变更，停用并反馈 |
| 取文失败：正文不完整/缺章节标记 | canvas 复制通道只选到片段，或平台前端变更（v2.5.0 取文链路，见「四·五」） | 中止语义是**有意的**（无正文不打分）；先直接重跑一次；连续失败=平台通道变更，停用并反馈维护者 |
| 取文失败：CDP 不可达 / 没有沟通页 | 登录浏览器没开，或 `BOSS_CDP_URL` 端口不对（Edge 9333 / Chrome 9222） | 开登录器、核对端口 env，浏览器里打开 `web/chat/index` 后重跑 |
| 取文失败：Node 缺少原生 WebSocket | Node < 22 | 升级 Node ≥ 22 |
| 取文失败：弹层 15s 未就绪 / `NO_API` | securityId 失效或平台前端改版 | 重跑一次（新一轮搜索会换新令牌）；仍失败=平台变更，停用并反馈 |

> 排查顺序建议：`boss doctor` → `boss status`（看 `checks`）→ `boss schema`（看命令可用性）→ 再动业务脚本。
> 上游排障文档：仓库 `docs/troubleshooting.md`。

## 八、与猎聘并列使用（两平台协同）

**同一岗位两平台跑通的完整流程**：

```bash
cd <项目根>
export SCREENER_REPORTS_DIR="./reports"   # 可选：两平台报告统一收进项目根 reports/

# 1. 猎聘
JOB_PROFILE="profiles/销售经理.json" SCREENER_DATA_DIR="./data/销售经理/liepin" \
  node "liepin-resume-screener/scripts/screener.js"
JOB_PROFILE="profiles/销售经理.json" SCREENER_DATA_DIR="./data/销售经理/liepin" \
  node "liepin-resume-screener/scripts/report.js"

# 2. BOSS（本 skill，独立数据目录；缓存与去重索引互不污染）
JOB_PROFILE="profiles/销售经理.json" SCREENER_DATA_DIR="./data/销售经理/boss" \
  node "boss-resume-screener/scripts/screener.js"
JOB_PROFILE="profiles/销售经理.json" SCREENER_DATA_DIR="./data/销售经理/boss" \
  node "boss-resume-screener/scripts/report.js"
```

**去重提示**：**平台内**（同岗位同平台）的重复推荐已由 `recommended-index.json` 自动拦截
（见「六·五」）；**跨平台不做自动去重**——同一候选人可能同时出现在两个平台，而平台 ID 体系不同，
强行匹配易误合。建议按「姓名 + 当前公司」人工判重；若确需去重，在报告交付后人工核对，
**不要让脚本自动合并**。

**两份报告的差异要如实告知用户**：BOSS 报告的「年龄/学历/年限」三列恒空（平台接口不再返回，见「六」），
猎聘报告字段更结构化完整；打分模型一致，但**输入的原文完整度不同**，分数可能有小幅差异。这是正常的。

## 九、提示词入口（用户可直接说）

- 「跑一轮 **BOSS** 筛选」→ 全量搜索 + 打分 + 出报告（用户本机优先引导双击 `run.bat`）
- 「**我招〈岗位名〉，帮我筛**」（只报名字）→ 已发布岗位直连（二·七）：joblist 匹配 → 起草画像 → 确认即跑
- 「**列一下我在 BOSS 上在招的岗位**」→ `node <skill>/scripts/joblist.js`（人读表格；`--json` 机器可读；`--raw` 原始输出）
- 「**把工作时间窗口改成 9 点到 18 点**」→ 确认后改 `profiles/_user.json` 的 `settings.workingWindow`（更宽需二次确认，见「用户背景档案」节第 6 条）
- 「**历史文件保留改成 7 天** / **把自动清理关掉**」→ 确认后改 `profiles/_user.json` 的 `settings.retentionDays`（默认 1 天，`0`=关断；见「用户背景档案」节第 10 条与 AI-GUIDE「三·八」）
- 「用 **BOSS** 帮我筛〈岗位名〉，要求〈……〉」→ 生成/复用画像 + 给运行命令 + 执行
- 「**猎聘和 BOSS 都跑一遍**〈岗位名〉」→ 依次跑两个 skill，分别出报告
- 「**BOSS** 上切换到〈岗位名〉岗位」→ 用对应 `JOB_PROFILE` + `SCREENER_DATA_DIR` 运行
- 「只跑 **BOSS** 的第 2 组关键词」→ `KW_GROUPS="2"`
- 「看看 **BOSS** 今天筛出来的候选人评分明细」→ `node <skill>/scripts/show-scores.js`
- 「**BOSS** 的打分模型调一下：XX 权重提高 / 加上 XX 关键词」→ 改画像或 `config.js` 后跑 `rescore`（零网络）
- 「这次怎么没出现上次那几个人」→ 推荐去重命中；看报告第二工作表「已推荐过(本次跳过)」（见「六·五」）
- 「这次允许重复推荐」→ `SCREENER_ALLOW_DUPLICATES=1`（或 run.bat 加 `--dup`）后重跑 report.js
- 「把 **BOSS** 的推荐记录清零」→ 删数据目录下的 `recommended-index.json`（缓存保留）
- 「检查一下 **boss-agent-cli** 有没有新版本 / 帮我更新」→ `node <skill>/scripts/check-cli-update.js`（默认检查并自动升级；只查不升加 `--check-only`）
- 「**BOSS** 登录态失效了」→ 先看 `boss status` 的 `checks`，再按步骤 3 处理（**不要反复重登**）
- 「**BOSS** 提示风控了」→ **立即全停**，人工处理，不要重试
- 「张三的 BOSS 链接打不开」→ 先确认浏览器已登录招聘者账号；仍打不开则把报告「搜索串」列内容粘到沟通页搜索框手动搜（报告链接打不开是常态，见「六、输出物」的兜底说明）

## 十、目录结构与参考文档

```
<项目根>/                          # 开源化后的项目布局（无机器私有路径，不含真实岗位数据）
├── boss-resume-screener/          # BOSS 通道工具包（本 skill，通用，不含岗位数据）
│   ├── SKILL.md                   # 本文件
│   ├── references/
│   │   └── boss-cli-notes.md      # boss-agent-cli 实测事实清单（版本/信封/错误码/命令）
│   └── scripts/
│       ├── screener.js            # 编排器：搜人 → 拿三 ID → 抓简历 → 四维打分（含版本自检）
│       ├── config.js              # 默认配置（已中性化）+ boss 可执行文件探测 + JOB_PROFILE 加载
│       ├── boss.js                # boss-agent-cli 封装：JSON 信封解析 + 错误码熔断 + CDP 注入
│       ├── scoring.js             # 四维打分内核（平台无关，与猎聘一致）
│       ├── report.js              # Excel 推荐报告（含推荐去重过滤 + 跳过明细工作表 + 打招呼状态列）
│       ├── greet.js               # 自动打招呼阶段（授权制，见四·六；run.js 在 rescore 前 spawn）
│       ├── greet-verify.js        # 回查/预检模块（v2.12.0 预算适配：40s/45s/150s + retry_after；见四·六）
│       ├── greet-ledger.js        # 打招呼全局账本（每日硬顶 + geek 级去重 + pending 待核实语义，data/_quota/boss-greet.json）
│       ├── show-scores.js         # 终端打印评分明细
│       ├── joblist.js             # 读取 BOSS 已发布岗位（在招职位）——已发布岗位直连入口（二·七）
│       ├── working-window.js      # 工作时间窗口纯函数（六·七；三处镜像之一）
│       ├── cleanup.js             # 历史文件统一清理（保留期 settings.retentionDays，默认 1 天；两侧镜像）
│       ├── check-cli-update.js    # 版本检查 / 升级（查 PyPI）+ 浏览器内核镜像安装
│       └── package.json           # scripts 快捷方式（screen/rescore/report/scores/...）
├── liepin-resume-screener/        # 猎聘通道（并列）
├── profiles/                      # 岗位画像（两平台共用；真实画像不入库，随项目文件夹迁移）
│   ├── _template.json
│   └── example-销售经理.json      # 通用示例画像
├── run.bat / run.js               # 统一入口（选平台+岗位、自检、逐城市跑、rescore+report）
├── setup.bat                      # 一次性安装（猎聘依赖 + 可选 BOSS 组件 + 内核预下载）
├── liepin-login.bat               # 猎聘登录启动器
├── boss-edge-login.bat            # BOSS 登录启动器（Edge，CDP 9333）
├── boss-zhipin-login.bat          # BOSS 登录启动器（Chrome，CDP 9222）
├── pack-release.js / pack-release.bat  # 打分发版（白名单打包）
├── data/<岗位>/<平台>/            # 运行数据（run.js 传 SCREENER_DATA_DIR；含 recommended-index.json）
└── reports/                       # 报告统一落点（run.js 传 SCREENER_REPORTS_DIR）
```

- `references/boss-cli-notes.md` — **boss-agent-cli 实测事实清单**：版本、安装落点、JSON 信封、
  52 个错误码分类、只读命令白名单、与猎聘的逐项差异、实测命令参数。**改动本 skill 前先读它。**
- 打分模型详解与画像指南复用猎聘侧文档：
  `liepin-resume-screener/references/scoring-model.md`、`.../job-profile-guide.md`。
- `pack-release.bat` — 打干净包发给别人：白名单只收两个 skill、`profiles/_template.json` 与
  `example-*` 示例画像、run/setup/登录器/README 等根文件；**排除 data/、reports/、node_modules/
  与一切真实岗位画像**。BOSS 的两个登录启动器已在包内。

**数据纪律**：简历缓存与导出文件仅本地保存，不得公开分享或二次分发。
