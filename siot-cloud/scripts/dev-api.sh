#!/usr/bin/env bash
# 로컬 개발용 API 서버 실행: apps/api/.env 를 읽어 tsx 로 실행 (PWA 는 apps/web/dist 를 정적 서빙)
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
set -a; . ./.env; set +a
exec node --import tsx src/server.ts
