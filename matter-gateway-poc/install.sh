#!/usr/bin/env bash
# 시옷 Matter/Thread 게이트웨이 설치 스크립트 — Raspberry Pi OS Lite (64-bit) 에서 1회 실행.
#   curl -fsSL <raw url>/install.sh | sudo bash      또는   sudo ./install.sh
# 멱등: 다시 실행해도 안전. 설치 위치 /opt/matter-gateway.
set -euo pipefail

TARGET=/opt/matter-gateway
REPO_URL="${REPO_URL:-https://github.com/dyiot36524-prog/siot-gateway.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
SUBDIR=matter-gateway-poc
BACKBONE_IF="${BACKBONE_IF:-eth0}"

log() { echo -e "\e[1;32m[install]\e[0m $*"; }
die() { echo -e "\e[1;31m[install] $*\e[0m" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "sudo 로 실행하세요."
[ "$(uname -m)" = aarch64 ] || log "경고: aarch64 가 아닙니다 ($(uname -m)). Pi 5 64-bit OS 를 권장합니다."

# ── 1. 패키지 ────────────────────────────────────────────────────────────
log "패키지 설치 (docker, bluez, git, curl)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git bluez rfkill jq >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin >/dev/null
systemctl enable --now docker >/dev/null
if [ -n "${SUDO_USER:-}" ]; then usermod -aG docker "$SUDO_USER" || true; fi

# ── 2. 블루투스 ──────────────────────────────────────────────────────────
rfkill unblock bluetooth || true
systemctl enable --now bluetooth >/dev/null
if bluetoothctl show 2>/dev/null | grep -q "Powered: no"; then bluetoothctl power on >/dev/null || true; fi

# ── 3. 소스 ──────────────────────────────────────────────────────────────
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -f "$SRC_DIR/docker-compose.yml" ] && [ -d "$SRC_DIR/agent" ]; then
  log "로컬 소스 사용: $SRC_DIR"
  mkdir -p "$TARGET"
  if [ "$SRC_DIR" != "$TARGET" ]; then
    (cd "$SRC_DIR" && tar --exclude=node_modules --exclude=data --exclude=.env -cf - .) | (cd "$TARGET" && tar -xf -)
  fi
else
  log "저장소 클론: $REPO_URL ($REPO_BRANCH)"
  TMP=$(mktemp -d)
  git clone -q --depth 1 -b "$REPO_BRANCH" "$REPO_URL" "$TMP/repo"
  mkdir -p "$TARGET"
  (cd "$TMP/repo/$SUBDIR" && tar --exclude=node_modules --exclude=data --exclude=.env -cf - .) | (cd "$TARGET" && tar -xf -)
  rm -rf "$TMP"
fi
cd "$TARGET"
mkdir -p data/otbr data/matter data/agent
[ -f rules.json ] || cp agent/rules.example.json rules.json

# ── 4. 커널/네트워크 설정 ────────────────────────────────────────────────
log "sysctl / systemd 설정"
sed "s/eth0/$BACKBONE_IF/g" host/99-matter-thread.conf > /etc/sysctl.d/99-matter-thread.conf
cp host/ipv6-forwarding-fix.service /etc/systemd/system/ipv6-forwarding-fix.service
sed "s#/opt/matter-gateway#$TARGET#g" host/matter-gateway.service > /etc/systemd/system/matter-gateway.service
# NetworkManager 가 accept_ra 를 덮어쓰는 문제 보정
if [ -d /etc/NetworkManager/conf.d ]; then
  cat > /etc/NetworkManager/conf.d/90-matter-ipv6.conf <<NM
[connection]
ipv6.ip6-privacy=0
NM
fi
sysctl --system >/dev/null
systemctl daemon-reload
systemctl enable ipv6-forwarding-fix.service >/dev/null

# ── 5. ZBT-2 장치 경로 ───────────────────────────────────────────────────
ZBT2_DEV="${ZBT2_DEV:-}"
if [ -z "$ZBT2_DEV" ]; then
  ZBT2_DEV=$(ls /dev/serial/by-id/ 2>/dev/null | grep -i -m1 "ZBT-2\|Nabu_Casa\|Home_Assistant_Connect" | sed 's#^#/dev/serial/by-id/#' || true)
