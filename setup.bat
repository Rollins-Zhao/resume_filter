@echo off
setlocal
chcp 65001 >nul
title 简历筛选工具 - 一次性安装
cd /d "%~dp0"

echo ============================================================
echo   简历筛选工具（猎聘 + BOSS直聘）- 一次性安装
echo   安装位置: %CD%
echo ============================================================
echo.

rem ---------- 1. Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未找到 Node.js。
  echo         请先安装 Node.js 20 或更新版本：https://nodejs.org
  echo         装好后重新双击本文件。
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo  [OK] Node.js %%v

rem ---------- 2. 猎聘依赖 ----------
echo.
echo  [1/3] 安装猎聘依赖（exceljs + liepin-cli），约 1-3 分钟 ...
echo.

call npm install exceljs @viyzhu/liepin-cli --registry=https://registry.npmmirror.com --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo  [提示] 国内镜像安装失败，改用官方源重试 ...
  call npm install exceljs @viyzhu/liepin-cli --no-audit --no-fund
)

rem 已知坑：部分镜像源会把 proxy-agent 的嵌套包装残缺（缺 dist/index.js），
rem 导致 liepin --version 报错。处理：删掉残缺包，顶层补装 proxy-agent@6.5.0。
if not exist "node_modules\proxy-agent\dist\index.js" (
  echo.
  echo  修复已知的 proxy-agent 残缺包问题 ...
  if exist "node_modules\proxy-agent" rmdir /s /q "node_modules\proxy-agent" 2>nul
  if exist "node_modules\@puppeteer\browsers\node_modules\proxy-agent" rmdir /s /q "node_modules\@puppeteer\browsers\node_modules\proxy-agent" 2>nul
  call npm install proxy-agent@6.5.0 --registry=https://registry.npmmirror.com --no-audit --no-fund
)

rem 用户铁律：CLI 必查必升——npm install 对已装包不升级，这里显式检查并升级 liepin-cli（失败不阻断安装）
echo.
echo  检查并升级 liepin-cli ...
call node liepin-resume-screener\scripts\check-cli-update.js

rem ---------- 3. BOSS 组件（可选）----------
echo.
set /p WANT_BOSS=  [2/3] 是否安装 BOSS 直聘组件？需要 Python 3.10+（直接回车=安装，输 n 跳过）：
if /i "%WANT_BOSS%"=="n" goto verify

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [提示] 未找到 Python。BOSS 组件需要 Python 3.10+：https://python.org
  echo         可稍后装好 Python 再重跑本文件；猎聘功能不受影响。
  goto verify
)

echo.
echo  安装 uv（包管理器，清华镜像优先）...
python -m pip install uv -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 python -m pip install uv

echo.
echo  安装 boss-agent-cli（清华镜像优先）...
python -m uv tool install boss-agent-cli --index-url https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 (
  echo  [提示] 镜像失败，改用官方源重试 ...
  python -m uv tool install boss-agent-cli
  if errorlevel 1 (
    echo  [警告] boss-agent-cli 安装失败。可稍后重跑本文件；猎聘功能不受影响。
    goto verify
  )
)

echo.
echo  [3/3] 预下载 BOSS 浏览器内核（约 200MB，只需一次；跳过也不影响，运行时会自动装）...
node boss-resume-screener\scripts\check-cli-update.js --install-browsers
if errorlevel 1 (
  echo  [提示] 内核下载失败（可能是网络问题）。首次运行 run.bat 跑 BOSS 时会自动重试；
  echo         也可按 boss-resume-screener\SKILL.md 的排障说明手动安装。
)

:verify
echo.
echo  ---------- 安装校验 ----------
echo.
if exist "node_modules\.bin\liepin.cmd" (
  echo  [OK] liepin-cli：
  call "node_modules\.bin\liepin.cmd" --version
) else (
  echo  [警告] 未找到 liepin-cli，请把上面的报错信息发给管理员。
)
node -e "require('exceljs');console.log('  [OK] exceljs 可用')" 2>nul || echo  [警告] exceljs 不可用，请重跑本文件
if exist "%USERPROFILE%\.local\bin\boss.exe" (
  echo  [OK] boss-agent-cli：
  "%USERPROFILE%\.local\bin\boss.exe" --version
) else (
  echo  [提示] 未找到 boss 命令。若刚才跳过了 BOSS 安装，属正常；否则请重跑本文件。
)

echo.
echo  ---------- AI 使用契约同步（默认 workbuddy） ----------
echo  把 AI-GUIDE.md 的使用契约写入 workbuddy 记忆文件，AI 对话才会先问你的公司/行业背景 ...
node ai-guide-sync.js workbuddy
if errorlevel 1 (
  echo  [提示] 同步失败（不影响安装）。可稍后手动运行：node ai-guide-sync.js workbuddy
  echo         换其他 AI 平台（豆包等）见 README「换平台」说明。
)

echo.
echo ============================================================
echo   安装完成。
echo.
echo   下一步：
echo     1. 双击登录器扫码（窗口保持开着，关窗=掉登录）：
echo          猎聘：     liepin-login.bat
echo          BOSS直聘： boss-edge-login.bat（Edge）
echo                     boss-zhipin-login.bat（Chrome）
echo     2. 双击 run.bat，选平台和岗位，等它跑完
echo     3. 去 reports/ 目录拿 Excel 推荐报告
echo.
echo   新岗位：复制 profiles\_template.json 改名填写，
echo          或参考 example-销售经理.json。
echo ============================================================
echo.
pause
endlocal
