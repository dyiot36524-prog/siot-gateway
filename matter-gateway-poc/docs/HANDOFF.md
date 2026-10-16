# 인수인계 — Matter/Thread 게이트웨이 (2026-10-16 기준)

새 세션에서 이 문서만 읽으면 이어서 작업할 수 있도록 지금까지의 결정, 만든 것, 현재 상태, 다음 할 일을 정리한다.

## 1. 목표와 배경
- 자사 스마트 IoT 플랫폼(기존 LifeSmart 기반 웹/앱)에 **타사 엔드디바이스**를 붙이기 위한 게이트웨이를 만든다.
- 1차 대상: IKEA Matter-over-Thread 기기 2종 — **GRILLPLATS**(플러그), **MYGGBETT**(문열림 센서).
- 구매 하드웨어: Raspberry Pi 5 8GB, 공식 M.2 HAT+ + SK hynix BC901 2242 NVMe 256GB, Home Assistant Connect **ZBT-2**(EFR32MG24, Thread RCP 펌웨어로 사용).
- Home Assistant 전체를 쓰는 방식은 무겁고 자유도가 낮다고 판단(여전히 유효). 대신 HA 생태계의 부품만 떼어 쓴다: **OTBR**(Thread 보더 라우터) + **matterjs-server**(2026-06 HA 가 matter.js 기반으로 교체한 Matter 컨트롤러, Apache-2.0, 단독 실행 가능).

## 2. 확정된 결정 (deep-interview, 모호도 19%)
스펙 전문: `matter-gateway-poc/docs/spec-pi-install.md`

| 항목 | 결정 |
|---|---|
| 설치 환경 | Raspberry Pi OS Lite 64-bit + NVMe, **HA 없음**, Docker Compose + systemd 자동 기동, `install.sh` 1회 실행 |
| 네트워크 | Pi 는 **유선 eth0** 고정. OTBR 백본·mDNS·Matter 모두 eth0 |
| Matter 백엔드 | matterjs-server 컨테이너 **기본**. matter.js 직접 임베드는 Thread BLE 커미셔닝 실패 시 예비(`MATTER_BACKEND=embedded`) |
| 코드 기반 | `matter-gateway-poc/agent`(Node.js) 를 확장. 기존 `siot-app/`(Next.js HA 애드온)은 수정하지 않고 **계약의 참조 구현**으로만 사용 |
| 플랫폼 연동 | 기존 시옷앱 게이트웨이와 **같은 API 계약**(`/siot-app/api/v1/*`, 등록코드 claim, Bearer, SSE, mDNS `_siot._tcp`, 릴레이)을 그대로 구현 → 플랫폼/앱 무수정 |
| 페어링 | 앱에서 페어링까지 합격 기준. 게이트웨이에 인증된 `POST /siot-app/api/v1/pairing` 신규 추가. 앱 화면은 플랫폼팀 별도 작업, 그 전까지 게이트웨이 **로컬 페이지**로 페어링 |
| 디바이스 모델 | Matter 클러스터 기반 **중립 모델**(capability 단위) → SiotDevice 로 매핑. 추후 Zigbee/LifeSmart 도 같은 모델에 얹음 |
| 로컬 자동화 | 필요. 룰 엔진 포함(합격 기준 아님) |
| 멀티 어드민 | 지원(커미셔닝 창 열기 API) |
| 판정 범위 | 같은 공유기 LAN 기준. 릴레이는 `SIOT_RELAY_URL` 설정 시 동작하도록 구현만 |
| 보류 | Zigbee(두 번째 동글), 이미지 복제 양산/OTA, 플랫폼·앱 UI, CSA/Thread 인증, 양산 HW(CM5) |

