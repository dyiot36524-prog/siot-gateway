# 인수인계 — Matter/Thread 게이트웨이 (2026-10-21 기준)

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
- CI: `.github/workflows/matter-gateway-test.yml` — `matter-gateway-poc/**` 변경 시 agent 테스트 82건(2026-10-20 기준: 기존 26 + relay-v2 계약 36 + Step 2 출고 모드·릴레이·분류기·sim 20) + compose 문법 검사. 에이전트 이미지는 `.github/workflows/gateway-agent-image.yml`(태그 `agent-v*` → GHCR arm64).

```
matter-gateway-poc/
  install.sh                 Pi OS 에서 sudo 로 1회 실행 (멱등). /opt/matter-gateway 에 설치
  docker-compose.yml         otbr(openthread/border-router, OT_* 환경변수) / matter(matterjs-server) / agent — 서드파티 2종은 .env OTBR_IMAGE/MATTER_IMAGE 의
                             @sha256 digest 고정(부팅 때 pull 없음). agent 마운트는 data/agent, state/{requests,health,out:ro} 만 (+ profile embedded: agent-embedded)
  host/                      99-matter-thread.conf(sysctl), ipv6-forwarding-fix.service, ble-conn-params.service(BLE supervision timeout), matter-gateway.service,
                             flash-zbt2.sh, flash-thread-rcp.sh, patches/matterjs-server/NobleBleChannel.js(BLE 재시도 백포트, compose 가 bind-mount)
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
  agent/test/                normalize, threadDataset, platform(계약), matterClient, pairing(재시도), siotMapper(실기기 스냅샷) — npm test 26건 통과
  scripts/stability-check.sh 24시간 안정성 점검(재접속·세션/구독 오류·재시작·기기 online·BLE timeout·OTBR). Pi 에서 실행 또는 `ssh gslt@<pi> bash -s 24h < scripts/stability-check.sh`
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

## 5. 현재 진행 상황 (2026-10-19, Mac 로컬 세션에서 실기기 설치)
- **Pi 접속**: 호스트명 `siot`, 유선 eth0 `192.168.0.172` (MAC `88:a2:9e:99:d1:16`). 로그인 사용자는 **`gslt`** (Imager 설정, kwangsu 아님). Mac 공개키 `~/.ssh/id_ed25519` 등록됨 → `ssh gslt@192.168.0.172`. `sudo` 는 비밀번호 필요(NOPASSWD 아님), gslt 는 `docker` 그룹.
  - Mac 에서 `siot.local` 은 ISP DNS 가로채기로 공인 IP 로 풀리므로 IP 로 접속. 이전 세션의 "ssh 멈춤"은 이 때문이었음.
  - OS 는 Raspberry Pi OS Lite 2026-10-06 (Trixie, cloud-init). SSH 는 bootfs `ssh` 파일 + `user-data` 수정으로 활성화함(`host/enable-ssh-bootfs.sh` 참고).
- **동글**: ZBT-2 가 아니라 **SONOFF Dongle Lite MG21**(EFR32MG21, CP210x, `/dev/ttyUSB0`) 이 꽂혀 있음. 출고 펌웨어 Zigbee EZSP 7.4.5 → iHost 공식 저장소의 `donglelmg21_mg21_openthread_stable_2.4.4_460800.gbl` 로 플래시 완료 (`SL-OPENTHREAD/2.4.4.0`, 460800, 흐름제어 끔). 되돌리기용 `donglelmg21_mg21_zigbee_factory_7.4.5_115200.gbl` 은 Pi `~/firmware/` 에 있음. 플래시 도구: `~/usf/bin/universal-silabs-flasher`, 스크립트 `host/flash-thread-rcp.sh`.
- **설치 중 발견·수정한 버그** (저장소에 반영, 커밋 필요):
  1. compose `otbr` 의 `sysctls:` 블록 → `network_mode: host` 에서 Docker 가 거부. 제거하고 `host/99-matter-thread.conf` 에 `net.ipv4.ip_forward=1`, `disable_ipv6=0` 추가.
  2. `data/matter` 가 root 소유 → matterjs-server(uid 1000) 가 `/data/config` EACCES 로 재시작 반복. `install.sh` 가 이미지 uid 로 chown 하도록 수정.
  3. `install.sh` 동글 감지에 Silicon Labs MG21 계열(SONOFF 등) 추가.
  4. matterjs-server 헬스체크가 `wget`(이미지에 없음) 이라 unhealthy → `curl` 로 변경.
  5. 에이전트 `matterClient.js`: 서버 재시작 후 첫 재접속이 ECONNREFUSED 면 영구히 멈추던 버그 → `everConnected` 로 계속 백오프 재시도. 회귀 테스트 `test/matterClient.test.js` 추가 (npm test 17건).
- **동작 확인됨** (install.sh 1차 실행 실패 후 수동으로 compose 기동):
  - OTBR: `leader`, `br state running`, 네트워크 `siot-btaylo` 채널 18 PAN 0x4E8B, REST 8081.
  - matterjs-server: 컨트롤러 기동, WS 127.0.0.1:5580, BLE enabled(hci0), 에이전트가 OTBR 데이터셋을 `set_thread_dataset` 로 자동 등록(xp=9ED1A30B9D3178C2).
  - 에이전트: gatewayId `gw_dd10c2c3-cc5c-5a82-ac12-4dd7f0bd424d`, 로컬 페이지 `http://192.168.0.172:3000` (mDNS `siot-dd10c2c3.local`, `_siot._tcp` Mac 에서 발견됨), 토큰 없는 플랫폼 API 401.
- **systemd 등록 완료**: `sudo ./install.sh` 재실행으로 `matter-gateway.service` enabled/active. 세 컨테이너 모두 healthy.
- **AC-1 재부팅 복구 통과** (2026-10-19 23:21 전원 재투입): 부팅 후 약 1분 내 3000 포트 healthz 응답, OTBR 이 저장된 데이터셋으로 `leader`/`br running`, matterjs-server 가 저장된 Thread 자격 복원(`Registered Thread credentials from stored`), 에이전트 synced·mDNS 광고, 토큰 없는 API 401. `ipv6-forwarding-fix.service` 는 oneshot 이라 실행 후 inactive 로 보이는 것이 정상(sysctl 값은 적용됨).
- **합격 기준 현황(2026-10-19 밤)**: AC-1 통과, mDNS/로컬페이지/401 확인. → 실기기 커미셔닝 결과는 아래 5b.

