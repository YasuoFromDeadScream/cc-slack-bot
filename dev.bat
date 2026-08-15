@echo off
setlocal
cd /d "%~dp0"

chcp 65001 >nul
title cc-slack-bot (dev)

REM Runs the same command as the "dev" script in package.json.
REM pnpm is not installed under Volta on this machine, so node is called directly.
echo [dev] node --watch index.js
node --watch index.js

echo.
echo [dev] stopped with exit code %errorlevel%
pause
