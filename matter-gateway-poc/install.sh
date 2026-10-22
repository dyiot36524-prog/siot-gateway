#!/usr/bin/env bash
# 시옷 Matter/Thread 게이트웨이 설치 스크립트 — Raspberry Pi OS Lite (64-bit) 에서 1회 실행.
#   curl -fsSL <raw url>/install.sh | sudo bash      또는   sudo ./install.sh [--mode=production|dev] [--thread=defer|auto]
#   (파이프 실행 시 인자:  curl ... | sudo bash -s -- --mode=dev --thread=auto)
# 멱등: 다시 실행해도 안전. 설치 위치 /opt/matter-gateway.
#   --mode=production (기본) LAN 3000 은 상태만, 전체 API 는 127.0.0.1:3001. 바인딩은 클라우드 릴레이 bind
#   --mode=dev               기존 단일 서버(로컬 페이지에서 등록 코드·페어링·제어)
#   --thread=defer (기본)    Thread 망을 만들지 않는다(세대 cfg 의 thread 모드가 정함). 이미 데이터셋이 있으면 그대로 올린다
#   --thread=auto            dev 용 기존 동작: 데이터셋이 없으면 새 망을 만든다
set -euo pipefail

THREAD_MODE=defer
MODE_ARG=""
for arg in "$@"; do
  case "$arg" in
    --thread=auto|--thread=defer) THREAD_MODE="${arg#--thread=}" ;;
    --mode=production|--mode=dev) MODE_ARG="${arg#--mode=}" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "알 수 없는 인자: $arg (사용: --mode=production|dev --thread=defer|auto)" >&2; exit 2 ;;
  esac
done

TARGET=/opt/matter-gateway
REPO_URL="${REPO_URL:-https://github.com/dyiot36524-prog/siot-gateway.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
SUBDIR=matter-gateway-poc
# OTBR 인프라 인터페이스 = matter.js PRIMARY_INTERFACE. 기본 siot0(항상 살아 있는 더미, host/siot-infra.service) — 공유기·LAN 케이블 없이도
# Thread 기기가 기억하는 Pi 주소가 유지된다(HANDOFF §9c). LAN_IF 는 ssh·릴레이용 유선(accept_ra 설정에만 쓴다)
BACKBONE_IF="${BACKBONE_IF:-siot0}"
LAN_IF="${LAN_IF:-eth0}"

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
# 에이전트 마운트 경계(계획 §2 d): requests(쓰기), health(쓰기), out(읽기 전용). OTA 상태·백업은 마운트 밖 /var/lib/siot
mkdir -p state/requests/ota state/requests/ctl state/health state/out
mkdir -p -m 0700 /var/lib/siot
# 규칙은 에이전트 데이터 볼륨(/app/data/rules.json)으로 이관. 기존 ./rules.json 이 있으면 최초 1회 복사, 없으면 에이전트가 예시를 복사
if [ -f rules.json ] && [ ! -f data/agent/rules.json ]; then cp rules.json data/agent/rules.json; log "rules.json → data/agent/rules.json 이관"; fi

# ── 4. 커널/네트워크 설정 ────────────────────────────────────────────────
log "sysctl / systemd 설정"
sed "s/eth0/$LAN_IF/g" host/99-matter-thread.conf > /etc/sysctl.d/99-matter-thread.conf
cp host/ipv6-forwarding-fix.service /etc/systemd/system/ipv6-forwarding-fix.service
cp host/ble-conn-params.service /etc/systemd/system/ble-conn-params.service   # BLE supervision timeout 2초 (host/ble-conn-params.service 참고)
sed "s#/opt/matter-gateway#$TARGET#g" host/matter-gateway.service > /etc/systemd/system/matter-gateway.service
# 더미 인프라 인터페이스 siot0: NM 비관리 + systemd 유닛(부팅 때 생성). BACKBONE_IF 를 실제 NIC 로 바꾸면 만들지 않는다
if [ "$BACKBONE_IF" = siot0 ]; then
  [ -d /etc/NetworkManager/conf.d ] && cp host/91-siot-infra.conf /etc/NetworkManager/conf.d/91-siot-infra.conf
  cp host/siot-infra.service /etc/systemd/system/siot-infra.service
fi
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
if [ "$BACKBONE_IF" = siot0 ]; then
  (nmcli general reload conf >/dev/null 2>&1 || true)
  systemctl enable --now siot-infra.service >/dev/null
  log "인프라 인터페이스 siot0: $(ip -br link show siot0 2>/dev/null | awk '{print $2}')"
