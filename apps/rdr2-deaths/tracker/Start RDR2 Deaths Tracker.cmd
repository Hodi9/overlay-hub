@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rdr2-deaths-ocr-tracker.ps1"
pause
