@echo off
setlocal
title BOSS Login (Chrome dedicated profile)

rem ============================================================
rem  BOSS Zhipin login launcher -- Chrome version
rem
rem  WHY THIS FILE EXISTS
rem  --------------------
rem  The CLI reads the login session from this folder:
rem      %USERPROFILE%\.boss-agent\chrome-cdp-profile
rem
rem  If you double-click the normal Chrome icon, Chrome uses its
rem  DEFAULT profile -> login goes to the wrong place and the CLI
rem  keeps reporting "not logged in".
rem
rem  ALWAYS log in through THIS file.
rem
rem  WHAT THIS SCRIPT DOES (important fixes)
rem  ---------------------------------------
rem  - Uses a DEDICATED profile folder, so it never mixes with your
rem    daily Chrome.
rem  - Opens a remote-debugging port (9222) so the AI can read the
rem    login session directly.
rem  - Disables the "sync / sign-in / first-run" popups that used
rem    to STEAL the window and make the QR page never appear.
rem  - Cleans a stale profile lock left by a previous crashed run.
rem
rem  STEPS
rem    1) Double-click this file
rem    2) In the page, click "APP scan to login"
rem    3) Scan the QR code with your BOSS APP, confirm on phone
rem    4) KEEP THE CHROME WINDOW OPEN
rem    5) Tell the AI: scanned
rem ============================================================

set "UD=%USERPROFILE%\.boss-agent\chrome-cdp-profile"
set "URL=https://www.zhipin.com/web/user/"
set "BROWSER="

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not defined BROWSER (
  echo.
  echo  [ERROR] Google Chrome not found on this machine.
  echo          Please install Google Chrome, then run this file again.
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
echo  Port    : 9222
echo.
echo  1^) In the page click "APP scan to login"
echo  2^) Scan the QR code with your BOSS APP
echo  3^) KEEP THE CHROME WINDOW OPEN
echo  4^) Then tell the AI: scanned
echo.

start "" "%BROWSER%" --user-data-dir="%UD%" --remote-debugging-port=9222 --no-first-run --no-default-browser-check --no-sync --disable-sync --disable-features=SyncPromoUI,SigninPromo,ChromeSignin,SigninAllowed,EdgeSyncPromo "https://www.zhipin.com/web/user/"

endlocal
exit /b 0
