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
```

## 명령

```sh
npm install
npm run -ws --if-present typecheck
npm run -ws --if-present test
npm -w apps/api run lint:openapi          # redocly lint, 오류 0
npm -w apps/web run build
npm run gen                               # schema/*.json → packages/protocol/src/generated/*.d.ts (결과 커밋)
npm -w packages/protocol run gen:check    # 생성본이 낡았으면 실패
npm -w apps/api run db:generate           # src/db/schema.ts → drizzle/*.sql
DATABASE_URL=postgres://... npm -w apps/api run db:migrate
```

`@siot/protocol` 은 빌드 없이 TS 소스(`src/index.ts`)를 export 한다. api 는 `tsx` 로 실행하고, Dockerfile(Step 1)에서 번들하거나 tsx 로 띄운다.

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

Ajv 로 검증할 때: `Ajv2020({strict:true, allowUnionTypes:true})` + `ajv-formats` + `addKeyword('x-direction')` 후 `allSchemas` 를 전부 `addSchema` (서로 `$id` 로 참조). 방향별 검증은 `SCHEMA_IDS.relayV2ServerToGateway` / `relayV2GatewayToServer`.

ID 형식: `org_`, `usr_`, `site_`, `dev_`, `evt_`, `wh_`, `pair_` + ULID(Crockford 26자). `gatewayId` 는 GW 가 정한 `gw_<uuid>`, `shortId` 는 그 앞 8 hex.

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
