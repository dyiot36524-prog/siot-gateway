#!/usr/bin/env bash
# Mac 에서 Raspberry Pi OS 부트 파티션(bootfs)에 SSH 를 활성화한다.
#   사용법:  ./enable-ssh-bootfs.sh [bootfs 경로]            # ssh 파일만 생성
# 주의: 2025-10 이후 Pi OS(Trixie, cloud-init) 이미지는 Imager 설정이 bootfs/user-data 에 있다.
#       ssh 파일 외에 user-data 에 `enable_ssh: true` / `ssh_pwauth: true` 를 넣고 meta-data 의
#       instance-id 를 바꾸면 다음 부팅에 cloud-init 이 다시 적용한다 (2026-10-19 siot Pi 에 적용한 방법).
#           PI_USER=gslt PI_PASSWORD='비밀번호' ./enable-ssh-bootfs.sh   # 사용자/비밀번호도 재설정
# 기본 bootfs 경로: /Volumes/bootfs
set -euo pipefail
BOOT="${1:-/Volumes/bootfs}"

[ -d "$BOOT" ] || { echo "bootfs 가 마운트되어 있지 않습니다: $BOOT"; ls /Volumes; exit 1; }
[ -f "$BOOT/config.txt" ] && [ -f "$BOOT/cmdline.txt" ] || { echo "$BOOT 는 Raspberry Pi 부트 파티션이 아닙니다"; exit 1; }

echo "== bootfs: $BOOT"
ls "$BOOT" | tr '\n' ' '; echo
echo "== cmdline.txt: $(cat "$BOOT/cmdline.txt")"

touch "$BOOT/ssh"
echo "== ssh 파일 생성 완료 (다음 부팅 시 sshd 활성화)"

if [ -n "${PI_PASSWORD:-}" ]; then
  PI_USER="${PI_USER:-gslt}"
  HASH=$(python3 -c "import crypt,sys; print(crypt.crypt(sys.argv[1], crypt.mksalt(crypt.METHOD_SHA512)))" "$PI_PASSWORD")
  printf '%s:%s\n' "$PI_USER" "$HASH" > "$BOOT/userconf.txt"
  echo "== userconf.txt 작성: 사용자 $PI_USER (다음 부팅 시 비밀번호 적용)"
fi

sync
echo "== 꺼내는 중..."
diskutil eject "$BOOT" >/dev/null && echo "== 완료. SSD 를 Pi 에 다시 장착하고 전원을 켜세요."
