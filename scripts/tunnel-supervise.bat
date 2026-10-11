@echo off
rem CNStockBot supervised Quick Tunnel (REQ-S3-8): auto-restart on crash and
rem on fake-alive (register fail). NOT a production deployment path - see
rem docs/deploy/local-tunnel.md (in Chinese).
rem Usage: scripts\tunnel-supervise.bat [port]   (default: .env PORT, else 18790)
rem The current tunnel URL is in logs\tunnel-url-<port>.txt ; logs in
rem logs\tunnel-<port>.log. Stop: node scripts\tunnel.mjs stop
rem NOTE: --protocol http2 is forced (QUIC/UDP 7844 often blocked in CN,
rem see PITFALLS 2026-10-10); URL changes on every restart - never hardcode it.
rem NOTE: cloudflared lookup is done by tunnel.mjs itself (PATH + well-known
rem install dirs), because long-lived sessions may not see a freshly
rem installed machine PATH (stale env, see PITFALLS 2026-10-11).
setlocal
set "PORT=%~1"
if not defined PORT (
  for /f "tokens=2 delims==" %%a in ('findstr /b /c:"PORT=" "%~dp0..\.env" 2^>nul') do set "PORT=%%a"
)
rem only accept a plain numeric port (.env may be CRLF or hold odd values)
echo.%PORT%|findstr /r /c:"^[0-9][0-9]*$" >nul || set "PORT=18790"

curl -sf http://127.0.0.1:%PORT%/health >nul 2>nul
if errorlevel 1 (
  echo [tunnel] main service not responding at 127.0.0.1:%PORT% ^(/health^). Start it with scripts\start-all.bat first.
  exit /b 1
)

echo [tunnel] supervised tunnel starting; URL will land in logs\tunnel-url-%PORT%.txt
echo [tunnel] this window may be closed ONLY via: node scripts\tunnel.mjs stop
node "%~dp0tunnel.mjs" start --port %PORT%
