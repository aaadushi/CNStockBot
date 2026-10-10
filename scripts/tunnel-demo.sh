#!/usr/bin/env bash
# CNStockBot 临时演示隧道（REQ-Dev-Tunnel）：把本机主服务经 Cloudflare Quick
# Tunnel 映射为临时 https URL，供自测/演示，非正式部署（见 docs/deploy/local-tunnel.md）。
# 用法：scripts/tunnel-demo.sh [端口]（默认读 .env 的 PORT，再退 18790）
# 前置：主服务已在运行（scripts/start-all.sh）；已安装 cloudflared。
# 注意：URL 随 cloudflared 进程退出而失效，切勿写死进 App 默认配置。
# --protocol http2：默认 QUIC(UDP 7844) 在部分网络被封/限速，会导致隧道连不上
#（Cloudflare Error 1033 / HTTP 530），强制走 http2 规避（见 PITFALLS 2026-10-10）。
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${1:-}"
if [ -z "$PORT" ]; then
  PORT="$(grep -m1 '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
fi
PORT="${PORT:-18790}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[tunnel] 未找到 cloudflared。安装：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "[tunnel] 主服务未在 127.0.0.1:${PORT} 响应 /health，请先运行 scripts/start-all.sh"
  exit 1
fi

echo "[tunnel] 映射 http://127.0.0.1:${PORT} -> 临时 https 地址"
echo "[tunnel] 输出中 *.trycloudflare.com 一行即为演示 URL；Ctrl+C 即断开"
exec cloudflared tunnel --url "http://127.0.0.1:${PORT}" --protocol http2
