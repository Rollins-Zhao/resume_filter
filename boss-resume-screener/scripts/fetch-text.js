// BOSS 在线简历「正文取回」模块 —— canvas 复制通道（2026-10-26 PoC 验证后产品化，v2.5.0）
//
// 背景（2026-10-26 定案）：平台下线旧简历接口后，boss-agent-cli v3.0.1 的 hr resume 只回骨架；
// 正文由前端 wasm 解密后直接画进 c-resume iframe 的 canvas，DOM 里永远没有文字；
// 平台给真人留的唯一文字出口 = 页面自绘选区 + copy 事件拦截（把解密文本塞进剪贴板）。
// 本模块复刻真人的「拖选整份简历 + Ctrl+C」手势，从本机剪贴板取回全文（PoC 实测 2297 字符/份）。
//
// 语义（用户 2026-10-26 拍板，写死不走开关）：
//   - BOSS 筛选默认取文：hr resume 成功后紧跟本模块，正文与骨架拼合进打分文本；
//   - 任何一步失败 → FatalError 立即中止本轮（不降级、不跳过——没有正文的打分没有参考意义）。
//   - Ctrl+A 在该页面无效（无全选机制，PoC 实证），选区只能靠拖拽手势建立；
//     拖选生效不依赖视觉滚动（iframe scrollY 全程 0，选区按手势逻辑扩展）。
// 红线：本模块只发送与真人等价的指针/键盘事件 + 读本机剪贴板；不解密、不碰密文、不伪造请求。
const { execFileSync } = require("child_process");
const { FatalError } = require("./boss");

const CDP_DEFAULT = "http://127.0.0.1:9333";
const POPUP_WAIT_MS = 15000; // 弹层出现上限（对齐 CLI 内部 15s 等待）
const CLOSE_WAIT_MS = 3000;
const DRAG_STEPS = 14; // 步数下限（v2.9.5 起实际步数按 scrollH 动态计算——固定 14 对长简历滚不到底）
const TEXT_MIN_LEN = 120; // 剪贴板正文低于此长度视为取文失败（正常简历全文 ≥ 数百字）

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(script) {
  // PowerShell 输出强制 UTF-8，与本模块按 utf8 解析的约定一致（同 boss.js 的 PYTHONUTF8 思路）
  // ⚠️ stdio 必须 ignore stdin：execFileSync 默认继承 stdin，PowerShell 在 stdin 为
  //    永不关闭的管道时会等待 EOF 不退出（2026-10-26 真机实测挂死 >2min）。
  return execFileSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 读剪贴板文本；safe 模式下失败/为空返回 ""（用于礼貌保存用户剪贴板，不参与失败判定） */
function readClipboard({ safe = false } = {}) {
  try {
    const out = ps("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw");
    return (out || "").replace(/\r\n$/, "");
  } catch (e) {
    if (safe) return "";
    throw new FatalError(`读取剪贴板失败（${String(e.message).slice(0, 120)}）`);
  }
}

function restoreClipboard(text) {
  if (!text) return; // 保存时就是空（用户剪贴板原本无文本/含非文本内容）→ 不恢复
  try {
    ps(`Set-Clipboard -Value ${JSON.stringify(text)}`);
  } catch {
    /* 恢复失败不影响主流程（礼貌性操作） */
  }
}

// ---------- CDP ----------
function cdpBase() {
  const url = (process.env.BOSS_CDP_URL || CDP_DEFAULT).replace(/\/+$/, "");
  return /^https?:\/\//.test(url) ? url : null;
}

async function attachChatPage() {
  if (typeof WebSocket === "undefined") {
    throw new FatalError("当前 Node 缺少原生 WebSocket（需 Node ≥ 22）。请升级 Node 后重跑");
  }
  const base = cdpBase();
  if (!base) {
    throw new FatalError(`BOSS_CDP_URL 配置无效（取文需要 CDP 登录浏览器）：${process.env.BOSS_CDP_URL || "(未设置)"}`);
  }
  let targets;
  try {
    targets = await (await fetch(base + "/json", { signal: AbortSignal.timeout(5000) })).json();
  } catch (e) {
    throw new FatalError(
      `CDP 不可达（${base}）：登录浏览器没开或端口不对。双击 boss-edge-login.bat（9333）或 boss-zhipin-login.bat（9222），并用 BOSS_CDP_URL 指对端口`
    );
  }
  const page = targets.find((t) => t.type === "page" && String(t.url || "").includes("zhipin.com/web/chat"));
  if (!page) {
    throw new FatalError("CDP 浏览器里没有沟通页。请在登录浏览器打开 https://www.zhipin.com/web/chat/index 并保持登录（v3.0.1 起看简历本就需要它）");
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new FatalError("CDP WebSocket 连接失败（浏览器可能刚关闭）"));
    }),
    sleep(5000).then(() => Promise.reject(new FatalError("CDP WebSocket 连接超时（5s）"))),
  ]);
  let id = 0;
  const pend = new Map();
  // v2.10.0：事件订阅（shot-capture 的 Network.responseReceived 监听用）。CDP 事件消息无 id、
  // 带 method 字段——原来只按 id 分发响应，事件被静默丢弃；on() 注册后一并路由。
  const evListeners = new Map();
  const on = (method, fn) => {
    if (!evListeners.has(method)) evListeners.set(method, new Set());
    evListeners.get(method).add(fn);
    return () => evListeners.get(method).delete(fn); // 取消订阅
  };
  const failAll = (msg) => {
    for (const fn of pend.values()) fn({ __connClosed: msg });
    pend.clear();
  };
  ws.onclose = () => failAll("CDP 连接已关闭（浏览器关闭或页面跳转）");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    } else if (m.method && evListeners.has(m.method)) {
      for (const fn of evListeners.get(m.method)) {
        try { fn(m.params || {}); } catch (err) { /* 监听器异常不炸连接 */ }
      }
    }
  };
  // 每次调用 10s 硬超时：连接异常时绝不无限挂起（2026-10-26 真机教训：等待点必须有界）
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pend.delete(i);
        rej(new FatalError(`CDP 调用超时（${method}）——浏览器无响应，中止`));
      }, 10000);
      pend.set(i, (m) => {
        clearTimeout(timer);
        if (m && m.__connClosed) rej(new FatalError(m.__connClosed));
        else res(m);
      });
      try {
        ws.send(JSON.stringify({ id: i, method, params }));
      } catch (e) {
        clearTimeout(timer);
        pend.delete(i);
        rej(new FatalError("CDP 发送失败（连接已断）"));
      }
    });
  const ev = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      throw new FatalError(
        "页面脚本执行异常：" + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || "").slice(0, 120)
      );
    }
    return r.result.result.value;
  };
  return { ws, call, ev, on };
}

