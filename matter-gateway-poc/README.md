# 시옷 Matter/Thread 게이트웨이

Raspberry Pi 5 + Home Assistant Connect ZBT-2 로 IKEA Matter-over-Thread 기기(GRILLPLATS 플러그, MYGGBETT 문열림 센서)를
게이트웨이가 직접 커미셔닝하고, **기존 시옷앱 게이트웨이와 같은 플랫폼 API 계약**으로 시옷플랫폼·앱에 연동되는 경량 게이트웨이.
Home Assistant 없이 Raspberry Pi OS + Docker 로 동작한다.

스펙: `docs/spec-pi-install.md` (deep-interview 결과) (합격 기준 AC-1 ~ AC-13)

```
install.sh              Pi OS Lite 에서 1회 실행하는 설치 스크립트 (AC-1)
docker-compose.yml      otbr(Thread 보더 라우터) / matterjs-server(Matter 컨트롤러) / agent(시옷 게이트웨이 에이전트)
host/                   sysctl, systemd 유닛(부팅 자동 기동), ZBT-2 플래시 스크립트
agent/                  Node.js 에이전트 (플랫폼 API + Matter 엔진 + 로컬 페이지 + 룰 엔진)
docs/                   설계 평가, 커미셔닝 설명, 중립 모델 명세
```

## 구조

```
시옷플랫폼/앱 ──(LAN: mDNS siot-<id>.local:3000, 외부: 릴레이)──▶ agent: /siot-app/api/v1/*  (Bearer 토큰)
                                                               │  claim · devices · control · events(SSE) · system · pairing
                                                               ▼
                                       중립 디바이스 모델 (model/) ◀── Matter 백엔드 (matterjs-server WS | matter.js 임베드)
                                                               │                       ▲ BLE 커미셔닝, Thread 데이터셋
                                                               ▼                       │
                                                        로컬 룰 엔진          OTBR (ZBT-2 RCP, REST 8081 → 데이터셋 자동 등록)
```

- 플랫폼 API 계약은 `siot-app/` 의 구현과 동일: gatewayId 파생(uuidv5), 등록코드 → `POST /siot-app/api/v1/claim`, `SiotDevice{id,name,deviceType,online,data,lastUpdated}`, action 문자열, SSE 포맷, mDNS `_siot._tcp`, 릴레이 프레임.
- 추가된 플랫폼 엔드포인트(인증): `POST /siot-app/api/v1/pairing {code}` → `202 {session}`, `GET /siot-app/api/v1/pairing/:sessionId`, `DELETE /siot-app/api/v1/devices/:id`, `POST /siot-app/api/v1/devices/:id/commissioning-window`(멀티 어드민).
- 로컬 페이지 `http://siot-<shortId>.local:3000/`: 등록 코드 발급, QR/수동코드 페어링, 기기 목록·제어. 앱 페어링 화면이 나오기 전까지의 대체 경로(AC-12).
- 기기 id 는 `matter:<nodeId>:<endpoint>`. 플러그 → `PLUG {switch, power}`, 문열림 → `BINARY_SENSOR {active(열림), measurement:"door", battery}`.

## 설치 (Raspberry Pi 5)

1. Raspberry Pi Imager 로 **Raspberry Pi OS Lite (64-bit)** 를 NVMe(또는 SD) 에 기록. 사용자/SSH 활성화. (NVMe 부팅은 `sudo rpi-eeprom-update -a` 후 부트 순서 조정)
2. ZBT-2 를 **USB 2.0 포트(검정)** 에 꽂는다. 펌웨어가 Thread(OpenThread RCP)인지 확인 — 아니면 Open Home Foundation Toolbox(Chromium) 에서 "OpenThread (RCP)" 설치 또는 `host/flash-zbt2.sh`.
3. Pi 를 공유기에 **유선(eth0)** 으로 연결하고 SSH 접속 후:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/dyiot36524-prog/siot-gateway/main/matter-gateway-poc/install.sh | sudo bash
   ```
   (저장소를 받아 둔 경우 `sudo ./install.sh`. 무선 백본이면 `sudo BACKBONE_IF=wlan0 ./install.sh`)
4. 스크립트가 끝나면 출력된 `http://siot-<shortId>.local:3000` 을 폰(같은 Wi-Fi)에서 연다.

