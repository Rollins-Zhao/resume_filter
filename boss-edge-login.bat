@echo off
setlocal
title BOSS Login (Edge dedicated profile)

rem ============================================================
rem  BOSS Zhipin login launcher -- Microsoft Edge version
rem
rem  Use this if you prefer Edge, or if Chrome is not installed.
rem
rem  WHY THIS FILE EXISTS
rem  --------------------
rem  The CLI reads the login session from this folder:
rem      %USERPROFILE%\.boss-agent\edge-cdp-profile
rem
rem  ALWAYS log in through THIS file (not the Edge taskbar icon).
rem
rem  WHAT THIS SCRIPT DOES (important fixes)
rem  ---------------------------------------
rem  - Uses a DEDICATED profile folder, so it never mixes with your
rem    daily Edge.
rem  - Opens a remote-debugging port (9333) so the AI can read the
rem    login session directly.
rem  - Disables the "sync confirmation" page that used to STEAL the
rem    window (Edge showed: "now syncing your data..." and the BOSS
rem    QR page never appeared).
rem  - Cleans a stale profile lock left by a previous crashed run.
rem
rem  STEPS
rem    1) Double-click this file
rem    2) In the page, click "APP scan to login"
rem    3) Scan the QR code with your BOSS APP, confirm on phone
rem    4) KEEP THE EDGE WINDOW OPEN
rem    5) Tell the AI: scanned
rem ============================================================

set "UD=%USERPROFILE%\.boss-agent\edge-cdp-profile"
set "URL=https://www.zhipin.com/web/user/"
set "BROWSER="

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER (
  echo.
  echo  [ERROR] Microsoft Edge not found.
  echo.
  pause
  exit /b 1
)

if not exist "%UD%" mkdir "%UD%" >nul 2>&1

rem --- remove stale profile lock from a previous crashed run ---
if exist "%UD%\SingletonLock" del /f /q "%UD%\SingletonLock" >nul 2>&1

echo.
echo  Browser : %BROWSER%
echo  Profile : %UD%
echo  Port    : 9333
echo.
echo  1^) In the page click "APP scan to login"
echo  2^) Scan the QR code with your BOSS APP
echo  3^) KEEP THE EDGE WINDOW OPEN
echo  4^) Then tell the AI: scanned
echo.

start "" "%BROWSER%" --user-data-dir="%UD%" --remote-debugging-port=9333 --no-first-run --no-default-browser-check --no-sync --disable-sync --disable-features=msEdgeSyncPromo,msEdgeIdentitySignin,msImplicitSignin,EdgeSyncPromo "https://www.zhipin.com/web/user/"

endlocal
exit /b 0