## 5b. 실기기 커미셔닝 결과 (2026-10-20 00:00~01:00, 별도 세션)
GRILLPLATS(QR `MT:CUO000QV1769DQ3C310`, disc 1671) 와 MYGGBETT(QR `MT:QDKT1CEK01O7BL12I00`, disc 2993) 모두 로컬 페이지/`POST /api/pairing` 경로로 커미셔닝 성공.
- 기기: `matter:5:1` PLUG `{switch, power, energy}` (GRILLPLATS Plug, fw 1.4.6), `matter:6:1` BINARY_SENSOR `{active, measurement:"door", battery, batteryLow}` (MYGGBETT, fw 1.0.9).
- **AC 현황**: 페어링(AC-5) 통과 2/2 · 플러그 제어 2초(AC): 20회 중 19회 <2초(중앙값 ~0.7초, 최대 2.13초) 통과 · 문열림 이벤트 5초: 통과(SSE 는 상태 변경 후 30~500ms 내 전달, 로컬 페이지 즉시 반영 확인) · claim/401: 토큰 없는 401 확인, claim 흐름은 계약 테스트로만 확인 · 24시간 안정성·재부팅 복원: 아래 5c.
- Thread: 플러그는 라우터(0xdc00, RSSI -58, LQ 3) 로 승격. OTBR ping 손실 0%, RTT 22~61ms. 가입 직후 수 분간 MAC NoAck → MRP 재전송(SII 2초 기준 3.8/9/14.6/25초 지연) 이 있었고 이후 안정화.

### 실패 원인과 수정 (모두 저장소 반영)
1. **BLE 초기 연결 불안정** — Pi 5 내장 BT(BCM4345C0) ↔ IKEA(EFR32 Thread/BLE 동시 운용). btmon: `LE Connection Complete` 직후 `0x3e Connection Failed to be Established` 로 끊김(성공률 ~40~50%, 호스트 bluetoothctl 도 동일, 다른 BLE 기기는 정상). matter.js 0.17.9 는 connect 오류를 재시도하지 않고 noble peripheral 이 'error' 상태로 남아 프로세스 재시작 전까지 재시도 불가.
   → `host/patches/matterjs-server/NobleBleChannel.js`: upstream main 수정 백포트(connect 오류 → reTryHandler 3회, 'error' 상태 거부 제거). compose 가 컨테이너 파일 위에 bind-mount. **matter.js > 0.17.9 이미지로 올리면 마운트 제거.** (`:dev` 태그 arm64 이미지는 /app 이 비어 있어 사용 불가, stable/latest = 1.4.0)
   → `agent/src/pairing.js`: 일시적(BLE) 실패만 커미셔닝 재시도(`PAIRING_MAX_ATTEMPTS`, 기본 3). 이벤트/세션에 `attempt`, `maxAttempts`, `lastError`. 실패 1회당 matter.js 탐색 타임아웃 3분(고정).
2. **커미셔닝 중 BLE 끊김** — `Connection Timeout(0x08)` = 커널 LE supervision timeout 420ms. → `host/ble-conn-params.service`(install.sh 설치) 가 `/sys/kernel/debug/bluetooth/hci0/supervision_timeout` 을 0x00C8(2초) 로. 플러그를 Pi 1m 안으로 옮긴 것도 도움.
3. **AddNOC InvalidCommand(0x85)** — compose `VENDOR_ID: "0xfff1"` 을 matter-server 1.4.0 이 `parseInt(v,10)` 으로 **0** 으로 파싱 → 패브릭 adminVendorId 0 → 기기가 거부. → `VENDOR_ID: "65521"`(10진수). 저장소가 `server-1-0` → `server-1-fff1` 로 바뀜(새 패브릭; Pi 의 `data/matter/server-1-0` 은 빈 옛 패브릭, 지워도 됨).
4. **모델 매핑** — GRILLPLATS 는 ep1 On/Off Plug + ep2 Electrical Sensor(0x0510, 클러스터 0x90/0x91/0x9C) 라 빈 SENSOR 가 하나 더 생김 → `siotMapper.js` 가 전력 측정 전용 엔드포인트를 on/off 엔드포인트에 합침(`endpointIds` 비열거 필드로 SSE 갱신 유지). MYGGBETT 배터리는 ep0 PowerSource → 루트 배터리를 기기에 합침. 실측 스냅샷 테스트 `agent/test/siotMapper.test.js`.
- 테스트: `npm test` 26건 통과(pairing 5, siotMapper 4 추가). CI 워크플로의 "15건" 문구는 수치만 옛것.
- 기타: 플러그 BLE 랜덤 주소가 재광고마다 바뀌어 noble dbus 프록시가 stale 해지는 로그(`interface not found in proxy object`)는 무해(재발견 후 진행). Pi USB 의 "CX 2.4G Wireless Receiver"(무선 키보드 수신기) 는 2.4GHz 간섭원일 수 있음(미검증). QR 은 사진을 OpenCV `QRCodeDetector` 로 디코드(흐린 사진은 축소+적응 임계값 필요).

## 5c. 24시간 안정성·재부팅 복원 검증 (2026-10-20 01:00~01:15, 별도 세션)
두 기기가 붙은 상태에서 측정. 코드 수정은 없었고 `scripts/stability-check.sh` 만 추가.

