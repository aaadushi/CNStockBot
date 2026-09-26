@echo off
rem CNStockBot one-click start (S3-4): launch data-service + main service in foreground.
rem Keep this window open; close it or press Ctrl+C to stop both services.
chcp 65001 >nul
node "%~dp0service.mjs" start %*
