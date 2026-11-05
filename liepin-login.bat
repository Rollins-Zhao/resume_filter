@echo off
setlocal
title Liepin Recruiter Login (dedicated profile)

rem ============================================================
rem  WHY THIS FILE EXISTS
rem  --------------------
rem  liepin-cli reads the login session from this folder:
rem      %USERPROFILE%\.liepin-cli\user-data
rem
rem  If you just double-click the normal Chrome icon, Chrome uses
rem  its DEFAULT profile instead -> the login goes to the wrong
rem  place and the CLI keeps reporting "login expired (flag=0)".
rem
rem  ALWAYS log in through THIS file.
rem
rem  STEPS
rem    1) Run this file (double-click)
rem    2) Log in at lpt.liepin.com  (recruiter site)
rem    3) KEEP THIS WINDOW OPEN -- do NOT close it after logging in.
rem       Closing it drops the session and the CLI then reports flag=0.
rem    4) Tell the AI to start screening
rem
rem  WHY --remote-debugging-port=53471
rem  ---------------------------------
rem  With this flag the CLI REUSES this exact browser instance instead
rem  of launching its own. Same session, no hand-off, and you can watch
rem  every request. Without it the CLI tries to start a second instance
rem  and fails on a locked profile ("port 53471 not ready").
rem ============================================================

set "UD=%USERPROFILE%\.liepin-cli\user-data"
set "URL=https://lpt.liepin.com"
set "BROWSER="

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER (
  echo.
  echo  [ERROR] Chrome / Edge not found on this machine.
  echo          Please install Google Chrome, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo  Browser : %BROWSER%
echo  Profile : %UD%
echo.
echo  1^) Log in to the Liepin RECRUITER site  ^(lpt.liepin.com^)
echo  2^) KEEP THIS WINDOW OPEN - do NOT close it after logging in
echo  3^) Then tell the AI to start screening
echo.

start "" "%BROWSER%" --user-data-dir="%UD%" --remote-debugging-port=53471 --no-first-run --no-default-browser-check "%URL%"

endlocal
exit /b 0
