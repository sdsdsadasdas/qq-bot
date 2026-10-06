@echo off
REM ============================================================
REM  Console launcher for the QQ bot (graphical control panel).
REM
REM  Double-click this file. Behaviour:
REM    * port free                  -> start the console (= opens the browser)
REM    * our console, code fresh    -> just open the browser at it
REM    * our console, code STALE    -> restart it automatically (and say why)
REM    * port held by something else-> report it and stop. NEVER kill it.
REM
REM  Why there is no "press Y/N" prompt any more (measured, twice):
REM    the previous version asked "Restart the console? [Y/N]" in English.
REM    A console left running by an earlier test made every double-click land
REM    on that prompt, the user did not know what to press, and the result was
REM    "the console will not open". A launcher must not require reading a
REM    question in order to do the obvious thing.
REM
REM  Why the stale check exists: server.js / page.js are read into memory once
REM    at startup, so a console that is already running keeps serving OLD code.
REM    Refreshing the browser does NOT pick up edits. Restarting automatically
REM    when those files are newer than the process is what makes double-click
REM    mean "give me a console with the current code".
REM
REM  Why it only kills OUR console: the old code did
REM    "Stop-Process on whatever owns the port" -- that would happily kill an
REM    unrelated program that happened to sit on 7788. Now the PID comes from
REM    our own /api/ping, and a foreign listener is reported instead.
REM
REM  IMPORTANT: this file is ASCII-ONLY and CRLF on purpose (cmd reads .cmd
REM  with the ANSI codepage; mojibake at the start of a line gets executed).
REM
REM  Batch runs top-to-bottom: the port-free path must reach the start code
REM  with NO label block in between; every other block is reached only by goto.
REM ============================================================
setlocal
cd /d "%~dp0"

REM The port can be overridden from the environment (GUI_PORT=7789), which is
REM also what the conflict message below tells the user to do. Setting it
REM unconditionally would silently ignore that override -- checked.
if "%GUI_PORT%"=="" (set "GUIPORT=7788") else (set "GUIPORT=%GUI_PORT%")
set "GUIURL=http://127.0.0.1:%GUIPORT%"

REM ---- 0. find node ---------------------------------------------------
REM
REM Why this does not just call "node": on this machine Node.js is NOT
REM installed and NOT on the user's PATH (measured: no C:\Program Files\nodejs,
REM no nvm/volta/fnm, nothing node-ish in the system or user PATH).  The only
REM node.exe is the one bundled inside the DSH desktop app, and DSH injects its
REM shim directory into the PATH of processes IT spawns -- so "node" works from
REM a DSH terminal and fails from a plain double-click.  Which is exactly the
REM error this check used to print:
REM     Node.js was not found on PATH -- the console cannot start.
REM
REM So look in the usual places, then fall back to the DSH bundle, and SAY
REM which one was used.  Order: explicit override -> PATH -> standard install
REM dirs -> project-local copy -> DSH bundle.
set "NODE_EXE="

if defined QQ_BOT_NODE if exist "%QQ_BOT_NODE%" set "NODE_EXE=%QQ_BOT_NODE%"

if not defined NODE_EXE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)

if not defined NODE_EXE (
  for %%p in (
    "%ProgramFiles%\nodejs\node.exe"
    "%ProgramFiles(x86)%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%LOCALAPPDATA%\Volta\bin\node.exe"
    "%APPDATA%\nvm\node.exe"
    "%NVM_SYMLINK%\node.exe"
    "%LOCALAPPDATA%\Microsoft\WinGet\Links\node.exe"
    "%~dp0node\node.exe"
    "%~dp0node.exe"
  ) do (
    if not defined NODE_EXE if exist %%p set "NODE_EXE=%%~fp"
  )
)

