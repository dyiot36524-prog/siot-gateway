#!/usr/bin/env bash
# Silicon Labs 동글(ZBT-2, SONOFF Dongle Lite MG21/Dongle-E 등)에 OpenThread RCP 펌웨어(.gbl)를 올린다.
#   사용법: host/flash-thread-rcp.sh <장치 by-id 경로> [펌웨어.gbl 또는 URL]
#   SONOFF Dongle Lite MG21 기본 펌웨어: iHost 공식 저장소 donglelmg21_mg21_openthread_stable_2.4.4_460800.gbl
#   (되돌리기: 같은 저장소의 donglelmg21_mg21_zigbee_factory_7.4.5_115200.gbl)
# 일반 사용자(dialout 그룹)로 실행 가능. Python venv 에 universal-silabs-flasher 를 설치해 쓴다.
set -euo pipefail
DEV="${1:?usage: flash-thread-rcp.sh <device> [firmware.gbl|url]}"
FW="${2:-https://raw.githubusercontent.com/iHost-Open-Source-Project/hassio-ihost-sonoff-dongle-flasher/main/firmware-build/donglelmg21_mg21_openthread_stable_2.4.4_460800.gbl}"
VENV="${USF_VENV:-$HOME/usf}"
[ -x "$VENV/bin/universal-silabs-flasher" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install -q universal-silabs-flasher; }
USF="$VENV/bin/universal-silabs-flasher"
case "$FW" in
  http://*|https://*) mkdir -p "$HOME/firmware"; F="$HOME/firmware/$(basename "$FW")"; curl -fsSL -o "$F" "$FW"; FW="$F";;
esac
echo "== 현재 펌웨어 probe"
"$USF" --device "$DEV" --probe-methods spinel:460800,ezsp:115200,bootloader:115200 probe 2>&1 | grep -E "Detected|Probing" || true
echo "== 플래시: $FW"
"$USF" --device "$DEV" flash --firmware "$FW" 2>&1 | grep -vE "DEBUG|CONFIG_|%\|" || true
echo "== 결과 probe (SPINEL 이어야 함)"
"$USF" --device "$DEV" --probe-methods spinel:460800,spinel:115200 probe 2>&1 | grep -E "Detected" || { echo "SPINEL 감지 실패"; exit 1; }
