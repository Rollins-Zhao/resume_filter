@echo off
setlocal
chcp 65001 >nul
title 简历筛选 - 猎聘 + BOSS直聘
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未找到 Node.js。请先安装 Node.js 20 以上：https://nodejs.org
  echo         安装完成后先双击 setup.bat，再回来运行本文件。
  echo.
  pause
  exit /b 1
)

rem v2.13.0 自更新：查 GitHub Release 最新版，有新版就地升级后继续（失败只提示不阻塞；SCREENER_SELF_UPDATE=0 关断）
node self-update.js --from-bat
if exist "run.bat.new" move /y "run.bat.new" "run.bat" >nul 2>nul

node run.js %*
echo.
pause
endlocal
