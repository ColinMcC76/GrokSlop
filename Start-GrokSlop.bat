@echo off
title GrokSlop
cd /d "%~dp0"

if /I "%~1"=="__run" goto run

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found. Install it from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

if not exist ".env" (
    echo WARNING: .env file not found in this folder.
    echo Create .env with TOKEN, CLIENT_ID, and other settings before running.
    echo.
)

if not exist "node_modules\" (
    echo Installing dependencies ^(first run only^)...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
    echo.
)

start "GrokSlop" /min "%~f0" __run
exit /b 0

:run
echo Starting GrokSlop...
echo The control panel opens in its own window.
echo This window stays minimized. Close it to stop the bot.
echo.

node index.js

if errorlevel 1 (
    echo.
    echo GrokSlop exited with an error.
    pause
)
