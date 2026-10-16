# Deep Interview Spec: Matter/Thread 게이트웨이 Pi 설치본 + 앱 연동

## Metadata
- Interview ID: 09db089a-575d-4c99-9442-2ca61fdb50cb
- Rounds: 9 (+ Round 0 topology)
- Final Ambiguity Score: 19%
- Type: brownfield
- Generated: 2026-10-15T04:41:38.841942+00:00
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.85 | 0.35 | 0.298 |
| Constraint Clarity | 0.75 | 0.25 | 0.188 |
| Success Criteria | 0.78 | 0.25 | 0.196 |
| Context Clarity | 0.83 | 0.15 | 0.125 |
| **Total Clarity** | | | **0.806** |
| **Ambiguity** | | | **0.194** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| Pi 설치본 | active | Pi 5 + NVMe + ZBT-2 에 Pi OS Lite 64-bit, Docker Compose, systemd 자동 기동 | AC-1 ~ AC-4 |
| Matter/Thread 코어 | active | OTBR + matterjs-server(기본) / matter.js 임베드(예비)로 IKEA 2종 커미셔닝·제어·상태 수신 | AC-5 ~ AC-8 |
| 앱/플랫폼 연동 | active | 기존 siot-app 플랫폼 API 계약을 게이트웨이 에이전트에 재구현 + 인증된 pairing API 추가 | AC-9 ~ AC-13 |
| Zigbee | deferred | 두 번째 동글로 Zigbee 기기 연동 | 사용자 확인 보류 (2026-10-15T04:26:40.698205+00:00): 다음 단계 |

## Goal
구매한 Raspberry Pi 5(NVMe, ZBT-2)에 Home Assistant 없이 설치 스크립트 1회로 설치되는 Matter/Thread 게이트웨이를 만든다. 게이트웨이 에이전트(`matter-gateway-poc/agent`, Node.js)가 기존 시옷앱 게이트웨이의 플랫폼 API 계약(`/siot-app/api/v1/*`, 등록코드 claim, Bearer 토큰, SSE, mDNS `_siot._tcp`, 릴레이)을 그대로 제공해 기존 플랫폼·앱이 수정 없이 게이트웨이를 등록·조회·제어하고, 새로 추가하는 인증된 pairing API로 IKEA Matter-over-Thread 플러그(GRILLPLATS)와 문열림 센서(MYGGBETT)를 게이트웨이 BLE로 커미셔닝한다.

## Constraints
- OS: Raspberry Pi OS Lite 64-bit, NVMe 부팅. HA OS/애드온 미사용. Docker Compose + systemd.
- 네트워크: Pi 는 유선 이더넷(eth0) 고정. OTBR 백본·mDNS·Matter 인터페이스 모두 eth0. Pi Wi-Fi 미사용.
- Matter 백엔드: matterjs-server 컨테이너 기본. matter.js 임베드 백엔드는 코드 유지하되 Pi 에서 Thread BLE 커미셔닝 실패 시에만 전환(환경변수 스위치).
- 코드 기반: `matter-gateway-poc/agent` 를 확장. Next.js `siot-app` 은 수정하지 않으며 계약의 참조 구현으로만 사용.
- 플랫폼 API 계약은 siot-app 과 동일해야 함: gatewayId = `gw_` + uuidv5(hw serial, 네임스페이스 6f1d2c9e-7a3b-5c4d-8e2f-1a2b3c4d5e6f), 등록코드(8 hex, 10분), `POST /siot-app/api/v1/claim` → `{gatewayId, gatewayToken}`, Bearer/`?token=` 인증, `SiotDevice{id,name,deviceType,online,data,lastUpdated}`, control action 문자열, SSE `data: {"type":"device",...}` + 25초 ping, `GET /system`, mDNS `siot-<shortId>` `_siot._tcp` port 3000 TXT `{id, app, url}`, 릴레이 프레임 `{t:"req"|"res", ...}`.
- 페어링 API 는 플랫폼용 인증 경로에 신규 추가(`POST /siot-app/api/v1/pairing` 등). 플랫폼·앱 페어링 화면은 별도 작업(플랫폼팀)으로 병행. 앱 화면 전까지 게이트웨이 로컬 페이지(인증 없음, LAN)에서 QR/수동코드 입력 페어링 가능.
- 합격 판정은 같은 공유기 LAN 기준. 릴레이 에이전트는 `SIOT_RELAY_URL` 설정 시 동작하도록 구현하되 판정 제외(릴레이 서버는 저장소 밖).
- 멀티 어드민(커미셔닝 창 열기) 지원 유지. 로컬 룰 엔진은 PoC 코드 그대로 포함(합격 기준 아님).
- Vendor ID 0xFFF1(테스트) 유지. CSA/Thread Group 인증은 범위 밖.
- PoC 의 MQTT 푸시 경로는 제거(또는 비활성). 클라우드 방향은 기존과 같이 플랫폼→게이트웨이.

