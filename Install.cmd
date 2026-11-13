@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ==========================================
echo    token-optimizer - GUI installer
echo  ==========================================
echo.
echo   A browser window will open with checkboxes for
echo   every optimization and companion plugin.
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   Node.js is required but was not found on PATH.
    echo   Install it from https://nodejs.org and double-click this again.
    echo.
    pause
    exit /b 1
)

node "%~dp0scripts\install-gui.mjs"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo   Installer exited with code %RC% - see the messages above.
) else (
    echo   Installer closed.
)
echo.
pause
exit /b %RC%