// ---------- 页面侧脚本 ----------
// 官方沟通页自带 API（与 CLI v3.0.1 同款入口，勿改参数形态）
function openPopupJs(geekId, jobId, securityId) {
  const ids = { encryptGeekId: geekId, encryptUid: geekId, encryptJobId: jobId, encryptJid: jobId, securityId: securityId };
  return `(function(){
  var api = window.top && window.top.iBossRoot && window.top.iBossRoot.resume;
  if (!api || typeof api.newChatResumeViewer !== 'function') return 'NO_API';
  try { api.newChatResumeViewer(${JSON.stringify(ids)}, {from: 'new-chat', source: 1}); } catch (e) { return 'OPEN_FAIL:' + String(e).slice(0, 80); }
  return 'OK';
})()`;
}

// 弹层/画布几何（canvas 坐标换算到主页面视口坐标系，供 Input 派发用）。
// 附带滚动复位（可关）：弹层容器若停在上次拖选残留的滚动位置，起拖点会错位、只选中尾部片段
//（2026-10-26 真机实测：残留滚动下 197 字符尾部片段 vs 复位后 2297 字符全文）。
// v2.15.0（BUG-2026-11-05 P1-1）两处副作用收敛：
//   ① 复位改为可选（geoJs(false)）：滚动现在真写 .resume-detail.scrollTop——分段采集循环里
//      每段测几何若照旧归零，会把每段打回顶部（旧版"虚拟滚动不写 scrollTop"下归零是无操作，
//      平台改版后变成实害）；开弹层后的正式测量仍复位（默认 true）。
//   ② 删除 window.scrollBy(主页面)——frRect.top<0 的成因是弹层容器内部滚动把 iframe 推到视口
//      上方，滚整个沟通页是误伤（用户可见左侧会话列表整页跳动）；改为归零 .resume-detail
//      （祖先链复位，与 ① 同一动作）后重测。
const geoJs = (reset) => `(function(){
  var frs = document.querySelectorAll('iframe');
  var pending = 0;
  for (var i = 0; i < frs.length; i++) {
    var fr = frs[i];
    if ((fr.src || '').indexOf('c-resume') < 0) continue;
    var doc = fr.contentDocument;
    if (!doc) return { err: 'iframe 不可访问' };
    var cv = doc.querySelector('canvas');
    if (!cv) return { err: 'iframe 内无 canvas' };
    var el = fr, resetN = 0;
    if (${reset ? "true" : "false"}) {
      while (el && el !== document.body) {
        try { if (el.scrollHeight > el.clientHeight + 10 && el.scrollTop > 0) { el.scrollTop = 0; resetN++; } } catch (e) {}
        el = el.parentElement;
      }
    }
    var r = cv.getBoundingClientRect();
    var frRect = fr.getBoundingClientRect();
    // 2026-10-29 真机实证（BUG-2026-10-29-resume-popup-zero-geometry.md）：弹层刚插入时 iframe 可能
    // 仍是 0×0（布局未完成）——"有 canvas 即就绪"会返回 0×0 几何，起拖点落到 (0,1) 遮罩上把弹层点掉，
    // 第二轮即报「未找到 c-resume iframe」整轮熔断。尺寸未成形一律继续等（由 waitForCanvas 轮询到就绪/超时）。
    if (r.width < 300 || r.height < 100) { pending++; continue; }
    // ⚠️ 2026-10-27 真机实证：弹层内容被滚动过时 iframe 会跑到视口上方（实测 top=-607），
    //    此时起拖点 y 为负 → 鼠标事件落在可视区外 → 选区为空、Ctrl+C 不覆盖剪贴板
    //    （表现为"取文失败：剪贴板正文不完整"且内容还是用户原来的剪贴板）。
    //    v2.15.0：成因 = 弹层滚动容器（.resume-detail 祖先链）内部滚动——归零它（与复位同一
    //    动作，reset=false 时此处也做一次按需归零：起拖点在视口外比"跳一下"更致命）后重测，
    //    不再滚动整个主页面（window.scrollBy 误伤沟通页，BUG-2026-11-05 附带发现②）。
    if (frRect.top < 0) {
      var el2 = fr, r2 = 0;
      while (el2 && el2 !== document.body) {
        try { if (el2.scrollHeight > el2.clientHeight + 10 && el2.scrollTop > 0) { el2.scrollTop = 0; r2++; } } catch (e) {}
        el2 = el2.parentElement;
      }
      resetN += r2;
      frRect = fr.getBoundingClientRect();
    }
    return {
      x: Math.round(frRect.left + r.left + r.width / 2),
      topY: Math.round(frRect.top + r.top),
      canvasH: Math.round(r.height),
      // v2.9.5 缺口⑤（2026-10-30 完整性审计）：canvas 视口高（~897px）≠ 内容全高——长简历的
      // 教育经历/资格证书在最底部，固定 14 步×250px（~3.5k px）覆盖不到 → 尾部系统性截断。
      // 这里报「内容真实高度」：canvas 自身高（虚拟重绘型=视口高，整幅渲染型=全高）与各滚动
      // 祖先 scrollHeight 取最大，供 dragSelect 动态算步数。
      scrollH: Math.round(Math.max(cv.height || 0, (function(){
        var m = 0, el = cv;
        while (el && el !== doc.body) {
          try { if (el.scrollHeight > m) m = el.scrollHeight; } catch (e) {}
          el = el.parentElement;
        }
        try { if (doc.body && doc.body.scrollHeight > m) m = doc.body.scrollHeight; } catch (e) {}
        return m;
      })())),
      reset: resetN
    };
  }
  return { err: pending ? '画布尺寸为 0（弹层未完成布局）' : '未找到 c-resume iframe' };
})()`;
// 默认带复位（开弹层后的正式测量用）；滚动中途/分段循环用 geoJs(false)。
const GEO_JS = geoJs(true);

