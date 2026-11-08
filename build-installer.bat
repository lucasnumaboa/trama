@echo off
chcp 65001 >nul
title Build Trama installer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org.
  pause
  exit /b 1
)

echo [1/3] Installing dependencies...
call npm install
if errorlevel 1 goto fail

echo [2/3] Building the interface...
call npm run build
if errorlevel 1 goto fail

echo [3/3] Building the installer with Inno Setup...
set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
  echo Inno Setup 6 was not found. Install it from https://jrsoftware.org/isinfo.php and run this file again.
  pause
  exit /b 1
)
"%ISCC%" "%~dp0installer\trama.iss"
if errorlevel 1 goto fail

echo.
echo Installer ready in the installer\output folder.
pause
exit /b 0

:fail
echo Something failed. See the message above.
pause
exit /b 1
