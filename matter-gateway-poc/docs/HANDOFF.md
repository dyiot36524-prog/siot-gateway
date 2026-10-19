# 인수인계 — Matter/Thread 게이트웨이 (2026-10-20 기준)

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
1. (완료) AC-1 재부팅 복구, (완료) AC-5 두 기기 커미셔닝·제어·이벤트. Pi 의 설치본은 `/opt/matter-gateway`(저장소 main 과 동일 내용). 소스 수정 후 반영: `rsync` 로 `~/matter-gateway-poc` 갱신 → `sudo ./install.sh` 재실행(멱등) 또는 `/opt/matter-gateway` 에서 `docker compose build agent && docker compose up -d`.
2. **24시간 안정성(AC)**: 창 시작 2026-10-20 01:06 KST. 2026-10-21 01:06 이후 `scripts/stability-check.sh` 로 재점검해 5c 표를 갱신(재접속·세션 오류·구독 끊김 0, 두 기기 online, 센서 battery 보고 확인). 재부팅 복원은 5c 에서 통과.
3. claim 흐름 실측(플랫폼팀 또는 curl 로 `POST /siot-app/api/v1/claim`) 과 플랫폼 페어링 화면 연동.
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