설치 스크립트가 하는 일: Docker/BlueZ 설치 → sysctl(IPv6 accept_ra=2, conntrack 3600) → systemd 유닛(`matter-gateway.service`, `ipv6-forwarding-fix.service`) → ZBT-2 장치 경로 감지 → `.env` 생성 → OTBR 기동과 Thread 네트워크 형성 → 전체 compose 기동. 재실행해도 안전하다.

## 합격 기준 검증 절차

| AC | 확인 방법 |
|---|---|
| AC-1 설치 1회 | `sudo ./install.sh` 완료 메시지, `docker compose ps` 3개 컨테이너 Up |
| AC-2 재부팅 복구 | 전원 재투입 → 2분 내 `curl http://127.0.0.1:3000/api/system` 의 `engineOnline:true`, 기기 목록 유지 |
| AC-3 데이터셋 자동 | 에이전트 로그 `Thread dataset registered from OTBR`, `/api/system` 의 `engine.threadCredentialsSet:true` |
| AC-4 mDNS | 폰 브라우저에서 `http://siot-<shortId>.local:3000`, `avahi-browse -rt _siot._tcp` |
| AC-5 커미셔닝 | 로컬 페이지에서 MYGGBETT, GRILLPLATS QR 입력 → 기기 목록에 BINARY_SENSOR / PLUG |
| AC-6 이벤트 5초 | `curl -N "http://127.0.0.1:3000/siot-app/api/v1/events?token=$T"` 띄우고 문 열기 |
| AC-7 제어 2초 | `curl -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"action":"ON"}' http://127.0.0.1:3000/siot-app/api/v1/devices/matter:1:1/control` |
| AC-8 24시간 | `docker logs -f gateway-agent` 에서 센서 `state` 갱신 지속, `/api/devices` 의 `online:true` |
| AC-9 claim | 로컬 페이지 등록코드 → `curl -X POST -d '{"registrationCode":"XXXXXXXX"}' .../siot-app/api/v1/claim` → 토큰 없이 호출 시 401 |
| AC-10 스키마 | `cd agent && npm test` (siot-app 응답 형태 대조 테스트 포함) + 플랫폼 실연동 |
| AC-11 pairing API | `curl -X POST -H "Authorization: Bearer $T" -d '{"code":"MT:..."}' .../siot-app/api/v1/pairing` → `GET .../pairing/<sessionId>` 로 stage 추적 |
| AC-12 로컬 페어링 | 로컬 페이지 페어링 폼 |
| AC-13 릴레이 | `.env` 에 `SIOT_RELAY_URL` 설정 후 재기동 → 에이전트 로그 `relay connected` |

## 운영

```bash
cd /opt/matter-gateway
docker compose ps                      # 상태
docker logs -f gateway-agent           # 에이전트
docker logs -f matterjs-server         # Matter 컨트롤러
docker exec otbr ot-ctl state          # Thread 역할 (leader 여야 함)
docker exec otbr ot-ctl dataset active -x
sudo systemctl status matter-gateway   # 부팅 자동 기동 유닛
cd agent && node src/cli.js devices    # CLI (호스트에 node 가 있을 때)
```

### Matter 백엔드 전환 (예비)
기본은 `matterjs-server` 컨테이너. Pi 에서 Thread 기기 BLE 커미셔닝이 실패하면 matter.js 직접 임베드로 전환:
```bash
docker compose stop matter agent
MATTER_BACKEND=embedded docker compose --profile embedded up -d --build agent-embedded
```
두 백엔드는 패브릭을 공유하지 않으므로 기기를 다시 페어링해야 한다. 자세한 비교는 `docs/assessment.md`.

## 알려진 제약 / 다음 단계
- matterjs-server 는 베타이며 CSA 재인증 전. VENDOR_ID 0xFFF1 은 테스트용.
- 플랫폼·앱의 페어링 화면은 별도 작업(플랫폼팀). 게이트웨이 쪽 API 는 준비됨.
- Zigbee 는 보류(두 번째 동글 + 어댑터). 이미지 복제 양산·OTA 는 다음 단계.
- 릴레이 서버는 저장소 밖(Fly.io). 이 저장소에서는 에이전트 쪽만 구현.
