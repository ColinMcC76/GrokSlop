@echo off
title GrokSlop
cd /d "%~dp0"

if /I "%~1"=="__run" goto run
if /I "%~1"=="__tunnel" goto tunnel

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

where cloudflared >nul 2>&1
if errorlevel 1 (
    echo.
    echo cloudflared was not found, so the tunnel was not started.
    echo The bot is running. Install cloudflared, then run this file again:
    echo https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    echo.
    pause
    exit /b 0
)

if not exist "%USERPROFILE%\.cloudflared\config.yml" if not exist "%USERPROFILE%\.cloudflared\config.yaml" (
    echo.
    echo No Cloudflare config at %USERPROFILE%\.cloudflared\config.yml
    echo The bot is running. The tunnel was not started.
    echo Create that file, then run this file again.
    echo.
    pause
    exit /b 0
)

start "GrokSlop Tunnel" /min "%~f0" __tunnel
exit /b 0

:run
echo Starting GrokSlop...
echo The control panel opens in its own window.
echo The Cloudflare tunnel runs in the GrokSlop Tunnel window.
echo This window stays minimized. Close it to stop the bot.
echo.

node index.js

if errorlevel 1 (
    echo.
    echo GrokSlop exited with an error.
    pause
)
exit /b 0

:tunnel
echo Starting Cloudflare tunnel grokslop...
echo This window stays minimized. Close it to stop the tunnel.
echo.

cloudflared tunnel run grokslop

if errorlevel 1 (
    echo.
    echo Cloudflare tunnel exited with an error.
    pause
)
exit /b 0
