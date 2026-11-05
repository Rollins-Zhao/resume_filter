---
name: liepin-resume-screener
version: 2.15.2
description: This skill should be used when bulk-screening candidates or resumes on 猎聘 (Liepin) recruiter platform — searching candidates by keyword groups, scoring them with a customizable multi-dimension model, deduplicating recommendations (same candidate enters the recommendation report only once per job), and generating a downloadable Excel recommendation report with direct resume links and suggested greeting scripts for manual outreach. It also covers liepin-cli installation, login-state recovery, quota discipline and circuit-breaker handling. Strictly read-only, human-outreach architecture: it never auto-sends greetings, messages, or contact-exchange requests. Triggers include 筛简历, 筛选候选人, 猎聘筛选, 候选人推荐报告, 简历直链, 简历去重, 推荐去重, 猎聘自动筛选.
agent_created: true
---

> 本文件 `version: 2.15.2`（对应发布包版本）。项目根会经 run.bat / `self-update.js` 自动升级（v2.13.0 起，查 GitHub Release）；本 skill 若被单独复制到 `~/.workbuddy/skills/` 等位置、版本低于项目根包内版本时，提醒用户从项目根复制刷新。

# 猎聘简历自动筛选（只读筛选 + 人工触达）

## 一、首要红线（绝对不可违反）

1. **绝不执行 `liepin greet`**。所有打招呼一律由用户在猎聘官网/App 手动完成。脚本中不存在调用 greet 的代码路径，不要新增。
   > 猎聘侧**没有** BOSS 侧那种「授权制自动打招呼」例外（v2.7.0 起 BOSS 侧在 `settings.greet`
   > 显式开启后可对 S/A 级自动发首条招呼，见 boss-resume-screener/SKILL.md「四·六」）——
   > 本平台保持纯只读，话术仅供用户手动粘贴；勿以 BOSS 侧先例在本侧新增任何 greet 路径。
2. **绝不交换联系方式**（手机号/微信）、**绝不批量群发消息**，无任何例外。
3. **只看不写**：只使用 `search` / `resume` / `recommend` / `talent` / `joblist` / `chatlist`（只读）等命令。
4. **遇风控立即停**：退出码 3、连续 3 次一般错误、日配额耗尽、出现"环境异常/账号异常"提示 → 立即终止全部自动化，通知用户人工检查，**不得重试**。
5. **登录受阻立即停手**：一旦出现 `about:blank`、被 302 到 `safe.liepin.com` 验证页、或退出码 3 → **立即终止，交用户在浏览器里人工过滑块，绝不再重登**。反复重登正是账号被判「行为异常」的主因（机制说明见步骤 2 的「登录频率闸」）。
6. **绝不加 `--force`**：`liepin login --force` 会跳过「复用现有会话」与「24 小时频率保护」两道闸。无论诊断出什么现象，**都不许给 `login` 加 `--force`**。
7. **猎聘内置节流情况（v0.2.7 实测）**：`search` / `resume` 等**读取命令没有任何自动阻断**，合规责任 100% 在编排层，所有随机间隔必须在脚本内实现（本 skill 已实现）。
   > 唯一例外是 `login`：v0.2.6 起自带频率闸（24 小时内超过 3 次交互式登录会被拦下），但 `--force` 可绕过——故见第 6 条。

## 二、适用场景

- 为某个岗位批量筛选猎聘候选人（如"销售经理"）
- 需要按自定义多维模型给候选人打分排序（维度与权重在画像/配置里定义，如销售领域/业绩表现/核心技能/行业背景）
- 需要输出可下载的 Excel 推荐报告（含「直达简历」超链接列 + 建议话术列）
- 同一岗位反复跑时自动推荐去重：同一候选人只进一次推荐报告，不重复打扰
- 需要给出可直接复制使用的个性化打招呼话术（**仅供用户手动粘贴**）

## 二·五、标准调用话术（用户可直接复制）

> 我需要招一个【岗位名称】，要求是【……】，请你用【猎聘招聘 SKILL】帮我筛选简历。

**只报岗位名也行**（已发布岗位直连，见「三·九」）：

> 我在猎聘上招**销售经理**，帮我筛简历。

展开示例：

> 我需要招一个**销售经理**，要求是：北京/上海、5 年以上 B2B 大客户销售经验、有团队管理经验、业绩持续达标。请你用**猎聘招聘 SKILL** 帮我筛选简历。

AI 收到后的动作：

0. **【硬性第一步，不允许跳过】生成画像前必须确认 `profiles/_user.json` 存在**（查找路径见「用户背景档案」节）；不存在 → 先问用户公司名/行业/业务方向/常用城市四项，**确认后写入档案**，再继续第 1 步。四项确认后可再问**一个可选补充问**（并入 `businessSummary`，见该节第 8 条）；平台自身记忆里已有用户背景时只能当**预填建议**、逐项确认后写入（第 9 条）。screener 启动时若打出"[提示] 尚未建立用户背景档案"，也按本步骤补建。
   **环境自检顺带（v2.10.0）**：同一开工环节先跑 `node doctor.js --json`（首次任务必做；能自动装的当场装，详见 AI-GUIDE「五」）——`criticalReady=false` 或本平台分组未 ✅ 时先按输出处理，不开跑。同一环节项目根存在 `self-update.js` 时先跑 `node self-update.js`（工具本体自更新，v2.13.0 起；失败单行提示不阻塞）。
   **评估档位顺带（v2.9.0，2026-10-30 补）**：同一开工环节检查 `settings.scoringPreference` 是否落档，没落档就问一次「简历评估方式：1 快速（默认——免费、速度快，关键词匹配，颗粒度较粗） 2 精细（AI 逐份读简历工作内容打分，更准并附匹配依据，消耗模型积分/token）」，选择写入档案（跳过/拒绝 → 写 "fast"，不再追问；措辞与 AI-GUIDE「二」一致）。**档案=精细时顺序强制**：screener → **llm-batch 精细评估（五·一节）** → report.js——未完成评估时 report 退出码 6 拒出报告（`SCREENER_FORCE_FAST=1` 单次降级）。
1. **用户只给岗位名** → 先跑 `node <skill>/scripts/joblist.js --json` 查已发布岗位（匹配规则：精确 → 唯一子串，与 run.js matchProfile 同款）：命中 → 用岗位字段（名称/城市/薪资）+ `_user.json` 背景 + `references/job-profile-guide.md` 起草画像，**列出要点等用户确认**再跑；未命中/多个 → 列出在招岗位让用户挑；列表拿不到（退出码 5）或为空 → 降级为下面的描述流程，不阻塞
2. 按 `references/job-profile-guide.md` 生成 `<项目根>/profiles/<岗位名>.json`（skill 外部）
3. 告知运行命令（或让用户直接双击项目根的 `run.bat`，见「统一入口 run.bat」节）
4. 执行筛选 → 出 Excel 推荐报告（含直达简历链接与建议话术）

## 三、快速开始

### 步骤 0：环境要求

- Node.js ≥ 20，本机已安装 Chrome/Chromium
- 关闭 VPN/代理（**猎聘封锁境外 IP**；脚本会自动剥离代理环境变量）
- 依赖 `exceljs`（首次使用需在项目根执行 `npm install exceljs`，或直接双击项目根 `setup.bat`）

### 步骤 1：安装 liepin-cli

禁止 `npm install -g`（本机策略会拦截）。装到项目内或托管工作区：

```bash
mkdir -p ~/.workbuddy/binaries/node/workspace   # 托管工作区（路径按各自机器为准）
cd ~/.workbuddy/binaries/node/workspace
npm install @viyzhu/liepin-cli proxy-agent@6.5.0 \
  --registry=https://registry.npmmirror.com --noproxy "*"
```