const DIALOG_JS = `(document.querySelectorAll('.new-chat-resume-dialog-main-ui').length > 0)`;

// 关闭弹层：点弹层自己的 .close-btn。
// ⚠️ 2026-10-27 真机实证：旧方案派发 Escape **已无效**（连按两次弹层仍在，直接堆成 2 层，
//    严格关层判定随即中止本轮）。当前前端每个 .new-chat-resume-dialog-main-ui 内含 1 个
//    .close-btn，调用其 click 后弹层节点被移除（实测 2 层 → 1 层）。Escape 仅作兜底保留。
const CLOSE_DIALOGS_JS = `(function(){
  var els = document.querySelectorAll('.new-chat-resume-dialog-main-ui');
  var clicked = 0;
  for (var i = els.length - 1; i >= 0; i--) {
    var b = els[i].querySelector('.close-btn');
    if (b) { try { b.click(); clicked++; } catch (e) {} }
  }
  return clicked;
})()`;

// ---------- 步骤 ----------
async function closePopupIfOpen(call, ev, { strict = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await ev(DIALOG_JS))) return;
    const clicked = await ev(CLOSE_DIALOGS_JS);
    if (!clicked) {
      // 兜底：老通道 Escape（万一某个版本 close-btn 不响应合成点击）
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    }
    const deadline = Date.now() + CLOSE_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(300);
      if (!(await ev(DIALOG_JS))) return;
    }
  }
  if (strict) throw new FatalError("简历弹层关闭失败（close-btn / Escape 均无效）——平台前端可能已变更，中止");
}

async function waitForCanvas(ev) {
  const deadline = Date.now() + POPUP_WAIT_MS;
  let geo = null;
  while (Date.now() < deadline) {
    geo = await ev(GEO_JS);
    if (!geo.err) return geo;
    await sleep(500);
  }
  throw new FatalError(`简历弹层 ${(POPUP_WAIT_MS / 1000)}s 内未就绪（${(geo && geo.err) || "超时"}）——可能页面改版或 securityId 失效，中止`);
}

/** v2.9.4 缺口④（2026-10-30 Edge 真机两次熔断实证）：窗口被完全遮挡（windowState 仍是 maximized）
 *  时浏览器按类最小化节流渲染——Input.dispatchMouseEvent 每事件 >10s，拖选（30+ 事件）必撞
 *  call() 的 10s 硬超时，而报错只说「浏览器无响应」不说为什么（restoreMinimizedWindow 只防
 *  minimized，防不住遮挡）。拖选前先发一次零副作用 mouseMoved 实测响应：超阈值即判定被节流，
 *  用可执行的原因明示后中止——不猜、不硬撞（已浏览简历都在缓存，恢复可见后重跑零损失）。
 *  实测基线：窗口可见时 17–18ms/次；被遮挡/最小化时 >5000ms/次。 */
