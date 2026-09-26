#!/usr/bin/env bash
# CNStockBot 一键停止（S3-4）：按 PID 文件停止 data-service + 主服务。
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service.mjs" stop "$@"