> 已知坑：镜像源的 `@puppeteer/browsers` 下会有一个残缺的嵌套 `proxy-agent`（缺 `dist/index.js`），导致 `liepin --version` 报错。解法是先删掉两个 proxy-agent 目录，再装 `proxy-agent@6.5.0` 到顶层。
> **版本要求 ≥ 0.2.6**：0.2.4 起自带 `safeGoto` 规避 CDP 检测；**0.2.6 起修掉了会导致账号被判「行为异常」的登录循环（issue #21）**——旧版 `login` 每次都重启浏览器，而会话 cookie（`is_persistent=0`）随浏览器进程结束即失效，于是「重启 → 登出 → 重新扫码」自我强化，反复给猎聘喂「异常登录」信号。**低于 0.2.6 的版本必须升级**（升级方式见下方「版本自检」）。

> **装在哪里都行 —— CLI 路径是自动探测的**（`scripts/config.js` 的 `resolveLiepinBin()`）：
> `LIEPIN_BIN` 环境变量 → 运行目录的 `node_modules/.bin` → 脚本上级的 `node_modules/.bin`
> → 托管 node 工作区（`~/.workbuddy/binaries/node/workspace`）→ 系统 `PATH`。
> 想把整个项目打包发给别人，推荐**装到项目内的 `node_modules`**（自带依赖，不依赖对方机器路径）：
> ```bash
> cd <项目根>
> npm install exceljs @viyzhu/liepin-cli proxy-agent@6.5.0 --registry=https://registry.npmmirror.com
> ```
> Windows 用户可直接双击分发包里的 `setup.bat`，它会完成上述安装并处理 proxy-agent 坑。

> **版本自检（必查必升）**：`scripts/check-cli-update.js` 读取已装版本 → 查 registry 最新版 → 语义化比较。
> `screener.js` 每次启动自动检查，**不是最新版就直接升级**（用户铁律；升级失败只提示、不阻塞）。
> 仅应急时设 `LIEPIN_CLI_AUTOUPDATE=0` 关断。

### 步骤 2：登录（含 about:blank 故障处理）

```bash
export PATH="$HOME/.workbuddy/binaries/node/workspace/node_modules/.bin:$PATH"   # 或项目内 node_modules/.bin
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
liepin login      # 弹出浏览器扫码；登录招聘者端 lpt.liepin.com
liepin joblist    # 验证登录态（exit 0 = 正常）
```

**退出码语义**（脚本据此分支，不要解析报错文案）：
`0` 成功 · `1` 一般错误 · `2` 登录态失效（重新 login） · `3` 风控触发（**立即全停**）

> ⚠️ **例外：登录被频率闸拦下时退出码是 0，不是 3。** `liepin login` 被拦下时返回
> `{success:false, rate_limited:true}`，但 CLI 不检查 `.success`、也不设置退出码，退出码仍是 `0`。
> 所以判断登录结果**必须**用 `liepin login --json` 读 `rate_limited` / `reused` 字段，不能只看退出码。

> **🛡️ 登录频率闸（v0.2.6 起，防封号的核心机制）**
> - **第一道闸 · 复用**：`login` 会先探测现有登录态，仍有效则直接复用并返回 `reused:true`，**完全不碰浏览器**。
>   这是最重要的一道——把「误重登」从根上掐掉，因为重登才是风险动作本身。
> - **第二道闸 · 记账**：确需人工扫码时，按 `~/.liepin-cli/login-history.json` 记账，
>   **24 小时内超过 3 次交互式登录会被拦下**并提示还需等几小时。此闸只算「真·重新扫码」，复用不计入。
> - ⛔ **AI 绝对不要加 `--force`**——它会同时跳过上面两道闸。
> - **为什么这么严**：会话 cookie `_e_ld_auth_` / `XSRF-TOKEN` 都是 `is_persistent=0`，浏览器进程一结束就等于退出登录；
>   旧版 `login` 每次无条件重启浏览器，形成「重启 → 登出 → 重新扫码」的自我强化循环，正是账号被判「行为异常」的主因。
>   0.2.6 起 Windows 改用 WMI `Win32_Process.Create` 拉起浏览器（进程归 WmiPrvSE，脱离 Agent 宿主的
>   `KILL_ON_JOB_CLOSE` Job Object），才断掉这个循环；回退开关 `LIEPIN_SPAWN_BREAKAWAY=false`。
> - 重置记账（换机器 / 清理登录态）可删 `~/.liepin-cli/login-history.json`，**但这不等于绕过风控，别当免罚卡用**。

**若 `liepin login` 报「页面已被清空（about:blank）」**：这是猎聘安全脚本的 CDP 检测。
- 先 `liepin quit` 清理，再重试一次
- 仍复现 → 停止自动登录，改用**手动登录法**：
  ```bash
  "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    --user-data-dir="$HOME/.liepin-cli/user-data" \
    --no-first-run --no-default-browser-check "https://lpt.liepin.com"
  ```
  （.bat 里等价写法是 `--user-data-dir="%USERPROFILE%\.liepin-cli\user-data"`。）
  用户在窗口内手动扫码登录 → cookie 持久化到 user-data → 之后 CLI 命令直接复用，无需再扫。
  > 分发包里已附带 **`liepin-login.bat`**，用户双击即可，无需手敲命令。它会自动探测 Chrome/Edge
  > 安装位置，并以 `%USERPROFILE%\.liepin-cli\user-data` 作为配置目录 —— 通用、不写死机器路径。
  > 交付给他人时**务必把这个文件一起给过去**，否则对方极易踩"登录了但 CLI 说没登录"的坑。
- ⚠️ **登录窗口要保持开着，不要关闭**（2026-09-16 实测）：关闭窗口会导致会话失效，之后所有接口（含 joblist）都返回 `{"flag":0}`，必须重新登录。判别：若 `joblist` 曾正常、随后全部接口报 `flag:0`，属**会话失效**而非风控，重登即可。
- ✅ 正确做法：用带 `--remote-debugging-port=53471` 的方式启动（`liepin-login.bat` 已内置该参数）。CLI 会**复用这个浏览器实例**，同一会话内登录态稳定——不用关窗、不用二次握手，还能全程看到 CLI 在做什么。
- 若**不带**调试端口启动（旧做法），CLI 无法复用、会尝试自启实例并因 user-data 被占而失败（报"端口 53471 未就绪"），那时才需要先关窗口——但关窗更易触发登录态失效，不推荐。

> **⚠️⚠️ 手动登录法最大的坑：Chrome 换成了默认配置目录（2026-09-10 实锤）**
>
> **必须用上面那条带 `--user-data-dir` 的命令启动 Chrome。** 直接双击 Chrome 图标 / 从开始菜单打开，
> 会落到系统默认配置目录 `%LOCALAPPDATA%\Google\Chrome\User Data`，登录状态写进了**错误的目录**；
> 而 CLI 只读 `%USERPROFILE%\.liepin-cli\user-data`，于是永远报「登录态已失效（flag=0）」。
>
> **典型误诊**：用户说"我明明登录进后台了"，AI 反复让用户重登，问题照旧。
>
> **判定方法**（登录后关掉窗口，比较两个目录 cookie 的修改时间）：
> ```bash
> ls -la --time-style=full-iso "$HOME/.liepin-cli/user-data/Default/Network/Cookies"                    # CLI 读这个
> ls -la --time-style=full-iso "$HOME/AppData/Local/Google/Chrome/User Data/Default/Network/Cookies"   # 默认目录
> ```
> 时间戳更新的是**默认目录** → 就是踩了这个坑。
>
> **正解：做一个 .bat 启动器交给用户双击**（纯 ASCII 内容，避免编码问题；分发包已自带 `liepin-login.bat`，此处保留原理说明）：
> ```bat
> @echo off
> title Liepin Login (dedicated profile)
> start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%USERPROFILE%\.liepin-cli\user-data" --no-first-run --no-default-browser-check "https://lpt.liepin.com"
> exit
> ```
> 放桌面让用户双击 → 打开的窗口一定落在 CLI 专用目录，登录一次长期有效。
>
> **另一个坑：AI 不要自己用 shell 后台启动 Chrome。** 在 Agent 沙箱里 `nohup ... &` / `Start-Process`
> 拉起的 Chrome，会在工具调用返回时随子进程被回收 → 用户看到窗口"闪退"。
> GUI 登录窗口**必须由用户在资源管理器里双击 .bat 启动**，进程归用户所有才不会被回收。
>
> **验证专用目录是否真的生效**（启动后 10s，比较 `Local State` 的修改时间）：
> 只有 `.liepin-cli/user-data/Local State` 更新、默认目录不动，才算对。