async function assertInputResponsive(call, log, thresholdMs = 2000) {
  const t0 = Date.now();
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 300 });
  const ms = Date.now() - t0;
  if (ms > thresholdMs) {
    throw new FatalError(
      `浏览器渲染被节流（Input 事件 ${ms}ms，正常 <100ms）——登录窗口大概率被遮挡或切到后台。` +
        `请保持浏览器窗口可见（至少部分露出，别被全屏窗口完全盖住/最小化），再重新运行。` +
        `已浏览的简历都在本地缓存，重跑不会重复浏览、不浪费额度。`
    );
  }
  if (ms > 300 && log) log(`    [预检] Input 响应偏慢（${ms}ms）——若后续熔断，请检查浏览器窗口是否被遮挡`);
}

/** v2.9.7b 缺口⑤：分段拼接 v2——两种真机形态都处理（2026-10-31 用户抓出重复 bug 后重写）：
 *  ① 「后段整块已包含于已累积内容」→ 丢弃（滚轮未推进时从头复制的重复段，实测占比可达 60%+）；
 *  ② 「尾-头行级最大重叠」→ 去重拼接（正常推进段，行级匹配防字符错位）。
 *  返回 { text, merged, dropped }。 */
function mergeSegments(segments) {
  const clean = (segments || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!clean.length) return { text: "", merged: 0, dropped: 0 };
  const eq = (x, y) => x.trim() === y.trim();
  // b 的行序列是否作为连续块出现在 a 中（要求 b 至少 1 个非空行）
  const containsBlock = (a, b) => {
    if (!b.length || b.length > a.length) return false;
    if (!b.some((l) => l.trim())) return false;
    for (let s = 0; s + b.length <= a.length; s++) {
      let ok = true;
      for (let j = 0; j < b.length; j++) if (!eq(a[s + j], b[j])) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  };
  let accLines = clean[0].split("\n");
  let accNorm = clean[0].replace(/\s+/g, "");
  let merged = 0;
  let dropped = 0;
  for (let i = 1; i < clean.length; i++) {
    const bLines = clean[i].split("\n");
    if (containsBlock(accLines, bLines)) { dropped++; continue; } // 形态①：整段重复 → 丢
    // 形态①'：归一化子串包含（近似段逃逸——同内容但断行/空白差异 ±几十字符，2026-10-31 实测
    // 604 vs 609 两态）。仅对足够长的段启用（≥80 字符），防短通用段误丢。
    const bNorm = clean[i].replace(/\s+/g, "");
    if (bNorm.length >= 80 && accNorm.includes(bNorm)) { dropped++; continue; }
    let best = 0; // 形态②：尾-头最大重叠
    for (let k = Math.min(accLines.length, bLines.length); k >= 1; k--) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        const bL = bLines[j].trim();
        if (!bL || !eq(accLines[accLines.length - k + j], bL)) { ok = false; break; }
      }
      if (ok) { best = k; break; }
    }
    if (best > 0) { accLines = accLines.concat(bLines.slice(best)); merged++; }
    else {
      accLines = accLines.concat([""], bLines);
      accNorm += bNorm; // 直连时才增长归一化累积（丢弃/重叠分支内容已在内）
    }
    if (best > 0) accNorm += bLines.slice(best).join("").replace(/\s+/g, "");
  }
  return { text: accLines.join("\n").trim(), merged, dropped };
}

// 测高脚本（⚠ 与 GEO_JS 不同：**不复位滚动**）——预热/分段定位用。
// v2.15.0（BUG-2026-11-05 P0-3，正确性）：旧版读 iframe 文档的 scrollingElement——实测真正
// 滚动的是外层 .resume-detail（iframe 文档 scrollTop 恒 0、scrollHeight=简历全高），旧读法
// 拿不到真实滚动位置，「到底」只能靠高度收敛+屏数推断；平台若改容器内滚动/懒加载高度变化，
// 会继续拍同一屏而 OCR 去重后正文变短却不报错（静默丢内容）。改为优先读 .resume-detail
//（BOSS 当前结构），回退 iframe 文档（改版容错），多返回 clientH 供到底判定
// scrollTop+clientH>=scrollH-2。弹层消失时 .resume-detail 与 iframe 皆不可得 → err（调用方中止）。
const MEASURE_JS = `(function(){
  var sc = document.querySelector('.resume-detail');
  if (sc && sc.scrollHeight > 10) {
    return { scrollH: sc.scrollHeight, scrollTop: sc.scrollTop, clientH: sc.clientHeight };
  }
  var frs = document.querySelectorAll('iframe');
  for (var i = 0; i < frs.length; i++) {
    var fr = frs[i];
    if ((fr.src || '').indexOf('c-resume') < 0) continue;
    var doc = fr.contentDocument;
    if (!doc) return { err: 'iframe 不可访问' };
    var se = doc.scrollingElement || doc.documentElement || doc.body;
    return { scrollH: se ? se.scrollHeight : 0, scrollTop: se ? se.scrollTop : 0, clientH: se ? se.clientHeight : 0 };
  }
  return { err: '未找到 c-resume iframe' };
})()`;

