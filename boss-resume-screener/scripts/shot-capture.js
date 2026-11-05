// BOSS 简历取文 v3 —— 截图采集器（v2.10.0，2026-10-31 用户拍板架构）
//
// 背景：canvas 复制通道（fetch-text.js 拖选-复制）经 9 轮真机迭代仍非确定性取全（同一份简历
// 815/408/9309/4989 字符多态；懒渲染疑似封顶 ~4600px，尾部模块系统性缺失）。2026-10-31 抓包定案：
// 正文密文（zpData.encryptGeekDetailInfo）由 wasm 解密进 canvas，DOM 永远无字——**不逆向 wasm**
//（红线），改为「截图 + AI 会话转写」：本模块只做真人等价动作（开弹层、滚轮阅读、截图），
// 文本由 AI 会话读图转写后经 ocr-batch.js 回填——PII 不出「本机 + AI 会话」边界（与 llm-batch 同信任模型）。
//
// 同时补「牛人分析器」：弹层打开时页面会发 geek/info/v2 XHR，其 zpData.jobCompetitive 是明文
//（截图拿不到的网络层增值信息，零 token）——开弹层前挂 Network 监听顺手回收。
//
// v2.15.0（BUG-2026-11-05 简历弹层跳动/重绘错位，合成器录屏 + 逐帧字节实证）：
//   - 用户看到的「一格一格跳、内容压扁在顶部一条+下方空白」= canvas 自上而下异步重绘的**中间态**；
//     落盘图实测未受损（+100ms 即稳定），但重绘窗口客观存在——机器慢/窗口被遮挡时可能拍到空白条。
//   - P0-2 固定 sleep(1000) 之外加「重绘就绪」探测（低质 JPEG 字节稳定判定）：不稳才多等（≤1.5s）；
//   - P0-3 到底判定升级：读真正滚动容器 .resume-detail 的 scrollTop（旧版 iframe scrollTop 恒 0，
//     只能靠高度收敛+屏数推断——平台改容器滚动/懒加载变化时会静默拍同屏、OCR 后缺正文不报错）；
//   - P1-2 clip 每张重算（重绘期弹层矩形会变）；P1-3 重复帧检测（滚动推进但画面相同 = 卡死中止；
//     滚动未推进的同帧 = 到底收尾）。
// v2.15.1（同日回滚 v2.15.0 的步长修改）：「拉伸/跳动」是平台 canvas 本地重绘中间态，只存在于
//   用户屏幕、平台侧不可见（用户查证无自动化识别风险后拍板回滚）；恢复 v2.10.0 起 11 份真机
//   验证的 80% 视口单滚轮（45% 步长会使张数/OCR 耗时翻倍）。上述正确性修复（就绪探测/真实到底/
//   重复帧/clip 重算）与观感无关，全部保留——0.8 大步长的重绘面积更大，就绪探测反而更重要。
//
// 语义（与 fetch-text 同款纪律）：
//   - 任何一步失败 → FatalError 立即中止本轮（不降级、不跳过）；人工回退通道 = BOSS_TEXT_MODE=drag。
//   - 截图节奏 = 阅读式慢滚（~1s/屏 + 就绪探测），比拖选的机械快滚更像真人；简历间间隔不动（config.intervals）。
// 红线：截图含更多 PII（含照片）——仅落本机数据目录、报告不嵌图、测完即删、不外发。
const fs = require("fs");
const path = require("path");
const { FatalError } = require("./boss");
const {
  openPopupJs, GEO_JS, MEASURE_JS, closePopupIfOpen, waitForCanvas, attachChatPage, assertInputResponsive,
} = require("./fetch-text");

const SHOT_DIR = "扫描图"; // 数据目录下的图片子目录（resumes/<id>.json 的 images 存相对路径）
const DWELL_MS = 1000; // 每屏停留（阅读式节奏；也给懒渲染追上来的时间——S1 顺带验证封顶是否自愈）
const INSIGHT_URL_MARK = "/wapi/zpjob/view/geek/info/v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- v2.15.0 重绘就绪探测（P0-2）----------
const STABLE_POLL_MS = 120; // 探测轮询间隔
const STABLE_MAX_MS = 1500; // 探测上限：超限按原节奏继续拍（重复帧检测兜底），不无限等
const STABLE_JPEG_QUALITY = 30; // 低质 JPEG：只为比字节数，不要画质

