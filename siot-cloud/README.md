# siot-cloud

시옷 클라우드 백엔드와 PWA. 계획 `.omc/plans/siot-platform-plan.md` §2 a(A1): npm workspaces, Fly.io 앱 1개(`siot-cloud`, nrt)에 API·릴레이·웹훅 워커·PWA, Postgres.
저장소 루트에는 package.json 을 두지 않는다(`siot-app` lockfile 과 HA 빌드 보호). 모든 명령은 이 디렉터리에서 실행한다.

```
siot-cloud/
  packages/protocol/   @siot/protocol — relay-v2·peer-v1·siot-device·public-v1-control JSON Schema, 생성 TS 타입, 프레임 fixture
  apps/api/            @siot/api — Fastify 5, drizzle(Postgres), 공개 API v1·앱 API·릴레이·웹훅
    openapi/           public-v1.yaml(파트너), app-v1.yaml(PWA)
    drizzle/           SQL 마이그레이션(커밋 대상)
  apps/web/            @siot/web — Vite + React + vite-plugin-pwa
  tools/partner-sim/   파트너 웹훅 수신 시뮬레이터(server.ts) + A3 시연(demo.ts)
  tools/slo/           C3 ①② 제어 100회 측정(control-100.ts)
  docs/ops/            배포·백업(PITR/wal-g)·복원 리허설·업타임 기록
```

## 명령

```sh
npm install
npm run -ws --if-present typecheck
npm run -ws --if-present test
npm -w apps/api run lint:openapi          # redocly lint, 오류 0
npm -w apps/web run build
npm -w apps/api run admin -- org:create --name 시옷플랫폼   # 운영자 CLI(src/admin/cli.ts)
PORT=8787 SECRET=whsec_… FAIL_FIRST=2 npm start -w tools/partner-sim
SIOT_API_KEY=sk_… PARTNER_SIM=http://localhost:8787 npm run demo:partner -w tools/partner-sim   # A3
SIOT_API_KEY=sk_… DEVICE_ID=dev_… npm run control-100 -w tools/slo                              # C3 ①②
npm run gen                               # schema/*.json → packages/protocol/src/generated/*.d.ts (결과 커밋)
npm -w packages/protocol run gen:check    # 생성본이 낡았으면 실패
npm -w apps/api run db:generate           # src/db/schema.ts → drizzle/*.sql
DATABASE_URL=postgres://... npm -w apps/api run db:migrate
```

`@siot/protocol` 은 빌드 없이 TS 소스(`src/index.ts`)를 export 한다. api 는 `tsx` 로 실행한다. **배포도 번들 없이 tsx 로 띄운다**(Step 1 결정: `Dockerfile` 3단계 — 전체 의존성으로 PWA 빌드 → `npm ci --omit=dev -w apps/api -w packages/protocol` → `node --import tsx src/server.ts`. 그래서 `tsx` 는 `@siot/api` 의 dependencies). 배포·백업·복원 절차는 `docs/ops/`.

## 계약 (P0 고정)

| 계약 | 파일 | 소비자 |
|---|---|---|
| 릴레이 proto 2 | `packages/protocol/schema/relay-v2.json` | api `src/relay`, 에이전트 `platform/relay.js` (`matter-gateway-poc/agent/test/relayFrames.test.js` 가 fixture 검증) |
| 게이트웨이 로컬 기기 | `packages/protocol/schema/siot-device.json` | snapshot/evt devices, `siotMapper.js toSiotDevices()` |
| 피어 링크 | `packages/protocol/schema/peer-v1.json` | 에이전트 PeerLink(Step 5) |
| 제어 응답 | `packages/protocol/schema/public-v1-control.json` | public-v1·app-v1 의 `ControlResult` |
| 공개 API | `apps/api/openapi/public-v1.yaml` | 파트너, partner-sim |
| 앱 API | `apps/api/openapi/app-v1.yaml` | `apps/web/src/api/client.ts` |
| DB | `apps/api/src/db/schema.ts` + `drizzle/` | api 전 모듈 |

