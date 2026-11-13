@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ==========================================
echo    token-optimizer - uninstaller
echo  ==========================================
echo.
echo   Remove the registration from where?
echo.
echo    [1] Global config    (every project)
echo    [2] Project config   (this folder only)
echo.
choice /c 12 /n /m "   Choose 1 or 2: "
if errorlevel 2 (set "ARGS=") else (set "ARGS=-Global")

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %ARGS%
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo   Uninstall reported a problem - see above. Exit code: %RC%
) else (
    echo   Done. The folder itself was not touched -
    echo   delete it manually if you want a full removal.
)
echo.
pause
exit /b %RC%
