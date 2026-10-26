// Step 1 통합 테스트 공통: 실제 Postgres(siot_test), fake GatewayBus, 시드, OpenAPI 응답 검증기.
// DB 를 쓰는 파일은 useTestDb() 를 부른다. 파일 사이 직렬화는 advisory lock 으로 한다(vitest 파일 병렬 그대로).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import type { BindFrame, CfgFrame, EvtFrame, SiotDevice, SnapshotFrame } from '@siot/protocol';
import { createDb, type Db } from '../../src/db/client.js';
import { M1_TABLES, gateways, organizations, sites, users } from '../../src/db/schema.js';
import { loadConfig, type Config } from '../../src/config.js';
import { buildApp, type AppContext, type BuildAppOptions } from '../../src/app.js';
import { hashPassword, type Role } from '../../src/auth/session.js';
import { newId } from '../../src/ids.js';
import {
  GatewayOfflineError,
  type GatewayBus,
  type GatewayRequest,
  type GatewayResponse,
  type OfflineInfo,
  type OnlineInfo,
  type Unsubscribe,
} from '../../src/relay/GatewayBus.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://localhost/siot_test';
const LOCK_KEY = 7_270_001;

export const testConfig: Config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DB_URL,
  SESSION_SECRET: 's'.repeat(40),
  DATA_ENC_KEY: 'd'.repeat(40),
  LABEL_MASTER_KEY: 'l'.repeat(40),
  APP_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent',
});

async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const r = await admin`select 1 from pg_database where datname = ${name}`;
    if (!r.length) await admin.unsafe(`create database "${name.replace(/"/g, '')}"`).catch(() => undefined);
  } finally {
    await admin.end();
  }
}

export interface TestDb {
  db: Db;
  truncate(): Promise<void>;
}