| 항목 | 결과 |
|---|---|
| 플러그 제어 2초 (재측정, ON/OFF 각 10회) | **통과** 20/20. HTTP 응답 중앙값 0.69s, SSE 확정 중앙값 0.72s, 최대 1.17s, 2초 초과 0 |
| 문열림 이벤트 SSE | **통과**. 재부팅 전 자석 조작 11건, 재부팅 후 에이전트 기동 약 1분 뒤 조작 8건 모두 `/api/stream` 으로 전달 |
| 재부팅 복원 (AC-1, 기기 붙은 상태, 전원 재투입) | **통과**. 컨테이너 3개 healthy, 에이전트 `synced 2 nodes`(matterjs-server 보다 먼저 떠서 ECONNREFUSED 2회 → 백오프 후 6초 내 동기), matterjs-server 가 저장된 CASE 재개 레코드로 플러그 1초·센서 4초 내 online + 구독 재설정, `Registered Thread credentials from stored`, OTBR `leader` 1초 내, `ble-conn-params.service` Result=success, 재부팅 후 `sudo cat /sys/kernel/debug/bluetooth/hci0/supervision_timeout` = **200** 확인 |
| 24시간 안정성 | **창 미완료 — 진행 중**. 기준 시작 2026-10-20 01:06 KST(재부팅 후). 01:00~01:15 구간: 에이전트 재접속 0, matterjs-server ERROR 0·세션 오류 0·구독 끊김 0, 컨테이너 재시작 0, 센서 battery 100 유지(센서 구독 max interval 30분 → 배터리는 변화 시 또는 30분 주기로만 보고됨) |

재점검(창이 지난 뒤): `ssh gslt@192.168.0.172 bash -s 24h < scripts/stability-check.sh` — 종료 코드 0 이면 통과, `!!` 줄이 경고 항목.

### 발견 사항 (기능 영향 없음, 코드 수정 없음)
1. **Pi 5 RTC 배터리 없음 → 부팅 직후 시각 지연.** 커널이 RTC 를 1970 으로 읽고 systemd 가 `/var/lib/systemd/timesync/clock` 의 마지막 저장 시각(01:03:29)으로 올린 뒤, NTP 동기(실시간 01:06:18)까지 약 1.5~2분 뒤처진 채 동작. 그 사이 docker 로그·`lastUpdated` 가 과거 시각으로 찍히고, 동기 순간 시각이 앞으로 점프하면서 matter.js 가 플러그 구독(timeout 1m39s)을 1회 재설정(01:06:34). 제어·이벤트 영향 없음. 24시간 로그를 읽을 때 부팅 직후 구간은 감안할 것. 정확한 타임스탬프가 필요하면 RTC 배터리(Pi 5 공식 RTC battery) 장착.
2. 재부팅 후 센서(MYGGBETT)가 OTBR 리더가 아니라 **플러그 라우터(0xdc00)의 자식**으로 재부착됨(`ot-ctl eidcache` 에서 두 ML-EID 모두 dc00 경유, `child table` 비어 있음). 이벤트 전달 정상 — 플러그를 빼면 센서가 리더로 재부착해야 하므로 추후 "플러그 제거 시 센서 유지" 도 한 번 확인할 가치 있음.
3. OTBR 부팅 약 6분 뒤 플러그로 UDP 전송 NoAck 2건(일시적, 이후 없음).
4. `sudo -n` 은 터미널 탭에서 비밀번호를 입력해 sudo 캐시가 살아 있을 때만 통과. 재부팅 직후 `supervision_timeout` 직접 읽기는 터미널 탭에서 `sudo cat` 필요(이번 재부팅 후 직접 읽기 = 200 확인).

## 6. 바로 다음 할 일
1. (완료) AC-1 재부팅 복구, (완료) AC-5 두 기기 커미셔닝·제어·이벤트, (완료 2026-10-21) M1 에이전트 Pi 반영·B7·인터넷 차단 재부팅·C3 ③ — §9. Pi 의 설치본은 `/opt/matter-gateway`(저장소 main 과 동일 내용, `SIOT_MODE=production`). 소스 수정 후 반영: `rsync` 로 `~/matter-gateway-poc/matter-gateway-poc` 갱신 → 터미널 탭에서 `sudo ./install.sh --mode=production --thread=defer`(멱등) 또는 `/opt/matter-gateway` 에서 `docker compose build agent && docker compose up -d --pull missing`.
2. (완료) **24시간 안정성(AC)**: 2026-10-20 01:06 ~ 10-21 01:02 KST 구간을 `stability-check.sh 24h` 로 점검 — 컨테이너 재시작 0, 에이전트 재접속 0(ERROR 2건은 부팅 직후 ECONNREFUSED), 두 기기 online, 센서 battery 100 보고. 단 matterjs-server 가 10-20 21:36 과 21:51 에 플러그(@1:5)를 "offline grace period expired" 로 잠시 unavailable 처리 후 재구독한 기록 2건(각 수십 초, 제어 영향 없음) — §9 발견 사항 참고.
3. claim 흐름 실측(플랫폼팀 또는 curl 로 `POST /siot-app/api/v1/claim`) 과 플랫폼 페어링 화면 연동. relay-v2 bind 는 Mac 로컬 백엔드로 실측 완료(§9).
4. matterjs-server 가 matter.js > 0.17.9 로 올라오면 `host/patches` bind-mount 와 `MATTER_IMAGE` 재검토. 추가 기기(IKEA 조명 등)로 멀티 어드민(commissioning-window) 검증.
5. 로그: `docker logs gateway-agent`, `docker logs matterjs-server`, `docker exec otbr ot-ctl state|neighbor table`, `~/install2.log`. BLE 심층 추적은 `sudo btmon`.

## 7. 그 다음 단계(우선순위)
1. 실기기 검증 결과로 코드 수정(예상 지점: matterjs-server 노드 스냅샷 필드, BLE 안정성, 슬리피 장치 구독).
2. 플랫폼/앱 페어링 화면(플랫폼팀) — `docs/openapi.yaml`, `docs/platform-integration.md` 기준.
3. Zigbee 어댑터(두 번째 동글, zigpy/Zigbee2MQTT → 중립 모델 `zigbee:` 접두어).
4. 양산: 이미지 복제, OTA, CM5/MG24 모듈 보드, CSA Vendor ID·Thread Group 가입.

## 8. 참고 사실
- IKEA 두 기기는 Dirigera 없이 타사 컨트롤러에 직접 페어링됨. 센서는 Thread 보더 라우터 필수. GRILLPLATS 는 QR 인식 문제 보고가 있어 11자리 수동 코드 경로도 지원함.
- 기존 siot-app 계약 참조 파일: `siot-app/lib/{gateway-id,gateway-identity,registration,platform-auth,types,device-mapper,control-map,mdns,relay-agent,system-status}.ts`, `siot-app/app/siot-app/api/v1/*`.
- VENDOR_ID 0xFFF1(=65521) 은 테스트용. compose 에는 **10진수**로 적을 것(5b-3 참고). 상용은 CSA 가입 후 발급 VID 필요.

