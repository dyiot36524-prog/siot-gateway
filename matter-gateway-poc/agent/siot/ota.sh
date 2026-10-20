#!/bin/sh
# OTA 적용 훅(placeholder) — 계획 §2 d "소유권". 호스트 고정 스크립트 /usr/local/lib/siot/siot-ota.sh 가
# 새 이미지에서 이 파일을 추출해 실행한다(타임아웃 120초). 하는 일은 버전별 .env 키·compose 변수 이관뿐이다.
# 300초 감시·판정·롤백·결과 기록은 고정 스크립트 소유이며 여기서 하지 않는다.
#
# 서명(M4): CI 가 ota-manifest.json({agentVersion, otaShSha256, minVersionFloor})을 만들고 Ed25519 로 서명해
# /siot/ota-manifest.json.sig 를 넣는다. 서명이 없거나 맞지 않으면 고정 스크립트는 known-good 훅을 쓴다.
#
# 인자: $1 = .env 경로(호스트), $2 = 대상 agentVersion
set -eu
ENV_FILE="${1:?usage: ota.sh <env-file> <target-version>}"
TARGET_VERSION="${2:?usage: ota.sh <env-file> <target-version>}"
# 현재 버전은 이관할 키가 없다.
echo "ota hook: nothing to migrate for $TARGET_VERSION ($ENV_FILE)"