/** beforeAll: DB 생성·마이그레이션·잠금·비우기, afterAll: 해제 */
export function useTestDb(): TestDb {
  let lock: postgres.Sql | null = null;
  let handle: ReturnType<typeof createDb> | null = null;
  const t: TestDb = {
    get db() {
      return handle!.db;
    },
    async truncate() {
      await handle!.sql.unsafe(`truncate ${M1_TABLES.map((x) => `"${x}"`).join(', ')} restart identity cascade`);
    },
  };
  beforeAll(async () => {
    await ensureDatabase(TEST_DB_URL);
    lock = postgres(TEST_DB_URL, { max: 1, onnotice: () => {} });
    await lock`select pg_advisory_lock(${LOCK_KEY})`;
    handle = createDb(TEST_DB_URL, { max: 5 });
    await migrate(handle.db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
    await t.truncate();
  }, 180_000);
  afterAll(async () => {
    await handle?.sql.end({ timeout: 5 });
    if (lock) {
      await lock`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => undefined);
      await lock.end();
    }
  });
  return t;
}

// ---------------------------------------------------------------- fake bus

export class FakeBus implements GatewayBus {
  readonly online = new Set<string>();
  readonly requests: { gatewayId: string; req: GatewayRequest; timeoutMs: number }[] = [];
  handler: (gatewayId: string, req: GatewayRequest, timeoutMs: number) => Promise<GatewayResponse> = async () => ({ id: 'x', status: 200 });

  async request(gatewayId: string, req: GatewayRequest, timeoutMs: number): Promise<GatewayResponse> {
    if (!this.online.has(gatewayId)) throw new GatewayOfflineError(gatewayId);
    this.requests.push({ gatewayId, req, timeoutMs });
    return this.handler(gatewayId, req, timeoutMs);
  }
  isOnline(gatewayId: string): boolean {
    return this.online.has(gatewayId);
  }
  readonly cfgs: { gatewayId: string; cfg: Omit<CfgFrame, 't'> }[] = [];
  async sendCfg(gatewayId: string, cfg: Omit<CfgFrame, 't'>): Promise<boolean> {
    this.cfgs.push({ gatewayId, cfg });
    return this.online.has(gatewayId);
  }
  async sendBind(_g: string, _b: Omit<BindFrame, 't'>): Promise<boolean> {
    return false;
  }
  onSnapshot(_h: (g: string, f: SnapshotFrame) => void): Unsubscribe {
    return () => {};
  }
  onEvt(_h: (g: string, f: EvtFrame) => void): Unsubscribe {
    return () => {};
  }
  onOnline(_h: (i: OnlineInfo) => void): Unsubscribe {
    return () => {};
  }
  onOffline(_h: (i: OfflineInfo) => void): Unsubscribe {
    return () => {};
  }
}

export const jsonBody = (b: unknown) => Buffer.from(JSON.stringify(b), 'utf8').toString('base64');
export const decodeBody = (b64: string | undefined) => (b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : undefined);

// ---------------------------------------------------------------- app

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  bus: FakeBus;
}

export async function makeApp(db: Db, opts: Partial<BuildAppOptions> = {}): Promise<TestApp> {
  const bus = new FakeBus();
  const app = await buildApp({ config: testConfig, db, bus, logger: false, startWorkers: false, webDist: false, pingDb: async () => {}, ...opts });
  await app.ready();
  return { app, ctx: app.siot!, bus: (opts.bus as FakeBus | undefined) ?? bus };
}

// ---------------------------------------------------------------- seed

export function gwId(n: number): string {
  const h = n.toString(16).padStart(8, '0');
  return `gw_${h}-0000-4000-8000-${h.padStart(12, '0')}`;
}

export async function seedOrg(db: Db, name = '시옷플랫폼'): Promise<string> {
  const orgId = newId('org');
  await db.insert(organizations).values({ orgId, name });
  return orgId;
}

export async function seedSite(db: Db, orgId: string, o: { ownerUserId?: string | null; epoch?: number } = {}): Promise<string> {
  const siteId = newId('site');
  await db.insert(sites).values({ siteId, orgId, name: `세대 ${siteId.slice(-4)}`, ownerUserId: o.ownerUserId ?? null, epoch: o.epoch ?? 1 });
  return siteId;
}

export async function seedGateway(db: Db, orgId: string, siteId: string | null, n: number): Promise<string> {
  const gatewayId = gwId(n);
  await db.insert(gateways).values({ gatewayId, shortId: gatewayId.slice(3, 11), orgId, siteId, pubkey: 'A'.repeat(43), status: siteId ? 'bound' : 'unbound' });
  return gatewayId;
}

export async function seedUser(db: Db, role: Role, orgId: string | null, password = 'password-1234'): Promise<{ userId: string; email: string; password: string }> {
  const userId = newId('usr');
  const email = `${role}-${userId.slice(-6).toLowerCase()}@example.com`;
  await db.insert(users).values({ userId, orgId, role, email, name: role, passwordHash: await hashPassword(password) });
  return { userId, email, password };
}

// ---------------------------------------------------------------- frames

export const BOOT_A = '11111111-1111-4111-8111-111111111111';
export const BOOT_B = '22222222-2222-4222-8222-222222222222';

export function plug(localId: string, on: boolean, extra: Partial<SiotDevice> = {}): SiotDevice {
  return { id: localId, name: `플러그 ${localId}`, deviceType: 'PLUG', online: true, data: { switch: on }, lastUpdated: '2026-10-21T00:00:00.000Z', vendor: 'IKEA of Sweden', model: 'GRILLPLATS', ...extra };
}

export function snapshot(bootId: string, seq: number, devices: SiotDevice[], keyVersion = 0, gatewayId = 'gw'): SnapshotFrame {
  return { t: 'snapshot', bootId, seq, keyVersion, gateway: { gatewayId, agentVersion: '0.9.0', matterServerVersion: '7.0.0', engineOnline: true, deviceCount: devices.length }, devices };
}

export function evtDevice(bootId: string, seq: number, devices: SiotDevice[], o: { replayed?: boolean; keyVersion?: number; at?: string } = {}): EvtFrame {
  return {
    t: 'evt',
    bootId,
    seq,
    keyVersion: o.keyVersion ?? 0,
    kind: 'device',
    at: o.at ?? new Date().toISOString(),
    data: { devices: devices as [SiotDevice, ...SiotDevice[]] },
    ...(o.replayed ? { replayed: true } : {}),
  };
}

/** GW 를 접속 상태로 만들고 snapshot 을 적용 */
export async function connect(t: TestApp, gatewayId: string, devices: SiotDevice[], bootId = BOOT_A, seq = 0, keyVersion = 0) {
  t.bus.online.add(gatewayId);
  await t.ctx.cache.setGatewayOnline(gatewayId, true);
  return t.ctx.cache.applySnapshot(gatewayId, snapshot(bootId, seq, devices, keyVersion, gatewayId));
}

// ---------------------------------------------------------------- OpenAPI 검증

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;

export function openapiValidator(file: 'public-v1.yaml' | 'app-v1.yaml') {
  const doc = parse(readFileSync(new URL(`../../openapi/${file}`, import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...doc, $id: 'doc' });
  const esc = (s: string) => encodeURIComponent(s.replace(/~/g, '~0').replace(/\//g, '~1'));
  const cache = new Map<string, ReturnType<typeof ajv.compile>>();
  const get = (ptr: string) => {
    let v = cache.get(ptr);
    if (!v) {
      v = ajv.compile({ $ref: `doc#${ptr}` });
      cache.set(ptr, v);
    }
    return v;
  };
  return {
    doc,
    /** 경로 템플릿(/v1/sites/{siteId})·메서드·상태 코드의 application/json 응답을 검증. 실패 시 오류 메시지 배열 */
    response(method: string, pathTemplate: string, status: number, body: unknown): string[] {
      const op = doc.paths?.[pathTemplate]?.[method.toLowerCase()];
      if (!op) return [`${method} ${pathTemplate} 가 문서에 없습니다`];
      const resp = op.responses?.[String(status)];
      if (!resp) return [`${method} ${pathTemplate} 에 ${status} 응답이 없습니다`];
      let ptr: string;
      if (resp.$ref) {
        const name = String(resp.$ref).split('/').pop()!;
        if (!doc.components.responses[name].content) return body === undefined || body === '' ? [] : ['본문이 없어야 합니다'];
        ptr = `/components/responses/${esc(name)}/content/${esc('application/json')}/schema`;
      } else {
        if (!resp.content) return [];
        ptr = `/paths/${esc(pathTemplate)}/${method.toLowerCase()}/responses/${status}/content/${esc('application/json')}/schema`;
      }
      const v = get(ptr);
      return v(body) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
    },
    schema(name: string, body: unknown): string[] {
      const v = get(`/components/schemas/${esc(name)}`);
      return v(body) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
    },
  };
}