## 9. M1 에이전트 Pi 실기기 반영·검증 (2026-10-21 01:00~22:40 KST)
main 의 M1 커밋(e304215·597abf0·d789eff·469fd58)을 Pi 에 반영하고 계획 §3 B7, Step 2 완료 조건(인터넷 차단 재부팅), C3 ③ 을 실측했다. 코드 수정은 없고 이 문서만 갱신. 로그 시각은 docker 로그 기준 UTC(KST −9h).

### 반영 절차 (그대로 재현 가능)
1. 반영 전: `/opt/matter-gateway/.env`·`docker-compose.yml`·`compose ps`·`compose config`·systemd unit 을 Pi `~/backup-m1-20261021-0101/` 에 백업. `docker image inspect` 로 compose 의 digest 고정값이 Pi 에 이미 있는 이미지와 일치함을 확인(otbr `70d2260e…` = v2026.10.0, matterjs-server `54232d0d…` = stable/latest, RepoDigests 보유).
2. Mac 에서 `rsync -az --exclude node_modules --exclude data --exclude .env matter-gateway-poc/` → Pi `~/matter-gateway-poc/matter-gateway-poc/`(소스) 와 `/opt/matter-gateway/`(설치본, `state/`·`.claude`·`.omc` 도 제외).
3. `.env` 에 `SIOT_MODE=production`, `SIOT_RELAY_URL=off`, `OTBR_IMAGE`/`MATTER_IMAGE`(digest), `AGENT_IMAGE=siot-matter-agent:local`, `PAIRING_MAX_ATTEMPTS=3` 추가. `.env` 는 root 소유였으나 디렉터리가 gslt 소유라 `mv`+`cp` 로 gslt 소유 사본으로 교체(`.env.pre-m1.bak` 보관). `state/{requests/{ota,ctl},health,out}` 생성.
4. `docker compose config -q` 통과 → `docker compose build agent`(약 20초, 캐시) → `docker compose up -d --pull missing --remove-orphans`: 컨테이너 3개 Recreate(이미지 참조가 태그→digest 로 바뀌어 otbr·matter 도 재생성, Thread 망은 data/otbr 로 유지되어 `leader` 즉시 복귀). 전후 `docker images --digests` 동일 → **pull 없음**.
5. root 가 필요한 부분(`/etc/systemd/system/matter-gateway.service` 갱신, `/var/lib/siot`)은 터미널 탭에서 `ssh -t gslt@192.168.0.172 'sudo bash ~/m1-sudo.sh'` 로 `install.sh --mode=production --thread=defer` 재실행(21:43 KST, 멱등). 결과: unit `ExecStart=… up -d --pull missing --remove-orphans` / `ExecStop=… stop`, `/var/lib/siot` 0700, `ble-conn-params` supervision_timeout 200 유지, Thread 데이터셋 있음 → defer 라도 기존 망 그대로.

### 확인 결과
| 항목 | 결과 |
|---|---|
| production 기동 | **통과**. 에이전트 로그 `mode=production`, `listening on 0.0.0.0:3000`, `local admin API on 127.0.0.1:3001`, `ss -ltn` 에 3000(0.0.0.0)·3001(127.0.0.1). Ed25519 장치 키 최초 생성(pubKey `19SwjE5E…JNU`), `rules seeded: /app/rules.example.json → /app/data/rules.json`(기존 `./rules.json` 과 내용 동일), `data/agent/gateway.json` **0600**(512B, deviceKey·token 포함), `state/health/health.json` 10초 간격 갱신(`writtenAt` 16:05:09 → 16:05:19) |
| B7 ① LAN `POST :3000/api/register` | **404** (`GET :3000/siot-app/api/v1/devices` 도 404) |
| B7 ② LAN `:3001/` | **연결 거부**(curl exit 7) |
| B7 ③ Pi `curl ':3001/siot-app/api/v1/devices?token=x'` | **401** `미등록 게이트웨이입니다`(bind 전). bind 후에도 쿼리 토큰은 401 |
| B7 ④ Bearer 헤더 | **200**, `count:2`, `matter:5:1`·`matter:6:1` 모두 `online:true`. LAN `GET :3000/api/gateway` 는 `{gatewayId, shortId:"dd10c2c3", bound, version, pubKey}` 만. 출고 상태 페이지 `http://192.168.0.172:3000/` 브라우저 확인(에이전트 정상·라벨 코드 dd10c2c3·세대 연결됨, 콘솔 오류 0) |
| 플러그 ON/OFF 10회(명령 20건, 3001 Bearer + SSE 확정) | **19/20 ≤2초**. 확정 중앙값 128ms·HTTP 중앙값 80ms. 1건(ON, 19번째) HTTP 5.9s/확정 5.96s — matterjs-server INFO 로그엔 흔적 없음(5b 의 MRP 재전송과 같은 양상으로 추정). 미확정 0 |
| 도어센서 SSE | **통과**. 22:32:53~22:33:21 KST 자석 6회 뗐다 붙임 → `/siot-app/api/v1/events` 로 12건 모두 전달(open/close 교대, battery 100). 같은 12건이 백엔드 `device.state_changed` 웹훅으로 partner-sim 에 도착(GW 보고 시각 대비 −39~+1272ms, 서명 검증 OK, 중복 0) |
| 인터넷 차단 재부팅(계획 590행) | **통과**. 22:33:37 공유기 WAN 뽑고 Pi 전원 재투입 → 부팅 후 `network-online` 직후 `matter-gateway.service` 가 **1초 안에 Finished**(journal 에 `Container … Running` 3줄뿐, 이전 unit 의 `Pulling/Pulled` 줄 없음). 컨테이너 **ID 3개 모두 재부팅 전과 동일**(01:04·01:07 생성분 보존), 이미지 목록 동일. OTBR `leader`, `Registered Thread credentials from stored`, 플러그 +6초·센서 +11초 online, 에이전트 `synced 2 nodes`(ECONNREFUSED 2회 후 6초), 릴레이 재접속 +2초, LAN `/api/gateway` bound. NTP 첫 동기는 부팅 33초 뒤(22:34:29) — 그 전에 compose 기동이 끝났으므로 인터넷 없이 기동한 것이 맞다. 단 WAN 은 부팅 30초쯤 뒤 다시 연결됐다(+20s 시점 ghcr.io 도달). `ExecStop=stop` 경로는 전원 차단이라 실행되지 않음(아래 미검증 참고) |
| C3 ③ (relay 차단 5분 → 해제, 3회) | **통과 3/3**. Mac 로컬 백엔드(`ws://192.168.0.89:8090/gateway`) 기준, `sudo bash ~/c3-cycle.sh`(iptables OUTPUT DROP dst 192.168.0.89:8090). 해제→`gateway.online` 웹훅: **4.7s / 1.8s / 1.0s**(≤60s). 차단→`gateway.offline` 웹훅: 25s / 15s / 15s(서버 heartbeat timeout 25s). 에이전트는 차단 중 `Opening handshake has timed out` 으로 백오프(최대 ~21s) 재시도 |