// ---------- 纯函数（单测覆盖：tests/shot-capture.test.js） ----------
/** geek/info/v2 响应体 → { insight, plainKeys }：insight=牛人分析器明文（≤500 字符）；
 *  plainKeys=zpData 里值为字符串的键（开放问题 2「明文字段全量清单」的累积证据，进日志不进数据） */
function parseInsightBody(bodyText) {
  const out = { insight: "", plainKeys: [] };
  let j = null;
  try { j = JSON.parse(bodyText); } catch { return out; }
  const zd = j && j.zpData;
  if (!zd || typeof zd !== "object") return out;
  out.plainKeys = Object.keys(zd).filter((k) => typeof zd[k] === "string");
  if (typeof zd.jobCompetitive === "string") out.insight = zd.jobCompetitive.trim().slice(0, 500);
  return out;
}

/** 底部判定（v2.15.0 双保险）：
 *  ① 真实到底——滚动容器 scrollTop+clientH 覆盖 scrollH（±2px 容差；MEASURE_JS 读 .resume-detail，
 *    旧版读 iframe 文档 scrollTop 恒 0 拿不到真实位置，BUG-2026-11-05 P0-3）；
 *  ② 回退——高度连续 2 次不增长（懒渲染收敛）且已拍屏数足以覆盖内容高度（scrollTop 不可用时）。
 *  高度仍在涨（stable<2）绝不停——懒渲染封顶真伪就靠这里不误停（首测 scrollH 从 150 涨到 4626）。 */
function scrollBottomReached({ stable, scrollH, scrollTop, clientH, viewH, step, shotsTaken }) {
  if (!stable || stable < 2) return false;
  const st = Number(scrollTop), ch = Number(clientH);
  if (Number.isFinite(st) && Number.isFinite(ch) && ch > 0) {
    if (st + ch >= (Number(scrollH) || 0) - 2) return true;
  }
  const need = 1 + Math.max(0, Math.ceil(((Number(scrollH) || 0) - (Number(viewH) || 0)) / (Number(step) || 1)));
  return shotsTaken >= need;
}

/** 截图文件名：<id>-NN.png（两位序号，>99 也自然进位） */
function shotFileName(id, n) {
  return `${String(id).replace(/[^\w.-]/g, "_")}-${String(n).padStart(2, "0")}.png`;
}

/** 滚动计划（v2.15.1 回滚为 v2.10.0 配置）：步长 = 视口高 × 80%（20% 重叠防漏行），上限 24 屏
 *  （≈8600px 内容，防御性封顶）。v2.15.0 曾改 45%+双滚轮以缩短重绘中间态观感——后确认拉伸属
 *  平台本地图形行为、无识别风险（2026-11-05 用户查证拍板），且小步长使张数/OCR 耗时翻倍，回滚。 */
function planShots({ canvasH } = {}) {
  const viewH = Number(canvasH) > 200 ? Number(canvasH) : 897;
  return { viewH, step: Math.max(200, Math.round(viewH * 0.8)), maxShots: 24 };
}

/** 重绘就绪的字节稳定判定（P0-2）：两次低质 JPEG 字节数相对变化 ≤1%（或差 ≤1 字节）视为同一画面。
 *  双双为空视为稳定（无数据不阻塞）；其一为空不稳定（画面刚出现/刚消失）。 */
function jpegSizeStable(a, b) {
  const x = Number(a) || 0, y = Number(b) || 0;
  if (!x && !y) return true;
  if (!x || !y) return false;
  return Math.abs(x - y) <= Math.max(1, Math.round(Math.max(x, y) * 0.01));
}

/** 重复帧裁决（P1-3，防「静默拍 N 张同图、OCR 去重后正文缺失不报错」）：
 *  sameBytes=与上一张字节完全相同（PNG 同画面同字节）时——
 *    滚动位置已推进（>+2px）→ "dup-stuck"（滚动假象/重绘卡死，异常中止）；
 *    滚动未推进           → "dup-bottom"（已到底，丢弃重复帧正常收尾）；
 *  字节不同 → null（正常继续）。位置缺失按到底收尾（防御，不误杀）。 */
