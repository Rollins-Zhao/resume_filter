@echo off
setlocal
chcp 65001 >nul
title 简历筛选工具 - 引导安装
cd /d "%~dp0"

echo ============================================================
echo   简历筛选工具引导安装：工具将安装到本文件所在的文件夹。
echo   建议先把它单独放进一个专用空文件夹（如 D:\resume_filter）。
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未找到 Node.js。请先安装 Node.js 20 以上：https://nodejs.org
  echo         装好后回到本文件夹重新双击本文件。
  echo.
  pause
  exit /b 1
)

where curl >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未找到 curl（Windows 10 1803+ 自带）。请改用仓库 Release 页的 zip 手动解压安装。
  echo.
  pause
  exit /b 1
)

echo  [1/3] 下载最新版（约 0.4MB，失败请检查网络后重跑本文件）...
curl -sSL --retry 5 --retry-all-errors --max-time 300 -o resume-screener-latest.zip "https://github.com/Rollins-Zhao/resume_filter/releases/latest/download/resume-screener-latest.zip"
if errorlevel 1 (
  echo  [错误] 下载失败。可到仓库 Release 页手动下载 zip，解压到本文件夹后直接从第 3 步继续。
  echo.
  pause
  exit /b 1
)

echo  [2/3] 解压...
tar -xf resume-screener-latest.zip
if errorlevel 1 (
  powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath 'resume-screener-latest.zip' -DestinationPath '.' -Force"
)
if errorlevel 1 (
  echo  [错误] 解压失败（tar 与 PowerShell 都没成功）。zip 已保留在本文件夹，请手动解压出全部文件后，再回来双击本文件夹里的 setup.bat。
  echo.
  pause
  exit /b 1
)
del resume-screener-latest.zip >nul 2>nul

echo  [3/3] 完成。
echo.
echo  下一步（按顺序）：
echo    1. 双击 setup.bat    安装依赖（首次约 3-10 分钟）
echo    2. 双击 登录器 .bat  扫码登录招聘平台（猎聘/BOSS 各一个）
echo    3. 双击 run.bat      开始使用（此后每次启动自动保持最新，无需再手动更新）
echo.
pause
endlocal
