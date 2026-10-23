@echo off
cd /d "%~dp0"
echo.
echo  1. Gaa ind i Cyberpunk (Borderless Windowed) og saet et main job som aktivt (spor det i journalen).
echo  2. Hold quest-titlen synlig i HUD'en.
echo  3. Skift tilbage til spillet nu - der tages et skaermbillede om 10 sekunder.
echo.
timeout /t 10
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\..\_lib\tracker\ocr-tracker.ps1" -ConfigPath "%~dp0cyberpunk-tracker-config.json" -Calibrate
pause