### 步骤 3：配置岗位（岗位画像存放在 skill 外部）

**架构约定（重要）**：skill 包内**不存放任何岗位数据**——skill 是通用工具，岗位画像属于业务数据，统一放在项目根的 `profiles/` 目录（与 skill 文件夹同级），这样整体移动项目文件夹即可迁移。

```
<项目根>/
├── liepin-resume-screener/     # skill 工具包（通用，不含岗位数据）
└── profiles/                   # 岗位画像（业务数据，一个岗位一个 JSON）
    ├── _template.json          # 填写模板（字段带中文说明）
    ├── _user.json              # 用户背景档案（run.bat 首次引导生成；本地数据不入库不打包）
    └── example-销售经理.json    # 通用示例画像
```

**方式一 · 自然语言（推荐）**：把岗位要求告诉 AI，由 AI 按 `references/job-profile-guide.md` 生成 `profiles/<岗位名>.json`，运行时指定：

```bash
JOB_PROFILE="profiles/销售经理.json" node "<skill目录>/scripts/screener.js"
```

**方式二 · 填模板**：复制 `profiles/_template.json` 改名填写（字段带中文说明；可参考 `profiles/example-销售经理.json`）。

**方式三 · 改默认值**：直接编辑 `scripts/config.js`（仅单岗位长期使用；仍建议把岗位参数写进外部画像，保持工具可复用）。

> `JOB_PROFILE` 支持简写：只写 `profiles/xxx.json` 时，会依次在「当前目录 → skill 上级目录 → skill 目录」自动查找。
> 画像支持 `cities` 数组（多城市批量搜索，统一入口会逐城跑）与 `allowDuplicateRecommendations`（推荐去重开关）。
> 多岗位并行时用 `SCREENER_DATA_DIR` 隔离数据目录，避免候选池与去重库互相污染：
> ```bash
> JOB_PROFILE="profiles/A.json" SCREENER_DATA_DIR="./data-a" node "<skill>/scripts/screener.js"
> ```
> 完整转换规则与示例见 `references/job-profile-guide.md`。

#### 用户背景档案（profiles/_user.json）——生成画像前必读

用户的公司/行业背景记在 skill 外部的 `profiles/_user.json`（字段：`companyName` / `industry` / `businessSummary` / `commonCities[]` / `history[]`；由 run.bat 首次引导自动生成，或 AI 会话生成）。涉及画像生成或"我们是谁"类信息时：

1. **先读档案**（查找路径与 JOB_PROFILE 一致：当前目录 `profiles/` → skill 上两级 `profiles/` → skill 上级 `profiles/`）。不存在 → 向用户问一次公司名/行业/业务方向/常用城市，**确认后**写入 `profiles/_user.json`（`updatedAt` 记当前时间）。
2. **生成画像时**：`project` 缺省取 `companyName`；`greetTemplate` 写 `我们是{company}` 占位符（脚本在生成报告时替换为最终 project）；`scoring.industry` 维度种子词参考 `industry` / `businessSummary`；`city` / `cities` 缺省建议 `commonCities`。
3. **变更检测**：用户话语中的公司/行业与档案不一致（如换了公司、业务转向）→ **列出差异向用户确认，确认后才更新**档案，旧值追加进 `history[]`（含 `changedAt`）。绝不未经确认直接改写。**区分长期变更与单岗位调整**：用户明确说"我们/公司换行业了"这类长期表达 → 走本条更新档案；用户只说"**这个岗位**不限行业/跨行业招/重点看 XX 行业" → **只调整该岗位画像的 scoring.industry，不动档案**（画像本就优先于档案），也不要为此发起档案确认。
4. **优先级**：岗位画像字段 > 用户档案 > 内置默认。多公司/多项目场景在画像里显式写 `project` / `greetTemplate` 覆盖档案。
5. 档案缺失或 JSON 损坏时脚本静默回落内置默认——AI 不要因档案问题阻塞招聘任务，按第 1 条补建即可。
6. **settings 块（全局设置，如 `settings.workingWindow` 工作时间窗口）**：修改同样走"列出差异 → 用户确认 → 更新"契约，且有三条防护——①用户没主动提时间/窗口话题时**不得**主动改；②要改得比默认 08:00–20:00 更宽（起更早/收更晚/全天）时，必须复述"窗口越宽，自动化特征越明显，被平台风控注意到的风险越高"并**二次确认**；③任何修改都要在回复中回显新旧值供用户核对。格式非法（非 `HH:MM-HH:MM` 两个时刻）应拒绝写入并说明正确格式。
7. **换 AI 平台使用**：本项目的 AI 入口契约在 `AI-GUIDE.md`（权威源），各平台记忆文件由 `node ai-guide-sync.js <平台>` 同步（预设 workbuddy/doubao/claude/codex/cursor，注册表 `ai-guide-targets.json` 可扩展）。用户说"我要换 X 平台用"→ 查注册表；没有 X → 问一句"X 平台的 AI 自动读项目里哪个文件？"→ `node ai-guide-sync.js --add X=<路径>` 注册并同步。
8. **可选补充问（不新增字段）**：四项问完确认后，可再问一句可选补充——「还有什么想补充的背景吗？如主要产品、目标客户、招聘偏好（没有则跳过）」。补充内容以「；补充：<内容>」并入 `businessSummary` 末尾（原方向为空时写「补充：<内容>」）；跳过则不再追问。run.bat 引导（`--setup-user`）同口径。
9. **平台记忆只是预填建议**：AI 平台自身记忆（全局记忆/其他会话摘要）里的用户背景**只能当预填建议**——逐项向用户复述、确认后才可写入档案；用户说「沿用之前的」也必须逐项过一遍。示例话术：「我在其他会话里记得你的公司是讯流国际（跨境物流）。档案『公司/项目名』填『讯流国际』、『所属行业』填『跨境物流』，对吗？业务方向和常用招聘城市也请逐项确认一下。」（契约原文见 `AI-GUIDE.md` 第二节）
10. **历史文件保留期（`settings.retentionDays`，v2.11.0）**：用户说「历史文件保留改成 N 天 / 把自动清理关掉」→ **复述新值确认后**改 `settings.retentionDays`（非负整数天，`0`=关断，默认 1）。清理范围与永不清理清单见 AI-GUIDE「三·八」（报告、去重索引、配额账本永不清理）；改完下次启动生效。格式非法（非非负整数）应拒绝写入并说明正确格式。

### 步骤 4：运行（AI 会话内手动命令；一键入口见下方「统一入口 run.bat」节）

