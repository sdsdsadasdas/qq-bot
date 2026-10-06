@echo off
REM ============================================================
REM  DEPRECATED -- this launcher no longer starts the bot alone.
REM
REM  Why: the bot posts into a REAL group chat. With no console
REM  open you cannot see what it is saying, and you cannot stop it
REM  with one click. That is the worst possible state, so the rule
REM  is: no console, no bot.
REM
REM  This file used to run "node src\bot.js --watch" with no
REM  control panel at all. It now just tells you what to do
REM  instead, so old muscle memory cannot silently start an
REM  unwatched bot.
REM
REM  What to do:
REM    double-click the OTHER .cmd in this folder
REM    (the console launcher -- its name is in Chinese).
REM    That starts the console AND the bot together.
REM
REM  If you really need a bare terminal run (debugging/automation)
REM  it is still possible, but must be explicit:
REM    node src\bot.js --watch --allow-no-console
REM   or set console.required=false in config.json.
REM
REM  NOTE: bot.js itself now refuses to start without a console,
REM  so bypassing this file still will not get you an unwatched bot.
REM
REM  IMPORTANT: ASCII-only and CRLF on purpose. Windows cmd reads
REM  .cmd using the ANSI codepage (GBK on a Chinese system), so a
REM  UTF-8 file turns Chinese into mojibake -- and mojibake at the
REM  start of a line gets executed as a command. Bare LF also
REM  breaks: multi-line if blocks get skipped silently.
REM  (Both measured. This file was rewritten to fix exactly that.)
REM ============================================================
setlocal
cd /d "%~dp0"

echo.
echo   This launcher no longer starts the bot on its own.
echo   -------------------------------------------------
echo.
echo   The bot posts into a real group chat. Without the console
echo   you cannot see what it is saying and cannot stop it easily.
echo.
echo   Start it the normal way instead -- double-click the other
echo   .cmd file in this folder (the console launcher).
echo.
echo   That starts the console AND the bot, and closing the console
echo   window stops the bot too.
echo.
echo   Bare terminal run (deliberately explicit):
echo.
echo       node src\bot.js --watch --allow-no-console
echo.
pause
exit /b 1
