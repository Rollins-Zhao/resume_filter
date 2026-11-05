// doctor.js 纯函数测试 + 真机自检运行验证。跑法：node tests/doctor.test.js
const assert = require("assert");
const { checkNodeVersion, summarize } = require("../doctor");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + extra}`);
  if (!cond) failed++;
};

// ---- checkNodeVersion ----
check("Node v24.13.1 → ok", checkNodeVersion("v24.13.1").ok === true);
check("Node v22.0.0 → ok（边界）", checkNodeVersion("v22.0.0").ok === true);
check("Node v20.19.0 → 不 ok", checkNodeVersion("v20.19.0").ok === false && checkNodeVersion("v20.19.0").major === 20);
check("非法版本串容错（major=0 → 不 ok）", checkNodeVersion("abc").ok === false);

// ---- summarize（分组就绪 + userActions 汇总 + info 项不计入行动清单）----
const s1 = summarize([
  { group: "critical", item: "Node", ok: true, action: "" },
  { group: "critical", item: "exceljs", ok: false, action: "跑 setup.bat" },
  { group: "liepin", item: "liepin-cli", ok: false, action: "重跑 doctor" },
  { group: "boss", item: "uv", ok: true, action: "" },
  { group: "boss", item: "boss-agent-cli", ok: true, action: "" },
  { group: "info", item: "Edge 未开", ok: false, info: true, action: "扫码登录" },
]);
check("critical 有缺口 → criticalReady=false", s1.criticalReady === false);
check("liepin 有缺口 → liepinReady=false", s1.liepinReady === false);
check("boss 全 ok → bossReady=true", s1.bossReady === true);
check("userActions 含 exceljs/liepin 行动项", s1.userActions.length === 2 && s1.userActions.join("").includes("setup.bat") && s1.userActions.join("").includes("重跑 doctor"));

const s2 = summarize([
  { group: "critical", item: "Node", ok: true, action: "" },
  { group: "critical", item: "exceljs", ok: true, action: "" },
  { group: "liepin", item: "liepin-cli", ok: false, action: "可忽略" },
  { group: "boss", item: "uv", ok: true, action: "" },
  { group: "boss", item: "boss-agent-cli", ok: true, action: "" },
]);
check("critical 就绪即 ready（平台缺口单列）", s2.criticalReady === true && s2.liepinReady === false && s2.bossReady === true);
check("info 项不进 userActions", !summarize([{ group: "info", item: "x", ok: false, info: true, action: "扫码" }]).userActions.length);

process.exit(failed ? 1 : 0);
