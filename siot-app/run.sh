#!/usr/bin/env sh
# 시옷앱 컨테이너 진입점.
# HA 애드온으로 돌면 Supervisor가 SUPERVISOR_TOKEN을 주입한다 → HA에 무설정 연결.
# 일반 도커로 돌면 HA_BASE_URL/HA_TOKEN 환경변수를 직접 받는다.
set -e

if [ -n "$SUPERVISOR_TOKEN" ]; then
  # HA 애드온: Supervisor 코어 프록시로 HA API 호출. 토큰은 Supervisor가 발급.
  : "${HA_BASE_URL:=http://supervisor/core}"
  export HA_TOKEN="$SUPERVISOR_TOKEN"
fi

export HA_BASE_URL
export SIOT_DATA_DIR="${SIOT_DATA_DIR:-/data}"
export PORT="${PORT:-3000}"
# 외부(다른 기기/HA UI)에서 접근하려면 0.0.0.0 바인딩 필요.
export HOSTNAME="0.0.0.0"

echo "[siot-app] 시작 — HA_BASE_URL=${HA_BASE_URL:-(미설정)} PORT=$PORT DATA=$SIOT_DATA_DIR"
exec node server.js
