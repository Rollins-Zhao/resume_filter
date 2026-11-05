@echo off
setlocal
chcp 65001 >nul
title 简历筛选工具 - 打干净包给下一个人
cd /d "%~dp0"

rem ============================================================
rem  为什么要有这个文件
rem  --------------------
rem  把工具转发给其他同事时，千万不要右键压缩整个文件夹！
rem  文件夹里还有你的真实岗位画像、候选人简历缓存和报告，
rem  这些数据绝不能离开你的电脑。
rem
rem  本启动器运行 pack-release.js，只把白名单里的文件
rem  （工具本体 + 画像模板 + 说明文档）收进 release\ 下的干净压缩包。
rem
rem  用法
rem     双击本文件
rem     想换版本号：
rem        pack-release.bat --version 2.0.1
rem ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [错误] 未找到 Node.js。请先安装 Node.js 20 以上：https://nodejs.org
  echo         装好后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   打包中 —— 只收白名单文件，生成可转发的干净压缩包
echo   当前目录: %CD%
echo ============================================================
echo.
echo  你的岗位画像 / 候选人数据 / 报告都不会进包。
echo.

call node "%~dp0pack-release.js" %*

if errorlevel 1 (
  echo.
  echo  [错误] 打包失败，请看上面的报错信息。
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   完成。
echo   输出位置:  %CD%\release\
echo   把里面的 .zip 发给对方即可。
echo.
echo   包里只有工具、画像模板和说明文档，
echo   绝不含你的候选人数据。
echo ============================================================
echo.
pause
endlocal
