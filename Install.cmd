@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ==========================================
echo    token-optimizer - installer
echo  ==========================================
echo.
echo   Register the plugin where?
echo.
echo    [1] Every project    (global config - recommended)
echo    [2] This folder only (project config)
echo.
choice /c 12 /n /m "   Choose 1 or 2: "
if errorlevel 2 (set "ARGS=") else (set "ARGS=-Global")

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %ARGS%
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo   Install FAILED - see the messages above. Exit code: %RC%
) else (
    echo   Install complete. Keep this folder where it is -
    echo   your OpenCode config points at it.
)
echo.
pause
exit /b %RC%