## Non-Goals
- Zigbee 연동(보류), 이미지 복제 양산(.img 골든 이미지), OTA 업데이트 체계
- 플랫폼/앱 UI 변경(페어링 화면 포함)과 릴레이 서버 변경
- CSA/Thread 인증, 상용 VID, 양산 하드웨어(CM5)
- HA OS 애드온 패키징

## Acceptance Criteria
- [ ] AC-1 Pi OS Lite 64-bit 를 NVMe 에 플래시하고 SSH 접속 후 `install.sh` 1회 실행으로 Docker, sysctl(IPv6 accept_ra=2, conntrack 3600), systemd 유닛, ZBT-2 장치 경로, compose 기동까지 완료된다.
- [ ] AC-2 전원을 뽑았다 꽂으면 OTBR·matterjs-server·에이전트가 사용자 개입 없이 복구되고 기존 Thread 네트워크·페어링 기기가 유지된다.
- [ ] AC-3 OTBR 이 leader 상태이고 데이터셋이 에이전트에 자동 등록되어 수동 `dataset` 명령이 필요 없다.
- [ ] AC-4 같은 공유기 Wi-Fi 의 폰에서 `siot-<shortId>.local:3000` 과 mDNS `_siot._tcp` 탐색으로 게이트웨이가 발견된다.
- [ ] AC-5 IKEA GRILLPLATS 와 MYGGBETT 2대 모두 게이트웨이 BLE 로 커미셔닝되어 `GET /siot-app/api/v1/devices` 에 각각 deviceType PLUG, BINARY_SENSOR 로 나타난다.
- [ ] AC-6 문을 열고 닫을 때 플랫폼 SSE `/siot-app/api/v1/events` 에 디바이스 이벤트가 5초 이내 도착한다.
- [ ] AC-7 `POST /siot-app/api/v1/devices/{id}/control` `{"action":"ON"}`/`"OFF"` 호출 후 2초 이내 플러그가 실제 전환되고 상태가 반영된다.
- [ ] AC-8 24시간 연속 운영 중 문열림 센서가 오프라인으로 빠지지 않고 상태 갱신이 계속 들어온다(배터리·슬리피 장치 구독 유지).
- [ ] AC-9 로컬 UI 등록코드 발급 → 플랫폼(또는 curl 대행)의 `POST /siot-app/api/v1/claim` → 토큰 발급 → 이후 API 가 Bearer 토큰으로 동작하고, 미인증 호출은 401 을 돌려준다.
- [ ] AC-10 `GET /siot-app/api/v1/system`, `/gateway`, `/devices`, `/devices/{id}`, `/events` 응답 형태가 siot-app 과 동일해 기존 플랫폼 코드가 수정 없이 동작한다(응답 스키마 대조 테스트 포함).
- [ ] AC-11 `POST /siot-app/api/v1/pairing` 에 Matter QR 문자열 또는 수동 코드를 보내면 세션 id 가 반환되고, 진행 단계(commissioning→interviewing→done/failed)가 SSE 또는 `GET /pairing/{id}` 로 조회된다.
- [ ] AC-12 게이트웨이 로컬 페이지에서 QR/수동코드를 입력해 같은 페어링 흐름을 실행할 수 있다(앱 화면 전까지의 대체 경로).
- [ ] AC-13 `SIOT_RELAY_URL` 을 설정하면 릴레이 WebSocket 에 접속해 req/res 프레임을 로컬 API 로 프록시한다(기능 구현 확인, 합격 판정 제외).

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 게이트웨이가 클라우드로 MQTT 푸시한다(PoC 설계) | 기존 플랫폼은 플랫폼→게이트웨이 REST/SSE 호출 구조 | 기존 계약 그대로 재구현, MQTT 푸시 제거 |
| 새 게이트웨이는 siot-app(Next.js) 위에 만든다 | PoC 에이전트에 API 추가가 더 가벼움 | PoC 에이전트 확장, siot-app 은 참조 구현 |
| 앱에서 페어링은 당연히 된다 | 플랫폼 API 에 페어링 엔드포인트가 없음 | 게이트웨이에 인증된 pairing API 신규 추가, 앱 화면은 별도 작업, 로컬 페이지로 대체 |
| Matter 백엔드 2종을 계속 유지 | 단순화: 하나만 기본 | matterjs-server 기본, 임베드는 예비 스위치 |
| 외부 접속까지 이번에 확인 | 릴레이 서버가 저장소 밖 | LAN 기준 판정, 릴레이는 구현만 |
| Pi 네트워크는 Wi-Fi 일 수도 | 백본 인터페이스 고정 필요 | 유선 eth0 고정 |

