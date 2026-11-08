@echo off
chcp 65001 >nul
title Trama
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies for the first time...
  call npm install
  if errorlevel 1 (
    echo Could not install the dependencies.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo Building the interface...
  call npm run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

echo Starting Trama at http://127.0.0.1:5190 ...
echo Keep this window open while you use Trama. Make sure ComfyUI is running.
start "" http://127.0.0.1:5190
node server\index.js
pause
