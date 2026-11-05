// boss-agent-cli 调用封装 —— 只读 + JSON 信封解析 + 错误码熔断
//
// 与猎聘封装的三个关键差异（勿照搬猎聘写法）：
//  1) boss-agent-cli 是 **Python CLI**（uv tool / pipx 安装），不是 npm 包；路径探测方式不同。
//  2) 输出是**统一 JSON 信封** {ok,schema_version,command,data,pagination,error,hints}，
//     stdout 只有 JSON、stderr 只有日志 → 直接 JSON.parse(stdout) 即可，无需容忍式抽取。
//  3) **退出码只有 0/1**，错误语义在 error.code 里（52 个错误码）。
//     ⚠️ 未登录（AUTH_REQUIRED）的退出码也是 1，绝不能靠退出码判断风控。
//
// 红线：本模块是通用传输层（不按命令拦截），但"写"只在两处出现——hr download-resume
//      （下载附件）与 hr greet（v2.7.0 唯一例外：仅 greet.js 在 profiles/_user.json
//      settings.greet.enabled=true 授权下调它并传 --yes；"操作者已批准" = 首跑两问授权 + 话术已配）。
//      reply / request-resume / accept-resume / exchange 仍无任何封装，100% 由用户手动完成。
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------- 错误类型（与猎聘版语义对齐，供上层熔断分支）----------
class FatalError extends Error {}        // 风控/账号异常 → 全停
class LoginExpired extends Error {}      // 登录态失效 → 请用户重新登录
class RateLimited extends Error {}       // 频率限制 → 停止本轮
class VerificationRequired extends Error {} // 平台要求人工验证 → 全停交人工
// 平台风控错误码（ACCOUNT_RISK 等，FatalError 的子类）：screener 捕获后额外落本地风控锁
//（2026-10-27 与刷新/登录环守护同源同纪律：风控态账号拒绝带热度重跑）
class RiskControlError extends FatalError {}

// 立即全停的错误码（recoverable=false 里的风控类 + 需人工验证）
const STOP_CODES = new Set(["ACCOUNT_RISK", "ENVIRONMENT_RISK", "LOGIN_RISK_CONTROL"]);
const VERIFY_CODES = new Set(["PLATFORM_VERIFICATION_REQUIRED"]);
const AUTH_CODES = new Set(["AUTH_REQUIRED", "AUTH_EXPIRED", "LOGIN_EXPIRED", "TOKEN_REFRESH_FAILED"]);
const RATE_CODES = new Set(["RATE_LIMITED"]);

// ---------- 可执行文件探测 ----------
// 优先级：BOSS_BIN 环境变量 → uv tool 目录 → pipx 目录 → ~/.local/bin → 系统 PATH 的 "boss"
function resolveBossBin() {
  if (process.env.BOSS_BIN) return process.env.BOSS_BIN;
  const names = process.platform === "win32" ? ["boss.exe", "boss.cmd", "boss.bat"] : ["boss"];
  const home = os.homedir();
  const dirs = [
    path.join(home, ".local", "bin"),                                  // uv tool / pipx 默认装到这儿
    path.join(home, ".local", "share", "uv", "tools", "boss-agent-cli", "Scripts"),
    path.join(home, "AppData", "Roaming", "Python", "Scripts"),        // pip --user（Windows）
  ];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* 忽略探测异常 */
      }
    }
  }
  return "boss"; // 交给系统 PATH
}

// ---------- 主调用 ----------
/**
 * 执行一次 boss 命令。
 * @param {string[]} args  命令与参数数组（不要自己拼引号）
 * @param {object}   opts  {bin, timeoutMs, logger, stripProxy}
 * @returns {{ok:boolean, code:string|null, envelope:object|null, raw:string, exit:number}}
 * 错误码命中红线时**抛异常**（不返回），由上层决定全停还是跳过的语义。
 */
