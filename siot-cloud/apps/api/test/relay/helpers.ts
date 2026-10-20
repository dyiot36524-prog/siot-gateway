// 릴레이 테스트 공용: 가짜 GW 클라이언트(ws), 인메모리 repo/cache/outbox/metrics, 테스트 Postgres.
import { createRequire } from 'node:module';
import { generateKeyPairSync, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { CfgAckFrame, EvtFrame, HelloFrame, SnapshotFrame } from '@siot/protocol';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import { registerRelay, type RelayHandle } from '../../src/relay/index.js';
import { sha256Hex } from '../../src/relay/crypto.js';
import { validateServerFrame } from '../../src/relay/frames.js';
import type { CfgBody, GatewayRecord, GatewayRepo, RelayDeps, RelayOutboxEvent, RelayTiming } from '../../src/relay/deps.js';

// ---------------------------------------------------------------- ws 클라이언트(@types/ws 없이)
type Frame = Record<string, unknown> & { t: string };
interface WsClient {
  readyState: number;
  send(s: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(ev: 'open', fn: () => void): void;
  on(ev: 'message', fn: (d: Buffer) => void): void;
  on(ev: 'close', fn: (code: number, reason: Buffer) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
}
const require = createRequire(import.meta.url);
const WS = require('ws') as { new (url: string, opts?: { headers?: Record<string, string> }): WsClient };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | undefined | null | false, ms = 3000, label = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(10);
  }
}

/** 받은 서버 프레임 전체(스키마 검증용) */
export const serverFramesSeen: Frame[] = [];

export class GwKey {
  readonly priv: KeyObject;
  readonly pubKey: string;
  constructor() {
    this.priv = generateKeyPairSync('ed25519').privateKey;
    const spki = createPublicKey(this.priv).export({ format: 'der', type: 'spki' });
    this.pubKey = spki.subarray(spki.length - 32).toString('base64url');
  }
  sign(nonce: string): string {
    return sign(null, Buffer.from(nonce, 'utf8'), this.priv).toString('base64url');
  }
}

export class FakeGw {
  ws!: WsClient;
  frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(
    readonly url: string,
    readonly gatewayId: string,
    readonly key: GwKey,
    readonly bootId = crypto.randomUUID(),
  ) {}

  connect(opts: { token?: string; query?: string; headers?: Record<string, string>; noId?: boolean } = {}): Promise<this> {
    const headers: Record<string, string> = { ...(opts.noId ? {} : { 'X-Siot-Gateway-Id': this.gatewayId }), ...opts.headers };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    this.ws = new WS(this.url + (opts.query ?? ''), { headers });
    this.frames = [];
    this.closed = null;
    this.ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as Frame;
      serverFramesSeen.push(f);
      this.frames.push(f);
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    this.ws.on('error', () => {});
    return new Promise((resolve) => {
      this.ws.on('open', () => resolve(this));
      this.ws.on('close', () => resolve(this));
    });
  }
  send(f: object): void {
    this.ws.send(JSON.stringify(f));
  }
  async waitFrame(t: string, from = 0, ms = 3000): Promise<Frame> {
    return until(() => this.frames.slice(from).find((f) => f.t === t), ms, `frame ${t} (got ${this.frames.map((f) => f.t).join(',')})`);
  }
  async waitClose(ms = 3000): Promise<{ code: number; reason: string }> {
    return until(() => this.closed, ms, 'close');
  }
  hello(nonce: string, over: Partial<HelloFrame> = {}): HelloFrame {
    return {
      t: 'hello',
      proto: 2,
      gatewayId: this.gatewayId,
      bootId: this.bootId,
      agentVersion: '0.3.0-test',
      matterServerVersion: null,
      startedAt: new Date().toISOString(),
      clock: new Date().toISOString(),
      cfgVersion: 0,
      keyVersion: 0,
      pubKey: this.key.pubKey,
      sig: this.key.sign(nonce),
      ...over,
    };
  }
  /** challenge → hello → welcome */
  async handshake(over: Partial<HelloFrame> = {}): Promise<Frame> {
    const ch = await this.waitFrame('challenge');
    this.send(this.hello(String(ch.nonce), over));
    return this.waitFrame('welcome');
  }
  snapshot(seq: number, over: Partial<SnapshotFrame> = {}): SnapshotFrame {
    return {
      t: 'snapshot',
      bootId: this.bootId,
      seq,
      keyVersion: 0,
      gateway: { gatewayId: this.gatewayId, agentVersion: '0.3.0-test', engineOnline: true, deviceCount: 0 },
      devices: [],
      ...over,
    };
  }
  evt(seq: number, over: Partial<EvtFrame> = {}): EvtFrame {
    return { t: 'evt', bootId: this.bootId, seq, keyVersion: 0, kind: 'log', at: new Date().toISOString(), data: { msg: `e${seq}` }, ...over } as EvtFrame;
  }
  cfgAck(cfgVersion: number, keyVersion = 1): CfgAckFrame {
    return { t: 'cfg_ack', cfgVersion, keyVersion, rulesVersion: 0 };
  }
  close(): void {
    this.ws.close(1000, 'bye');
  }
}

export function assertAllServerFramesValid(): number {
  for (const f of serverFramesSeen) {
    const r = validateServerFrame(f);
    if (!r.ok) throw new Error(`server frame ${f.t} invalid: ${r.error}`);
  }
  return serverFramesSeen.length;
}

// ---------------------------------------------------------------- 인메모리 deps
export const newGatewayId = () => `gw_${crypto.randomUUID()}`;
export const SITE_ID = 'site_01JZ8Q0V4Y4W6P1M2N3B5C7D9E';
export const ORG_ID = 'org_01JZ8Q0V4Y4W6P1M2N3B5C7D9E';

export class MemRepo implements GatewayRepo {
  rows = new Map<string, GatewayRecord>();
  calls: Array<{ op: string; gatewayId: string; arg?: unknown }> = [];
  reissues: Array<{ gatewayId: string; at: Date }> = [];
  cfg = new Map<string, CfgBody>();
  add(r: Partial<GatewayRecord> & { gatewayId: string; pubkey: string }): GatewayRecord {
    const rec: GatewayRecord = { orgId: ORG_ID, siteId: null, status: 'unbound', tokenHash: null, cfgVersion: 0, ...r };
    this.rows.set(rec.gatewayId, rec);
    return rec;
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async markOnline(gatewayId: string, hello: HelloFrame) {
    this.calls.push({ op: 'online', gatewayId, arg: hello.bootId });
  }
  async markOffline(gatewayId: string) {
    this.calls.push({ op: 'offline', gatewayId });
  }
  async recordCfgAck(gatewayId: string, ack: CfgAckFrame) {
    this.calls.push({ op: 'cfg_ack', gatewayId, arg: ack.cfgVersion });
  }
  async recordBound(gatewayId: string) {
    this.calls.push({ op: 'bound', gatewayId });
  }
  async reissueToken(gatewayId: string, hash: string, at: Date) {
    const r = this.rows.get(gatewayId)!;
    r.tokenHash = hash;
    this.reissues.push({ gatewayId, at });
    return { recentCount: this.reissues.filter((x) => x.gatewayId === gatewayId && at.getTime() - x.at.getTime() < 86_400_000).length };
  }
  async buildCfg(gatewayId: string) {
    const r = this.rows.get(gatewayId);
    if (!r?.siteId) return null;
    return (
      this.cfg.get(gatewayId) ?? {
        cfgVersion: r.cfgVersion,
        siteId: r.siteId,
        keys: [{ v: 1, key: 'A'.repeat(43) }],
        peers: [],
        rules: { version: 0, rules: [] },
      }
    );
  }
}

export class MemCache {
  log: string[] = [];
  online = new Map<string, boolean>();
  delayMs = 0;
  async applySnapshot(gatewayId: string, f: SnapshotFrame) {
    if (this.delayMs) await sleep(this.delayMs);
    this.log.push(`snapshot:${f.seq}`);
  }
  async applyEvt(gatewayId: string, f: EvtFrame) {
    if (this.delayMs) await sleep(this.delayMs);
    this.log.push(`evt:${f.seq}${'replayed' in f && f.replayed ? 'r' : ''}`);
  }
  async setGatewayOnline(gatewayId: string, online: boolean) {
    this.online.set(gatewayId, online);
    this.log.push(`online:${online}`);
  }
}

export class MemOutbox {
  events: Array<{ orgId: string; ev: RelayOutboxEvent }> = [];
  enqueue(orgId: string, ev: RelayOutboxEvent) {
    this.events.push({ orgId, ev });
  }
  types() {
    return this.events.map((e) => e.ev.type);
  }
}

export function memMetrics() {
  const c = () => ({ n: 0, inc(k = 1) { this.n += k; } });
  return { relayReconnects: c(), heartbeatTimeouts: c(), relayRequests: c(), gatewaysOnline: { v: 0, set(n: number) { this.v = n; } } };
}

export interface RelayFixture {
  app: FastifyInstance;
  relay: RelayHandle;
  url: string;
  repo: MemRepo;
  cache: MemCache;
  outbox: MemOutbox;
  metrics: ReturnType<typeof memMetrics>;
  alerts: { calls: Array<{ key: string; message: string }>; notify(key: string, message: string): void };
}

export async function startRelay(opts: { timing?: Partial<RelayTiming>; deployedAt?: Date; deps?: Partial<RelayDeps> } = {}): Promise<RelayFixture> {
  const app = Fastify({ logger: false });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  const repo = new MemRepo();
  const cache = new MemCache();
  const outbox = new MemOutbox();
  const metrics = memMetrics();
  const alerts = { calls: [] as Array<{ key: string; message: string }>, notify(key: string, message: string) { this.calls.push({ key, message }); } };
  const relay = await registerRelay(app, {
    repo,
    cache,
    outbox,
    metrics,
    alerts,
    deployedAt: opts.deployedAt ?? new Date(0),
    timing: { tickMs: 20, ...opts.timing },
    ...opts.deps,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, relay, url: `ws://127.0.0.1:${port}/gateway`, repo, cache, outbox, metrics, alerts };
}

export { sha256Hex };

// ---------------------------------------------------------------- 테스트 Postgres
const PG_BASE = process.env.RELAY_TEST_PG ?? 'postgres://localhost';

export async function pgAvailable(): Promise<boolean> {
  const sql = postgres(`${PG_BASE}/postgres`, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** 데이터베이스를 새로 만들고 drizzle 마이그레이션 적용 */
export async function freshDb(name: string): Promise<{ db: Db; sql: postgres.Sql; url: string }> {
  const admin = postgres(`${PG_BASE}/postgres`, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const url = `${PG_BASE}/${name}`;
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema }) as Db;
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  return { db, sql, url };
}

export const TEST_CONFIG = {
  NODE_ENV: 'test' as const,
  PORT: 0,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent' as const,
  DATABASE_URL: 'postgres://localhost/siot_relay_test',
  SESSION_SECRET: 's'.repeat(32),
  DATA_ENC_KEY: 'd'.repeat(32),
  LABEL_MASTER_KEY: 'l'.repeat(32),
  ALERT_WEBHOOK_URL: undefined,
  APP_ORIGIN: 'https://siot-cloud.fly.dev',
};
