// A2: 웹훅 서명·재시도(10s/30s, 같은 eventId)·dead-letter·24h 자동 비활성·gateway.online/offline·지연 p95.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { webhookDeliveries, webhooks } from '../../src/db/schema.js';
import { signPayload, verifySignature } from '../../src/webhooks/sign.js';
import { WEBHOOK_RETRY_DELAYS_SEC } from '../../src/webhooks/worker.js';
import { BOOT_A, connect, evtDevice, makeApp, openapiValidator, plug, seedGateway, seedOrg, seedSite, useTestDb, type TestApp } from './helpers.js';

const t = useTestDb();
const v = openapiValidator('public-v1.yaml');

interface Hit {
  at: number;
  eventId: string;
  body: Record<string, unknown>;
  sigOk: boolean;
  headers: IncomingMessage['headers'];
}

class Partner {
  server!: Server;
  hits: Hit[] = [];
  failFirst = 0;
  alwaysFail = false;
  secret = '';
  onHit?: (h: Hit) => void;
  nowSec: () => number = () => Math.floor(Date.now() / 1000);
  async start() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const h: Hit = {
          at: performance.now(),
          eventId: String(req.headers['siot-event-id']),
          body: JSON.parse(raw),
          sigOk: verifySignature(this.secret, raw, req.headers['siot-signature'] as string, this.nowSec()),
          headers: req.headers,
        };
        this.hits.push(h);
        this.onHit?.(h);
        const fail = this.alwaysFail || this.hits.length <= this.failFirst;
        res.writeHead(fail ? 500 : 200).end(fail ? 'nope' : 'ok');
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hook`;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

describe('signature', () => {
  it('t=,v1=HMAC-SHA256(secret, t.body), 허용 오차 300초', () => {
    const body = '{"a":1}';
    const now = 1_700_000_000;
    const sig = signPayload('whsec_abc', body, now);
    expect(sig).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature('whsec_abc', body, sig, now + 299)).toBe(true);
    expect(verifySignature('whsec_abc', body, sig, now + 301)).toBe(false);
    expect(verifySignature('whsec_abd', body, sig, now)).toBe(false);
    expect(verifySignature('whsec_abc', '{"a":2}', sig, now)).toBe(false);
  });
});

describe('A2 웹훅 전달(가짜 시계)', () => {
  let T: TestApp;
  let clock = new Date('2026-10-21T00:00:00.000Z');
  const partner = new Partner();
  let url = '';
  let key = '';
  let gw = '';
  let orgId = '';
  let webhookId = '';
  let seq = 0;
  const tick = (sec: number) => (clock = new Date(clock.getTime() + sec * 1000));

  beforeAll(async () => {
    await t.truncate();
    url = await partner.start();
    partner.nowSec = () => Math.floor(clock.getTime() / 1000);
    T = await makeApp(t.db, { now: () => clock });
    orgId = await seedOrg(t.db);
    const siteId = await seedSite(t.db, orgId);
    gw = await seedGateway(t.db, orgId, siteId, 7);
    key = (await T.ctx.apiKeys.issue(orgId, { name: 'k', mode: 'test', scopes: ['devices:read', 'webhooks:manage'] })).key;
    const r = await T.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { authorization: `Bearer ${key}` },
      payload: { url, events: ['device.state_changed', 'device.removed', 'gateway.online', 'gateway.offline'] },
    });
    expect(r.statusCode).toBe(201);
    webhookId = r.json().webhookId;
    partner.secret = r.json().secret;
    await connect(T, gw, [plug('matter:5:1', false)], BOOT_A);
  });
  afterAll(async () => {
    await T.app.close();
    await partner.stop();
  });
  beforeEach(async () => {
    partner.hits = [];
    partner.failFirst = 0;
    partner.alwaysFail = false;
    await t.db.update(webhooks).set({ failingSince: null, disabledAt: null }).where(eq(webhooks.webhookId, webhookId));
  });

  it('처음 2회 500 → 3번째에 같은 eventId 로 전달, 간격 10s/30s, 서명 유효, 본문은 스키마대로', async () => {
    partner.failFirst = 2;
    await T.ctx.cache.applyEvt(gw, evtDevice(BOOT_A, ++seq, [plug('matter:5:1', true)]));
    const worker = T.ctx.webhooks.worker;
    const t0 = clock.getTime();
    expect(await worker.runOnce()).toBe(1); // 즉시 1차
    tick(9);
    expect(await worker.runOnce()).toBe(0);
    tick(1);
    expect(await worker.runOnce()).toBe(1); // +10s
    tick(29);
    expect(await worker.runOnce()).toBe(0);
    tick(1);
    expect(await worker.runOnce()).toBe(1); // +30s
    expect(partner.hits).toHaveLength(3);
    expect(new Set(partner.hits.map((h) => h.eventId)).size).toBe(1);
    expect(partner.hits.every((h) => h.sigOk)).toBe(true);
    const sigTimes = partner.hits.map((h) => Number(/^t=(\d+)/.exec(String(h.headers['siot-signature']))![1]) * 1000 - t0);
    expect(sigTimes).toEqual([0, 10_000, 40_000]);
    const body = partner.hits[2]!.body;
    expect(v.schema('DeviceStateChangedEvent', body)).toEqual([]);
    expect(body).toMatchObject({ type: 'device.state_changed', eventId: partner.hits[0]!.eventId, gatewayId: gw, bootId: BOOT_A, seq, siteEpoch: 1, replayed: false, data: { source: 'event' } });
    const [d] = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, partner.hits[0]!.eventId));
    expect(d).toMatchObject({ status: 'delivered', attempt: 3, lastStatusCode: 200 });
  });

  it('8회 재시도(10s,30s,2m,10m,30m,1h,3h,6h) 뒤 dead-letter', async () => {
    partner.alwaysFail = true;
    await T.ctx.cache.applyEvt(gw, evtDevice(BOOT_A, ++seq, [plug('matter:5:1', false)]));
    const worker = T.ctx.webhooks.worker;
    await worker.runOnce();
    for (const s of WEBHOOK_RETRY_DELAYS_SEC) {
      tick(s);
      expect(await worker.runOnce()).toBe(1);
    }
    tick(86_400);
    expect(await worker.runOnce()).toBe(0);
    expect(partner.hits).toHaveLength(9);
    const [d] = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, partner.hits[0]!.eventId));
    expect(d).toMatchObject({ status: 'dead', attempt: 9, lastError: 'HTTP 500' });
  });

  it('24h 연속 실패면 자동 비활성, 이후 전달은 dead(WEBHOOK_DISABLED), 새 이벤트는 적재 안 함', async () => {
    partner.alwaysFail = true;
    await t.db.update(webhooks).set({ failingSince: new Date(clock.getTime() - 24 * 3600_000 - 1000) }).where(eq(webhooks.webhookId, webhookId));
    await T.ctx.cache.applyEvt(gw, evtDevice(BOOT_A, ++seq, [plug('matter:5:1', true)]));
    await T.ctx.webhooks.worker.runOnce();
    const [w] = await t.db.select().from(webhooks).where(eq(webhooks.webhookId, webhookId));
    expect(w!.disabledAt).not.toBeNull();
    tick(10);
    await T.ctx.webhooks.worker.runOnce();
    const [d] = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, partner.hits[0]!.eventId));
    expect(d).toMatchObject({ status: 'dead', lastError: 'WEBHOOK_DISABLED' });
    const n = (await t.db.select().from(webhookDeliveries)).length;
    await T.ctx.cache.applyEvt(gw, evtDevice(BOOT_A, ++seq, [plug('matter:5:1', false)]));
    expect((await t.db.select().from(webhookDeliveries)).length).toBe(n);
    // GET /v1/webhooks 에 disabledAt 이 보인다
    const list = await T.app.inject({ url: '/v1/webhooks', headers: { authorization: `Bearer ${key}` } });
    expect(list.json().data[0].disabledAt).not.toBeNull();
  });

  it('gateway.online/offline(relay 입력 모양) → GatewayStatusEvent, 같은 상태 연속은 억제', async () => {
    const outbox = T.ctx.webhooks.outbox;
    const siteId = T.ctx.cache.getGateway(gw)!.siteId;
    await outbox.enqueue(orgId, { type: 'gateway.offline', gatewayId: gw, siteId, at: clock.toISOString() });
    await outbox.enqueue(orgId, { type: 'gateway.offline', gatewayId: gw, siteId, at: clock.toISOString() });
    await outbox.enqueue(orgId, { type: 'gateway.online', gatewayId: gw, siteId, at: clock.toISOString() });
    await outbox.enqueue(orgId, { type: 'gateway.online', gatewayId: gw, siteId: null, at: clock.toISOString() });
    await T.ctx.webhooks.worker.runOnce();
    expect(partner.hits.map((h) => h.body.type)).toEqual(['gateway.offline', 'gateway.online']);
    for (const h of partner.hits) {
      expect(h.sigOk).toBe(true);
      expect(v.schema('GatewayStatusEvent', h.body)).toEqual([]);
    }
  });
});

describe('A2 지연: 백엔드 evt 수신 → partner 수신 p95 ≤1.0초(100건)', () => {
  let T: TestApp;
  const partner = new Partner();

  beforeAll(async () => {
    await t.truncate();
    const url = await partner.start();
    T = await makeApp(t.db, { startWorkers: true });
    const orgId = await seedOrg(t.db);
    const siteId = await seedSite(t.db, orgId);
    const gw = await seedGateway(t.db, orgId, siteId, 8);
    const key = (await T.ctx.apiKeys.issue(orgId, { name: 'k', mode: 'test', scopes: ['webhooks:manage'] })).key;
    const r = await T.app.inject({ method: 'POST', url: '/v1/webhooks', headers: { authorization: `Bearer ${key}` }, payload: { url, events: ['device.state_changed'] } });
    partner.secret = r.json().secret;
    await connect(T, gw, [plug('matter:6:1', false, { deviceType: 'BINARY_SENSOR', data: { active: false, measurement: 'door' } })], BOOT_A);
    (T as TestApp & { gw: string }).gw = gw;
  });
  afterAll(async () => {
    await T.app.close();
    await partner.stop();
  });

  it('100건', async () => {
    const gw = (T as TestApp & { gw: string }).gw;
    const sent = new Map<number, number>();
    const done = new Promise<void>((resolve) => {
      partner.onHit = () => {
        if (partner.hits.length >= 100) resolve();
      };
    });
    for (let i = 1; i <= 100; i++) {
      sent.set(i, performance.now());
      await T.ctx.cache.applyEvt(gw, evtDevice(BOOT_A, i, [plug('matter:6:1', false, { deviceType: 'BINARY_SENSOR', data: { active: i % 2 === 1, measurement: 'door' } })]));
      await new Promise((r) => setTimeout(r, 5));
    }
    await done;
    const lat = partner.hits.map((h) => h.at - sent.get(h.body.seq as number)!).sort((a, b) => a - b);
    const p95 = lat[94]!;
    expect(partner.hits.every((h) => h.sigOk)).toBe(true);
    expect(p95).toBeLessThanOrEqual(1000);
    console.log(`webhook latency p50=${lat[49]!.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${lat[99]!.toFixed(1)}ms`);
  }, 30_000);
});