function runBoss(args, opts = {}) {
  const bin = opts.bin || resolveBossBin();
  const env = { ...process.env };
  // boss-agent-cli 刻意尊重系统代理（httpx trust_env=True）。
  // 若沙箱注入的代理指向不可达地址，会让所有请求失败；默认剥离，可用 BOSS_KEEP_PROXY=1 保留。
  if (process.env.BOSS_KEEP_PROXY !== "1") {
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "*";
  }

  // Python CLI 在 Windows 管道下默认按 ANSI(GBK) 编码写 stdout——响应里出现 GBK 外字符
  // （如候选人简介中的部首/生僻字 ⽅ 等）时 print 直接崩，整条命令被包装成 NETWORK_ERROR
  // （2026-10-21 真机实测定位，抽奖式故障：响应内容决定成败）。强制 UTF-8 输出，
  // 与本封装按 encoding:"utf8" 解析 stdout 的约定一致，也顺带消除中文 stderr 乱码。
  env.PYTHONUTF8 = "1";

  // ---- 全局参数注入（必须在子命令之前）----
  //  1) --cdp-url：stoken 是动态反爬令牌，只能从活着的浏览器实时取。
  //     不注入 CDP 时，只读命令会因缺 __zp_stoken__ 失败。
  //     CLI 只默认探 localhost:9222（DEFAULT_CDP_URL），本 skill 用 Edge 的 9333 → 必须显式传。
  //     注：--cdp-url 是全局参数（挂在 cli 上），不是 login/search 等子命令的参数。
  //  2) --role recruiter：hr * 系列是招聘者命令，不显式指定 role 时子命令不会被识别。
  //  两者都可由环境变量覆盖/关闭：
  //     BOSS_CDP_URL=...  指定 CDP 地址（默认 http://127.0.0.1:9333）
  //     BOSS_CDP_URL=off  完全关闭 CDP 注入（走 CLI 自己的降级链路）
  const cdpUrl = process.env.BOSS_CDP_URL || "http://127.0.0.1:9333";
  let finalArgs = args;
  const inject = [];
  if (cdpUrl && cdpUrl.toLowerCase() !== "off" && !args.includes("--cdp-url")) {
    inject.push("--cdp-url", cdpUrl);
  }
  if (!args.includes("--role")) {
    inject.push("--role", process.env.BOSS_ROLE || "recruiter");
  }
  //  3) --delay 注入机制（v2.9.7 起默认不用）：CLI v3.1.0 的 30-60s 请求节流是防识别保护，
  //     2026-10-30 用户拍板保持官方默认。机制保留仅供用户本人显式设 BOSS_CLI_DELAY 应急使用，
  //     本工具自身任何进程都不再默认设置它。
  const cliDelay = process.env.BOSS_CLI_DELAY;
  if (cliDelay && !args.includes("--delay")) {
    inject.push("--delay", cliDelay);
  }
  if (inject.length) finalArgs = [...inject, ...args];

  let stdout = "";
  let exit = 0;
  try {
    stdout = execFileSync(bin, finalArgs, {
      env,
      encoding: "utf8",
      timeout: opts.timeoutMs || 180000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    exit = typeof e.status === "number" ? e.status : 1;
    stdout = (e.stdout || "").toString();
    if (!stdout && e.stderr) {
      // 极端情况：命令彻底没跑起来（如 CLI 未安装），stdout 为空
      const msg = (e.stderr || e.message || "").toString().split("\n")[0];
      if (/ENOENT|not found|不是内部或外部命令/.test(msg)) {
        throw new FatalError(
          `找不到 boss 命令（${bin}）。请先安装：uv tool install boss-agent-cli（详见 SKILL.md 步骤1）`
        );
      }
    }
  }

  if (opts.logger) {
    opts.logger.append(
      `\n$ boss ${finalArgs.join(" ")}\n[exit ${exit}]\n${stdout.slice(0, 20000)}\n`
    );
  }

  // 统一 JSON 信封：stdout 应当整体即为 JSON
  let envelope = null;
  const trimmed = (stdout || "").trim();
  if (trimmed) {
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      // 兜底：从首个 { 或 [ 处尝试逐段解析（stderr 混入等异常场景）
      const start = Math.min(
        ...["[", "{"].map((c) => {
          const i = trimmed.indexOf(c);
          return i === -1 ? Infinity : i;
        })
      );
      if (start !== Infinity) {
        for (let end = trimmed.length; end > start; end--) {
          try {
            envelope = JSON.parse(trimmed.slice(start, end));
            break;
          } catch {
            /* 继续收窄 */
          }
        }
      }
    }
  }

  const code = envelope && envelope.error ? envelope.error.code : null;

  // ---- 红线错误码 → 抛异常（由上层熔断）----
  if (code) {
    if (STOP_CODES.has(code)) {
      throw new RiskControlError(
        `${code}：${envelope.error.message}。**立即停止全部自动化**，请用户人工检查账号与访问环境`
      );
    }
    if (VERIFY_CODES.has(code)) {
      throw new VerificationRequired(
        `平台要求人工验证（${code}）。**立即终止**，请用户在 BOSS 官方页面完成验证后再评估`
      );
    }
    if (AUTH_CODES.has(code)) {
      throw new LoginExpired(`${code}：${envelope.error.message}。请先 boss login`);
    }
    if (RATE_CODES.has(code)) {
      throw new RateLimited(`${code}：请求频率过高，本轮停止`);
    }
  }

  // 记录风控提示（未命中硬红线但 hints 里带风险信息时，由上层决定是否降速）
  return { ok: !!(envelope && envelope.ok), code, envelope, raw: stdout, exit, bin };
}

module.exports = {
  runBoss,
  resolveBossBin,
  FatalError,
  LoginExpired,
  RateLimited,
  VerificationRequired,
  RiskControlError,
  AUTH_CODES,
};
