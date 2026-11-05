// 刷新/登录环守护 —— 常驻浏览器 CDP 只读侦听（2026-10-27 猎聘风控事故引入，两侧镜像）
//
// 事故与拍板（2026-10-27）：猎聘单轮浏览 20 份简历，第 15 份触发平台风控（WorkBuddy 诊断=浏览
// 频率过高）；且风控期间观察到网页频繁自动刷新。用户拍板：自动化运行中一旦出现「频繁刷新」
// 或「落到登录页」，立即停止全部自动化（不等当前批次跑完），并落本地风控锁防止带热度重跑。
//
// 侦听原理（纯只读红线：只 Page.enable + 收事件，不发任何输入/导航/请求）：
//   连接 CLI 常驻浏览器的 CDP 端口，attach 所有平台标签，监听主帧导航（Page.frameNavigated）：
//     1. 刷新风暴：NAV_WINDOW_MS 滑窗内主帧导航 ≥ NAV_LIMIT 次。正常节奏远低于此
//        （简历间 ≥25s、搜索间 ≥20s，单次 CLI 动作内部至多 1–3 次导航），秒级连发只可能是刷新环；
//     2. 登录环：任意被监听标签的主帧 URL 命中登录页特征（/login、passport、/web/user 等）。
//        正常运行中绝不应出现在登录页；CLI 退出码 2 的登录失效是另一条独立防线，互为补充。
//   触发即：写平台级风控锁（<lockDir>/<平台>.risk-lock.json）→ 控制台+日志告警 → process.exit(3)。
//   exit 在事件回调里直接执行；CLI 同步调用（execSync）阻塞事件循环时，会在当前命令返回后的
//   第一个事件循环点生效（正常几秒内）——「立马停止」按此语义如实文档化。
//
// 解锁：锁只是本地纪律（平台侧风控不受它控制，重试不会解除）。人工在浏览器确认账号恢复正常
//   （能手动搜索/浏览简历）、冷却一段时间后，删除锁文件即可；BOSS 侧另有 CLI 自己的
//   cdp_risk_lock，两把锁都要清。
//
// 开关：SCREENER_SKIP_REFRESH_GUARD=1 仅限测试环境跳过（默认机器强制，铁律 9）。
const fs = require("fs");
const path = require("path");

// ---- 平台参数（boss 侧镜像文件只改这三行）----
const PLATFORM = "liepin";
const DEFAULT_CDP = process.env.LIEPIN_CDP_URL || "http://127.0.0.1:53471";
const HOST_MATCH = "liepin.com"; // 被 attach 的标签：URL 含平台域名的 page target

// ---- 阈值（两侧一致；调整前先想清楚铁律 3：这是风控调参）----
const LOGIN_RE = /login|passport|signin|\/web\/user/i; // 登录页特征（两平台取并集，保持镜像零差异）
const NAV_WINDOW_MS = 20000; // 刷新风暴判定滑窗
const NAV_LIMIT = 6; // 滑窗内主帧导航数阈值（正常节奏最多 2–3 次，刷新环是秒级连发）
const RESCAN_EVERY_MS = 10000; // tick() 里重扫新标签的节流间隔（CLI 开新标签后自动跟上）
const KEEP_MS = 120000; // 导航时间线的保留时长（滑窗外仍留作日志上下文）

class RiskSignalError extends Error {} // tick() 检查点抛出（触发路径通常已直接 process.exit，双保险）

// ---------- 风控锁（平台级，跨岗位共享；目录由调用方传全局配额同款目录）----------
function lockPath(dir) {
  return path.join(dir, `${PLATFORM}.risk-lock.json`);
}

function readRiskLock(dir) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(dir), "utf8"));
  } catch {
    return null;
  }
}

function writeRiskLock(dir, reason, detail) {
  const rec = {
    locked: true,
    platform: PLATFORM,
    reason: reason || "",
    detail: String(detail || "").slice(0, 500),
    at: new Date().toISOString(),
    unlockedBy: "人工确认账号恢复正常并冷却后，删除本文件",
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath(dir), JSON.stringify(rec, null, 2));
  } catch (e) {
    console.warn(`[风控守护] 锁文件写盘失败（${e.message}）——停止逻辑不受影响`);
  }
  return rec;
}

// ---------- 纯函数（导出供测试）----------
/** 滑窗内导航计数：now 时刻往回 windowMs 内的时间线条目数 */
function countRecent(navs, now, windowMs = NAV_WINDOW_MS) {
  return navs.filter((n) => now - n.t < windowMs).length;
}

// ---------- 守护实例 ----------
/**
 * @param {object} p { lockDir, logger?, note? }  lockDir=全局配额同款目录；note 默认 console.log
 * @returns {{start:Function, tick:Function, stop:Function, tripped:object|null}}
 *  start：CDP 不可达直接抛错（机器强制）；无平台标签则告警并持续重扫（CLI 可能尚未开页）
 *  tick ：命令边界/休息切片调用；已触发则抛 RiskSignalError，顺带节流重扫新标签
 *  stop ：结束时关全部 WebSocket（不关会挂住进程退出）
 */
