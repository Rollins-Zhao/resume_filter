// BOSS 打招呼全局账本（平台级、跨岗位共享；v2.7.0 新增，BOSS 专有——不进 check-mirrors 镜像清单）
//
// 与 quota-global.js 的关系：同款模式（每日重置 + fail-open 写盘 + 全局目录解析复用 gq.resolveGlobalQuotaDir），
// 但职责正交：
//   - quota-global 管全局浏览硬顶（只读动作的量控）；
//   - 本文件管打招呼记账：① 每日发送数（cap 默认 20，仅 env BOSS_GREET_LIMIT 可调，画像不可覆盖——
//     对齐全局配额哲学：主动触达的量控不吃画像放大）；
//     ② geek 级去重名单——数据目录按岗位隔离，岗位内记账防不住跨岗重复，同一人只在全局层面挡一次。
// 计数文件：<全局目录>/boss-greet.json（与 data/_quota/boss.json、boss.risk-lock.json 同目录）
//   schema：{date, sentToday, cap, updatedAt, perJob:{<jobKey>:n}, geeks:{<geekId>:{at,jobId,name,status}}}
//   geeks 名单只增不减：想对同一人重新打招呼属人工决策（删条目/删文件），不做自动化重置。
//   status（v2.12.0）："sent"=已核实送达（占额度）｜"unverified"=回执 ok 但回查失败（不占额度、
//   命中去重阻断重发；下轮预检核实到会话则 chargeGreet 补记转 sent）。
const fs = require("fs");
const path = require("path");

const PLATFORM = "boss";
const DEFAULT_GREET_CAP = 20; // 每日打招呼本地硬顶：账号平台额度约 200/日，自动化只占 1/10（feature-greet.md §5）

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function greetLedgerPath(dir) {
  return path.join(dir, `${PLATFORM}-greet.json`);
}

// cap 解析：仅环境变量可调（>0 才生效），画像/其他来源一律不可覆盖
function resolveGreetCap() {
  const v = Number(process.env.BOSS_GREET_LIMIT);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_GREET_CAP;
}

// 缺失/损坏/跨天 → 归零对象（不写盘，保持只读安全；与 quota-global.loadGlobalQuota 同款）
function loadLedger(dir) {
  try {
    const q = JSON.parse(fs.readFileSync(greetLedgerPath(dir), "utf8"));
    if (q && typeof q === "object" && q.date === todayKey()) {
      return {
        date: todayKey(),
        sentToday: Number(q.sentToday) || 0,
        cap: Number(q.cap) || 0,
        updatedAt: q.updatedAt || "",
        perJob: q.perJob && typeof q.perJob === "object" ? q.perJob : {},
        geeks: q.geeks && typeof q.geeks === "object" ? q.geeks : {},
      };
    }
  } catch { /* 缺失/损坏/跨天 → 归零 */ }
  return { date: todayKey(), sentToday: 0, cap: 0, updatedAt: "", perJob: {}, geeks: {} };
}

function sentToday(dir) {
  return loadLedger(dir).sentToday;
}

function remainingToday(dir, cap) {
  return Math.max(0, cap - sentToday(dir));
}

function jobSentToday(dir, jobKey) {
  return Number(loadLedger(dir).perJob[jobKey]) || 0;
}

function hasGeek(dir, geekId) {
  return !!geekId && !!loadLedger(dir).geeks[geekId];
}

// 读取 geek 条目（greet.js 预检判断 pending/sent 用）；未收录返回 null
function geekEntry(dir, geekId) {
  if (!geekId) return null;
  const e = loadLedger(dir).geeks[geekId];
  return e && typeof e === "object" ? e : null;
}

// 纯记账不 throw：停不停由调用方（greet.js 发送循环）决定；写盘 fail-open
function chargeGreet(dir, jobKey, geekId, { jobId = "", name = "" } = {}) {
  const q = loadLedger(dir);
  q.sentToday += 1;
  q.cap = resolveGreetCap();
  q.updatedAt = new Date().toISOString();
  q.perJob[jobKey] = (Number(q.perJob[jobKey]) || 0) + 1;
  if (geekId) q.geeks[geekId] = { at: new Date().toISOString(), jobId, name, status: "sent" };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(greetLedgerPath(dir), JSON.stringify(q, null, 2));
  } catch (e) {
    console.warn(`[greet 账本] 记账写盘失败（fail-open 继续运行）：${e.message}`);
  }
  return q;
}

// v2.12.0：UNVERIFIED 落账（BUG-2026-11-03）——发送回执 ok 但回查失败（CLI 请求预算冷却）时，
// 只记去重条目（status:"unverified"）阻断下轮重发，**不占日发送额度**（未核实送达不记账面）。
// 存话术前 24 字（msg）与 jobKey：下轮 greet.js 预检拿沟通列表快照做文本匹配，命中即
// chargeGreet 补记转 sent（占额度）。pending 语义当天有效（账本次日清零；跨天重发由平台
// 「首条招呼唯一性」兜底）。写盘 fail-open 同 chargeGreet。
function markPending(dir, geekId, { jobId = "", name = "", msg = "", jobKey = "" } = {}) {
  if (!geekId) return loadLedger(dir);
  const q = loadLedger(dir);
  if (q.geeks[geekId]) return q; // 已有条目（sent/pending）不覆盖：首记优先
  q.updatedAt = new Date().toISOString();
  q.geeks[geekId] = { at: new Date().toISOString(), jobId, name, jobKey, msg: String(msg || "").slice(0, 24), status: "unverified" };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(greetLedgerPath(dir), JSON.stringify(q, null, 2));
  } catch (e) {
    console.warn(`[greet 账本] pending 写盘失败（fail-open 继续运行）：${e.message}`);
  }
  return q;
}

function summarizeToday(dir, cap) {
  const q = loadLedger(dir);
  const jobs = Object.entries(q.perJob).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join("、");
  const geeks = Object.keys(q.geeks).length;
  return `[greet 账本] 今日已发送 ${q.sentToday}/${cap}（累计去重 ${geeks} 人）${jobs ? `（${jobs}）` : ""}，次日自动清零`;
}

module.exports = {
  PLATFORM,
  DEFAULT_GREET_CAP,
  todayKey,
  greetLedgerPath,
  resolveGreetCap,
  loadLedger,
  sentToday,
  remainingToday,
  jobSentToday,
  hasGeek,
  geekEntry,
  chargeGreet,
  markPending,
  summarizeToday,
};
