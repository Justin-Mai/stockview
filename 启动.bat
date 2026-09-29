@echo off
rem ============================================================
rem  Stockview - local stock / fund / crypto ledger
rem  This launcher is intentionally ASCII-only: cmd.exe mis-parses
rem  UTF-8 multibyte lines, so all Chinese text is printed by Node.
rem ============================================================
chcp 65001 >nul
title Stockview Ledger
cd /d "%~dp0"

echo.
echo   ==========================================================
echo     Stockview  -  Stocks / Funds / Crypto  (local ledger)
echo   ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "node_modules\stock-sdk" (
  echo   First run detected: installing market-data dependency ...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto npmfail
  echo.
)

echo   Starting local server. Your browser will open automatically.
echo   Keep this window open - closing it stops the server.
echo.

node "server\index.js" --open

echo.
echo   Server stopped.
echo   Press any key to exit.
pause >nul
exit /b 0

:nonode
echo   [ERROR] Node.js was not found on this computer.
echo.
echo   Please install Node.js 18 or newer from https://nodejs.org
echo   then double-click this file again.
echo.
pause >nul
exit /b 1

:npmfail
echo.
echo   [ERROR] Failed to install dependencies.
echo   Please check your network connection and try again.
echo.
pause >nul
exit /b 1
