# relay-v2 프로토콜 (게이트웨이 ↔ siot-cloud)

게이트웨이 에이전트(`agent/src/platform/relay.js`)와 클라우드(`siot-cloud/apps/api/src/relay/`) 사이의 WebSocket 터널 규칙이다.
프레임 JSON Schema 의 단일 원천은 `siot-cloud/packages/protocol/schema/relay-v2.json` 이고, 이 문서와 어긋나면 스키마가 우선한다.
계약 테스트: `agent/test/relayFrames.test.js`(fixture), `agent/test/relay.test.js`(에이전트가 실제로 보낸 프레임 전부를 스키마로 검증).
근거: `.omc/plans/siot-platform-plan.md` §2 b.

## 1. 접속

| 항목 | 값 |
|---|---|
| 주소 | `wss://siot-cloud.fly.dev/gateway` (`SIOT_RELAY_URL`, `off` 면 비활성) |
| 헤더 | `X-Siot-Gateway-Id: <gatewayId>` 항상. 바인딩 후에는 `Authorization: Bearer <gatewayToken>` 추가 |
| 쿼리 토큰 | 없음. 서버는 `?token=` 접속을 close `4401` 로 끊는다 |
| 미바인딩 | 토큰 없이 접속하고 hello 의 Ed25519 서명으로 증명. 미등록 공개키는 close `4403` |
| 핸드셰이크 타임아웃 | 10초(`handshakeTimeout: 10000`) |
| 재접속 백오프 | `min(20초, 1초·2^n) × (1 ± 0.2)` → 최댓값 24초. welcome 을 받으면 n=0 으로 초기화 |
| 타이머 | 하트비트·재접속은 `performance.now()`(monotonic). RTC 없는 Pi 의 벽시계 점프 무시 |

장치 키는 Ed25519 이고 `data/agent/gateway.json`(0600) 의 `deviceKey.pkcs8` 에 있다. 공개키는 raw 32바이트 base64url(43자)로
`hello.pubKey` 와 LAN `GET /api/gateway` 의 `pubKey` 에 실린다(공장 사전 등록용). SSD 복제(하드웨어 시리얼 변경)를 감지하면
gatewayId·장치 키를 새로 만들고 토큰을 버린다 → 백엔드 재등록이 필요하다.

close 코드 처리(GW):
- `4401` 을 토큰 접속에서 받으면 다음 접속은 토큰 없이 서명만으로 한다(서버가 bind 재발급 경로로 처리).
- `4403` 은 경고 로그 후 일반 백오프.
- 서버가 `bind` 를 보낸 연결은 GW 가 스스로 닫고 **대기 없이** 토큰으로 재접속한다.

## 2. 프레임

모든 프레임은 JSON 텍스트이고 판별 필드는 `t` 다. 생산자는 정의된 필드만 보낸다(`additionalProperties: false`). 수신자는 모르는 필드를 무시한다.
`body` 는 base64, `at`/`clock`/`startedAt`/`serverTime` 은 ISO 8601, `bootId` 는 uuid, `sig`/`pubKey`/`keys[].key` 는 base64url(패딩 없음).

### 서버 → GW

| 프레임 | 필드 | 용도 |
|---|---|---|
| `challenge` | `nonce` | 접속 직후 |
| `welcome` | `serverTime, heartbeatSec(10), deadSec(25), cfgVersion` | hello 검증 후 |
| `bind` | `gatewayToken, siteId` | claim 직후. GW 는 토큰 저장 → `bound` → 토큰으로 재접속 |
| `cfg` | `cfgVersion, siteId, keys:[{v, key}], peers:[{gatewayId, lan[], mleid}], rules:{version, rules[]}, thread?` | 버전이 붙은 멱등 설정(M1 의 GW 는 저장·ack 만, `thread` 는 M2) |
| `ack` | `bootId, upTo` | evt 누적 확인 |
| `req` | `id, method, path, headers?, body?, timeoutMs?` | 명령. 로컬 API 로 프록시 |
| `ping` / `pong` | — | 하트비트 |

### GW → 서버

