# Matter/Thread 게이트웨이 PoC

Raspberry Pi 5 + Home Assistant Connect ZBT-2 로 IKEA Matter-over-Thread 기기(GRILLPLATS 플러그, MYGGBETT 문열림 센서)를
게이트웨이가 직접 커미셔닝하고, 중립 디바이스 모델로 바꿔 MQTT 로 플랫폼에 올리는 최소 구성.

구성: `otbr`(Thread 보더 라우터) + `matterjs-server`(Matter 컨트롤러, Apache-2.0) + `agent`(자사 Node.js) + `mosquitto`(PoC용 브로커)

```
docker-compose.yml      컨테이너 4개
host/                   Pi 호스트 설정 (sysctl, systemd, ZBT-2 플래시)
agent/                  Node.js 게이트웨이 에이전트 + CLI
docs/commissioning.md   커미셔닝 설명
docs/neutral-model.md   중립 디바이스 모델/명령/규칙 포맷
```

## 1주차 체크리스트

### 1. Pi 준비
1. Pi 5 에 SD 로 Raspberry Pi OS Lite (64-bit) 부팅 → `sudo rpi-eeprom-update -a && sudo reboot` (NVMe 부팅용 최신 부트로더)
2. M.2 HAT+ 에 BC901 장착 → `lsblk` 에 nvme0n1 보이는지 확인 → Imager 로 NVMe 에 OS 기록 → `sudo raspi-config` Advanced → Boot Order → NVMe/USB 우선 → SD 제거 후 재부팅
3. `sudo apt install -y docker.io docker-compose-v2 bluez avahi-daemon` 후 `sudo usermod -aG docker $USER`
4. `sudo cp host/99-matter-thread.conf /etc/sysctl.d/ && sudo cp host/ipv6-forwarding-fix.service /etc/systemd/system/ && sudo systemctl enable ipv6-forwarding-fix && sudo sysctl --system`
   - NetworkManager 를 쓰면 `/etc/NetworkManager/conf.d/`에도 accept_ra 설정을 반영 (런타임 sysctl 이 덮어써짐)
5. BLE 확인: `bluetoothctl show` 에서 Powered: yes

### 2. ZBT-2 → Thread RCP
1. ZBT-2 를 **USB 2.0 포트(검정)** 에 꽂거나 짧은 연장 케이블 사용 (USB 3 간섭 회피)
2. 가장 쉬운 방법: Chromium 에서 Open Home Foundation Toolbox 접속 → ZBT-2 선택 → **OpenThread (RCP)** 펌웨어 설치
   - CLI 방법: `host/flash-zbt2.sh /dev/ttyACM0 zbt2_openthread_rcp_<ver>.gbl` (펌웨어는 NabuCasa/silabs-firmware-builder 릴리스)
3. `ls /dev/serial/by-id/` 로 안정적인 장치 경로 확인 → `.env` 의 `ZBT2_DEV` 에 기입

### 3. 컨테이너 기동
```bash
cp .env.example .env   # ZBT2_DEV, BACKBONE_IF(eth0 또는 wlan0), GATEWAY_ID 수정
docker compose up -d otbr
docker exec otbr ot-ctl state            # disabled 면 아래로 네트워크 형성
docker exec otbr ot-ctl dataset init new
docker exec otbr ot-ctl dataset networkname gw-poc
docker exec otbr ot-ctl dataset commit active
docker exec otbr ot-ctl ifconfig up
docker exec otbr ot-ctl thread start
docker exec otbr ot-ctl state            # leader 가 되어야 함
docker exec otbr ot-ctl dataset active -x   # ← 이 hex 가 Thread 데이터셋
docker compose up -d matter mosquitto
docker logs -f matterjs-server          # bluetooth enabled 확인
```
OTBR 웹 GUI: `http://<pi-ip>/` , Matter 대시보드(선택): compose 의 LISTEN_ADDRESS 에 인터페이스 추가 후 `http://<pi-ip>:5580/`

### 4. 커미셔닝 검증 (핵심 리스크 확인)
```bash
cd agent && npm install
node src/cli.js info                              # thread_credentials_set, bluetooth_enabled 확인
node src/cli.js dataset <ot-ctl dataset active -x 결과>
node src/cli.js pair "MT:..."                     # MYGGBETT 의 QR 문자열 (배터리 넣고 페어링 모드)
node src/cli.js devices                           # contact/battery capability 가 보이면 성공
node src/cli.js pair "MT:..."                     # GRILLPLATS
node src/cli.js on matter:1 1 ; node src/cli.js off matter:1 1
node src/cli.js watch                             # 문 열고 닫으며 contact.open 변화 확인
node src/cli.js window matter:1                   # 멀티 어드민: Apple Home 등에서 추가할 수 있는 코드 발급
```
- `commission_with_code` 가 Thread 단계에서 실패하면(matterjs-server README 의 "network name" 제약) → 2차 경로:
  `npx @matter/nodejs-shell` 에서 `config thread-credentials set gw-poc <dataset-hex>` 후 `commission pair --ble-enable --pairing-code <코드>` 로 재검증.
  이 경로가 되면 에이전트를 matterjs-server 대신 `@matter/main` 직접 임베드로 전환(선택지 C).