```bash
cd <你的工作目录>                        # 数据目录默认生成在这里
export JOB_PROFILE="profiles/<岗位名>.json"   # 三个脚本都要传！见下方警告
export SCREENER_REPORTS_DIR="./reports"       # v2.9.2：手动跑 report.js 必带（run.js 会自动设）——不设报告会落数据目录深处，用户难找
node "<skill目录>/scripts/screener.js"   # 全量：搜索 + 简历详情 + 打分
node "<skill目录>/scripts/report.js"     # 生成 Excel 推荐报告
node "<skill目录>/scripts/show-scores.js" # 终端打印评分明细
node "<skill目录>/scripts/check-cli-update.js"              # 检查；有新版本则自动升级（默认）
node "<skill目录>/scripts/check-cli-update.js" --check-only # 只检查不升级（手动排查）
node "<skill目录>/scripts/cleanup.js"           # 历史文件统一清理（v2.11.0）：按 settings.retentionDays（默认 1 天，0=关断）清过期日志/简历缓存/结果缓存；--days N 单次指定保留期 / --dry 只计数不实删。报告、去重索引、配额账本永不清理
```

> ⚠️ **`JOB_PROFILE` 必须对 report.js 也生效**（用 `export` 或每个命令前都带上）。
> 只给 screener.js 传的话，报告**标题、文件名、话术**会全部回退成 `config.js` 里的默认岗位
> （历史坑：筛的是 A 岗位，报告却叫 B 岗位推荐报告）。

报告落点与文件名：

- 默认落在**数据目录**下的 `reports/`（不设 `SCREENER_REPORTS_DIR` 时，保持旧行为）。
- 设 `SCREENER_REPORTS_DIR` 后统一收集到指定目录——统一入口 run.js 会把它指到**项目根 `reports/`**。
- 文件名格式：`YYYY-MM-DD_猎聘_<岗位名>_推荐报告.xlsx`（平台标签取画像/配置的 `platformLabel`，默认"猎聘"）。

常用环境变量：

| 变量 | 作用 | 示例 |
|---|---|---|
| `KW_GROUPS` | 只跑指定关键词组（序号，逗号分隔） | `KW_GROUPS="2"` |
| `RESUME_LIMIT` | 覆盖单次简历详情上限 | `RESUME_LIMIT=15` |
| `JOB_PROFILE` | 指定岗位画像 JSON（多岗位切换） | `JOB_PROFILE="profiles/销售经理.json"` |
| `SCREENER_DATA_DIR` | 指定数据目录（默认 = 当前工作目录） | 多岗位隔离时用 |
| `SCREENER_REPORTS_DIR` | 指定报告输出目录（默认 = 数据目录下 `reports/`） | 统一入口传项目根 `reports/` |
| `SCREENER_CITY` | 覆盖画像的城市（多城市跑同一画像，免复制画像） | `SCREENER_CITY=上海` |
| `SCREENER_ALLOW_DUPLICATES` | 推荐去重开关（最高优先；`1`=允许重复 / `0`=强制去重） | `SCREENER_ALLOW_DUPLICATES=1` |
| `SCREENER_GLOBAL_QUOTA_DIR` | 全局浏览配额记账目录（run.bat 自动传项目根 `data/_quota/`；AI 手动跑建议也传） | `SCREENER_GLOBAL_QUOTA_DIR=<项目根>/data/_quota` |
| `SCREENER_GLOBAL_DAILY_VIEWS` | 全局每日浏览硬顶覆盖（>0 整数；默认 1000） | `SCREENER_GLOBAL_DAILY_VIEWS=500` |
| `SCREENER_WORKING_WINDOW` | 工作时间窗口覆盖（`HH:MM-HH:MM`；默认 08:00-20:00，按本地时间） | `SCREENER_WORKING_WINDOW=09:00-18:00` |
| `SCREENER_ANYTIME` | `1` = 越过工作时间窗口（run.bat 的 `--anytime` 即此） | `SCREENER_ANYTIME=1` |
| `SCREENER_RETENTION_DAYS` | 历史文件保留天数（v2.11.0 统一清理）：优先级 env > `_user.json` 的 `settings.retentionDays` > 默认 `1`；`0` = 关断。报告、去重索引、配额账本永不清理（契约见 AI-GUIDE「三·八」） | `SCREENER_RETENTION_DAYS=7` |

其他模式：`node screener.js rescore` 基于本地简历缓存**零网络重算**（改打分模型后必用）。

### 三·八、统一入口 run.bat（推荐用户优先用）

项目根的 `run.bat` / `run.js` 是给使用者的一键入口：**双击后菜单选平台（猎聘 / BOSS直聘 / 都跑）→ 选岗位画像 → 自动自检（登录态、CLI、浏览器内核）→ 逐城市跑筛选 → rescore + 出报告**。

- 数据目录约定：run.js 自动设 `SCREENER_DATA_DIR=<项目根>/data/<岗位>/<平台>/`——简历缓存、拒访记录、`recommended-index.json` 都落在这里，**作用域天然 = 岗位 × 平台**。
- 报告统一落到项目根 `reports/`（run.js 传 `SCREENER_REPORTS_DIR`），跑完会列出本次新生成的报告。
- 画像里的 `cities` 数组会被逐城市执行（城市间自动休整）；也可 `--city=上海` 只跑指定城市。
- 常用参数：`run.bat liepin 销售经理 [--city=上海] [--limit N] [--kw 1,3] [--dup] [--report-only] [--from-published [岗位名]] [--anytime] [--dry-run]`；`--dup` 等价于 `SCREENER_ALLOW_DUPLICATES=1`，`--report-only` 基于本地缓存重算并出报告（不搜索），`--from-published` 见「三·九」，`--anytime` 越过工作时间窗口（见「六·七」）。岗位菜单里选 `0` 可从已发布岗位新建画像。
- **岗位是"点播"不是"订阅"**：每次运行只处理用户指定的那一个岗位，历史岗位不会自动重跑；用户要求"所有岗位都跑"时才逐个执行。重跑老岗位 = 增量模式（processed.json 已看过的人不再请求，recommended-index 已推荐的人不再进报告）；新岗位首次运行 = 全量。各岗位数据目录/去重/报告完全隔离，仅全局浏览额度共享（按画像总数均分，当天不跑的岗位也占分母，见「六·六」）。
- 登录：先双击 `liepin-login.bat` 扫码（**窗口保持开着**），run.bat 自检到登录失效时会提示。

**AI 会话内的手动 `node` 命令仍然保留**（见步骤 4）：skill 被单独复制到 `~/.workbuddy/skills/` 等位置、没有项目根 run.js 时，就用步骤 4 的手动命令，此时数据目录默认 = 当前工作目录。

### 三·九、已发布岗位直连（joblist）

用户只报岗位名即可开跑：工具读取平台上已发布的在招岗位做匹配，画像起草零手填。

- **脚本**：`node <skill>/scripts/joblist.js [--json] [--raw]`。退出码：`0` 成功（含 0 条）｜`2` 登录失效｜`3` 风控/配额｜`5` 输出格式未识别（跑 `--raw` 看原始输出，把结果交给维护者适配字段映射）。
- **归一化条目**：`{name, city, salary, status, jobId, source, raw}`（`--json` 时含 raw 原始字段供起草深挖）。⚠️ 键序为保守猜测（joblist 输出格式未实测），真机适配入口是 `--raw`。
- **匹配规则**（与 run.js matchProfile 同款）：精确名称 → 唯一子串；未命中/多个 → 列出在招岗位让用户挑；确实没有 → 走"描述岗位要求"新建，不阻塞。
- **画像草稿约定**：jobTitle=岗位名、city=列表城市（缺省回落 `_user.json` commonCities → 北京）、`greetTemplate` 用 `{company}` 占位符、**不写 scoring**（用内置默认）——草稿 `_说明` 里注明"建议让 AI 按岗位要求定制打分"。
- **数据敏感**：在招岗位清单（名称/城市/薪资）属于招聘策略，向外部（issue/群聊）粘贴时只贴字段适配所需的最小片段。
- joblist 调用消耗 1 次岗位请求配额、受工作时间窗口约束（`--anytime`/`SCREENER_ANYTIME=1` 可越过）。

