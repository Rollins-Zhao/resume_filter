# boss-agent-cli 实测事实清单

> 本文件是 **BOSS 通道的"地面真相"**：所有条目均为 2026-10-15 在本机实测或从上游源码/文档直接读取，
> **不是推测**。改动本 skill 前先读这里，避免重新踩坑。
> 上游仓库：`github.com/can4hou6joeng4/boss-agent-cli`（默认分支 **`master`**，不是 main；MIT；Python ≥ 3.10）。

## 一、版本与安装

| 项 | 实测值 |
|---|---|
| 当前版本 | **v3.2.0**（2026-11-02 发布；2026-11-03 影响评估见「十一」，对本流程无破坏性影响） |
| 分发方式 | **PyPI**（`boss-agent-cli`），非 npm |
| 版本查询源 | `https://pypi.org/pypi/boss-agent-cli/json` → `info.version` |
| 可执行文件 | `boss`、`boss-mcp` |
| 本机落点 | `%USERPROFILE%\.local\bin\boss.exe` |
| 安装命令 | `uv tool install boss-agent-cli --index-url https://pypi.tuna.tsinghua.edu.cn/simple` |
| 版本输出 | `boss --version` → `boss, version 3.0.0` |
| optional extras | `crawl` / `dev` / `mcp`（排序：crawl, dev, mcp） |

**安装 uv 的坑**：清华镜像源**没有 uv 的 wheel**（`ERROR: Could not find a version that satisfies the requirement uv`），
必须走官方源 `python -m pip install uv`（本机成功装到 uv 0.13.1）。

**path 提示**：`uv tool install` 后若提示 `%USERPROFILE%\.local\bin is not on your PATH`，
**不必改系统 PATH** —— 本 skill 的脚本会自动探测该目录（`boss.js` / `config.js` 均实现）。

### 1.1 patchright 浏览器内核（⚠️ 实测大坑）

登录通道依赖 patchright 内核。官方安装命令在国内网络下**基本不可能成功**：

| 项 | 实测 |
|---|---|
| 官方命令 | `uv tool run --from boss-agent-cli patchright install chromium` |
| 下载源 | `cdn.playwright.dev` → 307 跳 `storage.googleapis.com` |
| 体积 | chromium ~196MB + headless shell ~115MB |
| 结果 | **反复 `Error: Download failed: server closed connection`**，进度 80~90% 断、重试从 0% 起，33 分钟未成功 |
| 根因 | CDN 链路不稳 + 官方下载器**不支持断点续传** |

**解法：走 npmmirror 镜像**（同版本，`Accept-Ranges: bytes` 支持续传，实测 **11 秒 / 17MB·s⁻¹**）：

```
https://cdn.npmmirror.com/binaries/chrome-for-testing/153.0.8010.12/win64/chrome-win64.zip
https://cdn.npmmirror.com/binaries/chrome-for-testing/153.0.8010.12/win64/chrome-headless-shell-win64.zip
```

**必须装两个内核** —— `headless=True` 用的是独立的 headless shell 包，不是 chromium 本体。
只装 chromium 会报 `Executable doesn't exist at ...chromium_headless_shell-1243\...`。

| 内核 | 目录名 | 可执行文件 |
|---|---|---|
| chromium | `chromium-1243` | `chrome-win64/chrome.exe` |
| headless shell | `chromium_headless_shell-1243` | `chrome-headless-shell-win64/chrome-headless-shell.exe` |

**目录名规则**（playwright core `registry/index.js`）：
`path.join(registryDirectory, name.replace(/-/g,"_") + "-" + revision)`
→ `chromium` → `chromium-1243`；`chromium-headless-shell` → `chromium_headless_shell-1243`。
（源码注释特别说明：浏览器目录名**不能含横线**，正是为避免前缀歧义。）

**标记文件**：落地后必须写 `INSTALLATION_COMPLETE`（内容任意版本文本即可），
否则 `downloadBrowserWithProgressBar` 仍会判定"未下载"并触发下载。
另 `DEPENDENCIES_VALIDATED` 用于跳过依赖复检。

**可执行路径模板**（`EXECUTABLE_PATHS["chromium"]["win-x64"]`，源码实测）：
`["chrome-win64", "chrome.exe"]` —— 解压后**不要**再套一层目录。

**版本号来源**：`patchright/driver/package/browsers.json` 里
`{name:"chromium", revision:"1243", browserVersion:"153.0.8010.12", title:"Chrome for Testing"}`。
升级 patchright 后 revision 会变，需同步更新镜像 URL 与目录名。