fi
systemctl enable --now ble-conn-params.service >/dev/null || true

# ── 5. ZBT-2 장치 경로 ───────────────────────────────────────────────────
ZBT2_DEV="${ZBT2_DEV:-}"
if [ -z "$ZBT2_DEV" ]; then
  ZBT2_DEV=$(ls /dev/serial/by-id/ 2>/dev/null | grep -i -m1 "ZBT-2\|Nabu_Casa\|Home_Assistant_Connect" | sed 's#^#/dev/serial/by-id/#' || true)
fi
# ZBT-2 가 없으면 EFR32MG21 계열 Silicon Labs 동글(SONOFF Dongle-E/Lite 등, OpenThread RCP 펌웨어 필요)도 허용
if [ -z "$ZBT2_DEV" ]; then
  ZBT2_DEV=$(ls /dev/serial/by-id/ 2>/dev/null | grep -i -m1 "SONOFF.*MG21\|SkyConnect\|Silicon_Labs_CP210" | sed 's#^#/dev/serial/by-id/#' || true)
  [ -n "$ZBT2_DEV" ] && log "ZBT-2 대신 Silicon Labs 동글 사용: $ZBT2_DEV (OpenThread RCP 펌웨어인지 확인 필요)"
fi
if [ -z "$ZBT2_DEV" ]; then
  log "경고: Thread 동글(ZBT-2 등)을 찾지 못했습니다. USB 2.0 포트에 꽂고 다시 실행하거나 .env 의 ZBT2_DEV 를 직접 지정하세요. (임시로 /dev/ttyACM0 사용)"
  ZBT2_DEV=/dev/ttyACM0
else
  log "Thread 동글: $ZBT2_DEV"
fi

# ── 6. .env ──────────────────────────────────────────────────────────────
DEFAULT_OTBR_IMAGE=openthread/border-router@sha256:70d2260eb5022f4c40be4f50195a1952d49041fc766fb3b2f213b06dcdc31a18
DEFAULT_MATTER_IMAGE=ghcr.io/matter-js/matterjs-server@sha256:54232d0d3e7dff5a54759469d2753399270412b4c30c55b31750a4595e4cb236
if [ ! -f .env ]; then
  cat > .env <<ENV
ZBT2_DEV=$ZBT2_DEV
BACKBONE_IF=$BACKBONE_IF
SIOT_GATEWAY_VERSION=$(jq -r .version agent/package.json 2>/dev/null || echo 0.2.0)
SIOT_MODE=${MODE_ARG:-production}
SIOT_RELAY_URL=${SIOT_RELAY_URL:-}
MATTER_BACKEND=${MATTER_BACKEND:-server}
LOG_LEVEL=info
OTBR_IMAGE=$DEFAULT_OTBR_IMAGE
MATTER_IMAGE=$DEFAULT_MATTER_IMAGE
AGENT_IMAGE=${AGENT_IMAGE:-siot-matter-agent:local}
ENV
else
  sed -i "s#^ZBT2_DEV=.*#ZBT2_DEV=$ZBT2_DEV#; s#^BACKBONE_IF=.*#BACKBONE_IF=$BACKBONE_IF#" .env
  # --mode 를 주면 덮어쓰고, 없으면 기존 값 유지(키가 없으면 production 추가)
  if [ -n "$MODE_ARG" ]; then
    if grep -q '^SIOT_MODE=' .env; then sed -i "s#^SIOT_MODE=.*#SIOT_MODE=$MODE_ARG#" .env; else echo "SIOT_MODE=$MODE_ARG" >> .env; fi
  else
    grep -q '^SIOT_MODE=' .env || echo "SIOT_MODE=production" >> .env
  fi
fi
SIOT_MODE=$(grep -m1 '^SIOT_MODE=' .env | cut -d= -f2-)
MATTER_IMAGE=$(grep -m1 '^MATTER_IMAGE=' .env | cut -d= -f2- || true); MATTER_IMAGE=${MATTER_IMAGE:-$DEFAULT_MATTER_IMAGE}
AGENT_IMAGE=$(grep -m1 '^AGENT_IMAGE=' .env | cut -d= -f2- || true); AGENT_IMAGE=${AGENT_IMAGE:-siot-matter-agent:local}
log "모드: $SIOT_MODE, Thread: $THREAD_MODE"

