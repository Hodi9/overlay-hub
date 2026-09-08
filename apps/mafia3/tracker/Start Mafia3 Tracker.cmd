@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\..\_lib\tracker\ocr-tracker.ps1" -ConfigPath "%~dp0mafia3-tracker-config.json"
pause