### C3 ③ 환경(백엔드 미배포라 Mac 로컬로 대체)
- Mac: `siot-cloud/apps/api` 를 `HOST=0.0.0.0 node --import tsx src/server.ts`(8090, `.env` 의 HOST=127.0.0.1 을 덮어씀), partner-sim 8787. 방화벽 꺼져 있어 Pi 에서 `http://192.168.0.89:8090/healthz` 200.
- `npm run admin -- gateway:provision --id gw_dd10c2c3-… --pubkey 19SwjE5E… --org org_01M5D05DKTM07803K6HEFGHM23` → 라벨 코드 `8ba9-238d-537e-e48b`. 기사 계정 `installer2@test.local` 생성, 세대 `site_01M5D130PV7H8BD321YNJV597G`("Pi 실기기 세대") 생성 후 `POST /app/v1/gateways/claim` → `bound`, 에이전트 로그 `bound … 토큰으로 재접속` → `cfg 적용 v1`. 웹훅 `wh_01M5D11Y058WGTAGE1SMHHKXE7`(gateway.online/offline, device.state_changed → `http://127.0.0.1:8787/hook`). 이전 QA 의 sim 웹훅(`wh_01M5D0BH…`, 비밀 다름)은 401 재시도를 내서 삭제.
- 검증 뒤 Pi `.env` 는 다시 **`SIOT_RELAY_URL=off`** 로 돌리고 에이전트만 재기동(토큰은 `gateway.json` 에 남아 있어 Bearer 200 유지, health `relay.connected=false`). Fly 배포 후에는 `SIOT_RELAY_URL=`(비움) 으로 바꾸고 백엔드에 같은 pubKey 로 다시 provision·claim 해야 한다(로컬 DB 의 바인딩은 Fly 와 무관).

### 발견 사항 (코드 수정 없음)
1. **RTC 없는 재부팅 + 인터넷 없음 → 시각이 약 5.5분 뒤처진 채 기동.** 커널 1970 → `/var/lib/systemd/timesync/clock`(22:28:27) 로 올림 → NTP 동기(22:34:29) 전까지 docker 로그·health·snapshot 의 시각이 과거. 재부팅 직후 백엔드로 간 resync `device.state_changed` 3건의 `fromGatewayAt` 이 **+331초** 로 찍힘(5c-1 과 같은 원인, 이번엔 파트너 지연 지표에 그대로 노출). 대책 후보: RTC 배터리, 또는 에이전트가 NTP 동기 전(`timedatectl` NTPSynchronized=no) 이벤트의 `at` 을 신뢰하지 않게 표시.
2. `install.sh` 의 `docker compose build --quiet agent` 가 (tar 복사로 mtime 이 바뀌어) **새 이미지 ID** 를 만들었지만 이어지는 `docker compose up -d` 는 실행 중인 agent 컨테이너를 재생성하지 않았다(`Container gateway-agent Running`). 소스가 같아 영향은 없었고, 다음 `up -d` 에서 새 이미지로 재생성됨(릴레이 off 로 되돌릴 때 확인). 빌드 뒤 반드시 적용하려면 `up -d --force-recreate agent` 또는 `build` 와 `up` 을 한 줄(`up -d --build agent`)로.
3. 재부팅 전후 24시간 로그: matterjs-server 가 10-20 21:36·21:51 UTC 에 플러그(@1:5)를 "offline grace period expired" 로 unavailable 처리 → `Failed to probe reachability … resubscribe with new session` → 수십 초 뒤 복귀. 제어·이벤트엔 영향 없었으나 플러그 Thread 링크가 간헐적으로 끊긴다는 신호(RSSI −58~−75, 라우터 역할). 위치/간섭(5b 의 2.4G 수신기) 재확인 가치 있음.
4. 재부팅 후 센서(MYGGBETT)는 처음엔 OTBR 리더의 자식(`child table` 0xe801, RSSI −52)으로 붙었다가 다시 플러그 라우터 경유로 옮겨 감(5c-2 와 동일). 이벤트 전달 정상.
5. `docker compose up -d` 로 relay URL 만 바꿔도 agent 컨테이너가 재생성되어 `bootId` 가 바뀐다(백엔드는 resync 로 처리). 운영에서 `.env` 변경은 재부팅과 같은 비용으로 볼 것.
6. 플러그 제어 20건 중 1건 5.9초 지연은 5b·5c 와 같은 빈도(약 1/20). C3 ①(100회, ≤3초 99회 이상) 측정 시 이 비율이면 통과 경계이므로 실제 100회 측정이 필요하다(배포 후 `tools/slo/control-100.ts`).