if not defined NODE_EXE (
  for %%p in (
    "C:\Program Files\DSH Desktop\resources\app\node_modules\node\bin\node.exe"
    "C:\Program Files\DSH Desktop\resources\app\node_modules\node\bin\node.exe"
  ) do (
    if not defined NODE_EXE if exist %%p set "NODE_EXE=%%~fp"
  )
)

if not defined NODE_EXE (
  echo.
  echo   Node.js was not found anywhere I know how to look.
  echo.
  echo   Looked at: PATH, the usual install folders, a copy next to this
  echo   file, and the Node bundled with DSH Desktop.
  echo.
  echo   Fix it by installing Node.js ^(https://nodejs.org^), or point me at
  echo   an existing node.exe:
  echo.
  echo       set QQ_BOT_NODE=D:\somewhere\node.exe
  echo.
  pause
  exit /b 1
)
echo   node: %NODE_EXE%

REM ---- 1. is anything listening on the port? -------------------------
powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',%GUIPORT%); if($c.Connected){exit 0}; exit 1 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 goto :startit

REM ---- 2. something is there: is it OUR console, and is it fresh? -----
REM   exit 0 = ours and fresh       -> open the browser
REM   exit 2 = ours but stale       -> restart it
REM   exit 3 = not ours / no answer -> report, do not touch it
powershell -NoProfile -Command "$u='http://127.0.0.1:%GUIPORT%/api/ping'; for($i=0;$i -lt 3;$i++){ try { $j=(Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $u).Content | ConvertFrom-Json; if($j.app -ne 'qq-bot-console'){ exit 3 }; if($j.console -and $j.console.stale){ exit 2 }; exit 0 } catch { Start-Sleep -Milliseconds 700 } }; exit 3"
if errorlevel 3 goto :conflict
if errorlevel 2 goto :restart
goto :openonly

REM =====================================================================
REM  port free, or old console already stopped -> start the console
REM =====================================================================
:startit
echo.
echo   QQ Bot Console
echo   --------------
echo   URL    : %GUIURL%
echo   Closing this window stops the console and the bot.
echo.

set GUI_PORT=%GUIPORT%
set GUI_OPEN=1
"%NODE_EXE%" gui\server.js

echo.
echo   Console exited.
echo   If it exited immediately, read the error above (port busy? node
echo   version? config.json unreadable?).
echo.
pause
exit /b 0

REM =====================================================================
REM  our console, but it loaded old code -> restart it
REM =====================================================================
:restart
echo.
echo   A console is already running, but it serves OLD code
echo   (server.js / page.js were edited after it started).
echo   Restarting it now. If a bot was running under it, that bot stops too.
echo.
powershell -NoProfile -Command "$j=(Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 'http://127.0.0.1:%GUIPORT%/api/ping').Content | ConvertFrom-Json; if($j.pid){ Stop-Process -Id $j.pid -Force; exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo   Could not read the console PID -- close the old console window by
  echo   hand, then run this file again.
  echo.
  pause
  exit /b 1
)
echo   Stopped. Waiting for the port to free up...
timeout /t 3 >nul 2>&1
goto :startit

REM =====================================================================
REM  port held by something that is not our console
REM =====================================================================
:conflict
echo.
echo   Port %GUIPORT% is in use by something that is NOT the qq-bot console
echo   (no answer from /api/ping). Nothing was started and nothing was killed.
echo.
echo   Who is holding it:
echo.
powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort %GUIPORT% -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($p){ $x=Get-Process -Id $p -ErrorAction SilentlyContinue; '    PID ' + $p + '  ' + $x.ProcessName } else { '    (could not tell)' }"
echo.
echo   Either close that program, or run the console on another port:
echo      set GUI_PORT=7789
echo.
pause
exit /b 1

REM =====================================================================
REM  our console is running with current code -> just show it
REM =====================================================================
:openonly
echo.
echo   Console is already running with current code.
echo   Opening %GUIURL%
echo.
start "" "%GUIURL%"
echo   This window closes in 3 seconds...
timeout /t 3 >nul 2>&1
exit /b 0