## 四、工作流

```
预检（liepin joblist 低成本探测登录态）
  ↓
多关键词组搜索（组间随机 20–40s）→ 抽取候选池
  ↓ 长随机休息 60–150s
简历详情抓取（逐份随机 25–55s，每连看 5 份歇口气 60–180s，单次 ≤30 份，已缓存/已拒访跳过；全程刷新/登录环守护在线，详见六·八）
  ↓
四维打分（维度与权重由画像/配置决定；打分函数在 scripts/scoring.js）
  ↓
推荐去重（对照 recommended-index.json，已推荐过的只进"跳过"清单，见六·五节）
  ↓
Excel 推荐报告（含「直达简历」超链接列 + 建议话术列）
  ↓
用户在猎聘官网/App 手动点开 → 收藏 → 打招呼（粘贴话术）
```

## 五、打分模型

四维加权，满分 100（默认为**通用销售岗示例**：**销售领域 30 / 业绩表现 30 / 核心技能 25 / 行业背景 15**；实际岗位的维度、关键词、权重、分级全在画像/`config.js` 的 `scoring` / `gradeBands` 里覆盖）。

关键设计（避免误判，务必保留；实现在 `scripts/scoring.js`，`screener.js` 调用 `scoreResume(text, scoring, gradeBands)`）：
- **上下文维度需"关键词 + 上下文词"同句**才算强命中（如业绩维度：业绩词必须与"完成/达成/超额/回款"等 `contextWords` 同句）。只泛泛提相关词只给 `weakScore` 兜底分，防止"泛提即得分"误报。
- 分句按 `。[；;\n]` 切分，**不要按逗号切**（中文简历逗号密集，会把关键词与上下文词拆散）。
- 普通维度：规则命中累加，封顶该维度 `weight`。
- 分级：S ≥ 80，A ≥ 60，B ≥ 40，C < 40；**报告默认全量收录所有等级**（v2.9.1 起 `minReportGrade` 默认 "C"——2026-10-30 用户拍板「报告不要门槛，都放进来」），画像可钉 `"A"`/`"S"` 收紧。
- 改打分模型后跑 `screener.js rescore` 零网络重算。**注意**：若放宽了 `gradeBands`（如把 A 线从 60 降到 50），此前因等级不足被跳过的人会重新进入推荐报告——这是正常行为，不是去重失效（原理见六·五节）。

详细字段含义、调参方法与实测案例见 `references/scoring-model.md`。

### 五·一、精细评估（LLM 语义评估，v2.6.0 可选档）

**定位**：规则引擎（快速档）之外的评估方式，由 **AI 会话本身**（正在对话的模型）逐份读简历工作内容、
按画像标准打分并附原文依据。**不配置任何模型 API——用的就是当前会话的模型**。触发：档案
`settings.scoringPreference: "detailed"`（run.bat 首跑引导会问，回车默认快速），或用户当次明说（当次指令优先于档案偏好）。

**机器强制（v2.9.0，BUG-2026-10-30 P0 修复）**：档案=精细且本轮候选池未全部评估时，`report.js`
**退出码 6 拒绝出报告**（与档案 exit 4 同款纪律——「AI 会自觉跑 llm-batch」的假设已被 2026-10-30
实证证伪：选了精细的用户拿到的是全规则分且报告无标注）。本次显式降级：`SCREENER_FORCE_FAST=1`
（不改档案）。猎聘侧顺序强制为 screener → llm-batch 评估 → report；run.bat 双击路径在筛选完成后会
出现断点交互（停下交给 AI 评估 / 本次降级快速）。报告首行固定标注「评估方式：…」自证分数口径。

**取舍口径（告知用户的标准话术）**：快速=免费、秒级、关键词匹配颗粒度粗；精细=评估更准并附
匹配依据，消耗模型积分/token（每份简历约 3k token 量级，20 份一轮 ≈ 10 万级）。

**流程（契约在工具侧 `scripts/llm-batch.js`，执行在会话侧——工具不做任何模型调用）**：
1. 前置：`data/<岗位>/<平台>/data/last-results.json` 存在（先跑完筛选）
2. `node <skill>/scripts/llm-batch.js status` 看进度
3. `node <skill>/scripts/llm-batch.js next` → stdout 纯 JSON：进度 + 评估标准 + 一批简历全文
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
| `reports/YYYY-MM-DD_猎聘_<岗位>_推荐报告.xlsx` | 主表：排名/等级/评分/姓名/**直达简历（超链接）**/公司/职位/城市/多维命中明细/来源关键词/建议话术；若本次有因重复被跳过的候选人，第二工作表**「已推荐过(本次跳过)」**列出跳过明细 |

**报告落点**：默认 = 数据目录下 `reports/`；统一入口 run.js 传 `SCREENER_REPORTS_DIR` 收集到项目根 `reports/`（见步骤 4）。

**「直达简历」链接格式**：`https://lpt.liepin.com/cvview/showresumedetail?resIdEncode=<resume_id>`
（搜索返回的原始数据自带 `url` 字段，含来源埋点参数；也可用上述精简式，已验证 HTTP 200 可达）。
猎聘链接为**稳定直链、无需刷新**；BOSS 侧因平台无稳定直链，报告链接走搜索直达（见
`boss-resume-screener/SKILL.md`「六、输出物」的链接定案），**两侧链接形态不同属有意不对称**。

**使用前提**（必须告知用户）：
1. 点链接前浏览器需已登录猎聘招聘者账号，否则跳登录页
2. 建议在电脑端操作（简历页 → 收藏 → 打招呼 → 粘贴话术）
3. 节奏控制在真人水平：看完一份再打一个，每天 20–40 人为正常 HR 区间

## 六·五、推荐去重（recommended-index.json）

**语义**：同一岗位同一候选人**只进一次推荐报告**。已在索引里的人，本次即使再次被搜到并达标，也不会重复进报告，而是进第二工作表「已推荐过(本次跳过)」并在控制台打印跳过明细。

- **位置**：数据目录根下的 `recommended-index.json`（`SCREENER_DATA_DIR` 或当前工作目录；统一入口 run.js 下即 `<项目根>/data/<岗位>/<平台>/recommended-index.json`）。
- **作用域 = 数据目录 = 岗位 × 平台**：换岗位或换平台互不影响；手动跑时若没设 `SCREENER_DATA_DIR`，作用域就是当前工作目录。
- **键**：`<platform>:<候选人ID>`（如 `liepin:123456`），写入时附岗位与时间戳。
- **与 screener 去重缓存职责正交**：`data/processed.json` 防"重复请求网络"（省配额），本索引防"重复推荐"（防打扰）。

**三级开关**（优先级从高到低）：
1. 环境变量 `SCREENER_ALLOW_DUPLICATES=1/0`（**最高优先**；`1`=允许重复 / `0`=强制去重；run.bat 的 `--dup` 即 `=1`）
2. 画像字段 `allowDuplicateRecommendations`（`true`=允许重复）
3. `config.js` 默认 `false`（去重开启）

**如何重置去重记录**：
- 连简历缓存一起清：删除整个数据目录（`data/<岗位>/<平台>/`）。
- 只清推荐记录、保留缓存：**只删 `recommended-index.json`** 一个文件即可，下次报告从空索引重建。
- 索引文件损坏时脚本会自动把它隔离为 `recommended-index.corrupt-<时间戳>.json` 并从空索引重建（控制台有警告）。

**放宽 gradeBands 后旧 B 升 A 会重新出现，属正常**：索引只记"已进过推荐报告"的人；此前因 `minReportGrade`/分级不足被跳过的人**从未入索引**，放宽标准后他们第一次达标，自然会出现在报告里。不要误判为去重失效。

## 六·六、全局浏览配额（每日每平台 1000 份硬顶，多岗位均分）