## Technical Context
- 참조 구현(siot-app): `lib/gateway-id.ts`(uuidv5), `lib/gateway-identity.ts`(hw serial), `lib/registration.ts`/`app/siot-app/api/v1/claim/route.ts`(claim), `lib/platform-auth.ts`(timing-safe Bearer), `lib/types.ts`(SiotDevice, DEVICE_TYPES), `lib/device-mapper.ts`(data 키), `lib/control-map.ts`(action 문자열), `app/siot-app/api/v1/events/route.ts`(SSE 포맷), `lib/mdns.ts`(_siot._tcp), `lib/relay-agent.ts`(릴레이 프레임), `lib/system-status.ts`(/system 응답).
- 기반 코드(PoC): `matter-gateway-poc/agent/src/{matterClient,matterBackend,pairing,rules,model/*}.js`, `docker-compose.yml`, `host/*`.
- 신규: 플랫폼 API 서버 모듈(HTTP+SSE, 포트 3000), claim/등록코드, gatewayId 파생, mDNS 광고, 릴레이 클라이언트, 중립 모델→SiotDevice 매핑, 로컬 페어링 페이지, `install.sh`, systemd 유닛, OTBR 데이터셋 자동 주입.

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Gateway | core domain | gatewayId, gatewayToken, shortId | Gateway serves Platform API; Gateway controls Devices |
| Platform | external system | - | Platform claims Gateway; Platform polls/streams Devices |
| 시옷플랫폼 앱 | external system | - | App scans Gateway QR / enters code |
| RegistrationCode | supporting | code, expiresAt | exchanged for GatewayToken |
| SiotDevice | core domain | id, name, deviceType, online, data | Gateway exposes SiotDevices |
| Matter EndDevice | core domain | nodeId, vendor, clusters | mapped to SiotDevice; joined to Thread network |
| Thread Network/OTBR | supporting | dataset, networkName | Gateway hosts OTBR |
| Relay | external system | SIOT_RELAY_URL | Platform reaches Gateway via Relay |
| Pi 설치 이미지 | supporting | Raspberry Pi OS Lite 64-bit, NVMe, Docker Compose, systemd | Gateway runs on Pi 설치 이미지 |
| Gateway Agent 프로세스 | core domain | Node.js, Matter 엔진, Platform API 서버, claim, mDNS, relay | Gateway Agent implements Platform API; Gateway Agent hosts Matter Engine |
| PairingSession | core domain | sessionId, setupCode, stage, deviceId | App starts PairingSession via Platform API; Gateway Agent runs PairingSession |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 8 | 8 | - | - | - |
| 2 | 9 | 1 | 0 | 8 | 100% |
| 3 | 10 | 1 | 0 | 9 | 90% |
| 4 | 11 | 1 | 0 | 10 | 91% |
| 5 | 11 | 0 | 0 | 11 | 100% |
| 6 | 11 | 0 | 0 | 11 | 100% |
| 7 | 11 | 0 | 0 | 11 | 100% |
| 8 | 11 | 0 | 0 | 11 | 100% |
| 9 | 11 | 0 | 0 | 11 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (10 rounds incl. Round 0)</summary>