**验证就绪**：`boss doctor` 的 `patchright_chromium` 项 → 
`"已安装 patchright 所需修订版 chromium-1243 与 chromium_headless_shell-1243"`。

> **沙箱注意**：Agent 会话内直接运行 `chrome-headless-shell.exe` 会因**无 GPU** 触发
> `GPU process isn't usable. Goodbye.`（GPU 进程崩溃重试 6 次后自杀）。这是沙箱硬件限制，
> 用户本机不受影响。另注意 patchright `launch()` 本身**可成功**（`OK launch` / `OK closed`），
> 只有真正导航页面时才受 GPU 限制。

## 二、输出契约（最关键）

`boss schema --format native` 的 `data.conventions` 明确：

- **stdout：只有 JSON**（信封格式）
- **stderr：只有日志和进度**（`--log-level` 控制）
- **退出码：只有 `0`（ok=true）/ `1`（ok=false）**

信封结构（实测）：

```json
{
  "ok": true,
  "schema_version": "1.0",
  "command": "recruiter-candidates",
  "data": { ... },
  "pagination": null,
  "error": null,
  "hints": { "next_actions": [...], "operator_actions": [...] }
}
```

失败时 `error` 为：

```json
{"code": "AUTH_REQUIRED", "message": "未登录，请先执行 boss login",
 "recoverable": true, "recovery_action": "boss login"}
```

> ⚠️⚠️ **退出码陷阱（务必记住）**：未登录时 `boss hr candidates` 的退出码是 **1**，
> 与"一般错误""风控"**完全无法区分**。实测 `boss status` 与 `boss hr candidates` 未登录时
> 退出码均为 `1`。**必须读 `error.code`**。本 skill 的 `boss.js` 已按错误码分类，
> **切勿改成看退出码**。

**hints 双受众**：
- `hints.next_actions` —— 给 Agent 的后继命令
- `hints.operator_actions` —— 给真人的自然语言指引（TTY 下渲染到 stderr）

## 三、错误码分类（熔断依据 · 实测 52 个）

`boss schema` 的 `data.error_codes` 提供 52 个码，每项含 `recoverable` 与描述。

### 立即全停（`recoverable=false` 的风控类）
| 码 | 含义 |
|---|---|
| `ACCOUNT_RISK` | 风控拦截 |
| `ENVIRONMENT_RISK` | 访问环境存在异常 |
| `LOGIN_RISK_CONTROL` | 登录请求可能触发平台风控 |

### 需人工验证（立即终止）
| 码 | 含义 |
|---|---|
| `PLATFORM_VERIFICATION_REQUIRED` | 平台要求人工验证 |

### 登录类（可恢复 → 请用户登录）
`AUTH_REQUIRED`（未登录）、`AUTH_EXPIRED`、`LOGIN_EXPIRED`、`TOKEN_REFRESH_FAILED`

### 频率类（本轮停止）
`RATE_LIMITED`

### 正常拒访（跳过，不计错误）
`RESUME_NOT_FOUND`、`RESUME_NOT_SHARED`、`RECRUITER_NOT_AUTHORIZED`

### 其他值得注意
- `ENVIRONMENT_RISK_LOCKED` —— CDP 风控锁（stoken 未变时本地拒绝，`recoverable=false`）
- `CDP_UNAVAILABLE` / `BROWSER_SESSION_NOT_FOUND` / `BROWSER_KERNEL_MISSING`
- `RECRUITER_CHAT_TAB_REQUIRED` —— 招聘者操作需 Chrome 已打开聊天页（chat/index）
- `NOT_SUPPORTED` / `PLATFORM_NOT_SUPPORTED` —— 能力未实现（如 CDP 下的附件下载）
- `INVALID_PARAM` —— 参数校验失败
- `GREET_LIMIT` / `ALREADY_GREETED` / `ALREADY_APPLIED` —— 涉及写操作，本 skill **不使用**

## 四、只读命令白名单（本 skill 只用这些）

