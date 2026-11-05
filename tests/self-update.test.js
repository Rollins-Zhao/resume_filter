// self-update.js 纯函数单测（v2.13.0：GitHub Release 自更新）：版本比较 / 资产挑选 / 受保护路径白名单 /
// 应用计划排序 / 零依赖 zip 读取器（store+deflate、目录条目、UTF-8 中文文件名）。
// 跑法：node tests/self-update.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const M = require("../self-update");
const { parseVer, cmpVer, readLocalVersion, pickAsset, isProtectedEntry, planApply, readZipEntries, parseTier2Headers } = M;

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + extra}`);
  if (!cond) failed++;
};

// ---------- 纯函数：版本比较 ----------
check("parseVer：v 前缀 / 预发布后缀 / 缺段", JSON.stringify(parseVer("v2.13.0")) === "[2,13,0]" && JSON.stringify(parseVer("2.9.10-beta.1")) === "[2,9,10]" && JSON.stringify(parseVer("")) === "[0,0,0]");
check("cmpVer：按数字比较而非字符串（2.13.0 > 2.9.10）", cmpVer("2.13.0", "2.9.10") === 1);
check("cmpVer：升版判断（2.12.0 < 2.13.0）", cmpVer("2.12.0", "2.13.0") === -1);
check("cmpVer：v 前缀不影响相等判断", cmpVer("v2.13.0", "2.13.0") === 0);

// ---------- 纯函数：本地版本读取 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "selfupd-"));
try {
  fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "resume-screener", version: "2.12.0" }));
  check("readLocalVersion：读 package.json 的 version", readLocalVersion(TMP) === "2.12.0");
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "selfupd-empty-"));
  check("readLocalVersion：缺 package.json → null", readLocalVersion(TMP2) === null);
  fs.rmSync(TMP2, { recursive: true, force: true });

  // ---------- 纯函数：Release 资产挑选 ----------
  const assets = [
    { name: "install.bat", browser_download_url: "u1", size: 1 },
    { name: "resume-screener-2.12.0.zip", browser_download_url: "u2", size: 2 },
    { name: "resume-screener-latest.zip", browser_download_url: "u3", size: 3 },
  ];
  check("pickAsset：优先精确版本号资产", pickAsset(assets, "2.12.0").url === "u2");
  check("pickAsset：无精确版本 → 常量名 latest", pickAsset([assets[0], assets[2]], "2.13.0").url === "u3");
  check("pickAsset：只有杂名 zip → 第一个 resume-screener-*.zip", pickAsset([{ name: "resume-screener-9.9.9.zip", browser_download_url: "u4", size: 4 }], "2.13.0").url === "u4");
  check("pickAsset：无 zip 资产 → null", pickAsset([assets[0]], "2.13.0") === null);

  // ---------- 纯函数：受保护路径白名单（第二道防线） ----------
  const protectedPaths = [
    ".env", "sub/.env", "DATA/x.json", "data/x.json", "logs/a.log", "reports/r.xlsx", "release/x.zip",
    "node_modules/a", "chrome-win64/a", ".git/config", ".workbuddy/memory/MEMORY.md",
    ".claude/settings.json", "tests/a.test.js", ".playwright-mcp/x.yml",
    "profiles/_user.json", "profiles/销售经理.json", "profiles/sub/_template.json",
    "C:/x/y.js", "/abs/x", "a/../b", "../x",
    // Win32 归一化绕过（评审 I2）：每段末尾的点/空格落盘前会被剥掉（"data "/ "data."/" ".env." 即 data//.env）
    "data /x.json", "data./x.json", ".env.", ".env ",
    // 盘符/ADS 变体（评审 I2 顺手加固）
    "a:b/c.js",
  ];
  const okPaths = [
    "run.bat", "run.js", "package.json", "README.md", "doctor.js", ".gitignore",
    "profiles/_template.json", "profiles/example-销售经理.json",
    "liepin-resume-screener/scripts/screener.js", "boss-resume-screener/SKILL.md",
  ];
  check("isProtectedEntry：拦截矩阵全中", protectedPaths.every((p) => isProtectedEntry(p) === true), protectedPaths.filter((p) => isProtectedEntry(p) !== true).join(","));
  check("isProtectedEntry：放行矩阵全过", okPaths.every((p) => isProtectedEntry(p) === false), okPaths.filter((p) => isProtectedEntry(p) !== false).join(","));

  // ---------- 纯函数：应用计划（排序 / run.bat 分流 / 拦截项进 skipped） ----------
  const names = ["package.json", "run.js", "b.txt", "a/b.js", "run.bat", "data/x.json"];
  const p1 = planApply(names, { fromBat: false });
  check("planApply：run.js 倒数第二、package.json 压轴", p1.direct[p1.direct.length - 2] === "run.js" && p1.direct[p1.direct.length - 1] === "package.json");
  check("planApply：普通文件保持 zip 原序在前", p1.direct.slice(0, 2).join("|") === "b.txt|a/b.js" && p1.direct[2] === "run.bat");
  check("planApply：非 bat 上下文 run.bat 直接写", p1.batDeferred.length === 0);
  check("planApply：受保护项进 skipped", p1.skipped.join(",") === "data/x.json");
  const p2 = planApply(names, { fromBat: true });
  check("planApply：--from-bat 时 run.bat 入延迟队列", p2.batDeferred.join(",") === "run.bat" && !p2.direct.includes("run.bat"));
  check("planApply：--from-bat 排序不变（压轴规则同上）", p2.direct[p2.direct.length - 2] === "run.js" && p2.direct[p2.direct.length - 1] === "package.json");

  // ---------- 零依赖 zip 读取器（测试内手搓 store+deflate 混合 zip） ----------
  // 写 0 值 CRC：读取器不校验 CRC（完整性由 https + 版本复核承担，与方案口径一致）。
  const makeZip = (items) => {
    const locals = []; const centrals = []; let offset = 0;
    for (const it of items) {
      const raw = Buffer.from(it.data, "utf8");
      const data = it.deflate ? zlib.deflateRawSync(raw) : raw;
      const nameBuf = Buffer.from(it.name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(it.deflate ? 8 : 0, 8);
      local.writeUInt32LE(0, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      locals.push(local, nameBuf, data);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8); // bit11：UTF-8 文件名
      central.writeUInt16LE(it.deflate ? 8 : 0, 10);
      central.writeUInt32LE(0, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(raw.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBuf);
      offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(items.length, 8);
    eocd.writeUInt16LE(items.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  };
  const zip = makeZip([
    { name: "a.txt", data: "hello" },
    { name: "dir/", data: "" }, // 目录条目应被跳过
    { name: "dir/b.js", data: "console.log(1)", deflate: true },
    { name: "文件/说明.md", data: "中文内容", deflate: true },
  ]);
  const entries = readZipEntries(zip);
  check("readZipEntries：目录条目被跳过，共 3 条", entries.length === 3 && entries.map((e) => e.name).join("|") === "a.txt|dir/b.js|文件/说明.md");
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.data.toString("utf8")]));
  check("readZipEntries：store 条目原样解出", byName["a.txt"] === "hello");
  check("readZipEntries：deflate 条目 inflateRaw 解出", byName["dir/b.js"] === "console.log(1)");
  check("readZipEntries：UTF-8 中文文件名与内容", byName["文件/说明.md"] === "中文内容");

  // ---------- applyUpdate 落盘语义（集成模拟 2026-11-04 抓出的 bug 回归） ----------
  const AT = fs.mkdtempSync(path.join(os.tmpdir(), "selfupd-apply-"));
  try {
    const simEntries = [
      { name: "run.bat", size: 12, data: Buffer.from("@echo new\n", "utf8") },
      { name: "package.json", size: 20, data: Buffer.from(JSON.stringify({ version: "2.13.0" }), "utf8") },
    ];
    const OLD_BAT = "@echo old\r\n";
    fs.writeFileSync(path.join(AT, "run.bat"), OLD_BAT);
    M.applyUpdate(AT, simEntries, { fromBat: false });
    check("applyUpdate：非 bat 上下文 run.bat 直接覆盖本体", fs.readFileSync(path.join(AT, "run.bat"), "utf8") === "@echo new\n");
    check("applyUpdate：非 bat 上下文不产生 run.bat.new", !fs.existsSync(path.join(AT, "run.bat.new")));
    check("applyUpdate：非 bat 上下文 package.json 已写", JSON.parse(fs.readFileSync(path.join(AT, "package.json"), "utf8")).version === "2.13.0");
    fs.writeFileSync(path.join(AT, "run.bat"), OLD_BAT);
    M.applyUpdate(AT, simEntries, { fromBat: true });
    check("applyUpdate：--from-bat 时 run.bat 本体不动", fs.readFileSync(path.join(AT, "run.bat"), "utf8") === OLD_BAT);
    check("applyUpdate：--from-bat 时新内容落 run.bat.new", fs.readFileSync(path.join(AT, "run.bat.new"), "utf8") === "@echo new\n");
  } finally {
    fs.rmSync(AT, { recursive: true, force: true });
  }

  // ---------- tier2 响应头解析（评审 C1：版本只在第一跳 Location，Content-Disposition 只有常量资产名） ----------
  const hdr = (lines) => lines.join("\r\n");
  check(
    "parseTier2Headers：从第一跳 Location 的 tag 取版本",
    parseTier2Headers(hdr([
      "HTTP/1.1 302 Found",
      "location: https://github.com/o/r/releases/download/v2.14.0/resume-screener-latest.zip",
      "HTTP/1.1 200 OK",
      "content-disposition: attachment; filename=resume-screener-latest.zip",
    ])) === "2.14.0"
  );
  check(
    "parseTier2Headers：Content-Disposition 常量名不是版本 → null（修复前会假报「已是最新」）",
    parseTier2Headers(hdr(["HTTP/1.1 200 OK", "content-disposition: attachment; filename=resume-screener-latest.zip"])) === null
  );
  check(
    "parseTier2Headers：非语义化 tag（nightly 等）→ null，宁失败不猜测",
    parseTier2Headers(hdr(["location: https://github.com/o/r/releases/download/nightly/x.zip"])) === null
  );
  check("parseTier2Headers：空头文本 → null", parseTier2Headers("") === null);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