### Round 0
**Q:** Topology confirmation (4 components)
**A:** Zigbee 미루고 1~3만
**Ambiguity:** 100%
### Round 1
**Q:** 새 게이트웨이는 기존 siot-app API 계약(/siot-app/api/v1/*, claim, mDNS, 릴레이)을 그대로 구현해 플랫폼/앱 무수정 연동?
**A:** 네, 기존 계약 그대로. PoC 의 MQTT 푸시는 버림
**Ambiguity:** 62% (Goal: 0.4, Constraints: 0.3, Criteria: 0.3, Context: 0.6)
### Round 2
**Q:** HA OS 없이 Raspberry Pi OS Lite 64-bit + NVMe + Docker Compose + systemd 자동 기동?
**A:** 네, Pi OS + Docker, HA 없이
**Ambiguity:** 51% (Goal: 0.6, Constraints: 0.4, Criteria: 0.35, Context: 0.6)
### Round 3
**Q:** siot-app 코드베이스에 Matter 엔진 이식 vs PoC 에이전트에 API 추가 vs 두 프로세스 분리?
**A:** PoC 에이전트에 /siot-app/api/v1 계약, claim, mDNS, 릴레이를 추가 구현 (Next.js siot-app 미사용)
**Ambiguity:** 45% (Goal: 0.65, Constraints: 0.45, Criteria: 0.4, Context: 0.75)
### Round 4 (contrarian)
**Q:** 앱에서 Matter QR 스캔→페어링 완료까지 합격 기준에 포함? (플랫폼 API pairing 엔드포인트 추가 + 앱 화면 필요)
**A:** 네. 게이트웨이에 인증된 pairing API 추가, 플랫폼·앱 페어링 화면은 별도 작업으로 병행. 앱 화면 전까지는 게이트웨이 로컬 페이지로 페어링
**Ambiguity:** 40% (Goal: 0.65, Constraints: 0.5, Criteria: 0.5, Context: 0.8)
### Round 5
**Q:** 설치 산출물: Pi OS 플래시 후 SSH 에서 설치 스크립트 1회 실행. 합격: 전원 재투입 후 자동 복구 + 앱이 mDNS 로 찾아 claim 가능
**A:** 네, 설치 스크립트 + 재부팅 복구 기준. 이미지 복제 양산은 다음 단계
**Ambiguity:** 33% (Goal: 0.75, Constraints: 0.52, Criteria: 0.6, Context: 0.83)
### Round 6 (simplifier)
**Q:** matterjs-server 컨테이너를 기본, matter.js 임베드는 Thread BLE 커미셔닝 실패 시 예비?
**A:** 네, 서버 기본 + 임베드는 예비
**Ambiguity:** 30% (Goal: 0.8, Constraints: 0.6, Criteria: 0.6, Context: 0.83)
### Round 7
**Q:** Matter 코어 합격 기준: 2대 BLE 커미셔닝, 문열림→SSE 5초, 플러그 제어 2초, 24h 안정성
**A:** 네, 4가지 모두
**Ambiguity:** 26% (Goal: 0.8, Constraints: 0.6, Criteria: 0.73, Context: 0.83)
### Round 8
**Q:** 앱 연동 합격은 LAN 기준, 릴레이는 SIOT_RELAY_URL 설정 시 동작하도록 구현만?
**A:** 네, LAN 기준 + 릴레이는 구현만
**Ambiguity:** 23% (Goal: 0.82, Constraints: 0.68, Criteria: 0.77, Context: 0.83)
### Round 9
**Q:** Pi 는 유선 이더넷(eth0) 고정, Wi-Fi 미사용?
**A:** 네, 유선 이더넷 고정
**Ambiguity:** 19% (Goal: 0.85, Constraints: 0.75, Criteria: 0.78, Context: 0.83)
</details>