| 命令 | 参数（实测自 `--help`） | 用途 |
|---|---|---|
| `boss status` | — | 登录态与健康检查（含 `checks` 数组） |
| `boss hr candidates <QUERY>` | `--city`（cityCode）`--job-id` `--experience` `--degree` `--age` `--school-level` `--activeness` `--source`（默认4）`--salary` `--select` `--page` | **搜候选人** |
| `boss hr resume <GEEK_ID>` | `--job-id` `--security-id` `--raw`（**禁带 `--exchange`**） | **看简历**（结构化） |
| `boss hr applications` | `--job-id` `--label-id`（0=全部/1=新招呼/2=沟通中）`--page` | 投递者列表 |
| `boss hr recommendations --job-id <encJobId>` | `--page`（required: job-id） | 推荐牛人 |
| `boss hr chat` / `boss hr chatmsg <friend_id>` | — | 沟通记录（只读） |
| `boss hr jobs list` | **未实测**（v2.3.0 加入；schema 证实 hr.jobs 存在，命令形态已验证可达鉴权层） | 在招岗位列表（`scripts/joblist.js` 用，见 SKILL.md「二·七」；适配入口 `--raw`） |
| `boss schema --format native` | — | 能力发现 |
| `boss doctor` | — | 环境诊断 |

**明确禁用**（写操作，红线）：
`hr greet`、`hr reply`、`hr request-resume`、`hr accept-resume`、`hr resume --exchange`、
`greet`、`batch-greet`、`apply`、`exchange`、`mark`。

**唯一允许的"写"**：`boss hr download-resume <friend_id> --message-id <mid> --output <path>`
—— 仅下载候选人**已发来**的附件；**不自动同意**请求（不用 `--yes`）。

## 五、招聘者能力边界（重要）

`boss schema` 的 `data.commands.hr.subcommands` 共 **13 个**：
`applications`、`resume`、`chat`、`chatmsg`、`last-messages`、`jobs`、`candidates`、
`reply`、`request-resume`、`accept-resume`、`download-resume`、`recommendations`、`greet`。

顶部命令共 **39 个**；`data.supported_recruiter_platforms` = `["zhipin-recruiter"]`（唯一）。

**结论**：HR 侧**有**候选人搜索（`candidates`）、简历查看（`resume`）、推荐牛人（`recommendations`）、
投递列表（`applications`）—— 本 skill 的四维筛选链路**完全可行**。

## 六、三段式数据流（BOSS 与猎聘的根本差异）

```
① boss hr candidates <kw> --city <code>
    → 候选人卡片列表（每张需含 geek_id / job_id / security_id）
② boss hr resume <geek_id> --job-id <jid> --security-id <sid>
    → 结构化 JSON
③ 扁平化 → 四维打分
```

上游 `commands/recruiter/candidates.py` 的 `hints.next_actions` 亦明确此顺序：
> `boss hr resume <geek_id> --job-id <id> --security-id <id> — 查看简历`

**`security_id` 是动态令牌**（上游 CHANGELOG 多处提到"动态 `securityId`"、令牌轮换），
因此**必须搜完即串行抓简历**，不能分批离线处理。

### ⚠️ `--city` 取值：求职者端与招聘者端不一致（实测坑）

同一个 CLI 里两条命令的 `--city` **取值域不同**，极易搞错：

| 命令 | 取值 | 依据（源码/帮助实测） |
|---|---|---|
| `boss search`（求职者端） | **中文城市名** | `commands/search.py` 帮助：「城市名称（如 北京、上海）」；第 132 行 `if city and city not in CITY_CODES: → INVALID_PARAM`，走白名单校验 |
| `boss hr candidates`（招聘者端） | **数字 cityCode** | `commands/recruiter/candidates.py` 帮助：「城市筛选（cityCode，如 101020100；-2=全国）」 |

`api/recruiter_client.py::search_geeks` 里 `city_code = city or "-2"` **直接**放进
`params["city"]` 和 `filters.region.cityCode`，**没有任何中文名→编码的翻译**。
而 `api/client.py::search_jobs`（求职者端）走的是 `endpoints.CITY_CODES.get(city)` —— 两者实现不同。

**cityCode 编码表**：CLI 内置 `endpoints.CITY_CODES`（来自 `api/boss.yaml` 的 `lookups.city`），
共 40 个主要城市，键是中文名、值是数字编码：

```
北京 101010100 / 上海 101020100 / 广州 101280100 / 深圳 101280600 / 杭州 101210100
成都 101270100 / 南京 101190100 / 武汉 101200100 / 西安 101110100 / 苏州 101190400
长沙 101250100 / 郑州 101180100 / 重庆 101040100 / 天津 101030100 / 合肥 101220100
厦门 101230200 / 济南 101120100 / 青岛 101120200 / 大连 101070200 / 宁波 101210400
福州 101230100 / 东莞 101281600 / 珠海 101280700 / 佛山 101280800 / 昆明 101290100
贵阳 101260100 / 太原 101100100 / 南昌 101240100 / 南宁 101300100 / 石家庄 101090100
哈尔滨 101050100 / 长春 101060100 / 沈阳 101070100 / 海口 101310100 / 兰州 101160100
乌鲁木齐 101130100 / 无锡 101190200 / 常州 101191100 / 温州 101210700 / 惠州 101280300
```