跨岗位共享的"成功浏览简历"日配额，防止单个账号一天看太多简历：

- **记账**：`data/_quota/liepin.json`（schema `{date, resumeViews, cap, updatedAt, perJob:{<岗位>:份数}}`；目录可由 `SCREENER_GLOBAL_QUOTA_DIR` 指定，默认按 cwd/skill 相对位置解析）。**只计成功浏览的简历详情**：缓存命中、无权限被拒、搜索请求都不占额度。
- **硬顶**：每平台每日 1000 份（`config.globalMaxResumeViewsPerDay`，env `SCREENER_GLOBAL_DAILY_VIEWS` 可调；画像不可覆盖此项）。到顶后简历阶段**软停止**（正常收尾出报告、退出码 0、次日自动清零）——与风控熔断（exit 3）是两回事，不要混淆。
- **均分**：run.bat 按公式 `份额 = 全局剩余 ÷ profiles/ 岗位画像总数` 给每岗位算当日预算（跨多次运行生效；**新增画像自动参与重分**），并把 `min(单轮默认上限, 份额剩余)` 作为 `RESUME_LIMIT` 传给 screener。份额用尽 → 跳过筛选直接出报告。
- **AI 手动串岗位时**：按同款公式算 RESUME_LIMIT（`剩余 = 1000 - 今日已浏览`，查 `data/_quota/liepin.json` 的 perJob 得该岗位已用量；画像有 `dailyResumeQuota` 则以它为该岗位日限，仍受全局硬顶）。
- **口径说明**：翻日按 UTC 0 点（北京时间早 8 点），与 quota.json 一致；同平台不要并行开两个窗口跑（记账会互相覆盖）。
- 与每岗位 `data/quota.json`（请求计数）是两层：全局管浏览硬顶，岗位管请求兜底。

## 六·七、工作时间窗口（默认 8:00–20:00，降低自动化识别风险）

工具默认只在每天 **8:00–20:00（按用户电脑的本地时钟）** 执行搜索/看简历；离线操作（rescore/report/--report-only/--setup-user/--dry-run）不受限。

- **双层执行**：run.bat 启动时**硬拦截**（窗外直接退出并提示下次窗口）；screener 运行中**软停止**（到点正常收尾出报告、退出码 0——与风控熔断 exit 3 是两回事，不要混淆；搜索与简历阶段都检查）。
- **越过**：`run.bat --anytime` 或 env `SCREENER_ANYTIME=1`（自动化识别风险自担）。
- **修改**（优先级从高到低）：env `SCREENER_WORKING_WINDOW=HH:MM-HH:MM` → `profiles/_user.json` 的 `settings.workingWindow` → 默认 08:00-20:00。**画像里写 workingWindow 无效**（风控类全局项，强制回钉）。非法值一律回落默认并 warn。
- **边界语义**：起始时刻含（8:00:00 可跑），结束时刻不含（20:00:00 整点即停）。支持跨午夜窗口（如 `22:00-06:00`）。AI 修改窗口的契约见「用户背景档案」节的 settings 规则。
- 注意：配额翻日按 UTC（北京时间早 8 点），窗口按本地钟——两者口径不同属正常。

## 六·八、风控守护（刷新/登录环立即停 + 本地风控锁）与浏览节奏

2026-10-27 猎聘风控事故（单轮浏览 20 份、第 15 份触发风控，WorkBuddy 诊断=浏览频率过高；风控期间网页频繁自动刷新）后引入，两部分配套：

**① 刷新/登录环守护（`scripts/refresh-guard.js`，两侧镜像）**

- **机制**：screener 预检通过后，用 CDP（`LIEPIN_CDP_URL`，默认 `http://127.0.0.1:53471`，即 liepin-login.bat 开的常驻浏览器）**只读侦听**所有 liepin.com 标签的主帧导航（仅 `Page.enable` + 收事件，不发任何输入/请求）。两种信号**触发即立即全停**：
  - **刷新风暴**：20 秒滑窗内主帧导航 ≥ 6 次（正常节奏远低于此——简历间 ≥25s、搜索间 ≥20s；秒级连发只可能是风控刷新环）；
  - **登录环**：任意被监听标签落到登录页特征 URL（/login、passport、/web/user 等；正常运行中绝不应出现）。
- **停止语义**：触发即在事件回调里 `process.exit(3)`（exit 3 = 熔断族，run.bat 会基于本地缓存重算出报告）；CLI 同步调用阻塞事件循环时，在当前命令返回后的第一个事件循环点生效（正常几秒内）。
- **机器强制（铁律 9）**：CDP 连不上 = 守护失效 = 拒绝开跑（预检直接报错）；测试环境 `SCREENER_SKIP_REFRESH_GUARD=1` 跳过。需 Node ≥ 22（原生 WebSocket）。
- **本地风控锁**：守护触发、或 CLI 报退出码 3（平台风控）时，写 `data/_quota/liepin.risk-lock.json`；**带锁启动直接拒跑**。解锁 = 人工在浏览器确认账号恢复正常（能手动搜索/浏览）、冷却一段时间后**删除该锁文件**。锁是本地纪律：重试不会解除平台侧风控，防的是"带热度重跑"。
- AI 会话遇到锁/守护触发：如实告知用户原因与解锁路径，**不要代删锁文件、不要绕过**；用户明确说账号已恢复并要求解锁时，删锁文件即可。

**② 浏览节奏放缓（猎聘侧）**

`config.js` 默认间隔（画像可覆盖，但节奏是风控调参，改前想清楚）：

| 间隔 | 旧值 | 新值（2.6.1 起） |
|---|---|---|
| 简历间 `betweenResumes` | 10–25s | **25–55s** |
| 搜索间 `betweenSearches` | 15–30s | 20–40s |
| 阶段切换 `longBreak` | 30–90s | 60–150s |
| 歇口气 `restBreak`（新增） | — | 60–180s，每连续成功浏览 `restEvery`（默认 5）份触发一次 |



