#!/usr/bin/env bash
# ZBT-2 에 OpenThread RCP 펌웨어를 올린다 (Thread 모드).
# 더 쉬운 방법: Chromium 에서 Open Home Foundation Toolbox 로 "OpenThread (RCP)" 선택.
# 펌웨어(.gbl)는 NabuCasa/silabs-firmware-builder 릴리스의 zbt2_openthread_rcp_* 파일.
set -euo pipefail
DEV="${1:-/dev/ttyACM0}"
FW="${2:?usage: flash-zbt2.sh <device> <zbt2_openthread_rcp_*.gbl>}"
pipx install universal-silabs-flasher >/dev/null 2>&1 || pip install --user universal-silabs-flasher
universal-silabs-flasher --device "$DEV" --bootloader-reset rts_dtr flash --firmware "$FW" \
  || universal-silabs-flasher --device "$DEV" --bootloader-reset baudrate flash --firmware "$FW"
universal-silabs-flasher --device "$DEV" probe