/** 拖选配方（PoC 实证；按住左键从顶部往下，边移动边滚轮，逻辑选区会覆盖整份简历）
 *  ⚠️ 2026-10-27 真机实证：弹层容器 top 可能是负值（实测 -7，落在视口上方），
 *    起拖点若按 topY+6 计算会变成 y=-1 → 按压落在视口外、iframe 内建立不了选区，
 *    后续拖拽改选到底层页面（会话列表），Ctrl+C 复制回一堆聊天记录。故起点必须钳到视口内。 */
async function dragSelect(call, geo, startOffset = 6) {
  const x = geo.x;
  const y = Math.max(1, Math.max(geo.topY, 0) + startOffset);
  // v2.9.5：步数按 scrollH 动态计算（下限 14）。⚠ 2026-10-30 夜实证：scrollH 是「已渲染高」非
  // 真实内容高（canvas 懒渲染），取文完整性问题（缺口⑤）未解——两个仓促方案实测更差已回退，
  // 调查记录见记忆/BUG 文档，确定解待专项（分段拼接方案）。
  const viewH = geo.canvasH || 897;
  const steps = geo.scrollH
    ? Math.max(DRAG_STEPS, Math.ceil((geo.scrollH - viewH) / 250) + 2)
    : DRAG_STEPS;
  // 残留清理：上次会话异常中断可能把「按住」状态留在页面 → 先补一次释放（无按下时无害）
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(400); // 滚动复位后的重绘稳定等待
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(200);
  for (let k = 0; k < steps; k++) {
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y + 80, button: "left", buttons: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y: y + 80, deltaX: 0, deltaY: 250 });
    await sleep(160);
  }
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y + 200, button: "left", buttons: 1 });
  await sleep(150);
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: y + 200, button: "left", buttons: 0, clickCount: 1 });
  await sleep(300);
}