## 3. 저장소 상태
- 저장소: `dyiot36524-prog/siot-gateway` (main). 새 GitHub 저장소 생성은 클라우드 세션에서 불가해 기존 저장소에 하위 디렉터리로 넣음.
- 병합된 PR: #1(PoC 초기), #2(Pi 설치본 + 플랫폼 API 계약 + OpenAPI/가이드/CI).
- `.claude/skills/deep-interview/`: oh-my-claudecode 의 deep-interview 스킬 복사(MIT). 저장소 루트에서 세션을 열면 `/deep-interview` 사용 가능. OMC 의 후속 스킬(omc-plan, ralph 등)은 없음.
- CI: `.github/workflows/matter-gateway-test.yml` — `matter-gateway-poc/**` 변경 시 agent 테스트 15건 + compose 문법 검사.

```
matter-gateway-poc/
  install.sh                 Pi OS 에서 sudo 로 1회 실행 (멱등). /opt/matter-gateway 에 설치
  docker-compose.yml         otbr(openthread/border-router:v2026.10.0, OT_* 환경변수) / matter(matterjs-server) / agent
                             (+ profile embedded: agent-embedded)
  host/                      99-matter-thread.conf(sysctl), ipv6-forwarding-fix.service, matter-gateway.service, flash-zbt2.sh
  agent/src/
    index.js                 진입점: 플랫폼 API → mDNS → 릴레이 → Matter 백엔드 연결(백오프) → OTBR 데이터셋 자동 등록
    matterBackend.js         MATTER_BACKEND=server|embedded 선택
    matterClient.js          matterjs-server WebSocket 클라이언트 (set_thread_dataset, commission_with_code, device_command ...)
    embedded/matterEmbedded.js  matter.js 0.17.9 CommissioningController 직접 임베드 (같은 메서드/이벤트 표면)
    model/                   중립 모델: clusters.js, normalize.js(Matter 속성→capability), registry.js
    platform/                server.js(HTTP+SSE API, 페어링 세션), identity.js(gatewayId uuidv5), store.js, auth.js,
                             registration.js, siotMapper.js(중립→SiotDevice, action 매핑), mdns.js, relay.js, otbr.js,
                             static/(로컬 페이지)
    pairing.js, commands.js, rules.js, cli.js
  agent/test/                normalize, threadDataset, platform(계약 테스트) — npm test 15건 통과
  docs/                      assessment.md, commissioning.md, neutral-model.md, spec-pi-install.md,
                             openapi.yaml(플랫폼 API 명세), platform-integration.md(앱 페어링 화면 가이드), HANDOFF.md(이 문서)
```

## 4. 핵심 동작 요약
- **gatewayId** = `gw_` + uuidv5(하드웨어 시리얼, 네임스페이스 6f1d2c9e-...). 컨테이너에는 `/sys/firmware/devicetree/base/serial-number` 와 `/etc/machine-id` 를 마운트.
- **등록**: 로컬 페이지 "등록 코드 발급"(8 hex, 10분) → 플랫폼이 `POST /siot-app/api/v1/claim` → 64 hex 토큰. 토큰 없으면 모든 플랫폼 API 401.
- **기기 id**: `matter:<nodeId>:<endpoint>`. 플러그 → `PLUG {switch, power, energy}`, 문열림 → `BINARY_SENSOR {active(열림=true), measurement:"door", battery}`.
- **제어**: `POST .../devices/{id}/control {"action":"ON"|"OFF"|"TOGGLE"...}` → Matter OnOff 명령. 응답은 낙관적 상태, 확정 상태는 SSE `events` 로.
- **페어링**: `POST .../pairing {"code":"MT:..."}` → 202 세션 → stage: queued → commissioning → interviewing → done|failed. 동시 1세션(409).
- **Thread 데이터셋**: 에이전트가 OTBR REST(127.0.0.1:8081)에서 읽어 Matter 컨트롤러에 자동 등록.
- **중요 리스크**: matterjs-server README 는 단독 `--ble` 모드에서 Thread 기기 커미셔닝을 "미지원"이라 적음(소스에는 명령이 있어 실측 필요). 실패하면 임베드 백엔드로 전환(README "Matter 백엔드 전환").

