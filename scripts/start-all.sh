#!/usr/bin/env bash
# CNStockBot 一键启动（S3-4）：拉起 data-service + 主服务，前台监督。
# 保持本终端开启；Ctrl+C 即停止双服务。
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service.mjs" start "$@"