async function sendCopy(call) {
  await call("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "c", code: "KeyC", windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "c", code: "KeyC", windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 });
  await sleep(800);
}

// ---------- 主入口 ----------
/**
 * 取回一份候选人的在线简历全文。
 * @param {object} p {geekId, jobId, securityId, logger?, note?}
 * @returns {Promise<string>} 简历全文（成功浏览路径内调用，不额外计配额——同一次浏览动作）
 * 失败语义：任何一步不对抛 FatalError，由 screener 全停（用户拍板：不降级）。
 */
async function fetchResumeText({ geekId, jobId, securityId, logger = null, note = (s) => console.log(s) }) {
  const log = (s) => {
    note(s);
    if (logger) logger.append(s + "\n");
  };
  const { ws, call, ev } = await attachChatPage();
  try {
    // v2.9.4 缺口④前置探测：被遮挡/节流的浏览器拖选必超时，先实测一次再干活（~17ms 开销）
    await assertInputResponsive(call, log);
    // 0. 清理上一份可能残留的弹层（宽松关闭，残留会在下一步开新弹层前清场）
    await closePopupIfOpen(call, ev);
    // 0.5 页面滚回顶部：上次异常中断可能把底层页面/弹层留在滚动状态，拖选起点会落到视口外
    try {
      await ev("(window.scrollTo(0,0), document.documentElement.scrollTop=0, document.body.scrollTop=0, 'OK')");
    } catch {
      /* 复位失败不阻塞：GEO_JS 里还有一道按需复位 */
    }
    // 1. 开弹层（官方 API，与 CLI 同款）
    const opened = await ev(openPopupJs(geekId, jobId, securityId));
    if (opened === "NO_API") throw new FatalError("沟通页缺少 iBossRoot.resume API——平台前端可能已变更，中止");
    if (String(opened).startsWith("OPEN_FAIL")) throw new FatalError(`打开简历弹层失败（${opened}），中止`);
    // 2. 等弹层 + canvas 就绪；15s 未就绪先清场重开一次再等（2026-10-27 交接 R-03：
    //    securityId 动态令牌可能已轮换/弹层没弹出来，直接熔断太重。重开 = 同一动作的
    //    幂等重试（重调一次页面自带 API，等同用户再点一次），不额外请求平台接口；两次都失败才中止）
    let geo;
    try {
      geo = await waitForCanvas(ev);
    } catch (e1) {
      log("    [正文] 弹层 15s 未就绪，清场后重开一次再等…");
      await closePopupIfOpen(call, ev);
      const reopened = await ev(openPopupJs(geekId, jobId, securityId));
      if (reopened === "NO_API") throw new FatalError("沟通页缺少 iBossRoot.resume API——平台前端可能已变更，中止");
      if (String(reopened).startsWith("OPEN_FAIL")) throw new FatalError(`重开简历弹层失败（${reopened}），中止`);
      geo = await waitForCanvas(ev);
    }
    // 3. 礼貌保存用户剪贴板（文本；原本为空/非文本则不恢复）
    const savedClip = readClipboard({ safe: true });
    // 4-5. 拖选 + 复制 + 校验；**同一弹层内最多试 2 次**（不额外请求平台、不改变"失败即中止"语义）：
    //   2026-10-27 真机实测，弹层刚出现时画布可能尚未完成首帧，拖选会建立空选区、
    //   Ctrl+C 不覆盖剪贴板（读回的是用户原有剪贴板）——重测几何后重试一次即可。
    const validText = (s) => s.length >= TEXT_MIN_LEN && /(工作经历|项目经历|教育经历|实习经历|在校经历)/.test(s);
    // v2.9.7 缺口⑤确定解·分段采集：canvas 懒渲染 + 拖选中的重绘打断选区 = 单趟拖选非确定性
    //（同份简历出现过 815/408/9309 字符三态）。改为：无按键滚到底逼出全量渲染（scrollH 收敛）→
    // 逐视口段做**视口内短拖选**（不边选边滚，避开重绘打断）→ 行级重叠去重拼接（mergeSegments）。
    // 完整性信号：尾部模块标记（教育经历/荣誉/证书/技能/自评——渲染顺序在简历最尾）。
    // 代价：每段 ~2-3s，长简历每份多 ~10-25s（与总节奏的权衡见 config.intervals 注释）。
    const TAIL_MARK = /(教育经历|所获荣誉|资格证书|专业技能|自我评价|求职期望|在校经历)/;
    const viewH = geo.canvasH || 897;
    // A. 预热：无按键滚到底，等内容真实高度收敛（MEASURE_JS 不复位，不会把滚动打回去）
    let fullH = 0;
    let warmSame = 0;
    for (let i = 0; i < 60; i++) {
      await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: geo.x, y: Math.max(1, geo.topY + Math.min(400, Math.floor(viewH / 2))), deltaX: 0, deltaY: 500 });
      await sleep(180);
      const m = await ev(MEASURE_JS);
      const h = (m && m.scrollH) || 0;
      if (h <= fullH + 2) { if (++warmSame >= 2) break; } else warmSame = 0;
      fullH = Math.max(fullH, h);
    }
    // B.（v2.9.8 混合策略）先整趟拖选——大覆盖、快、历史上单趟最优可达 9k+ 字符；
    //    缺尾部模块标记时再分段补采（短简历的尾部模块常在分段里拿到），最终按「唯一非空行数」
    //    择优（不用原始字符数——重复内容会虚增长度，2026-10-31 用户抓出并实证）。
    const uniqueLines = (s) => new Set(String(s).split("\n").map((l) => l.trim()).filter(Boolean)).size;
    const wheelY = Math.max(1, geo.topY + Math.min(400, Math.floor(viewH / 2)));
    // 从预热停留的底部滚回顶部
    for (let i = 0; i < 10; i++) {
      await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: geo.x, y: wheelY, deltaX: 0, deltaY: -600 });
      await sleep(120);
    }
    await sleep(600);
    const gw = await ev(GEO_JS);
    if (gw && gw.err) throw new FatalError(`简历弹层几何不可用（${gw.err}），中止`);
    await dragSelect(call, gw, 6);
    await sendCopy(call);
    const wholeText = readClipboard().trim();
    log(`    [正文] 整趟拖选：${wholeText.length} 字符${TAIL_MARK.test(wholeText) ? "（含尾部模块标记）" : "（缺尾部标记 → 分段补采）"}`);
    let text = wholeText;
    let segInfo = "整趟";
    // C. 分段补采（虚拟滚动不写 scrollTop、滚轮推进会振荡——靠 mergeSegments 块包含去重 + 唯一行择优兜底）
    if (!TAIL_MARK.test(wholeText)) {
      const SEG_OVERLAP = 150;
      const step = Math.max(200, viewH - SEG_OVERLAP);
      const SEG_CAP = 8;
      const segs = [];
      for (let seg = 0; seg < SEG_CAP; seg++) {
        // v2.15.0：分段循环测几何不复位（geoJs(false)）——滚动真写 .resume-detail.scrollTop 后，
        // 照旧归零会把每段打回顶部（BUG-2026-11-05 P1-1；旧版"虚拟滚动不写 scrollTop"下是无操作）。
        const g = await ev(geoJs(false));
        if (g && g.err) throw new FatalError(`简历弹层几何不可用（${g.err}），中止`);
        // 视口内短拖选：按下 → 拉到本视口底部 → 释放（不边选边滚，避开重绘打断选区）
        const yTop = Math.max(1, g.topY + 6);
        const yBot = g.topY + viewH - 30;
        await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: g.x, y: yTop, button: "left", buttons: 0, clickCount: 1 });
        await sleep(250);
        await call("Input.dispatchMouseEvent", { type: "mousePressed", x: g.x, y: yTop, button: "left", buttons: 1, clickCount: 1 });
        await sleep(120);
        await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: g.x, y: yBot, button: "left", buttons: 1 });
        await sleep(120);
        await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: g.x, y: yBot, button: "left", buttons: 0, clickCount: 1 });
        await sleep(150);
        await sendCopy(call);
        const segText = readClipboard().trim();
        if (segText) segs.push(segText);
        log(`    [正文] 段 ${seg + 1}/${SEG_CAP}：${segText.length} 字符`);
        // 滚轮推进到下一段
        await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: geo.x, y: wheelY, deltaX: 0, deltaY: step });
        await sleep(450);
      }
      const mergedRes = mergeSegments(segs);
      if (uniqueLines(mergedRes.text) > uniqueLines(wholeText)) {
        text = mergedRes.text;
        segInfo = `分段（${segs.length} 段 / 拼 ${mergedRes.merged} / 弃 ${mergedRes.dropped}）`;
        log(`    [正文] 分段结果更优（唯一行 ${uniqueLines(mergedRes.text)} > 整趟 ${uniqueLines(wholeText)}），采用分段`);
      } else {
        log(`    [正文] 整趟结果保留（唯一行 ${uniqueLines(wholeText)} ≥ 分段 ${uniqueLines(mergedRes.text)}）`);
      }
    }
    // 完整性兜底（2026-10-26 语义保留）：分段拼接结果仍需过有效文本启发——连基本章节标记都没有 → 中止
    if (!validText(text)) {
      restoreClipboard(savedClip);
      throw new FatalError(
        `取文失败：分段拼接后正文仍不完整（${text.length} 字符 / ${segs.length} 段，缺章节标记或过短）——canvas 复制通道疑似失效，中止。内容头：${text.slice(0, 60).replace(/\s+/g, " ")}`
      );
    }
    if (!TAIL_MARK.test(text)) log(`    [正文] ⚠️ 结果无尾部模块标记（${text.length} 字符）——可能该简历确实无这些模块，也可能仍未取全`);
    log(`    [正文] 取文完成：${text.length} 字符（${segInfo}，唯一行 ${uniqueLines(text)}）`);
    restoreClipboard(savedClip);
    // 6. 关弹层（严格：关不掉就中止，避免下一份弹层堆叠）
    await closePopupIfOpen(call, ev, { strict: true });
    return text;
  } finally {
    ws.close();
  }
}