# ── 7. 컨테이너 빌드/기동 ────────────────────────────────────────────────
log "컨테이너 빌드 및 기동 (최초 수 분 소요)"
docker compose pull --ignore-buildable --quiet || true
# matterjs-server 이미지는 비root(기본 1000:1000)로 실행되므로 데이터 디렉터리 소유권을 맞춘다
MATTER_UID=$(docker image inspect "$MATTER_IMAGE" --format '{{.Config.User}}' 2>/dev/null || true)
chown -R "${MATTER_UID:-1000:1000}" data/matter
# 레지스트리 이미지(digest)면 pull 로 충분하고, 로컬 태그일 때만 빌드한다
case "$AGENT_IMAGE" in *@sha256:*) ;; *) docker compose build --quiet agent ;; esac
docker compose up -d otbr
# ── 8. Thread 네트워크 (auto: 최초 1회 형성 / defer: 형성하지 않음) ──────
log "OTBR 대기"
for i in $(seq 1 30); do docker exec otbr ot-ctl state >/dev/null 2>&1 && break; sleep 2; done
STATE=$(docker exec otbr ot-ctl state 2>/dev/null | head -1 | tr -d '\r' || echo unknown)
HAS_DATASET=0
docker exec otbr ot-ctl dataset active -x 2>/dev/null | grep -qE '^[0-9a-f]{20,}' && HAS_DATASET=1
if [ "$STATE" = "disabled" ] || [ "$STATE" = "detached" ]; then
  if [ "$HAS_DATASET" = 0 ] && [ "$THREAD_MODE" = auto ]; then
    log "Thread 네트워크 생성 (--thread=auto)"
    NET_NAME="siot-$(tr -dc a-z0-9 </dev/urandom | head -c 6)"
    docker exec otbr sh -c "ot-ctl dataset init new && ot-ctl dataset networkname $NET_NAME && ot-ctl dataset commit active" >/dev/null
    HAS_DATASET=1
  fi
  if [ "$HAS_DATASET" = 1 ]; then
    docker exec otbr sh -c "ot-ctl ifconfig up && ot-ctl thread start" >/dev/null
  else
    log "Thread 망 형성 보류(--thread=defer): 세대 설정(cfg thread 모드)으로 형성/합류합니다"
  fi
fi
if [ "$HAS_DATASET" = 1 ]; then
  for i in $(seq 1 30); do
    STATE=$(docker exec otbr ot-ctl state 2>/dev/null | head -1 | tr -d '\r' || echo unknown)
    case "$STATE" in leader|router|child) break ;; esac; sleep 2
  done
fi
log "OTBR 상태: $STATE"

docker compose up -d
systemctl enable matter-gateway.service >/dev/null
systemctl start matter-gateway.service || true

# ── 9. 요약 ──────────────────────────────────────────────────────────────
sleep 5
# 축소 /api/gateway {gatewayId, shortId, bound, version, pubKey} 와 dev 확장 응답 모두 호환
GW_JSON=$(curl -fsS http://127.0.0.1:3000/api/gateway 2>/dev/null || echo '{}')
GID=$(echo "$GW_JSON" | jq -r '.gatewayId // "(에이전트 기동 중)"')
SHORT=$(echo "$GW_JSON" | jq -r '.shortId // empty'); SHORT=${SHORT:-${GID:3:8}}
BOUND=$(echo "$GW_JSON" | jq -r 'if (.bound // .registered) then "연결됨" else "미연결" end')
VER=$(echo "$GW_JSON" | jq -r '.version // "-"')
IP=$(hostname -I | awk '{print $1}')
if [ "$SIOT_MODE" = dev ]; then
  NEXT="   1) 로컬 페이지에서 \"등록 코드 발급\" → 시옷플랫폼 앱에 입력(claim)
   2) IKEA 기기 QR 을 로컬 페이지(또는 앱)에 입력해 페어링"
else
  NEXT="   1) 설치 기사 앱에서 라벨 코드 siot-$SHORT 로 게이트웨이 등록(클라우드 릴레이 bind)
   2) 기기 페어링·제어는 기사 앱에서 (LAN 페이지는 상태 확인용, 전체 API 는 127.0.0.1:3001)"
fi
cat <<SUMMARY

============================================================
 설치 완료 ($SIOT_MODE, thread=$THREAD_MODE)
   gatewayId : $GID   (v$VER, 세대 $BOUND)
   로컬 페이지: http://siot-$SHORT.local:3000  (또는 http://$IP:3000)
   OTBR      : $STATE   (웹 GUI http://$IP/)
   Matter    : docker logs -f matterjs-server
   에이전트  : docker logs -f gateway-agent
 다음 단계
$NEXT
   3) 전원 재투입 후 http://siot-$SHORT.local:3000 이 다시 뜨는지 확인
============================================================
SUMMARY