relay-v2 인코딩 요약(Step 2 게이트웨이 실행자와 합의):
- 프레임은 `{t:"<type>", ...}` JSON 텍스트. 생산자는 스키마를 엄격히 지키고(`additionalProperties:false`), 수신자는 모르는 필드를 무시한다.
- `ping`/`pong` 은 `{t}` 만. `req.body`/`res.body` 는 base64, `headers` 는 문자열 맵, `req.timeoutMs` 선택.
- `hello.pubKey` = Ed25519 raw 32B base64url(43자), `hello.sig` = Ed25519(UTF-8(`challenge.nonce`)) base64url(86자). `bootId` 는 uuid v4.
- 시각(`clock`, `startedAt`, `serverTime`, `evt.at`)은 ISO 8601. `cfgVersion`/`keyVersion` 미설정은 0.
- `snapshot = {bootId, seq(마지막 evt seq, 없으면 0), keyVersion, gateway, devices[]}`. evt 보다 항상 먼저.
- `evt.data`: `device` → `{devices:[SiotDevice…]}`, `device_removed` → `{deviceId?, ids:[localId…]}`, `pairing` → `{sessionId, stage, errorCode?, error?, deviceId?, devices?}`, 나머지 자유 객체. `replayed` 는 재전송일 때만 `true`.
- `cfg.keys[].key` = 32B base64url(43자). M1 cfg 에는 `thread` 가 없다.
- `cfg.rules = {version, rules:[Rule…]}`: 세대 자동화 규칙 version(저장마다 +1)과 그 GW 기기만으로 컴파일한 규칙(`$defs/Rule`, 트리거 device|schedule). 규칙이 없는 GW 도 같은 version 의 빈 배열을 받는다. GW 는 적용 후 `cfg_ack.rulesVersion` 으로 보고.

Ajv 로 검증할 때: `Ajv2020({strict:true, allowUnionTypes:true})` + `ajv-formats` + `addKeyword('x-direction')` 후 `allSchemas` 를 전부 `addSchema` (서로 `$id` 로 참조). 방향별 검증은 `SCHEMA_IDS.relayV2ServerToGateway` / `relayV2GatewayToServer`.

ID 형식: `org_`, `usr_`, `site_`, `dev_`, `evt_`, `wh_`, `pair_`, `aut_` + ULID(Crockford 26자). `gatewayId` 는 GW 가 정한 `gw_<uuid>`, `shortId` 는 그 앞 8 hex.

## Step 1 백엔드 구성 (apps/api/src)

| 모듈 | 내용 |
|---|---|
| `app.ts` | 조립 순서: metrics → webhooks(outbox·worker·alerts) → cache → `registerRelay(app, {db, config, cache, outbox, metrics, alerts, deployedAt})` → auth → public → appapi(+ `registerGatewayClaim`) → PWA 정적(apps/web/dist). 테스트는 `buildApp({bus})` 로 fake GatewayBus 를 넣는다 |
| `auth/` | `apiKey.ts`(sk_live_/sk_test_+32 base62, SHA-256, 앞 12자, 365/730일, 조직당 활성 2개, 매 요청 DB 확인 → 폐기 즉시 401), `session.ts`(argon2id, `siot_session` httpOnly·SameSite=Lax·https 면 Secure, 30일 슬라이딩), `roles.ts`(siteAccess full/diagnostics/none, operator 제어 403, 인계 후 installer `HANDED_OVER`), `rateLimit.ts`(인메모리 토큰 버킷), `secretBox.ts`(relay/crypto 와 같은 `v1.` AES-256-GCM 포맷) |
| `cache/` | `PgStateCache`: 인메모리 + write-through(gateways·devices·events, 웹훅 outbox 같은 트랜잭션). GW 별 직렬화. replay 규칙·resync 합성(sub=1..k)·keyVersion→epoch. 재기동 직후 전 GW offline. `StateCache` 에 `resolveDevice/getGateway/getSiteGateways/reloadGateway/updateDeviceMeta/subscribeEvents` 추가 |
| `public/` | public-v1 전 엔드포인트, `ControlCoordinator`(N1, deadline 3,000ms, 기기당 5 req/s), 키당 20 req/s·버스트 40, `Siot-Api-Version` |
| `appapi/` | app-v1 auth/me/sites/devices/control/events(SSE)/pairing 큐(`PairingQueue`, GW 별 직렬·GW 간 병렬). CSRF Origin 훅. gateways 조회·claim 은 `gateways.ts`(Step 2) |
| `webhooks/` | `Outbox.ts`(`enqueue(orgId, event, tx?)` — relay 의 gateway.online/offline 입력도 받음, 같은 상태 연속 억제), `worker.ts`(즉시 1차, 10s…6h 8회 후 dead, 24h 연속 실패 자동 비활성+경보, api_key.expiring), `sign.ts`, `alerts.ts`(Slack 호환, 30분 중복 억제) |
| `metrics/` | 앱별 prom-client 레지스트리. relay 가 `relayReconnects/heartbeatTimeouts/gatewaysOnline/relayRequests` 를 갱신 |
| `admin/` | `npm run admin --` 의 `org:create`, `user:create`, `apikey:create`, `apikey:revoke`, `gateway:provision`, `gateway:claim-window`, `gateway:transfer-org` (audit_log 기록) |

공통: `src/ids.ts`(ID 생성·패턴), `src/http.ts`(오류 형식·cursor 페이지·FastifyRequest 확장).

### 테스트 DB