### 미검증·남은 것
- (완료 22:59 KST) `ExecStop=stop` 정상 종료 경로: 터미널 탭에서 `sudo systemctl stop matter-gateway && docker ps -a && sudo systemctl start matter-gateway` → stop 뒤 컨테이너 3개가 **같은 ID 로 `Exited (0)`** 보존(삭제되지 않음), start 뒤 15초 안에 3개 `Up`(matterjs-server healthy), 기기 2대 online 복귀(journal: stop 은 otbr 종료에 9초, start 뒤 에이전트 synced +6초, 플러그 online +5초, 센서 +19초). 전원 차단 재부팅 경로에서는 docker 의 `unless-stopped` 가 부팅 때 먼저 올리고 compose 는 `Running` 만 확인했다.
- C3 ①·②(플러그 100회·같은 명령 10회), 인터넷 차단 상태를 **길게 유지한** 재부팅(이번엔 WAN 복구가 부팅 30초 뒤), Fly 배포 후의 C3 ③ 재측정(인터넷 경유 443).
- 임시 파일: Pi `~/m1-sudo.sh`, `~/c3-cycle.sh`, `~/c3-cycle.log`, `~/plug-check.py`, `~/plug-check-*.log`, `~/door-sse.log`, `~/pre-reboot.txt`, `~/images-{before,after}.txt`, `~/.gw-token`(3001 Bearer, 0600), `~/backup-m1-20261021-0101/`. Mac 로컬 DB(`siot_dev`)에 Pi GW 행·세대·기사 계정·API 키·웹훅이 남아 있다.

### 9b. 로컬 자동화(룰) 실측과 오프라인 이벤트 재전송 (2026-10-22 00:14~00:50 KST)
- **규칙 ID 수정.** Pi 의 `data/agent/rules.json` 은 예시 그대로(`matter:2`→`matter:1`)라 10-21 밤 자석 12회 동안 한 번도 발동하지 않았다. 컨테이너 안에서 `matter:6`(MYGGBETT)→`matter:5`(GRILLPLATS) 로 바꾸고(원본 `rules.json.example.bak`) 에이전트 재기동 → `2 rules loaded`. 예시 파일의 자리표시자 ID 는 의도된 것이므로 **Pi 마다 1회 맞춰야 한다**(M2 D3 에서 PWA→`cfg.rules` 로 대체).
- **인터넷 없이 동작 확인(사용자 WAN 분리 후 자석 조작).** 문 열림 11회 모두 `rule fired: door-open-turns-plug-on` → 플러그 ON. SSE 기준 문 열림 이벤트 → 플러그 `switch:true` 확정 93~223ms(중앙값 약 120ms). 닫힘 규칙의 `delay 5000` 때문에 빠르게 뗐다 붙이면 5초 뒤 OFF 가 다음 ON 을 덮어 헷갈렸음 → **닫힘 규칙의 delay 를 제거**(즉시 OFF). 제거 후 발동은 로그로 확인, 지연 수치는 미측정.
- **오프라인 이벤트 재전송(relay-v2 replay).** Mac 백엔드에 다시 붙인 뒤 백엔드 프로세스를 54초 내리고 그 사이 3001 로 플러그 ON/OFF 6회(seq 4~9) → 백엔드 복귀 후 에이전트 재접속(백오프 최대 ~24초) 즉시 snapshot 다음에 6건 모두 `replayed:true` 로 DB `events` 에 들어왔고(`at` 은 원래 발생 시각, `received_at` 은 15:47:10), 파트너 웹훅 `device.state_changed` 6건이 재접속 1초 안에 도착(`fromGatewayAt` 39~55초 = 오프라인 시간). 10-21 C3 ③ 차단 중 이벤트 4건도 같은 경로로 `replayed=t` 로 남아 있다.
  - **한계(설계대로):** 링버퍼는 메모리, 부팅당 1,000건(`relay.js RING_SIZE`). 에이전트 재시작·정전이면 버퍼가 사라지고 백엔드는 snapshot 차이로 `resync` 이벤트만 합성한다(이번 재부팅 뒤 `kind=resync` 2건 확인). 1,000건을 넘으면 오래된 것부터 버린다. 그리고 **지금 Pi 는 `SIOT_RELAY_URL=off`** 라 어떤 백엔드로도 보내지 않는다 — Fly 배포 후 URL 을 비우고 provision·claim 해야 재전송이 의미를 가진다.
- 검증 뒤 `.env` 는 다시 `SIOT_RELAY_URL=off`, 에이전트 재기동. Mac API·partner-sim 종료.
- **(발견, 2026-10-22 00:55) Pi 의 유선 LAN 케이블을 뽑으면 로컬 자동화가 멈춘다.** 공유기 WAN(인터넷)만 뽑은 00:42 시험은 11/11 발동했지만, Pi 의 eth0 케이블을 뽑은 00:54:54~00:57:11 구간에는 도어 이벤트가 하나도 들어오지 않았고 플러그 구독도 1m47s 뒤 만료됐다(Pi→플러그 probe 는 성공, 기기→Pi 방향만 끊김). 케이블 복구 뒤 첫 제어 1건이 10초 타임아웃, 이후 정상. 원인 후보: OTBR 이 인프라 인터페이스(eth0) 다운 시 OMR 프리픽스/경로를 거두거나, 기기가 알고 있는 컨트롤러 주소가 eth0 쪽이라 회신 불가. 세대 요구사항은 "인터넷 없이 동작"이지 "공유기·스위치 없이 동작"이 아니므로 M1 에선 **Pi 는 공유기(LAN)에 항상 유선 연결** 로 운영. 공유기 전원 차단까지 버티는 것은 계획 D4(ii) 범위라 그때 OTBR `OT_INFRA_IF`/주소 선택을 손본다. 센서 쪽 구독은 최대 30분(구독 max 30m) 뒤에야 재설정되므로 케이블 복구 직후 바로 쓰려면 `docker compose restart matter`.

### 9c. 공유기 없이 동작 — 원인 확정과 수정 (2026-10-22 01:00~09:15 KST)
**증상.** Pi 의 LAN 케이블을 뽑으면(공유기 WAN 이 아니라 Pi 쪽 eth0 링크 다운) 도어센서→Pi 보고가 끊겨 로컬 자동화가 멈추고, 센서는 보고 실패 몇 분 뒤 스스로 재부팅(bootReason=1)했다. Pi→기기 요청은 성공했다.

