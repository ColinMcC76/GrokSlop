@echo off
title GrokSlop
cd /d "%~dp0"

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

echo Starting GrokSlop...
echo Close this window or press Ctrl+C to stop the bot.
echo.

node index.js

if errorlevel 1 (
    echo.
    echo GrokSlop exited with an error.
    pause
)
