@echo off
rem CNStockBot supervise mode (S3-5): launch data-service + main service with crash auto-restart.
rem Keep this window open or detach it; run scripts\stop-all.bat to stop services AND the supervisor.
chcp 65001 >nul
node "%~dp0service.mjs" supervise %*
