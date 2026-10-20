// M1 테이블 13개 (계획 §3 B1, Step 1-1). 공유 계약 — 변경은 추가(additive)만, README 변경 로그에 기록.
// ID 규칙: <prefix>_<ULID> (org_, usr_, site_, dev_, evt_, key_, wh_, whd_, pair_), gatewayId 는 GW 가 정한 gw_<uuid>.
// M2(invitations, handover_cards, automation_rules, thread_networks), M4(ota_*, alerts, gateway_logs)는 여기 없다.
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tz('created_at').notNull().defaultNow();

export const userRole = pgEnum('user_role', ['installer', 'resident', 'operator']);
export const gatewayStatus = pgEnum('gateway_status', ['unbound', 'bound', 'site_reset_pending', 'factory_reset_pending']);
export const apiKeyMode = pgEnum('api_key_mode', ['live', 'test']);
export const deliveryStatus = pgEnum('webhook_delivery_status', ['pending', 'delivered', 'failed', 'dead']);
export const pairingStatus = pgEnum('pairing_status', ['queued', 'running', 'done', 'failed', 'cancelled']);

export const organizations = pgTable('organizations', {
  orgId: text('org_id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    userId: text('user_id').primaryKey(),
    /** installer·operator 는 조직 소속, resident 는 null */
    orgId: text('org_id').references(() => organizations.orgId),
    role: userRole('role').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** argon2id */
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
    disabledAt: tz('disabled_at'),
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** 쿠키 토큰의 SHA-256 hex. 원문은 저장하지 않는다 */
    sessionHash: text('session_hash').primaryKey(),
    userId: text('user_id').notNull().references(() => users.userId, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
    /** 30일 슬라이딩 */
    expiresAt: tz('expires_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const sites = pgTable(
  'sites',
  {
    siteId: text('site_id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.orgId),
    name: text('name').notNull(),
    address: text('address'),
    /** 세대 초기화마다 +1. events.site_epoch 귀속 기준 */
    epoch: integer('epoch').notNull().default(1),
    /** 인계되면 resident user_id. null = 인계 전(또는 초기화 후 vacant) */
    ownerUserId: text('owner_user_id').references(() => users.userId),
    createdByUserId: text('created_by_user_id').references(() => users.userId),
    handedOverAt: tz('handed_over_at'),
    createdAt: createdAt(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('sites_org_idx').on(t.orgId), index('sites_owner_idx').on(t.ownerUserId)],
);

export const siteKeys = pgTable(
  'site_keys',
  {
    siteId: text('site_id').notNull().references(() => sites.siteId, { onDelete: 'cascade' }),
    /** cfg.keys[].v / evt.keyVersion */
    version: integer('version').notNull(),
    /** DATA_ENC_KEY 로 AES-256-GCM 암호화한 32바이트 세대 키 */
    keyEnc: text('key_enc').notNull(),
    /** 이 키가 속한 sites.epoch */
    epoch: integer('epoch').notNull(),
    createdAt: createdAt(),
    /** cfg.keys 목록에서 빠진 시각(일상 회전은 최대 7일 유예, 세대 초기화는 즉시) */
    retiredAt: tz('retired_at'),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.version] })],
);

export const gateways = pgTable(
  'gateways',
  {
    gatewayId: text('gateway_id').primaryKey(),
    /** gatewayId 앞 8 hex (라벨 siot-<shortId>) */
    shortId: text('short_id').notNull(),
    /** 출고 등록(gateway:provision --org) 조직. claim 은 이 조직 installer 만 */
    orgId: text('org_id').notNull().references(() => organizations.orgId),
    siteId: text('site_id').references(() => sites.siteId),
    status: gatewayStatus('status').notNull().default('unbound'),
    /** 사전 등록 Ed25519 raw 공개키 base64url */
    pubkey: text('pubkey').notNull(),
    /** gatewayToken SHA-256 hex. 재발급 시 즉시 교체(옛 해시 폐기) */
    tokenHash: text('token_hash'),
    /** 서버가 원하는 cfg 버전 */
    cfgVersion: integer('cfg_version').notNull().default(0),
    /** GW 가 마지막으로 cfg_ack/hello 로 보고한 버전 */
    cfgAckedVersion: integer('cfg_acked_version').notNull().default(0),
    keyVersion: integer('key_version').notNull().default(0),
    /** 초기화 후 24h claim 창. null 이면 창 제한 없음(출고 직후 첫 claim) */
    claimWindowUntil: tz('claim_window_until'),
    lastSeenAt: tz('last_seen_at'),
    bootId: text('boot_id'),
    agentVersion: text('agent_version'),
    matterServerVersion: text('matter_server_version'),
    online: boolean('online').notNull().default(false),
    lastErrorCode: text('last_error_code'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('gateways_short_id_uq').on(t.shortId),
    uniqueIndex('gateways_token_hash_uq').on(t.tokenHash),
    index('gateways_site_idx').on(t.siteId),
    index('gateways_org_idx').on(t.orgId),
  ],
);

export const devices = pgTable(
  'devices',
  {
    /** dev_ + ULID (공개 API deviceId) */
    deviceId: text('device_id').primaryKey(),
    gatewayId: text('gateway_id').notNull().references(() => gateways.gatewayId),
    /** SiotDevice.id (예: matter:5:1) */
    localId: text('local_id').notNull(),
    siteId: text('site_id').references(() => sites.siteId),
    name: text('name').notNull(),
    room: text('room'),
    deviceType: text('device_type').notNull(),
    data: jsonb('data').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    online: boolean('online').notNull().default(false),
    vendor: text('vendor'),
    model: text('model'),
    lastUpdated: tz('last_updated').notNull().defaultNow(),
    removedAt: tz('removed_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('devices_gateway_local_uq').on(t.gatewayId, t.localId), index('devices_site_idx').on(t.siteId)],
);

export const events = pgTable(
  'events',
  {
    eventId: text('event_id').primaryKey(),
    gatewayId: text('gateway_id').notNull().references(() => gateways.gatewayId),
    bootId: text('boot_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** 실제 evt = 0, snapshot 차이로 합성한 resync = 1..k (deviceId 정렬 순) */
    sub: integer('sub').notNull().default(0),
    siteId: text('site_id').references(() => sites.siteId),
    /** keyVersion → site_keys.epoch 로 귀속. 미바인딩 GW 이벤트는 null */
    siteEpoch: integer('site_epoch'),
    keyVersion: integer('key_version').notNull().default(0),
    /** relay-v2 evt.kind 또는 'resync' */
    kind: text('kind').notNull(),
    /** GW 관측 시각(evt.at) */
    at: tz('at').notNull(),
    receivedAt: tz('received_at').notNull().defaultNow(),
    replayed: boolean('replayed').notNull().default(false),
    data: jsonb('data').notNull(),
  },
  (t) => [
    unique('events_gateway_boot_seq_sub_uq').on(t.gatewayId, t.bootId, t.seq, t.sub),
    index('events_site_epoch_idx').on(t.siteId, t.siteEpoch, t.receivedAt),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    apiKeyId: text('api_key_id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.orgId),
    name: text('name').notNull(),
    mode: apiKeyMode('mode').notNull(),
    /** 앞 12자(표시용) */
    prefix: text('prefix').notNull(),
    /** 전체 키 SHA-256 hex */
    hash: text('hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: createdAt(),
    expiresAt: tz('expires_at').notNull(),
    revokedAt: tz('revoked_at'),
    lastUsedAt: tz('last_used_at'),
    expiringNotifiedAt: tz('expiring_notified_at'),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.hash), uniqueIndex('api_keys_prefix_uq').on(t.prefix), index('api_keys_org_idx').on(t.orgId)],
);

export const webhooks = pgTable(
  'webhooks',
  {
    webhookId: text('webhook_id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.orgId),
    url: text('url').notNull(),
    /** DATA_ENC_KEY 로 암호화한 서명 비밀 */
    secretEnc: text('secret_enc').notNull(),
    events: text('events').array().notNull(),
    createdAt: createdAt(),
    /** 24h 연속 실패 자동 비활성 시각 */
    disabledAt: tz('disabled_at'),
    failingSince: tz('failing_since'),
    deletedAt: tz('deleted_at'),
  },
  (t) => [index('webhooks_org_idx').on(t.orgId)],
);

/** 트랜잭셔널 outbox. 이벤트 저장과 같은 트랜잭션에서 넣고 인프로세스 워커가 보낸다 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),
    /** 공개 eventId(evt_...). gateway.online 등 events 테이블 밖 이벤트도 있어 FK 없음 */
    eventId: text('event_id').notNull(),
    webhookId: text('webhook_id').notNull().references(() => webhooks.webhookId, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    attempt: integer('attempt').notNull().default(0),
    nextAt: tz('next_at').notNull().defaultNow(),
    status: deliveryStatus('status').notNull().default('pending'),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    deliveredAt: tz('delivered_at'),
  },
  (t) => [unique('webhook_deliveries_event_webhook_uq').on(t.eventId, t.webhookId), index('webhook_deliveries_due_idx').on(t.status, t.nextAt)],
);

/** GW 별 직렬 페어링 큐 (Step 3a). 에이전트 메모리 세션 소실(server.js:37)에 대비 */
export const pairingSessions = pgTable(
  'pairing_sessions',
  {
    pairingSessionId: text('pairing_session_id').primaryKey(),
    gatewayId: text('gateway_id').notNull().references(() => gateways.gatewayId),
    siteId: text('site_id').notNull().references(() => sites.siteId),
    requestedByUserId: text('requested_by_user_id').notNull().references(() => users.userId),
    /** Matter 셋업 코드(DATA_ENC_KEY 암호화). 완료 후 지운다 */
    codeEnc: text('code_enc'),
    name: text('name'),
    status: pairingStatus('status').notNull().default('queued'),
    /** relay-v2 evt pairing.stage */
    stage: text('stage'),
    errorCode: text('error_code'),
    error: text('error'),
    /** GW 로컬 sessionId */
    localSessionId: text('local_session_id'),
    deviceIds: text('device_ids').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('pairing_sessions_gateway_status_idx').on(t.gatewayId, t.status, t.createdAt)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: tz('at').notNull().defaultNow(),
    /** user | operator_cli | system | gateway | api_key */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    orgId: text('org_id'),
    /** 예: gateway.claim, gateway.token_reissued, site.reset, apikey.revoke */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    data: jsonb('data'),
    ip: text('ip'),
  },
  (t) => [index('audit_log_target_idx').on(t.targetType, t.targetId, t.at), index('audit_log_org_idx').on(t.orgId, t.at)],
);

export const M1_TABLES = [
  'organizations',
  'users',
  'sessions',
  'sites',
  'site_keys',
  'gateways',
  'devices',
  'events',
  'api_keys',
  'webhooks',
  'webhook_deliveries',
  'pairing_sessions',
  'audit_log',
] as const;