/** 调试入口：不传 id，直接对「当前已打开」的弹层取文（人工排查用，产品链路不走这里） */
async function extractFromOpenPopup({ logger = null, note = (s) => console.log(s) } = {}) {
  const { ws, call, ev } = await attachChatPage();
  try {
    const geo = await waitForCanvas(ev);
    const savedClip = readClipboard({ safe: true });
    await dragSelect(call, geo);
    await sendCopy(call);
    const text = readClipboard().trim();
    restoreClipboard(savedClip);
    return text;
  } finally {
    ws.close();
  }
}

/** 预检：确保 CDP 浏览器里存在沟通页标签；没有则自动开一个（v2.5.1 机器强制）。
 * 背景：2026-10-26 事故——沟通页没开导致 hr resume 页面兜底失效、连撞 3 次 ENDPOINT_DEPRECATED
 * 熔断空跑（此前只写在文档里靠人记，违反铁律 9「关键前置条件必须机器强制」）。
 * 自动开用 browser 级 Target.createTarget（Chrome 136+ 的 /json/new 忽略 url 参数，不能走 HTTP 开页）。
 * @returns {Promise<{opened:boolean}>} opened=true 表示本次自动新开了标签 */
/** 预检辅助：登录窗口被最小化时，Chrome 会节流渲染 —— Input.dispatchMouseEvent 每发一个要等约 5s，
 *  拖选（30+ 个鼠标事件）必然撞 10s 硬超时熔断。2026-10-27 真机实证：最小化时 5003ms/次、
 *  恢复 normal 后 14–33ms；同一份简历恢复窗口即取文成功。
 *  这里**只在 windowState=minimized 时**还原为 normal，其余情况不动用户窗口；任何失败静默不阻塞。 */