| 프레임 | 필드 | 용도 |
|---|---|---|
| `hello` | `proto:2, gatewayId, bootId, agentVersion, matterServerVersion, startedAt, clock, cfgVersion, keyVersion, pubKey, sig` | 접속 인증. `sig = Ed25519(UTF-8 nonce)` |
| `bound` | — | bind 처리 완료 |
| `cfg_ack` | `cfgVersion, keyVersion, rulesVersion` | cfg 적용 완료 |
| `snapshot` | `bootId, seq, keyVersion, gateway{gatewayId, agentVersion, engineOnline, deviceCount, …}, devices[]` | 연결마다 전체 재동기화 |
| `evt` | `bootId, seq, keyVersion, kind, at, data, replayed?` | GW→서버 전용. 아래 kind 표 |
| `res` | `id, status, headers, body` | req 응답 |
| `ping` / `pong` | — | 하트비트 |

`cfgVersion`·`keyVersion` 은 미설정이면 0. `keyVersion` 은 저장된 cfg `keys` 의 최대 `v`. `snapshot.seq` 는 그 시점 마지막 evt seq(없으면 0).

### evt kind

| kind | data | 발생 |
|---|---|---|
| `device` | `{devices:[SiotDevice, …]}` (1개 이상) | registry `device.added/updated`, 속성 변화(`state`, 해당 endpoint 의 SiotDevice 만) |
| `device_removed` | `{deviceId:"matter:<node>", ids:[SiotDevice.id, …]}` | registry `device.removed` (알려진 SiotDevice 가 없으면 보내지 않음) |
| `pairing` | `{sessionId, stage, errorCode?, error?, deviceId?, devices?, attempt?, maxAttempts?}` | 페어링 진행. `errorCode` 는 openapi `PairingErrorCode`, `attempt`/`maxAttempts` 는 commissioning 재시도 번호 |
| `gateway` | 자유 객체(`engineOnline`, `deviceCount`, …) | Matter 백엔드 연결/해제·동기화 |
| `thread` | 자유 객체(`datasetRegistered`, `bytes`) | OTBR 데이터셋 자동 등록 |
| `error` | 자유 객체(`source`, `message`) | Matter 백엔드 첫 접속 실패, unhandledRejection |
| `log` | `{level, scope, msg}` | WARN/ERROR 로그, 분당 10줄(relay 자신의 로그 제외) |

## 3. 접속 순서

```
GW                                   서버
 |-- WS upgrade (X-Siot-Gateway-Id[, Authorization]) -->|
 |<-------------------- challenge {nonce} --------------|
 |-- hello {…, cfgVersion, keyVersion, pubKey, sig} --->|
 |<-------------------- welcome {cfgVersion, …} --------|
 |   (welcome.cfgVersion > GW cfgVersion 일 때만)        |
 |<-------------------- cfg {…} ------------------------|
 |-- cfg_ack {cfgVersion, keyVersion, rulesVersion} --->|
 |-- snapshot {bootId, seq, keyVersion, …} ------------>|
 |-- evt … replayed:true (미확인분, seq 순) ----------->|
 |-- evt … (실시간) ----------------------------------->|
 |<-------------------- ack {bootId, upTo} -------------|
```

1. GW 는 `welcome.cfgVersion` 이 자기 값보다 크면 `cfg` 를 기다렸다가 적용·`cfg_ack` 후에 `snapshot` 을 보낸다. 10초 안에 cfg 가 오지 않으면 그대로 snapshot 을 보낸다(서버는 그 연결을 끊고 재접속을 유도한다).
2. 버전이 같으면 welcome 직후 snapshot 을 보낸다.
3. 연결 중에 오는 `cfg`(규칙 변경 등)는 적용 후 `cfg_ack` 만 보낸다. 같은 버전 재전송은 그대로 ack, 더 낮은 버전은 무시하고 현재 버전으로 ack 한다.
4. 서버 쪽 보류 규칙(cfg 를 보낸 연결에서 cfg_ack 전 snapshot·evt 보류, 연결당 1,000건, 10초 무응답이면 끊기)과 `factory_reset_pending`·`site_reset_pending` 선처리는 백엔드 책임이다.