## 5. 현재 진행 상황 (막힌 지점)
- SSD 에 Raspberry Pi OS Lite 64-bit 를 Mac 에서 Imager 로 기록함. 호스트명 **`siot`**, 사용자명은 아마 **`kwangsu`**(Imager 기본값), Wi-Fi 없음. SSH 활성화 여부는 불확실.
- Pi 에 SSD 장착, 유선 랜·전원 연결 완료. ZBT-2 는 USB 2.0 포트에 꽂아야 함(아직 확인 안 됨). ZBT-2 펌웨어가 Thread(OpenThread RCP)인지도 확인 필요.
- Mac 에서 `ping siot.local` 은 응답. `ssh -v kwangsu@siot.local` 은 `Connecting to siot.local port 22` 에서 멈춤(refused 아님 = 응답 없음).
  - 가능 원인: (a) 첫 부팅/재부팅 중, (b) `siot.local` 이 다른 기기(예: 기존 HA 기반 시옷 게이트웨이)로 풀림, (c) SSH 미활성.
  - 확인 명령(Mac): `ping -c 2 siot.local; nc -vz -w 5 siot.local 22; arp -a` → IP 의 MAC 이 `2c:cf:67`/`d8:3a:dd`/`dc:a6:32`/`e4:5f:01`/`b8:27:eb` 로 시작하면 Pi.
  - `refused` 면 SSD 를 Mac 에 꽂아 bootfs 에 빈 파일 `ssh` 생성. 부팅 자체가 안 되면(초록 LED 없음) Imager 의 Bootloader 업데이트 이미지를 SD 로 한 번 부팅.
- 클라우드 세션은 댁 LAN 에 닿지 않으므로, **Mac 에서 로컬 세션**(`git clone ... && cd siot-gateway && claude`)으로 Pi 접속·설치를 진행하기로 함.

## 6. 바로 다음 할 일 (로컬 세션)
1. Pi 찾기 → `ssh kwangsu@<ip>` 접속.
2. 설치:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/dyiot36524-prog/siot-gateway/main/matter-gateway-poc/install.sh | sudo bash
   ```
   완료 메시지의 `http://siot-<shortId>.local:3000` 을 폰에서 열기.
3. 합격 기준 AC-1~AC-13 순서로 확인(`matter-gateway-poc/README.md` 표). 순서: 재부팅 복구 → OTBR leader/데이터셋 자동 등록 → mDNS → MYGGBETT/GRILLPLATS 커미셔닝(로컬 페이지) → 이벤트 5초/제어 2초 → claim/401 → 24시간.
4. 로그 수집: 설치 스크립트 출력, `docker logs gateway-agent`, `docker logs matterjs-server`, `docker exec otbr ot-ctl state`.
5. AC-5 커미셔닝 실패 시: `docker compose stop matter agent && MATTER_BACKEND=embedded docker compose --profile embedded up -d --build agent-embedded`.

## 7. 그 다음 단계(우선순위)
1. 실기기 검증 결과로 코드 수정(예상 지점: matterjs-server 노드 스냅샷 필드, BLE 안정성, 슬리피 장치 구독).
2. 플랫폼/앱 페어링 화면(플랫폼팀) — `docs/openapi.yaml`, `docs/platform-integration.md` 기준.
3. Zigbee 어댑터(두 번째 동글, zigpy/Zigbee2MQTT → 중립 모델 `zigbee:` 접두어).
4. 양산: 이미지 복제, OTA, CM5/MG24 모듈 보드, CSA Vendor ID·Thread Group 가입.

## 8. 참고 사실
- IKEA 두 기기는 Dirigera 없이 타사 컨트롤러에 직접 페어링됨. 센서는 Thread 보더 라우터 필수. GRILLPLATS 는 QR 인식 문제 보고가 있어 11자리 수동 코드 경로도 지원함.
- 기존 siot-app 계약 참조 파일: `siot-app/lib/{gateway-id,gateway-identity,registration,platform-auth,types,device-mapper,control-map,mdns,relay-agent,system-status}.ts`, `siot-app/app/siot-app/api/v1/*`.
- VENDOR_ID 0xFFF1 은 테스트용. 상용은 CSA 가입 후 발급 VID 필요.
