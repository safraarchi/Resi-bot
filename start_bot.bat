@echo off
cd /d "%~dp0"
reg add HKCU\Console /v QuickEdit /t REG_DWORD /d 0 /f >nul 2>&1
title Bot Resi Telegram - Antigravity
color 0A
echo ========================================================
echo         MENJALANKAN BOT RESI TELEGRAM (LOKAL)
echo ========================================================
echo.

node index.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Bot berhenti atau terjadi kesalahan.
    pause
)