fi
if [ -z "$ZBT2_DEV" ]; then
  log "경고: ZBT-2 를 찾지 못했습니다. USB 2.0 포트에 꽂고 다시 실행하거나 .env 의 ZBT2_DEV 를 직접 지정하세요. (임시로 /dev/ttyACM0 사용)"
  ZBT2_DEV=/dev/ttyACM0
else
  log "ZBT-2: $ZBT2_DEV"
fi

# ── 6. .env ──────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cat > .env <<ENV
ZBT2_DEV=$ZBT2_DEV
BACKBONE_IF=$BACKBONE_IF
SIOT_GATEWAY_VERSION=$(jq -r .version agent/package.json 2>/dev/null || echo 0.2.0)
SIOT_RELAY_URL=${SIOT_RELAY_URL:-}
MATTER_BACKEND=${MATTER_BACKEND:-server}
LOG_LEVEL=info
ENV
else
  sed -i "s#^ZBT2_DEV=.*#ZBT2_DEV=$ZBT2_DEV#; s#^BACKBONE_IF=.*#BACKBONE_IF=$BACKBONE_IF#" .env
fi

# ── 7. 컨테이너 빌드/기동 ────────────────────────────────────────────────
log "컨테이너 빌드 및 기동 (최초 수 분 소요)"
docker compose pull --ignore-buildable --quiet || true
docker compose build --quiet agent
docker compose up -d otbr
# ── 8. Thread 네트워크 형성(최초 1회) ───────────────────────────────────
log "OTBR 대기"
for i in $(seq 1 30); do docker exec otbr ot-ctl state >/dev/null 2>&1 && break; sleep 2; done
STATE=$(docker exec otbr ot-ctl state 2>/dev/null | head -1 | tr -d '\r' || echo unknown)
if [ "$STATE" = "disabled" ] || [ "$STATE" = "detached" ]; then
  if ! docker exec otbr ot-ctl dataset active -x 2>/dev/null | grep -qE '^[0-9a-f]{20,}'; then
    log "Thread 네트워크 생성"
    NET_NAME="siot-$(tr -dc a-z0-9 </dev/urandom | head -c 6)"
    docker exec otbr sh -c "ot-ctl dataset init new && ot-ctl dataset networkname $NET_NAME && ot-ctl dataset commit active" >/dev/null
  fi
  docker exec otbr sh -c "ot-ctl ifconfig up && ot-ctl thread start" >/dev/null
fi
for i in $(seq 1 30); do
  STATE=$(docker exec otbr ot-ctl state 2>/dev/null | head -1 | tr -d '\r' || echo unknown)
  [ "$STATE" = "leader" ] && break; sleep 2
done
log "OTBR 상태: $STATE"

docker compose up -d
systemctl enable matter-gateway.service >/dev/null
systemctl start matter-gateway.service || true

# ── 9. 요약 ──────────────────────────────────────────────────────────────
sleep 5
GID=$(curl -fsS http://127.0.0.1:3000/api/gateway 2>/dev/null | jq -r .gatewayId || echo "(에이전트 기동 중)")
SHORT=${GID:3:8}
IP=$(hostname -I | awk '{print $1}')
cat <<SUMMARY

============================================================
 설치 완료
   gatewayId : $GID
   로컬 페이지: http://siot-$SHORT.local:3000  (또는 http://$IP:3000)
   OTBR      : $STATE   (웹 GUI http://$IP/)
   Matter    : docker logs -f matterjs-server
   에이전트  : docker logs -f gateway-agent
 다음 단계
   1) 로컬 페이지에서 "등록 코드 발급" → 시옷플랫폼 앱에 입력(claim)
   2) IKEA 기기 QR 을 로컬 페이지(또는 앱)에 입력해 페어링
   3) 전원 재투입 후 http://siot-$SHORT.local:3000 이 다시 뜨는지 확인
============================================================
SUMMARY