## 4. replay 규칙

- 이벤트 키는 `(gatewayId, bootId, seq, sub)` 다. 실제 evt 는 `sub=0`. 중복은 무시한다.
- `bootId` 는 에이전트 시작마다 새 uuid, `seq` 는 1부터. 링버퍼는 **메모리 1,000건**이며 넘치면 가장 오래된 것부터 버린다. 재시작하면 사라진다.
- GW 는 모든 evt 를 링버퍼에 넣는다. snapshot 을 보낸 연결이면 바로 보내고, 아니면 다음 snapshot 뒤에 보낸다.
- `ack {bootId, upTo}` 를 받으면 같은 bootId 의 `seq ≤ upTo` 를 비운다(다른 bootId 는 무시).
- 연결마다 snapshot 뒤에 링버퍼에 남은 미확인 evt 전부를 seq 순서로 `replayed:true` 로 보낸다. 즉 **evt 보다 snapshot 이 항상 먼저**다.
- 백엔드는 `seq ≤ snapshot.seq` 인 evt 를 캐시에 반영하지 않는다(snapshot 이 더 새롭다). 웹훅은 미전달분만 `replayed:true` 로 보낸다.
- 링버퍼가 사라진 재시작(bootId 변경)은 백엔드가 이전 캐시와 snapshot 의 차이로 `device.state_changed {source:"resync"}` 를 합성한다.
  합성 키는 `(gatewayId, snapshot.bootId, snapshot.seq, sub=1..k)`(deviceId 정렬 순서)라 같은 snapshot 재전송은 중복 제거된다.
- `keyVersion` 은 evt 가 **만들어질 때**의 값이다. 세대 초기화 뒤 replay 된 옛 keyVersion evt 는 백엔드에서 옛 epoch 에 귀속된다.

## 5. bind 와 재발급

- `bind` 를 받으면 GW 는 `gateway.json` 에 `gatewayToken`, `siteId` 를 저장하고 `bound` 를 보낸 뒤 연결을 닫고 즉시 토큰으로 재접속한다.
- 백엔드는 토큰 해시만 가진다. 상태가 `bound` 인데 GW 가 유효 토큰 없이 서명된 hello 를 보내면(bind 유실·`bound` 미수신·토큰 손상)
  새 토큰을 발급하고 옛 해시를 즉시 폐기한 뒤 `bind` 를 재전송한다. 서명이 신뢰의 근거이고 토큰은 세션 편의용이다.
- dev 모드(`SIOT_MODE=dev`)의 로컬 claim 으로 받은 토큰도 같은 저장소를 쓰며, claim 직후 GW 는 즉시 재접속한다.

## 6. 하트비트

- 양방향 `heartbeatSec`(기본 10초) 동안 보낸 프레임이 없으면 `ping` 을 보낸다. 받은 `ping` 에는 `pong`.
- 어떤 프레임이든 받으면 수신 시각을 갱신한다. `deadSec`(기본 25초) 동안 아무 프레임도 없으면 연결을 끊고(`terminate`) 백오프로 재접속한다.
- 반열림 연결이 감지되기 전 최대 25초 동안 클라우드 제어 요청은 `offline` 대신 `timeout` 으로 끝날 수 있다(계획 A5).

## 7. req 프록시

- 대상: 출고 모드 `http://127.0.0.1:3001`(loopback 전용 전체 API), dev 모드 `http://127.0.0.1:3000`. `path` 는 `/` 로 시작해야 한다(아니면 400).
- 요청 헤더 중 `host, connection, content-length, keep-alive, upgrade, transfer-encoding, accept-encoding, authorization` 은 버리고,
  GW 자신의 `Authorization: Bearer <gatewayToken>` 을 넣는다(클라우드가 보낸 Authorization 은 쓰지 않는다).
- `timeoutMs`(기본 30초, 100ms~120초로 제한)를 넘으면 `res {status:504}`, 연결 실패 등은 `502`. 오류 본문은 `{ok:false, error}` JSON(base64).
- 응답 헤더 중 `content-encoding, transfer-encoding, content-length, connection, keep-alive` 는 버린다.