- Step 1 통합 테스트(`apps/api/test/step1/*.int.test.ts`)는 로컬 Homebrew Postgres 의 **`siot_test`** DB 를 쓴다(`TEST_DATABASE_URL` 로 바꿀 수 있음). 없으면 만들고 마이그레이션한 뒤 파일마다 truncate 한다. 파일 사이 직렬화는 advisory lock. 테스트 후 DB 는 지우지 않고 남겨 둔다.
- Step 2 릴레이 테스트는 `siot_relay_test`·`siot_relay_e2e`(`RELAY_TEST_PG`).

## 소유권 (다음 단계 병렬 실행자용)

| 실행자 | 소유(수정 가능) | 규칙 |
|---|---|---|
| **Step 1** (백엔드 데이터·공개 API·관측성) | `apps/api/src/{public,appapi,webhooks,metrics,auth,cache,admin}/**`(단 `appapi/gateways.ts` 제외), `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/config.ts`, `apps/api/src/healthz.ts`, `Dockerfile`, `fly.toml`, CI(`.github/workflows/siot-cloud.yml`), `tools/partner-sim`, `tools/slo` | `app.ts` 의 "플러그인 등록 지점" 순서대로 모듈을 연결한다 |
| **Step 2 백엔드** (릴레이·바인딩) | `apps/api/src/relay/**`, `apps/api/src/appapi/gateways.ts`(claim) | `app.ts` 는 건드리지 않고 `registerRelay(app, deps)`·`registerGatewayClaim(app, deps)` 시그니처만 채운다. `GatewayBus` 인터페이스 변경은 Step 1 과 합의 후 추가만 |
| **Step 3a** (기사 PWA) | `apps/web/**` | API 는 `app-v1.yaml` 계약대로. 계약 변경이 필요하면 Step 1 에 요청 |
| 공유 | `packages/protocol/**`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/**`, `apps/api/openapi/*.yaml` | **추가(additive)만.** 바꾸면 아래 변경 로그에 한 줄 남기고 `npm run gen`·`db:generate` 결과를 함께 커밋. 필드 삭제·이름 변경·enum 축소 금지(필요하면 새 버전 파일) |

`@fastify/websocket`·`@fastify/cookie` 는 `app.ts` 에서 이미 등록한다(relay 는 `app.get('/gateway', {websocket:true}, …)` 만).

## 변경 로그 (공유 계약)

| 날짜 | 파일 | 변경 | 작성 |
|---|---|---|---|
| 2026-10-20 | protocol 전체, openapi 2종, db/schema.ts, drizzle/0000_m1_init.sql | P0 최초 작성. §2 b 표 대비 추가: `snapshot.keyVersion`(replay 규칙의 epoch 귀속에 필요), `evt device_removed.data.ids` | P0 |
| 2026-10-21 | packages/protocol/schema/relay-v2.json (+ generated/relay-v2.d.ts) | `EvtPairing.data` 에 선택 필드 `attempt`, `maxAttempts`(정수 ≥1, commissioning 재시도 번호) 추가. 에이전트 `relayEvents.js` 가 싣는다 | Step 2 백엔드 |
| 2026-10-21 | apps/api/package.json | `ajv`·`ajv-formats` 를 dependencies 로 이동(릴레이가 런타임에 relay-v2 프레임을 양방향 검증) | Step 2 백엔드 |
| 2026-10-21 | apps/api/openapi/public-v1.yaml | 응답 코드 추가: `400`(ID 형식·Siot-Api-Version 형식) → sites/{siteId}·gateways/{id}·devices/{id}·webhooks/{id}(DELETE·test), `403`(INSUFFICIENT_SCOPE) → GET /v1/sites·GET/POST /v1/webhooks. 설명에 조직 격리 404 규칙(제거된 자기 기기·삭제된 웹훅·세대 미소속 GW)과 지원 버전 `2026-10-01` 명시 | Step 1 |
| 2026-10-21 | package.json(workspaces), apps/api/package.json | workspaces 에 `tools/partner-sim`·`tools/slo` 추가. `tsx` 를 dependencies 로 이동(배포 이미지가 tsx 로 실행), `admin` 스크립트 추가 | Step 1 |
| 2026-10-26 | relay-v2.json(+ generated, fixtures), db/schema.ts, drizzle/0001_automations.sql, public-v1.yaml | 자동화 규칙(M1 당김): `$defs/Rule`(트리거 device\|schedule, conditions, actions command\|delay)로 불투명 `Rules.items` 교체, `valid.cfg-thread.json` 의 자리표시 규칙을 새 형식으로. 테이블 `automation_rules`, `gateways.rules_acked_version`. `GET/PUT /v1/sites/{siteId}/automations`, `Gateway.rulesVersion`(선택), ID `aut_` | 자동화 백엔드 |
