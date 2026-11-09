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

echo [1/2] Installing dependencies...
call npm install
if errorlevel 1 goto fail

echo [2/2] Building the interface and the installer...
call npm run dist
if errorlevel 1 goto fail

echo.
echo Installer ready: installer\output\Trama-Setup-*.exe
pause
exit /b 0

:fail
echo Something failed. See the message above.
pause
exit /b 1