`-2` = 全国。

> 实测确认：传 `--city "深圳"` 和传 `--city "101280600"` 时，
> CLI 都**不报参数错误**（都先撞 `AUTH_REQUIRED`）—— 说明招聘者端**没有本地白名单校验**，
> 错误编码会被静默发给服务端、导致搜索空结果。因此**必须传对编码**，不能靠报错兜底。

本 skill 的 `config.js` 内置 `BOSS_CITY_CODE_MAP`（照抄上表），配置层只写中文名
（`bossCity`）即可，脚本自动算出 `bossCityCode`；表外城市回落到 `-2`。

### `hr resume` 解析后的字段结构
来源：上游 `services/resume_parser.py` 的 `parse_resume()`：

```
base:      { name, gender, age, degree, work_years, active_status, avatar }
expect:    { position, salary, city }
works:     [ { company, position, department, start, end, duration,
               responsibility, performance, keywords[] } ]
projects:  [ { name, role, start, end, duration, description, achievement } ]
education: [ { school, major, degree, start, end } ]
competitive: [ "..." ]   # 竞争力提示文案
```

本 skill 的 `flattenResume()` 会把以上字段（+ 兜底遍历未知字段）拼成全文参与打分，
`extractFields()` 抽取姓名/公司/职位/城市/年龄/学历用于报告展示。

## 七、内置节流（与猎聘最大差异之一）

上游 `api/throttle.py` 的 `RequestThrottle`：

- 默认间隔 `(1.5, 3.0)` 秒，**高斯分布**随机
- 5% 概率额外加 2–5s（模拟人的犹豫）
- **突发惩罚**：15s 内 ≥3 次请求 → 加 1.2–2.8s；45s 内 ≥6 次 → 加 4–7s
- 线程安全（加锁），并发调用也会被串行化

职位列表请求另有 **SQLite 持久预算**：普通 `search` 与 crawler 跨 CLI 进程串行预留 **5–10 秒**请求窗口。

**对本 skill 的含义**：CLI 已自带节流，但**不够免责**。本 skill 在其之上**再叠加**随机间隔
（搜索 20–40s / 简历 15–35s / 阶段切换 40–100s），是**双层兜底**。
→ **不要因为"CLI 有节流"就调快本 skill 的间隔**。

## 八、登录机制

- `boss login` —— 按平台选择链路；`boss status` 验证。
- 凭据加密：**Fernet + PBKDF2 机器绑定**，存本地 `~/.boss-agent/`。
- v3.0.0 **移除了 Browser Bridge daemon 与 Chrome 扩展**；
  浏览器通道默认降级链为 **CDP → headless**。
- 复用已有会话（不新建页面/不导航/不注入 Cookie）：
  ```bash
  boss --browser-source existing-browser --cdp-url http://localhost:9222 <cmd>
  ```
- `boss status` 返回 `checks` 数组，逐项诊断：
  `credential_file`、`auth_session`、`cookie_presence`、`wt2_presence`、`stoken_presence`、
  `stoken_freshness`、`auth_token_quality`、`login_preflight`、`cookie_completeness`、
  `candidate_search_health`、`candidate_detail_health`、`recruiter_read_health`。
  → **排查登录问题先看这个数组**，比反复重登高效。
- `wt2` 存在但 `__zp_stoken__` 缺失 = **部分登录态**；上游推荐用
  「Chrome CDP 远程调试端口 + `boss login --cdp`」修复。
- ⚠️ 上游明文声明：**CDP 只能用于本机可信环境，不得当作风控绕过通道**。

## 九、合规与风险（上游立场）

- `compliance` 段落：`operating_mode: assisted`，`sensitive_commands_blocked: false`，
  **当前版本所有已实现能力均可调用**（`COMPLIANCE_BLOCKED` 仅为历史码保留，不主动产生）。
  → 意味着 **CLI 层面不会替使用者拦截写操作**，红线**必须由本 skill 的编排层自己守住**。
- `docs/platform-risk.md` 要点：
  - 抓取页数/详情/重试/运行时必须有默认上限，**不得用 `0` 表示无限**。
  - 命中风险页或风险码 → 先存 checkpoint，继续需用户新动作。
  - Cookie / Token / `__zp_stoken__` / `security_id` / 真实个人信息
    **不得进入日志、错误、导出、fixture**。
  - 不得无界换通道重试。

## 十、实测命令记录（2026-10-15）

