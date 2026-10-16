@echo off
cd /d "%~dp0"
reg add HKCU\Console /v QuickEdit /t REG_DWORD /d 0 /f >nul 2>&1
title Bot Resi Telegram - Antigravity Watchdog
color 0A

:loop
cls
echo ========================================================
echo         MENJALANKAN BOT RESI TELEGRAM (LOKAL)
echo         Mode: Auto-Restart Watchdog Aktif (24/7)
echo ========================================================
echo [%date% %time%] Memulai engine bot...
echo.

node index.js

echo.
echo ========================================================
echo [%date% %time%] PERINGATAN: Bot berhenti tidak terduga!
echo Merestart otomatis engine bot dalam 3 detik...
echo (Tekan CTRL + C untuk menghentikan loop)
echo ========================================================
timeout /t 3 /nobreak > nul
goto loop
