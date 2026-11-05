// 工作时间窗口纯函数 —— 与 liepin-resume-screener/scripts/working-window.js 逐字镜像；run.js 内嵌第三份（⚠️ 三处镜像，改必同步）
// 全部纯函数：不碰 new Date()/fs，时间由调用方传参注入（离线可单测）。
// 边界语义：起始含端、结束不含端（20:00:00 整点即窗外 → 软停止点）。
// 支持跨午夜窗口（如 22:00-06:00 夜班）：wraps = start > end。

const DEFAULT_WINDOW = ["08:00", "20:00"];

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min, total: h * 60 + min, text: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` };
}

/** 解析窗口："HH:MM-HH:MM" 字符串或 [start, end] 数组 → {ok, start, end, startMin, endMin, wraps, reason} */
function parseWorkingWindow(spec) {
  let a = null;
  let b = null;
  if (Array.isArray(spec) && spec.length === 2) {
    a = spec[0];
    b = spec[1];
  } else if (typeof spec === "string" && spec.includes("-")) {
    const parts = spec.split("-");
    a = parts[0];
    b = parts[1];
  } else {
    return { ok: false, start: "", end: "", startMin: 0, endMin: 0, wraps: false, reason: "格式应为 HH:MM-HH:MM 或 [\"HH:MM\", \"HH:MM\"]" };
  }
  const sa = parseHHMM(a);
  const sb = parseHHMM(b);
  if (!sa || !sb) {
    return { ok: false, start: "", end: "", startMin: 0, endMin: 0, wraps: false, reason: `时间格式非法（${a} - ${b}）` };
  }
  if (sa.total === sb.total) {
    return { ok: false, start: "", end: "", startMin: 0, endMin: 0, wraps: false, reason: "起始与结束不能相同" };
  }
  return { ok: true, start: sa.text, end: sb.text, startMin: sa.total, endMin: sb.total, wraps: sa.total > sb.total, reason: "" };
}

/** now 是否在窗口内（取本地时间时分；起始含端、结束不含端；跨午夜用 wraps 分支） */
function isWithinWindow(now, win) {
  const w = win && win.ok ? win : parseWorkingWindow(DEFAULT_WINDOW);
  const t = now.getHours() * 60 + now.getMinutes();
  return w.wraps ? t >= w.startMin || t < w.endMin : t >= w.startMin && t < w.endMin;
}

/** 下次窗口开启提示（仅在窗外调用）："今天 08:00" / "明天 08:00" */
function describeNextOpen(now, win) {
  const w = win && win.ok ? win : parseWorkingWindow(DEFAULT_WINDOW);
  const t = now.getHours() * 60 + now.getMinutes();
  return t < w.startMin ? `今天 ${w.start}` : `明天 ${w.start}`;
}

module.exports = { DEFAULT_WINDOW, parseWorkingWindow, isWithinWindow, describeNextOpen };