- GRILLPLATS QR 인식 문제 보고가 있으므로 11자리 수동 코드로도 시도.
- 24시간 이상 `watch` 를 켜 두고 MYGGBETT(슬리피 장치) 가 끊기지 않는지 확인. 끊기면 conntrack 타임아웃/방화벽 점검.

### 5. 에이전트 + 로컬 규칙
```bash
docker compose up -d --build agent
mosquitto_sub -h 127.0.0.1 -t 'gw/#' -v           # 디바이스/상태/페어링 이벤트 확인
mosquitto_pub -h 127.0.0.1 -t gw/gw-poc-001/cmd -m '{"reqId":"1","deviceId":"matter:1","capability":"onoff","action":"toggle"}'
mosquitto_pub -h 127.0.0.1 -t gw/gw-poc-001/pairing/start -m '{"sessionId":"s1","code":"MT:..."}'
```
`agent/rules.example.json` 의 deviceId 를 실제 값으로 바꾸고 재기동하면 "문 열림 → 플러그 ON" 이 클라우드 없이 동작한다.

### 6. 선택지 C: matter.js 직접 임베드 백엔드
에이전트는 두 백엔드를 환경변수 하나로 바꾼다.

| | `MATTER_BACKEND=server` (기본) | `MATTER_BACKEND=embedded` |
|---|---|---|
| 컨트롤러 | matterjs-server 컨테이너, WebSocket 5580 | 에이전트 프로세스 안의 `CommissioningController` |
| Thread BLE 커미셔닝 | README 상 제약 있음(검증 필요) | 셸과 동일 경로(`threadNetwork` 옵션)로 지원 |
| BLE | 서버 컨테이너의 BlueZ/D-Bus | 에이전트 컨테이너의 HCI(noble), privileged 필요 |
| 부가 기능 | 대시보드, OTA, DCL 캐시 제공 | 직접 구현 필요 (DCL 인증서 검증은 라이브러리가 수행) |
| 자유도/인증 | HA 호환 API 에 묶임 | 최대. 인증 시 자사 컨트롤러로 제출 가능 |

호스트에서 바로 검증:
```bash
cd agent
export MATTER_BACKEND=embedded MATTER_BLE=1 MATTER_INTERFACE=eth0 DATA_DIR=./data
sudo -E node src/cli.js info                       # HCI 소켓 접근 때문에 sudo (또는 setcap cap_net_raw,cap_net_admin+eip $(which node))
sudo -E node src/cli.js dataset <ot-ctl dataset active -x 결과>     # 네트워크 이름은 데이터셋에서 자동 추출
sudo -E node src/cli.js pair "MT:..."
sudo -E node src/cli.js devices && sudo -E node src/cli.js watch
```
컨테이너로: `docker compose stop matter agent && docker compose --profile embedded up -d --build agent-embedded`

두 백엔드는 같은 스토리지를 공유하지 않는다(각자 별도 패브릭). 한쪽에서 등록한 기기를 다른 쪽에서 쓰려면 기기를 제거 후 다시 페어링하거나 커미셔닝 창을 열어 2차 관리자로 추가한다.

## 알려진 제약 / 다음 단계
- matterjs-server 는 베타이며 CSA 재인증 전. VENDOR_ID 0xFFF1 은 테스트용(임베드 버전도 동일).
- 임베드 백엔드는 matter.js 0.17.9 의 `CommissioningController`(legacy 명칭이지만 셸이 쓰는 현행 API) 기준. 0.18 에서 API 가 바뀔 수 있으니 버전 고정.
- 임베드 백엔드의 첫 실기기 확인 지점: 커미셔닝 후 `devices` 에 contact/onoff capability 가 보이는지, `watch` 에서 attribute_updated 가 흐르는지.
- ZBT-2 하나는 Thread 전용. Zigbee 는 두 번째 동글 + zigpy/Zigbee2MQTT 어댑터로 추가(중립 모델 `zigbee:` 접두어).
- 플랫폼 브로커 연결 시 게이트웨이별 mTLS 인증서 + 토픽 ACL 필요. 게이트웨이 클레임(박스 QR) 플로우는 별도.
- 양산 하드웨어(CM5/자체 보드 + MG24 모듈)와 CSA/Thread Group 가입은 PoC 이후 결정.