```bash
# 版本
boss --version                                  # → boss, version 3.0.0

# 未登录（退出码 1，错误码 AUTH_REQUIRED）
boss status                                     # ok=false, error.code=AUTH_REQUIRED
boss hr candidates "海外仓" --city 101280600      # ok=false, error.code=AUTH_REQUIRED

# 参数校验（不误判为风控）
boss hr candidates x --bogus-flag               # ok=false, error.code=INVALID_PARAM

# 能力发现
boss schema --format native                     # data.commands 39 项；hr.subcommands 13 项
```

> 以上均在本机执行并记录。`hr candidates` / `hr resume` 的**成功返回结构**
> 需登录招聘者账号后实测确认；本 skill 已按 `parse_resume()` 的字段定义做多键兼容，
> 首次真实运行后如有字段差异，按 `references` 与上游源码校准，**不要猜**。

## 十一、v3.2.0 影响评估（2026-11-03 实测考证，结论：无破坏性影响）

上游 v3.1.0 → v3.2.0（2026-11-02 发布，19 提交）逐项对照本 skill 依赖面：

| 3.2.0 变更 | 对本 skill 的影响 |
|---|---|
| `--experience`/`--salary`/`--education`/`--industry` 码表修正（原标签整体错位一档） | **无影响**。改的是**求职者端** `search`/preset/watch 的「标签→码」表；本 skill 走 `hr candidates`，实测 3.2.0 帮助原文 `--experience 如 -3,-3（应届）/ -1,-1（不限）`、`--degree 201,201`、`--salary -1,3`、`--city -2=全国` 与 v3.0.0 **一字未变**（招聘者端逗号码直传平台，另一套体系）。且当前无画像启用这些筛选参数 |
| 确定性缺陷改报 `INTERNAL_ERROR`（不再 `NETWORK_ERROR`，不可恢复） | **无需改代码**。boss.js 红线集合不含这两个码，screener 对两者同路处理（一般错误计数、连续 3 次熔断），行为等价 |
| 平台响应 null 字段归一化（`jobList`/`bossInfo` 等为 null 不再崩溃误报网络错误） | **净收益**（减少虚假错误计数） |
| 登录链：CDP 不可用时不再走 httpx QR 通道（原本就走不通）；`browser-cookie3>=0.20` 下限 | **无影响略改善**。本 skill 登录走 CDP（.bat 起浏览器 + `--cdp-url` 全局注入），依赖随 `uv tool upgrade` 自动带上 |
| `--city` 新增「全国=100010000」、嘉兴、徐州、香港（求职者端城市表） | **无影响**。`hr candidates --city` 帮助仍认可 `-2=全国`；本 skill 城市兜底 `-2` 保持有效（表外小城市如需精确可后续把 3 个新城补进 config.js 的 `BOSS_CITY_CODE_MAP`，非必须） |
| macOS 修复 ×2、`boss ai` 修复 ×2、Agent 集成文档改只读默认 | **不相关**（Windows + 不用 boss ai + 我们本就只读优先） |

**附带结论**：
- 搜索来源打招呼「假成功」bug（BUG-2026-10-29，本仓追踪）在 3.2.0 **未被触及**（无 greet 相关提交），v2.7.1 止血策略继续有效。
- `hr jobs list` 输出结构（v2.9.3 适配 3.1.0 的 `data.data[]`/`locationName`/`encryptId`）在 3.2.0 **未再变化**，适配仍有效。
- 本机升级无需类似猎聘 `liepin quit` 的动作：CLI 进程逐命令短命，浏览器由用户 .bat 常驻，升级不留旧实例。

**⚠️ 2026-11-04 修正（BUG-2026-11-03-boss-greet-UNVERIFIED）**：上表「无破坏性影响」仅对 3.1.0→3.2.0 的 **diff** 成立。**RequestBudget 跨进程预算层是 v3.1.0 引入**（`~/.boss-agent/request-budget.sqlite3`，任何两次 CLI 派发间隔 ≥30s、单进程等待上限 30s、限流反馈写 cooldown、租约在高斯等待期间被独占），greet 的「发送→回查」闭环从未在 3.1.0+ 上验证过，11-03 workbuddy 真机首撞：回查 `hr chat` 恒 REQUEST_BUDGET_EXHAUSTED → 恒 UNVERIFIED 不记账（发送实际送达）。我们 verify 节奏（3 次×5s 间隔×60s 进程超时）与预算 30s 间隔结构性不兼容，需改 greet.js 编排适应预算（详见 BUG 文档与修复记录）。
