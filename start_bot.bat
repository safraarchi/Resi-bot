@echo off
cd /d "%~dp0"
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