function judgeDuplicateFrame({ sameBytes, prevPos, curPos }) {
  if (!sameBytes) return null;
  const a = Number(prevPos), b = Number(curPos);
  if (Number.isFinite(a) && Number.isFinite(b) && b > a + 2) return "dup-stuck";
  return "dup-bottom";
}

// ---------- 页面侧脚本 ----------
// 折叠点开（v2.10.0 真机实证：「查看全部N份经历/N项分析」——某候选人 8 份经历只展开 1 份，
// 不点开则截图/拖选两代通道都取不全早期经历）。在顶层文档与 c-resume iframe 里找叶子节点
// 文本含「查看全部」的元素并点击；点不到返回 0（不报错——canvas 内绘按钮走后续真机验证另案）。
const EXPAND_JS = `(function(){
  var n = 0;
  var tryDoc = function(doc) {
    if (!doc) return 0;
    var c = 0;
    var els = doc.querySelectorAll('div,span,a,button,p');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.childElementCount) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 24) continue;
      if (!/查看全部|展开全部/.test(t)) continue;
      try { el.click(); c++; } catch (e) {}
    }
    return c;
  };
  n += tryDoc(document);
  var frs = document.querySelectorAll('iframe');
  for (var i = 0; i < frs.length; i++) {
    if ((frs[i].src || '').indexOf('c-resume') < 0) continue;
    try { n += tryDoc(frs[i].contentDocument); } catch (e) {}
  }
  return n;
})()`;

// 弹层容器矩形（截图裁剪用）：只拍弹层本身，不拍左侧会话列表（少含他人 PII）。
const DIALOG_RECT_JS = `(function(){
  var el = document.querySelector('.new-chat-resume-dialog-main-ui');
  if (!el) return { err: '未找到弹层容器' };
  var r = el.getBoundingClientRect();
  if (r.width < 300 || r.height < 100) return { err: '弹层尺寸未成形' };
  var vw = window.innerWidth, vh = window.innerHeight;
  var x = Math.max(0, Math.floor(r.left)), y = Math.max(0, Math.floor(r.top));
  return { x: x, y: y, width: Math.min(Math.ceil(r.right), vw) - x, height: Math.min(Math.ceil(r.bottom), vh) - y };
})()`;

/** 重绘就绪探测（P0-2）：每 STABLE_POLL_MS 截一张低质 JPEG 比较字节数，连续 2 次稳定即认为
 *  重绘完成。固定 sleep 是「猜」（实测好机器 100ms 够、慢机器/被遮挡可能不够——一旦不够就拍到
 *  空白条帧）；这里只在真不稳时多花时间（稳态下一次比较即过），上限 STABLE_MAX_MS 兜底后按原
 *  节奏继续拍（重复帧检测是第二道网）。返回是否稳定（false 不报错——探测失败不阻塞主流程）。 */
async function waitRedrawStable(call, clip) {
  const t0 = Date.now();
  let prev = 0;
  let stableCnt = 0;
  while (Date.now() - t0 < STABLE_MAX_MS) {
    let size = 0;
    try {
      const s = await call("Page.captureScreenshot", {
        format: "jpeg", quality: STABLE_JPEG_QUALITY,
        ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 } } : {}),
      });
      size = ((s && s.result && s.result.data) || "").length;
    } catch {
      return false; // 探测通道异常：不阻塞，按原节奏拍
    }
    if (jpegSizeStable(prev, size)) {
      if (++stableCnt >= 2) return true;
    } else {
      stableCnt = 0;
    }
    prev = size;
    await sleep(STABLE_POLL_MS);
  }
  return false;
}