| 现象 | 原因 | 解法 |
|---|---|---|
| 退出码 4：`profiles/_user.json 不存在` | 背景档案门槛（v2.3.2 起为前置条件，防"没问背景就开跑"） | 按提示问四项建档案后重跑；用户不想答就写空档案；测试环境 `SCREENER_SKIP_USER_CONTEXT=1` |
| `[窗口] …提前收尾/在窗口之外` | 工作时间窗口到点或窗外运行（六·七） | 属正常软停止（退出码 0），下次窗口自动恢复；急用加 `--anytime`；改窗口见 `_user.json` settings |
| `浏览器启动超时：端口 53471 未就绪` | 有 Chrome 实例占用 CLI 的 user-data 目录，且未开调试端口 | 改用 `liepin-login.bat`（已带 `--remote-debugging-port=53471`）启动，CLI 即可直接复用 |
| **关窗后所有接口返回 `flag=0`** | 关闭登录窗口导致会话失效（2026-09-16 实测） | 用 `liepin-login.bat` 重登，**登录后保持窗口开着**再跑命令 |
| 登录时页面变 about:blank | 猎聘安全脚本 CDP 检测 | 见"步骤 2"手动登录法 |
| 用户已登录后台，CLI 仍报 `flag=0` 登录态失效 | Chrome 走了系统默认配置目录，登录状态没写进 CLI 专用目录 | 用带 `--user-data-dir` 的 .bat 启动器重登；比对两目录 cookie 时间戳 |
| AI 拉起的登录窗口"闪退" | Agent 沙箱 shell 的子进程随命令返回被回收 | GUI 窗口交给用户双击 .bat 启动，AI 不要自己后台拉起 |
| **累计 30–40 次请求后全部接口返回 `flag:0`** | 会话触发频率限制（2026-09-16 实测 38 次后；2026-09-03 约 30 次后，模式一致） | 立即停止本次会话，隔时段再跑；**单次会话建议控制在 30–40 请求内**，分批进行 |
| `liepin login` 提示「已拦下这次登录：过去 24 小时内已经登录 N 次」 | 触发登录频率闸（上限 3 次/24h，v0.2.6 起） | **这是正常保护，不要加 `--force`**。等提示的小时数过去再登；优先用 `liepin-login.bat` 复用会话 |
| 分不清登录到底成没成功 | 被闸门拦下时退出码仍是 `0`，与"登录成功"无法区分 | 用 `liepin login --json`，看 `rate_limited`（被拦）与 `reused`（复用了现有会话）字段 |
| 用户反馈"又让我重登" | AI 反复要求重登，属典型误诊（见步骤 2「手动登录法」的坑） | 先按步骤 2 的 cookie 时间戳判定法定位真因，**不要靠反复重登试错** |
| 退出码 2 / `{"flag":0}` | 登录态失效 | `liepin login` 重新登录 |
| 退出码 3 | 风控触发 | **全停**，人工在浏览器完成验证后再评估；2.6.1 起同时落本地风控锁（见六·八），解锁=确认账号恢复后删 `data/_quota/liepin.risk-lock.json` |
| `[风控守护] ⚠️ refresh-storm / login-page …立即停止` | 运行中出现频繁刷新或落到登录页（六·八守护触发，2026-10-27 事故后引入） | 属**有意立即全停**（exit 3）；按提示人工检查账号、冷却后删锁文件重跑；`SCREENER_SKIP_REFRESH_GUARD=1` 仅限测试 |
| 启动报「检测到本地风控锁」 | 上一轮风控信号留下的锁还没清 | 人工确认账号恢复正常+冷却后删除提示里的锁文件；**不要代删/绕过/反复重试** |
| 启动报「CDP 不可达…（守护是硬前置）」 | 常驻浏览器没开/端口不对，守护无法上线 | 用 `liepin-login.bat` 启动并保持窗口开着再跑；端口被改过就设 `LIEPIN_CDP_URL`；测试环境可 `SCREENER_SKIP_REFRESH_GUARD=1` |
| 简历详情返回"简历不存在/无权限" | 正常拒访（不在人才库/额度限制） | 记入 `data/denied.json` 跳过，**不计入错误**、不重试 |
| 搜索返回非 JSON | CLI 输出混有前后缀文本 | 用 `extractJson()` 容错抽取，不要直接 `JSON.parse` |
| 简历详情不是 JSON | liepin-cli 的 resume 输出是 `key: value` 文本 | 用 `parseResumeText()` 正则抽取字段，全文参与打分 |
| 报告里候选人比上次少、控制台提示"已跳过 N 条已推荐过" | 推荐去重命中（同一岗位同一候选人只推荐一次） | 正常行为；确需重复推荐见六·五节三级开关，或删数据目录/`recommended-index.json` 重置 |

## 七·五、打包分发给他人复用（链式：A → B → C）

项目根的 `pack-release.js` 按**白名单**把可分发的文件收进一个 zip：

```bash
cd <项目根>
node pack-release.js
# → release/resume-screener-<版本>.zip
node pack-release.js --out "D:/somewhere"       # 自定义输出目录
node pack-release.js --version 1.0.3            # 不改源码就换版本号（链式分发用）
```

Windows 用户可直接双击 `pack-release.bat`（等价于 `node pack-release.js`，同样支持 `--version`）。

**打进包的**（白名单收集，打包时脚本会打印完整清单）：

| 路径 | 说明 |
|---|---|
| `liepin-resume-screener/` | 猎聘 skill 工具包：SKILL.md + references/ + scripts/ |
| `boss-resume-screener/` | BOSS直聘 skill 工具包（同构） |
| `profiles/` | **仅 `_template.json` + `example-*.json` 通用示例**（走允许名单）；真实岗位画像一律不进包 |
| `run.bat` / `run.js` | 统一双击入口（选平台+岗位、自检、逐城市跑、出报告） |
| `setup.bat` | 一键装依赖（猎聘 + BOSS 双平台，含 proxy-agent 已知坑处理） |
| `liepin-login.bat` | 猎聘登录启动器：自动探测 Chrome/Edge，配置目录取 `%USERPROFILE%\.liepin-cli\user-data`，通用不写死路径 |
| `boss-edge-login.bat` / `boss-zhipin-login.bat` | BOSS 登录启动器（Edge / Chrome + 调试端口） |
| `pack-release.js` | **打包脚本本体** —— 必须进包，否则无法链式分发（原因见下方 ⚠️） |
| `pack-release.bat` | 打包脚本的双击启动器 |
| `AI-GUIDE.md` / `ai-guide-sync.js` / `ai-guide-targets.json` | AI 会话契约权威源 + 同步器 + 平台注册表（新平台接入用，见 README） |
| `package.json` | 根依赖清单（exceljs） |
| `README.md` | 使用说明（三步走：setup → 登录 → run.bat） |
| `CLAUDE.md` / `.gitignore` | AI 助手的开发/使用约定 / 防止运行数据被误提交 git |

**绝不进包的**：`data/`、`reports/`、`logs/`、`node_modules/`、`release/`，以及 **`profiles/` 里除模板与 `example-*` 之外的所有真实岗位画像** —— 前三者含**真实候选人数据**，岗位画像含**在招岗位与搜索策略**。
白名单 + `EXCLUDE_NAMES` 双重保险，这些目录即使存在也不会被外带。

> ⚠️ **`profiles/` 必须用「允许名单」而不是「黑名单」**（`pack-release.js` 的 `PROFILES_ALLOWLIST`，默认只放 `_template.json` 与 `example-` 开头的示例）。
> 真实画像按 `profiles/<岗位名>.json` 命名、没有固定规律，用黑名单逐个排除迟早会漏；
> 允许名单则保证**新增任何岗位画像都会被自动挡住**，无需回头改打包脚本。
> 设计意图：**打包出去的是「工具」，不是「你的招聘策略」。**

> zip 由脚本内置的写入器生成（Node 原生 `zlib`，零第三方依赖），文件名按 UTF-8 写入并置 bit 11
> 标志位，中文文件名在 Windows 资源管理器 / macOS / Linux 下解压均正常。

**⚠️ 链式分发（A → B → C）—— 这是 `pack-release.js` 必须进包的原因**

包是**可再分发**的：同事 A 用一段时间后，能自己再打一个同样干净的包转给 B，B 再转给 C，
不必回头找原始分发者。**前提是 `pack-release.js` 在包里**（2026-10-08 补入，此前漏了）。

- 缺了它，A 只剩「右键压缩整个文件夹」一条路，而那个文件夹里躺着
  **A 的真实岗位画像 + `data*/` 候选人简历缓存 + `reports/` 含真实姓名的报告 + `logs/`**，
  一并发出去就是**泄露候选人个人信息 + 交出招聘策略**。
- 所以交付文档（`README.md` / `CLAUDE.md`）里都写明：
  **转发必须走打包脚本，绝不要右键压缩整个文件夹。**
- 对方重打包：双击 `pack-release.bat`，或 `node pack-release.js --version 1.0.3`。
- 链式分发**不会逐层带脏数据**：打包是白名单收集，`walk()` 只遍历两个 skill 目录与 `profiles/`，
  A 那台机器上的 `data-xxx/` 这类**自定义命名**数据目录根本不会被遍历到。
- 换 `--version` 只是便于区分"是谁传的那一版"，不换也能用（新旧包会同名，仅靠时间戳区分）。