**조사.** `ip link set eth0 down` 으로 내린 재현(4회)은 모두 정상(도어 36/36)이었고, 실제 케이블 분리(3회)는 매번 센서가 끊겼다. `tcpdump -i wpan0` 캡처에서 센서가 Pi 로 보낸 첫 패킷의 목적지가 **Pi 의 eth0 IPv6 주소(fd54:…, 공유기 RA 로 받은 ULA)** 였다. matter.js 가 `PRIMARY_INTERFACE=eth0` 로 자기 운영 레코드를 광고하고 OTBR 이 같은 인터페이스(`OT_INFRA_IF=eth0`)에서 DNS-SD 프록시를 돌리므로, Thread 기기가 컨트롤러를 다시 찾을 때(기기 주도 CASE 재개·구독 보고) 유선 주소를 받는다. 케이블이 빠지면 그 주소가 사라져 기기→Pi 방향만 끊긴다. 세션이 메시로컬 주소에 묶여 있을 때는 멀쩡하므로 재현이 들쭉날쭉했다(플러그는 메시로컬 세션이라 대부분 정상). 소프트웨어 다운이 통과한 것도 그때 센서 세션이 메시로컬이었기 때문.

**수정(한 가지).** OTBR 인프라 인터페이스와 matter.js PRIMARY_INTERFACE 를 항상 살아 있는 더미 인터페이스 **`siot0`** 로 옮겼다.
- `host/siot-infra.service`(부팅 때 `ip link add siot0 type dummy`, docker 보다 먼저), `host/91-siot-infra.conf`(NetworkManager 비관리 — NM 이 관리하면 IPv6 auto 가 RA 를 기다리다 활성화에 실패함, 실측), `host/99-matter-thread.conf` 에 siot0 accept_ra=2/forwarding=1, `install.sh` 기본 `BACKBONE_IF=siot0`(+ `LAN_IF=eth0` 는 sysctl 용), compose 기본값 siot0.
- 동작: OTBR 이 siot0 에 자기 on-link prefix(fd9e:…/64) RA 를 보내고 커널 SLAAC 가 Pi 에 `fd9e:…` 주소를 붙인다. OTBR `br state` 는 케이블이 빠져도 **running** 유지(인프라 링크가 항상 UP), OMR prefix 도 유지. matter.js 는 siot0 의 fd9e 주소로 광고(IPv4 없음 경고는 무해).
- eth0 는 그대로 LAN(ssh·릴레이·`_siot._tcp` 광고). LAN 의 다른 장치가 Thread 기기에 직접 라우팅하는 기능은 사라지지만 설계상 모든 접근이 에이전트를 거치므로 쓰지 않는다. IP 기반(Wi-Fi/유선) Matter 기기 커미셔닝이 필요해지면 `BACKBONE_IF=eth0` 로 되돌리거나 브리지(eth0+더미)로 바꿔야 한다.

**검증(09:06~09:07 케이블 실제 분리, 자석 10초 간격).** 분리 중 도어 이벤트 34건 전부 도착·규칙 34회 발동·플러그 동작, `br state running` 유지, 복구 후 센서 재부팅 없음. 플러그 양방향도 정상.

**운영 메모.** Pi 의 `.env` 는 `BACKBONE_IF=siot0`. 되돌리기: `BACKBONE_IF=eth0` → `docker compose up -d`, `sudo systemctl disable --now siot-infra`. Pi 임시 파일: `~/eth0-down-probe.sh|.log`, `~/unplug-monitor.sh|.log`, `~/sse-logger.sh`, `~/rule-sse.log`, `~/wpan0.pcap`(센서 패킷 캡처), `~/m1-dummy-if.sh|.log`. 센서 펌웨어 1.0.9 → DCL 에 1.1.4 OTA 가 있다고 matterjs-server 가 알림(미적용).

### 9d. C3 ①② 제어 SLO 실측 + GHCR 에이전트 이미지 (2026-10-26 23:10 KST)
- **C3 ①② 통과.** Mac 로컬 백엔드(8090, Pi 릴레이 `ws://192.168.0.89:8090/gateway`)에 Pi 를 붙이고 `tools/slo/control-100.ts` 를 공개 API 키로 실행(`SIOT_API=http://127.0.0.1:8090 DEVICE_ID=dev_01M5D12DB4J77PA3P1R2QNYDM2`, 요청 간격 400ms).
  - ① ON/OFF 교대 100회: **confirmed ≤3초 100/100**(기준 99). 확정 지연 p50 128ms · p95 191ms · p99 334ms · 최대 334ms. 미확정·오프라인 0.
  - ② 같은 ON 연속 10회: **10/10**. p50 74ms · p95 137ms(이미 ON 인 상태라 더 빠름).
  - 10-21 의 "20회 중 1회 5.9초" 지연은 이번 110회에선 없었다. 경계 케이스였던 1/100 우려는 해소. Fly 배포 후 인터넷 경유로 한 번 더 재는 것은 남음(계획 §7 M1-9).
  - 측정 후 Pi `.env` 는 다시 `SIOT_RELAY_URL=off`.
- **GHCR 에이전트 이미지.** 태그 `agent-v0.2.0` 푸시 → `.github/workflows/gateway-agent-image.yml`(npm test → OTA manifest → arm64 buildx → GHCR) 실행, 약 2분 만에 성공(run 40337431873). 이미지 `ghcr.io/dyiot36524-prog/siot-gateway-agent:0.2.0`, **digest `sha256:bbb4dad4995b43d187ebe8c7a8182b7a0c9105e428672c852f151f4186057040`**(공개, 익명 pull 가능 — 레지스트리 HEAD 로 확인). `.env AGENT_IMAGE=ghcr.io/dyiot36524-prog/siot-gateway-agent@sha256:bbb4dad4995b43d187ebe8c7a8182b7a0c9105e428672c852f151f4186057040` 로 바꾸고 `docker compose up -d --pull missing` 하면 Pi 가 로컬 빌드 대신 출고 이미지를 쓴다(아직 바꾸지 않음 — 로컬 빌드 유지).

### 9e. 플랫폼 자동화 규칙 → 게이트웨이 로컬 실행 (2026-10-26 23:00~24:00 KST, M3 Step 5 일부를 M1 로 당김)
플랫폼이 공개 API 로 자동화를 저장하면 백엔드가 게이트웨이별로 컴파일해 relay `cfg.rules` 로 내려보내고, 게이트웨이는 `rules.json` 에 영속해 **인터넷·백엔드 없이** 실행한다. 계약 원문: 세션 노트 `automations-contract.md`(§1 공개 형식, §2 게이트웨이 형식, §3 매핑). 게이트웨이 2대에 걸친 규칙(피어)은 M3 그대로 남김.