function createGuard({ lockDir, logger = null, note = (s) => console.log(s) } = {}) {
  const log = (s) => {
    note(s);
    if (logger) logger.append(s + "\n");
  };

  let tripped = null; // {reason, detail, at}
  const sockets = new Map(); // targetId -> WebSocket
  let navs = []; // {t, url} 全部被监听标签的主帧导航时间线（跨标签合并：风暴常跨标签）
  let lastScan = 0;
  let warnedNoTab = false;

  function trigger(reason, detail) {
    if (tripped) return;
    tripped = { reason, detail, at: new Date().toISOString() };
    writeRiskLock(lockDir, reason, detail);
    log(`\n[风控守护] ⚠️ ${reason} —— 立即停止全部自动化（exit 3）。${detail}`);
    log(`[风控守护] 已落本地风控锁：${lockPath(lockDir)}`);
    log(`[风控守护] 解锁：人工在浏览器确认账号恢复正常（能手动搜索/浏览）、冷却后删除上述锁文件再重跑；不要反复重试。`);
    process.exit(3); // 事件回调里直接退出，不等当前批次
  }

  function onNav(url, tabId) {
    if (tripped) return;
    const now = Date.now();
    navs.push({ t: now, url });
    navs = navs.filter((n) => now - n.t < KEEP_MS);
    if (LOGIN_RE.test(url)) {
      trigger("login-page", `标签(${tabId})落到登录页：${url}`);
      return;
    }
    const n = countRecent(navs, now);
    if (n >= NAV_LIMIT) {
      const recent = navs.slice(-NAV_LIMIT).map((x) => x.url).join(" | ");
      trigger("refresh-storm", `${n} 次主帧导航/${NAV_WINDOW_MS / 1000}s（阈值 ${NAV_LIMIT}）：${recent.slice(0, 400)}`);
    }
  }

  function attach(target) {
    if (sockets.has(target.id)) return;
    let ws;
    try {
      ws = new WebSocket(target.webSocketDebuggerUrl);
    } catch {
      return; // 单个标签 attach 失败不影响其余（重扫会再试）
    }
    sockets.set(target.id, ws);
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: "Page.enable" })); // 只订阅事件，不发任何输入
      } catch { /* 连接已断则等重扫 */ }
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.method === "Page.frameNavigated" && m.params && m.params.frame && !m.params.frame.parentId) {
          onNav(String(m.params.frame.url || ""), m.sessionId || target.id);
        }
      } catch { /* 非 JSON 帧忽略 */ }
    };
    ws.onclose = () => sockets.delete(target.id);
    ws.onerror = () => sockets.delete(target.id);
  }

  /** 重扫 /json：返回平台标签数（含已在监听的）；不可达时抛错 */
  async function scan() {
    const targets = await (
      await fetch(`${DEFAULT_CDP}/json`, { signal: AbortSignal.timeout(5000) })
    ).json();
    const pages = (Array.isArray(targets) ? targets : []).filter(
      (t) => t && t.type === "page" && String(t.url || "").includes(HOST_MATCH)
    );
    for (const p of pages) {
      if (LOGIN_RE.test(String(p.url || ""))) {
        // 扫描点也查登录页：覆盖「启动时/重扫时页面已在登录页」的窗口期
        trigger("login-page", `标签(${p.id})位于登录页：${p.url}`);
        return pages.length;
      }
      attach(p);
    }
    return pages.length;
  }

  async function start() {
    if (typeof WebSocket === "undefined") {
      throw new Error("当前 Node 缺少原生 WebSocket（风控守护需 Node ≥ 22）。请升级 Node 后重跑");
    }
    let pages;
    try {
      pages = await scan();
    } catch {
      throw new Error(
        `CDP 不可达（${DEFAULT_CDP}）：常驻浏览器没开或端口不对。请用项目根的登录启动器启动并保持窗口开着（守护是硬前置，铁律 9；测试环境可 SCREENER_SKIP_REFRESH_GUARD=1 跳过）`
      );
    }
    if (pages === 0) {
      log(`[守护] 未发现 ${HOST_MATCH} 标签（CLI 可能尚未开页），将持续重扫…`);
    }
    log(`[守护] 刷新/登录环侦听已启动（CDP ${DEFAULT_CDP}，监听 ${Math.max(pages, sockets.size)} 个标签；风暴阈值 ${NAV_LIMIT} 次/${NAV_WINDOW_MS / 1000}s，登录页即刻停）`);
    lastScan = Date.now();
  }

  function tick() {
    if (tripped) {
      throw new RiskSignalError(`${tripped.reason}：${tripped.detail}（详见上方 [风控守护] 输出与锁文件）`);
    }
    if (Date.now() - lastScan >= RESCAN_EVERY_MS) {
      lastScan = Date.now();
      scan().catch(() => { /* 重扫失败静默：下个 tick 再试 */ });
      if (!warnedNoTab && sockets.size === 0) {
        warnedNoTab = true;
        log(`[守护] ⚠️ 仍未发现 ${HOST_MATCH} 标签——刷新/登录环侦听实际未生效（若 CLI 用其他通道工作会出现），已知悉继续`);
      }
    }
  }

  function stop() {
    for (const ws of sockets.values()) {
      try { ws.close(); } catch { /* ignore */ }
    }
    sockets.clear();
  }

  return {
    start,
    tick,
    stop,
    get tripped() { return tripped; },
  };
}

module.exports = {
  PLATFORM,
  DEFAULT_CDP,
  HOST_MATCH,
  RiskSignalError,
  lockPath,
  readRiskLock,
  writeRiskLock,
  countRecent,
  createGuard,
};