**对方拿到后的顺序**：解压 → 先看 `README.md` → 双击 `setup.bat` 装依赖 → 双击 `liepin-login.bat`
扫码登录（⚠️ **窗口保持开着，关窗会话立即失效**）→ 双击 `run.bat` 选平台与岗位跑筛选；
或把 `liepin-resume-screener/` 交给自己的 AI（复制到 `~/.workbuddy/skills/`，或在对话里给出该目录的绝对路径）→ 在对话里说岗位要求。

---

## 八、存放位置与迁移

**推荐布局**（整体放在非系统盘的项目文件夹，想搬就整个搬）：

```
<项目根>\                          ← 你的项目文件夹（可整体移动）
├── liepin-resume-screener\        ← 猎聘 skill 工具包（不含任何岗位数据）
├── boss-resume-screener\          ← BOSS直聘 skill 工具包（同构）
├── profiles\                      ← 岗位画像（你的业务数据）
│   ├── _template.json
│   └── example-销售经理.json       ← 通用示例；真实画像自建，勿外发
├── data\<岗位>\<平台>\             ← 各岗位运行数据（run.js 自动生成）
├── reports\                       ← 报告输出（run.js 统一收集到这）
├── run.bat / run.js               ← 统一入口
├── setup.bat                      ← 双平台依赖安装
├── liepin-login.bat               ← 猎聘登录启动器
├── boss-edge-login.bat / boss-zhipin-login.bat ← BOSS 登录启动器
├── pack-release.js / pack-release.bat ← 打包分发
└── package.json / README.md / CLAUDE.md / .gitignore
```

使用步骤：

1. 在项目根目录执行 `npm install exceljs`（或双击 `setup.bat` 一次性装好双平台依赖）
2. 指定岗位画像运行：`JOB_PROFILE="profiles/xxx.json" node "liepin-resume-screener/scripts/screener.js"`；或直接双击 `run.bat`
3. `data/`（统一入口下为 `data/<岗位>/<平台>/`）与 `reports/` 自动生成；多岗位用 `SCREENER_DATA_DIR` 分开
4. **迁移**：直接移动整个项目文件夹，无需改动任何配置

> 无需把 skill 安装到系统 skills 目录。使用时在对话里指明 skill 路径即可；单独复制到 `~/.workbuddy/skills/` 也能用（此时用步骤 4 的手动命令）。

**数据纪律**：简历缓存与导出文件仅本地保存，不得公开分享或二次分发。

## 九、提示词入口（用户可直接说）

- 「跑一轮猎聘筛选」→ 全量搜索 + 打分 + 出报告（最省事：让用户双击项目根 `run.bat`）
- 「**我招〈岗位名〉，帮我筛**」（只报名字）→ 已发布岗位直连（三·九）：joblist 匹配 → 起草画像 → 确认即跑
- 「**列一下我在猎聘上在招的岗位**」→ `node <skill>/scripts/joblist.js`（人读表格；`--json` 机器可读）
- 「**把工作时间窗口改成 9 点到 18 点**」→ 确认后改 `profiles/_user.json` 的 `settings.workingWindow`（更宽需二次确认，见「用户背景档案」节第 6 条）
- 「**历史文件保留改成 7 天** / **把自动清理关掉**」→ 确认后改 `profiles/_user.json` 的 `settings.retentionDays`（默认 1 天，`0`=关断；见「用户背景档案」节第 10 条与 AI-GUIDE「三·八」）
- 「**我有个新岗位要筛：〈岗位描述〉**」→ 按 `references/job-profile-guide.md` 生成 `profiles/<岗位名>.json`，并给出运行命令
- 「切换到〈岗位名〉岗位」→ 用对应 `JOB_PROFILE` 运行
- 「同时跑 A、B 两个岗位」→ 各自 `JOB_PROFILE` + `SCREENER_DATA_DIR` 隔离数据
- 「只跑第 2 组关键词」→ `KW_GROUPS="2"`
- 「多跑几个城市」→ 画像里加 `cities` 数组（统一入口会逐城跑），或 `SCREENER_CITY=上海`
- 「看看今天筛出来的候选人评分明细」→ `node <skill>/scripts/show-scores.js`
- 「调整打分模型：把某维度权重提高 / 加上 XX 关键词」→ 改 profile 或 `config.js` 后跑 `rescore`（零网络）
- 「这个候选人上次已经推荐过了，别再推」→ 推荐去重默认开启（六·五节）；确需重复推荐设 `SCREENER_ALLOW_DUPLICATES=1` 或用 run.bat `--dup`
- 「清空推荐记录，重新出一版报告」→ 删数据目录下的 `recommended-index.json`（只清去重，不动简历缓存）
- 「给这批候选人的打招呼话术」→ 从报告"建议话术"列复制（仅供用户手动粘贴）
- 「登录态失效了」→ 按步骤 2 重新登录（含 about:blank 预案）
- 「登录被拦下了 / 提示 24 小时内超过 3 次」→ 这是防封号闸门在正常工作，**不要加 `--force`**；等窗口过去，或直接用 `liepin-login.bat` 复用现有会话
- 「检查一下 liepin-cli 有没有新版本 / 帮我更新」→ `node <skill>/scripts/check-cli-update.js`（默认检查并自动升级；只查不升加 `--check-only`）
- 「打一个分发包给别人用 / 转给下一个同事」→ `node <项目根>/pack-release.js [--version x.y.z]`（Windows 可双击 `pack-release.bat`），产出 `release/*.zip`；
  **必须走脚本，不要右键压缩整个文件夹**（会带出真实岗位画像与候选人数据）。包本身可再分发，A→B→C 都走同一条路。

## 十、目录结构与参考文档

```
liepin-resume-screener/            # 工具包（通用，不含岗位数据）
├── SKILL.md                       # 本文件
├── references/                    # 策略 / 打分模型 / 岗位画像指南
└── scripts/
    ├── screener.js                # 编排器：搜索 → 简历详情 → 打分（含 CLI 版本自检；打分调 scoring.js）
    ├── scoring.js                 # 打分函数 scoreResume(text, scoring, gradeBands)——平台/岗位无关，参数化
    ├── config.js                  # 默认配置（中性示例岗位）+ CLI 路径自动探测 + JOB_PROFILE/环境变量合并
    ├── report.js                  # Excel 推荐报告 + 推荐去重索引 recommended-index.json 读写
    ├── show-scores.js             # 终端打印评分明细
    ├── joblist.js                 # 读取猎聘已发布岗位（在招职位）——已发布岗位直连入口（三·九）
    ├── working-window.js          # 工作时间窗口纯函数（六·七；三处镜像之一）
    ├── cleanup.js                 # 历史文件统一清理（保留期 settings.retentionDays，默认 1 天；两侧镜像）
    └── check-cli-update.js        # liepin-cli 版本检查 / 更新

<项目根>/profiles/                 # 岗位数据（skill 外部，随项目文件夹迁移）
├── _template.json                 # 填写模板
├── example-销售经理.json           # 通用示例画像
└── <岗位名>.json                  # 每个岗位一个画像（真实画像自建，勿外发）

<项目根>/                          # 统一入口与分发相关
├── run.bat / run.js               # 统一入口（推荐用户双击使用）
├── setup.bat                      # 双平台一键装依赖
├── liepin-login.bat               # 猎聘登录启动器（通用，不写死路径）
├── boss-edge-login.bat / boss-zhipin-login.bat  # BOSS 登录启动器
├── pack-release.js                # 打包脚本 → release/*.zip（自身进包，支持链式分发）
├── pack-release.bat               # 打包脚本的双击启动器
├── package.json / README.md / CLAUDE.md / .gitignore
```

- `references/strategy.md` — 完整平台策略与风险事实清单（猎聘 + BOSS 使用策略、红线、量级控制、处罚梯度）
- `references/scoring-model.md` — 打分模型详解与调参指南
- `references/job-profile-guide.md` — **岗位画像指南**：自然语言 → 画像字段的转换规则、完整示例、多岗位并行用法
