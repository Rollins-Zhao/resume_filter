#!/usr/bin/env node
/**
 * ai-guide-sync.js —— 把 AI-GUIDE.md（权威契约）同步到各 AI 平台自动读取的记忆/规则文件
 *
 * 用法：
 *   node ai-guide-sync.js                 # 默认同步 workbuddy
 *   node ai-guide-sync.js <平台别名>       # 如 doubao / claude / cursor（见 ai-guide-targets.json）
 *   node ai-guide-sync.js --all           # 同步注册表里的全部目标
 *   node ai-guide-sync.js --list          # 列出已注册平台
 *   node ai-guide-sync.js --add X=路径    # 注册新平台并立即同步
 *   node ai-guide-sync.js path/xxx.md     # 参数含 / 或 \ 时视为目标文件路径（临时同步，不注册）
 *
 * 同步规则（幂等，对目标文件的其余内容零影响）：
 *   - 目标不存在 → 生成（契约块 + 空行）；
 *   - 已存在无契约标记 → 在文件**头部插入**契约块；
 *   - 已有标记 → 只替换标记块之间的内容。
 *   契约块由 `<!-- AI-GUIDE ... BEGIN -->` / `<!-- AI-GUIDE ... END -->` 包裹。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const GUIDE_PATH = path.join(ROOT, "AI-GUIDE.md");
const TARGETS_PATH = path.join(ROOT, "ai-guide-targets.json");
const TAG_BEGIN = "<!-- AI-GUIDE (由 ai-guide-sync.js 维护，改契约请改 AI-GUIDE.md 后重新同步) BEGIN -->";
const TAG_END = "<!-- AI-GUIDE END -->";

function loadTargets() {
  try {
    const t = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(t)) if (!k.startsWith("_")) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
function saveTargets(t) {
  const cur = loadTargets();
  const merged = { _说明: "AI 平台记忆文件注册表：键=平台别名，值=该平台 AI 会话自动读取的文件（相对项目根）。ai-guide-sync.js 把 AI-GUIDE.md 契约同步到这些文件（幂等合并，只动契约标记块）。新平台：node ai-guide-sync.js --add 别名=路径", ...cur, ...t };
  fs.writeFileSync(TARGETS_PATH, JSON.stringify(merged, null, 2) + "\n");
}

/** 把契约块同步进目标文件（幂等） */
function syncFile(relTarget) {
  const guide = fs.readFileSync(GUIDE_PATH, "utf8").trim();
  const block = `${TAG_BEGIN}\n\n${guide}\n\n${TAG_END}`;
  const abs = path.resolve(ROOT, relTarget);
  let updated;
  if (!fs.existsSync(abs)) {
    updated = block + "\n";
  } else {
    const cur = fs.readFileSync(abs, "utf8");
    const bi = cur.indexOf(TAG_BEGIN);
    const be = cur.indexOf(TAG_END);
    if (bi !== -1 && be !== -1 && be > bi) {
      updated = cur.slice(0, bi) + block + cur.slice(be + TAG_END.length);
    } else {
      updated = block + "\n\n" + cur; // 头部插入，原内容全部保留
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, updated);
  console.log(`[ai-guide-sync] 已同步 → ${relTarget}`);
}

function main() {
  const args = process.argv.slice(2);
  const targets = loadTargets();

  if (args.includes("--list") || args.includes("-l")) {
    console.log("已注册平台（别名 → 目标文件）：");
    for (const [k, v] of Object.entries(targets)) console.log(`  ${k} → ${v}`);
    return;
  }

  const addIdx = args.indexOf("--add");
  if (addIdx !== -1) {
    const spec = args[addIdx + 1];
    const eq = spec && spec.indexOf("=");
    if (!spec || eq === -1) { console.error("用法：--add 别名=相对路径（如 --add trae=.trae/rules/project.md）"); process.exit(1); }
    const name = spec.slice(0, eq).trim();
    const p = spec.slice(eq + 1).trim();
    saveTargets({ [name]: p });
    console.log(`[ai-guide-sync] 已注册平台 ${name} → ${p}`);
    syncFile(p);
    return;
  }

  let want = args.find((a) => !a.startsWith("--")) || "workbuddy";
  if (args.includes("--all")) {
    const list = Object.entries(targets);
    if (!list.length) { console.error("注册表为空"); process.exit(1); }
    for (const [, p] of list) syncFile(p);
    return;
  }
  if (/[\\/]/.test(want)) { syncFile(want); return; } // 直接给路径
  const target = targets[want];
  if (!target) {
    console.error(`未注册的平台「${want}」。已注册：${Object.keys(targets).join("、")}。`);
    console.error(`注册新平台：node ai-guide-sync.js --add ${want}=<该平台 AI 自动读取的文件路径>`);
    process.exit(1);
  }
  syncFile(target);
}

if (!fs.existsSync(GUIDE_PATH)) { console.error("找不到 AI-GUIDE.md"); process.exit(1); }
main();
