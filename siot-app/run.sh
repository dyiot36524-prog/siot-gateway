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

# HA 애드온 옵션(/data/options.json)의 relay_url → SIOT_RELAY_URL (원격 접속 릴레이).
# 비어있으면 릴레이 비활성(로컬 전용).
if [ -z "$SIOT_RELAY_URL" ] && [ -f /data/options.json ]; then
  RELAY=$(node -e "try{process.stdout.write(String(require('/data/options.json').relay_url||''))}catch(e){}")
  if [ -n "$RELAY" ]; then export SIOT_RELAY_URL="$RELAY"; fi
fi
# 외부(다른 기기/HA UI)에서 접근하려면 0.0.0.0 바인딩 필요.
export HOSTNAME="0.0.0.0"

echo "[siot-app] 시작 — HA_BASE_URL=${HA_BASE_URL:-(미설정)} PORT=$PORT DATA=$SIOT_DATA_DIR"
exec node server.js