// ---------- 主入口 ----------
/**
 * 开弹层截图采集一份候选人的在线简历（正文文本由 AI 会话转写后经 ocr-batch.js 回填）。
 * @param {object} p {geekId, jobId, securityId, outDir, logger?, note?}
 *   outDir = 数据目录（data/<岗位>/boss/data）；图片落 outDir/扫描图/<id>-NN.png
 * @returns {Promise<{images:string[], bossInsight:string, scrollHMax:number, ms:number}>}
 *   images 为相对 outDir 的路径（存 resumes/<id>.json 的 images 字段）。
 * 失败语义：任何一步不对抛 FatalError，由 screener 全停（与 fetch-text 同款，不降级）。
 */
async function captureResumeShots({ geekId, jobId, securityId, outDir, logger = null, note = (s) => console.log(s) }) {
  const log = (s) => {
    note(s);
    if (logger) logger.append(s + "\n");
  };
  if (!outDir) throw new FatalError("captureResumeShots 缺少 outDir（数据目录）——调用方接线错误，中止");
  const { ws, call, ev, on } = await attachChatPage();
  try {
    // 0. 预检 + 清场（与拖选通道同款）：被遮挡节流下滚轮也会撞超时
    await assertInputResponsive(call, log);
    await closePopupIfOpen(call, ev);
    try {
      await ev("(window.scrollTo(0,0), document.documentElement.scrollTop=0, document.body.scrollTop=0, 'OK')");
    } catch { /* 复位失败不阻塞：GEO_JS 里还有一道按需复位 */ }

    // 1. 网络监听（S3）：必须在开弹层**之前**挂上——geek/info/v2 在弹层打开瞬间发出
    await call("Network.enable");
    const insightReqs = [];
    on("Network.responseReceived", (p) => {
      const u = (p.response && p.response.url) || "";
      if (u.includes(INSIGHT_URL_MARK) && p.requestId) insightReqs.push(p.requestId);
    });

    // 2. 开弹层（官方 API；15s 未就绪清场重开一次——同 fetch-text R-03 语义）
    const opened = await ev(openPopupJs(geekId, jobId, securityId));
    if (opened === "NO_API") throw new FatalError("沟通页缺少 iBossRoot.resume API——平台前端可能已变更，中止");
    if (String(opened).startsWith("OPEN_FAIL")) throw new FatalError(`打开简历弹层失败（${opened}），中止`);
    let geo;
    try {
      geo = await waitForCanvas(ev);
    } catch (e1) {
      log("    [截图] 弹层 15s 未就绪，清场后重开一次再等…");
      await closePopupIfOpen(call, ev);
      const reopened = await ev(openPopupJs(geekId, jobId, securityId));
      if (reopened === "NO_API") throw new FatalError("沟通页缺少 iBossRoot.resume API——平台前端可能已变更，中止");
      if (String(reopened).startsWith("OPEN_FAIL")) throw new FatalError(`重开简历弹层失败（${reopened}），中止`);
      geo = await waitForCanvas(ev);
    }

    // 3. 几何与裁剪矩形；弹层内部滚回顶（残留滚动会让首拍从中间开始）
    const plan = planShots({ canvasH: geo.canvasH });
    const wheelY = Math.max(1, geo.topY + Math.min(400, Math.floor(plan.viewH / 2)));
    for (let i = 0; i < 8; i++) {
      await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: geo.x, y: wheelY, deltaX: 0, deltaY: -600 });
      await sleep(120);
    }
    // 3.5 点开折叠（多轮：展开后可能露出新的「查看全部」）；点不到如实记录 0 处
    let expanded = 0;
    for (let round = 0; round < 3; round++) {
      const c = await ev(EXPAND_JS);
      if (!c) break;
      expanded += c;
      await sleep(900); // 展开重绘稳定
    }
    log(expanded ? `    [截图] 已点开折叠 ${expanded} 处（查看全部）` : "    [截图] 未发现可点开的折叠按钮（DOM 面 0 处）");
    await sleep(800); // 首帧绘制稳定（拖选通道实证：刚开弹层画布可能未完成首帧）
    const gw = await ev(GEO_JS);
    if (!gw || gw.err) throw new FatalError(`简历弹层几何不可用（${(gw && gw.err) || "未知"}），中止`);
    let clip = null;
    try {
      const dr = await ev(DIALOG_RECT_JS);
      if (dr && !dr.err && dr.width >= 300) clip = dr;
    } catch { /* 矩形拿不到 → 全视口兜底 */ }
    log(`    [截图] ${clip ? `裁剪弹层矩形 ${clip.width}×${clip.height}（不含会话列表）` : "弹层矩形不可用，全视口截图"} · 视口高 ${plan.viewH}px · 步长 ${plan.step}px`);

    // 4. 截图主循环：拍（clip 每张重算 + 重复帧裁决）→ 滚一屏(-20% 重叠) → 阅读式停顿 →
    //    重绘就绪探测 → 测高；真实到底（scrollTop+clientH）或高度收敛且覆盖足够屏数 = 到底。
    //    失败清理（终审 M-3）：中途熔断时删除本次已写盘的图片——无缓存引用的孤儿 PNG 是无索引 PII，不留。
    const dir = path.join(outDir, SHOT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const images = [];
    try {
      let scrollH = ((await ev(MEASURE_JS)) || {}).scrollH || 0;
      let stable = 0;
      const t0 = Date.now();
      let prevShotBuf = null; // P1-3：上一张字节（Buffer.equals ≙ md5 相同）
      let prevShotPos = 0; // 上一张拍摄时的滚动位置（pos_{k-2}）
      let curPos = 0; // 本张拍摄时的滚动位置（上轮滚后 MEASURE 的 scrollTop；首张 0=顶部）
      for (let n = 1; n <= plan.maxShots; n++) {
        // P1-2：clip 每张重算——重绘期弹层矩形可能变化，循环前的旧 clip 会裁错位（BUG-2026-11-05）。
        if (n > 1) {
          try {
            const dr = await ev(DIALOG_RECT_JS);
            if (dr && !dr.err && dr.width >= 300) clip = dr;
          } catch { /* 拿不到沿用上一张 */ }
        }
        const shot = await call("Page.captureScreenshot", {
          format: "png",
          ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 } } : {}),
        });
        // ⚠️ call() 返回整条 CDP 消息，截图数据在 result.data（两层）——2026-10-30 真机实证：
        // 少包一层 result 拿到 undefined，误报「未返回图像数据」（与 ev() 的 result.result.value 同款坑）
        const b64 = shot && shot.result && shot.result.data;
        if (!b64) throw new FatalError("Page.captureScreenshot 未返回图像数据（截图通道疑似不可用）——中止；可用 BOSS_TEXT_MODE=drag 回退拖选通道重跑");
        const buf = Buffer.from(b64, "base64");
        // P1-3：重复帧裁决（写盘前，重复帧不落盘）——滚动推进但画面相同 = 滚动假象/重绘卡死（中止，
        // 防 OCR 去重后静默缺正文）；滚动未推进的同帧 = 已到底（丢弃重复帧收尾）。
        const dup = judgeDuplicateFrame({ sameBytes: !!(prevShotBuf && buf.equals(prevShotBuf)), prevPos: prevShotPos, curPos });
        if (dup === "dup-stuck") {
          throw new FatalError(`第 ${n} 张与上一张画面完全相同，但滚动位置已从 ${prevShotPos}px 推进到 ${curPos}px——滚动假象或画布重绘卡死，中止本份（防 OCR 去重后静默缺正文）`);
        }
        if (dup === "dup-bottom") {
          log(`    [截图] 第 ${n} 张与上一张相同且滚动已到头（${curPos}px）——判定到底，丢弃重复帧，共 ${images.length} 张`);
          break;
        }
        const rel = `${SHOT_DIR}${path.sep}${shotFileName(geekId, n)}`;
        fs.writeFileSync(path.join(outDir, rel), buf);
        images.push(rel);
        prevShotBuf = buf;
        prevShotPos = curPos;
        if (n === plan.maxShots) {
          log(`    [截图] 已达单份上限 ${plan.maxShots} 张，停止（超长简历如仍缺尾部，反馈调大 planShots.maxShots）`);
          break;
        }
        // 滚一屏（-20% 重叠）。v2.15.0 曾拆 2 次半屏小滚轮缩短重绘中间态，v2.15.1 回滚（无识别
        // 风险 + 张数/OCR 耗时翻倍，见 planShots 注释）——单滚轮 80% 视口为 v2.10.0 起真机验证配置。
        await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: gw.x, y: wheelY, deltaX: 0, deltaY: plan.step });
        await sleep(DWELL_MS);
        // P0-2：重绘就绪探测——DWELL 停顿后画面仍未稳定（慢机器/窗口被遮挡）时最多再多等 1.5s，
        // 不稳不报错按原节奏拍（重复帧检测是第二道网）。稳态下一次比较即过，零额外开销。
        await waitRedrawStable(call, clip);
        const m = await ev(MEASURE_JS);
        // 终审 I-1（Important）：弹层中途消失（用户手关/平台移除）时 MEASURE 返回 err——原逻辑静默继续，
        // 会对底层沟通页（含其他候选人会话）连拍 bogus 图还以「成功」返回。err 即中止本份。
        if (!m || m.err) {
          throw new FatalError(`简历弹层在采集中途不可用（${(m && m.err) || "无响应"}）——可能被手动关闭或平台移除，中止本份`);
        }
        const h = m.scrollH || 0;
        curPos = Number(m.scrollTop) || 0;
        stable = h <= scrollH + 2 ? stable + 1 : 0;
        scrollH = Math.max(scrollH, h);
        if (scrollBottomReached({ stable, scrollH, scrollTop: m.scrollTop, clientH: m.clientH, viewH: plan.viewH, step: plan.step, shotsTaken: n })) {
          log(`    [截图] 滚动到底：内容高 ${scrollH}px 收敛（滚动位置 ${curPos}px），共 ${n} 张`);
          break;
        }
      }
      if (!images.length) throw new FatalError("截图采集失败（0 张）——中止；可用 BOSS_TEXT_MODE=drag 回退拖选通道重跑");

      // 5. 牛人分析器回收（放截图后：响应体早已就绪，getResponseBody 不用等流式完成）
      let bossInsight = "";
      let plainKeys = [];
      const doneRid = new Set();
      for (let attempt = 0; attempt < 6 && !bossInsight; attempt++) {
        for (const rid of [...insightReqs]) {
          if (doneRid.has(rid)) continue;
          try {
            const b = await call("Network.getResponseBody", { requestId: rid });
            // 终审 M-2：CDP 协议级错误是 resolve {id,error} 而非 throw——此时不标记完成，下一轮真重试
            if (!b || b.error) continue;
            doneRid.add(rid);
            // 同上：call() 返回整条消息，body 在 result.body（base64Encoded 也在 result 里）
            const body = b.result && b.result.body;
            const txt = body ? (b.result.base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body) : "";
            const parsed = parseInsightBody(txt);
            if (parsed.plainKeys.length) plainKeys = parsed.plainKeys;
            if (parsed.insight) { bossInsight = parsed.insight; break; }
          } catch { /* 连接级异常 → 下一轮重试 */ }
        }
        if (bossInsight || !insightReqs.length) break;
        await sleep(400);
      }
      if (plainKeys.length) log(`    [分析] geek/info/v2 明文字段：${plainKeys.join("、")}`);
      if (bossInsight) log(`    [分析] 牛人分析器：${bossInsight.slice(0, 60)}${bossInsight.length > 60 ? "…" : ""}`);
      else log("    [分析] 本次未捕获牛人分析器（接口未发或无 jobCompetitive）——留空不阻塞");

      // 6. 关弹层（严格：关不掉就中止，避免下一份弹层堆叠）
      await closePopupIfOpen(call, ev, { strict: true });
      log(`    [截图] 采集完成：${images.length} 张 · 内容高 ${scrollH}px · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { images, bossInsight, scrollHMax: scrollH, ms: Date.now() - t0 };
    } catch (e) {
      // 终审 M-3：任何失败（含关弹层失败）都不留孤儿 PNG——无缓存引用的截图是无索引 PII，删净后上抛
      for (const rel of images) {
        try { fs.unlinkSync(path.join(outDir, rel)); } catch { /* 已不在则罢 */ }
      }
      throw e;
    }
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

module.exports = {
  captureResumeShots, parseInsightBody, scrollBottomReached, shotFileName, planShots,
  jpegSizeStable, judgeDuplicateFrame,
};
