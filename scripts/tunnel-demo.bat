@echo off
rem CNStockBot temporary demo tunnel (REQ-Dev-Tunnel): expose the local main
rem service as a temporary https URL via Cloudflare Quick Tunnel, for
rem self-testing / demos only - NOT a production deployment path
rem (see docs/deploy/local-tunnel.md, in Chinese).
rem Usage: scripts\tunnel-demo.bat [port]   (default: .env PORT, else 18790)
rem Prerequisites: main service running (scripts\start-all.bat) + cloudflared.
rem NOTE: the URL dies with the cloudflared process - never hardcode it
rem into the App default server address.
setlocal
set "PORT=%~1"
if not defined PORT (
  for /f "tokens=2 delims==" %%a in ('findstr /b /c:"PORT=" "%~dp0..\.env" 2^>nul') do set "PORT=%%a"
)
rem only accept a plain numeric port (.env may be CRLF or hold odd values)
echo.%PORT%|findstr /r /c:"^[0-9][0-9]*$" >nul || set "PORT=18790"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [tunnel] cloudflared not found. Install: winget install cloudflare.cloudflared
  exit /b 1
)

curl -sf http://127.0.0.1:%PORT%/health >nul 2>nul
if errorlevel 1 (
  echo [tunnel] main service not responding at 127.0.0.1:%PORT% ^(/health^). Start it with scripts\start-all.bat first.
  exit /b 1
)

echo [tunnel] exposing http://127.0.0.1:%PORT% as a temporary https URL
echo [tunnel] the https://*.trycloudflare.com line in the output below is your demo URL; close this window to stop.
cloudflared tunnel --url http://127.0.0.1:%PORT%
