@echo off
rem CNStockBot one-click stop (S3-4): stop data-service + main service by PID files.
chcp 65001 >nul
node "%~dp0service.mjs" stop %*