async function restoreMinimizedWindow(base, targetId, log) {
  let ws = null;
  try {
    const ver = await (await fetch(base + "/json/version", { signal: AbortSignal.timeout(5000) })).json();
    if (!ver.webSocketDebuggerUrl) return;
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("browser 级 WebSocket 连接失败"));
      setTimeout(() => rej(new Error("browser 级 WebSocket 超时")), 5000);
    });
    const bcall = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = Math.floor(Math.random() * 1e9);
        const onMsg = (e) => {
          const m = JSON.parse(e.data);
          if (m.id !== id) return;
          ws.removeEventListener("message", onMsg);
          if (m.error) rej(new Error(m.error.message || "CDP 错误"));
          else res(m.result);
        };
        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => rej(new Error(`${method} 超时`)), 8000);
      });
    const { windowId, bounds } = await bcall("Browser.getWindowForTarget", { targetId });
    if (bounds && bounds.windowState === "minimized") {
      await bcall("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      log("    [预检] 登录窗口此前被最小化，已还原为正常窗口（拖选取文要求窗口可见）");
    }
  } catch {
    /* 还原失败不阻塞主流程：用户手动把浏览器窗口还原后重跑即可 */
  } finally {
    try {
      if (ws) ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function ensureChatTab({ logger = null, note = (s) => console.log(s) } = {}) {
  const log = (s) => {
    note(s);
    if (logger) logger.append(s + "\n");
  };
  if (typeof WebSocket === "undefined") {
    throw new FatalError("当前 Node 缺少原生 WebSocket（需 Node ≥ 22）。请升级 Node 后重跑");
  }
  const base = cdpBase();
  if (!base) {
    throw new FatalError(`BOSS_CDP_URL 配置无效：${process.env.BOSS_CDP_URL || "(未设置)"}`);
  }
  // ⚠️ 2026-10-27 真机实证：只认 **/web/chat/index**。此前匹配宽松到 "web/chat"，
  //    浏览器停在 /web/chat/recommend 时预检判定"在位"直接放行，随后 hr resume 撞
  //    ENDPOINT_DEPRECATED（旧 wapi/zpjob/view/geek/info 已下线、页面兜底只在 index 页生效）。
  //    改到 index 标签后同一候选人抓取立即成功。-- 不要把这里放宽回 "web/chat"。
  const listTargets = async () =>
    (await (await fetch(base + "/json", { signal: AbortSignal.timeout(5000) })).json()).filter(
      (t) => t.type === "page" && String(t.url || "").includes("zhipin.com/web/chat/index")
    );
  let pages;
  try {
    pages = await listTargets();
  } catch (e) {
    throw new FatalError(
      `CDP 不可达（${base}）：登录浏览器没开或端口不对。双击 boss-edge-login.bat（9333）或 boss-zhipin-login.bat（9222），并用 BOSS_CDP_URL 指对端口`
    );
  }
  if (pages.length > 0) {
    await restoreMinimizedWindow(base, pages[0].id, log);
    return { opened: false };
  }
  log("    [预检] 沟通页标签不存在，自动打开…");
  // browser 级 WS → Target.createTarget（不走 /json/new：Chrome 136+ 忽略其 url 参数）
  let ver;
  try {
    ver = await (await fetch(base + "/json/version", { signal: AbortSignal.timeout(5000) })).json();
  } catch (e) {
    throw new FatalError("CDP /json/version 不可达，无法自动打开沟通页——请手动在登录浏览器打开 https://www.zhipin.com/web/chat/index 后重跑");
  }
  if (!ver.webSocketDebuggerUrl) {
    throw new FatalError("CDP 浏览器未暴露 browser 级调试端口（webSocketDebuggerUrl 缺失），请手动在登录浏览器打开 https://www.zhipin.com/web/chat/index 后重跑");
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new FatalError("browser 级 WebSocket 连接失败，无法自动打开沟通页——请手动打开 web/chat/index 后重跑"));
    }),
    sleep(5000).then(() => Promise.reject(new FatalError("browser 级 WebSocket 连接超时（5s），请手动打开 web/chat/index 后重跑"))),
  ]);
  try {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new FatalError("Target.createTarget 超时（10s），请手动打开 web/chat/index 后重跑")), 10000);
      let done = false;
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === 1 && !done) {
          done = true;
          clearTimeout(timer);
          if (m.error) rej(new FatalError(`自动打开沟通页失败（${m.error.message}），请手动打开 web/chat/index 后重跑`));
          else res();
        }
      };
      ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "https://www.zhipin.com/web/chat/index" } }));
    });
    // 等新标签真正加载出 web/chat（未登录时会跳登录页，url 不含 /web/chat → 超时中止）
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        if ((await listTargets()).length > 0) {
          log("    [预检] 沟通页标签已自动打开（保持别关）");
          const opened = await listTargets();
          if (opened[0]) await restoreMinimizedWindow(base, opened[0].id, log);
          return { opened: true };
        }
      } catch {
        /* 轮询期 CDP 抖动，继续等 */
      }
    }
    throw new FatalError(
      "自动打开的沟通页 10s 内未就绪（URL 未落到 web/chat——多为未登录被跳到登录页）。请在登录浏览器确认已登录 BOSS、手动打开 https://www.zhipin.com/web/chat/index 后重跑"
    );
  } finally {
    ws.close();
  }
}

// v2.7.0：favoriteCandidate（自动收藏）已随收藏路线弃用整体移除（弹层收藏按钮对未沟通候选人
// 被平台权限拦截，2026-10-28 证伪）；旧数据 favorites.json 留档不读不写。S/A 触达见 greet.js。

// v2.10.0：S1 截图采集器（shot-capture.js）复用的构件在此导出——同 skill 内复用不算跨目录 require。
// v2.15.0：geoJs(reset) —— GEO_JS 的参数化生成器（滚动复位可关，见其头注）。
module.exports = {
  fetchResumeText, extractFromOpenPopup, ensureChatTab, assertInputResponsive, mergeSegments,
  openPopupJs, geoJs, GEO_JS, MEASURE_JS, DIALOG_JS, closePopupIfOpen, waitForCanvas, attachChatPage,
};