**구현(커밋 참조)**
- 공개 API `GET/PUT /v1/sites/{siteId}/automations`(스코프 read / control), `Gateway.rulesVersion`. 규칙: `trigger` = `device{deviceId(dev_), field, changedTo|equals}` 또는 `schedule{at:"HH:MM", days?, tz?=Asia/Seoul}`, `conditions[]{deviceId, field, equals|gt|lt}`, `actions[]{command{deviceId, ON|OFF|TOGGLE} | delay{ms}}`. 최대 100규칙·10조건·10액션. 오류 400 `VALIDATION_FAILED`(경로 포함) / `UNKNOWN_DEVICE` / `CROSS_GATEWAY_NOT_SUPPORTED`.
- 백엔드: `automation_rules`(세대당 1행, version, rules jsonb) + `gateways.rules_acked_version`(마이그레이션 `0001_automations.sql`). `src/automations/compile.ts` 가 `dev_`→`(gatewayId, matter:<node>, endpoint)` 와 `field`→`capability.field`(siotMapper 역방향: switch→onoff.on, active→contact.open|motion.detected, battery→battery.percent, power→power.watts, energy→energy.kwh, brightness→level.percent, value→센서 measurement 별) 로 바꾼다. PUT 은 한 트랜잭션에서 version+1, 세대 모든 GW `cfgVersion+1`, 커밋 뒤 접속 중인 GW 에 `cfg` 즉시 push(오프라인이면 다음 접속 때 자동). `cfg_ack.rulesVersion` → `appliedVersion`.
- 프로토콜: `relay-v2.json` `$defs.Rule`(불투명 객체 → 정식 스키마), fixture 2개 추가.
- 에이전트: `rules.js` — `{version, rules}` 파일, `replace()` 버전 가드(낮거나 같은 버전·v0+빈 배열 무시), `schedule` 트리거(30초 틱, tz 기준 분당 1회, `days`), **시계 게이트**(`SIOT_CLOCK_SYNC_FILE=/host/systemd/timesync/synchronized`, compose 가 `/run/systemd` 를 ro 마운트; 동기 전엔 schedule 보류·WARN 1회, 밀린 분 미실행; `health.json` `clockSynced`). `index.js` 가 `relay.on('cfg')` → `rules.onCfg()`. `mqtt` 액션 무시.
- 테스트: protocol 38→43, api 156→186(compile 19·통합 7), 에이전트 82→91(`rules.test.js`). OpenAPI lint 0, typecheck·gen:check 통과.

**실기기 검증(Mac 로컬 백엔드 8090 + Pi)**
| 장면 | 결과 |
|---|---|
| PUT(도어 열림→ON, 닫힘→OFF, 23:51 예약 OFF, 23:55 예약 ON) | 200 version 2. **1초 안에** Pi 로그 `cfg 적용 v3 (rulesVersion=2)` → `rules installed v2 (4 rules)`, GET `appliedVersion: 2`, `data/agent/rules.json` version 2 |
| 예약 OFF 23:51 (온라인) | `rule fired … {"schedule":"2026-10-26 23:51"}` 23:51:13, SSE 플러그 switch:false +120ms |
| 예약 ON 23:55 (온라인) | 23:55:13 발동, +110ms 확정 |
| 예약 OFF 23:59 (**백엔드 정지 상태**, 에이전트는 ECONNREFUSED 재접속 루프 중) | **23:59:13 발동, +140ms 플러그 OFF** — 백엔드 없이 로컬 스케줄 실행 확인. 백엔드 복귀 뒤 이벤트는 replay 로 전달(9b 와 동일 경로) |
| 도어 트리거 오프라인 | 10-22 의 공유기 없는 시험(9c, 34/34)과 같은 엔진·같은 형식이라 재측정 생략. 이번엔 규칙이 플랫폼 API 에서 내려온 것만 다름 |
| 시계 게이트 (재부팅 실측, 10-27 00:34 전원 재투입) | **통과**. 부팅 직후 Pi 시계는 저장값(약 3분 20초 과거)으로 올라오고 `/run/systemd/timesync/synchronized` 없음 → 새 에이전트 `health.json` **`clockSynced: false`**(Pi 시계 00:35:07·00:35:17 샘플) → timesyncd 첫 동기 00:38:42(Pi 시계 기준, 실시간으로는 에이전트 기동 약 25초 뒤) → `clockSynced: true`. 규칙은 `2 rules loaded (v4)` 로 영속 확인. 전원 차단 직후 첫 샘플은 이전 부팅의 health.json 이 남아 `true` 로 보일 수 있음(에이전트가 10초 안에 덮어씀) |

**운영 메모**
- 플랫폼 쪽 사용법: 세대 기기 목록(`GET /v1/sites/{id}/devices`)의 `deviceId` 로 규칙을 만들어 `PUT …/automations` 한 번. `GET` 의 `gateways[].appliedVersion >= version` 이면 게이트웨이에 들어간 것. 규칙 전체 교체 방식이라 플랫폼이 원본을 보관해야 한다.
- `tz` 기본 Asia/Seoul, `days` 생략은 매일. 같은 분에 두 번 발동하지 않는다. 게이트웨이가 꺼져 있던 동안 지나간 예약은 실행하지 않는다(밀린 실행 없음).
- 검증 뒤 Pi 규칙은 도어 2개만 남기고 예약은 지움(매일 밤 플러그가 토글되지 않도록). Pi `.env` 는 다시 `SIOT_RELAY_URL=off`.
- CI e2e `apps/api/test/relay/e2e.automations.test.ts`: 실제 에이전트(시뮬 백엔드) 자식 프로세스로 PUT → rules.json v1 → 시뮬 도어 열림 → 에이전트가 플러그 ON → evt → 공개 API 반영, PUT [] → v2 까지 1.5초. 커밋 e47291f.
- 남은 것: 세대 초기화 시 `automation_rules` 삭제, 공개 API 에서 `power`/`energy` 트리거는 endpoint 를 특정하지 않음(멀티 엔드포인트 플러그에서 교차 발동 가능), 피어(GW 2대) 규칙은 M3.
