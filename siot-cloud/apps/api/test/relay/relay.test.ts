// 릴레이 서버(인메모리 deps): 프레임 스키마 양방향(C1), 4400/4401/4403, 접속 순서·보류·10초 종료, 하트비트→offline,
// replay 전달 순서·누적 ack, bind 유실 재발급, GatewayBus.request/sendBind/sendCfg, 연결 대체.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { FRAME_DIRECTIONS } from '@siot/protocol';
import { parseGatewayFrame, validateGatewayFrame, validateServerFrame } from '../../src/relay/frames.js';
import { GatewayOfflineError, GatewayTimeoutError } from '../../src/relay/GatewayBus.js';
import { RELAY_CLOSE_CODES } from '../../src/relay/index.js';
import {
  assertAllServerFramesValid,
  FakeGw,
  GwKey,
  newGatewayId,
  sha256Hex,
  SITE_ID,
  sleep,
  startRelay,
  until,
  type RelayFixture,
} from './helpers.js';

const require = createRequire(import.meta.url);
const fixtureDir = join(dirname(require.resolve('@siot/protocol/schema/relay-v2.json')), '../fixtures/relay-v2');

describe('relay-v2 frames (C1, both directions)', () => {
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));
  it.each(files)('fixture %s is accepted only in its direction', (f) => {
    const frame = JSON.parse(readFileSync(join(fixtureDir, f), 'utf8'));
    const dir = FRAME_DIRECTIONS[frame.t as keyof typeof FRAME_DIRECTIONS];
    const s2g = validateServerFrame(frame).ok;
    const g2s = validateGatewayFrame(frame).ok;
    if (f.startsWith('valid.')) {
      expect(s2g).toBe(dir !== 'gateway_to_server');
      expect(g2s).toBe(dir !== 'server_to_gateway');
    } else {
      expect(s2g && g2s).toBe(false);
    }
  });

  it('receiver ignores unknown fields but rejects real violations', () => {
    const snap = JSON.parse(readFileSync(join(fixtureDir, 'valid.snapshot.json'), 'utf8'));
    expect(validateGatewayFrame({ ...snap, futureField: 1 }).ok).toBe(true);
    const { seq: _s, ...noSeq } = snap;
    expect(validateGatewayFrame(noSeq).ok).toBe(false);
    expect(parseGatewayFrame('{not json').ok).toBe(false);
    expect(validateGatewayFrame({ t: 'evt', kind: 'nope' }).ok).toBe(false);
    expect(validateGatewayFrame({ t: 'challenge', nonce: 'x'.repeat(16) }).ok).toBe(false); // 서버→GW 전용
  });

  it('pairing evt accepts attempt/maxAttempts', () => {
    const f = {
      t: 'evt',
      bootId: crypto.randomUUID(),
      seq: 1,
      keyVersion: 0,
      kind: 'pairing',
      at: new Date().toISOString(),
      data: { sessionId: 's1', stage: 'commissioning', attempt: 2, maxAttempts: 3 },
    };
    const v = validateGatewayFrame(f);
    expect(v.ok).toBe(true);
  });
});

describe('relay server', () => {
  let fx: RelayFixture;
  let key: GwKey;
  let gwId: string;
  const clients: FakeGw[] = [];
  const gw = (k = key, id = gwId) => {
    const c = new FakeGw(fx.url, id, k);
    clients.push(c);
    return c;
  };

  async function setup(timing = {}, deployedAt?: Date) {
    fx = await startRelay({ timing, deployedAt });
    key = new GwKey();
    gwId = newGatewayId();
    fx.repo.add({ gatewayId: gwId, pubkey: key.pubKey });
  }
  beforeEach(async () => setup());
  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws?.terminate();
    await fx.app.close();
  });
  afterAll(() => {
    // 이 파일에서 서버가 보낸 모든 프레임이 ServerToGateway 스키마를 지켰다
    expect(assertAllServerFramesValid()).toBeGreaterThan(20);
  });

  // ---------------------------------------------------------------- 접속 거부
  it('query token → 4401 (before anything else)', async () => {
    const c = await gw().connect({ query: '?token=abc' });
    expect((await c.waitClose()).code).toBe(4401);
    expect(c.frames).toEqual([]);
  });

  it('wrong bearer token → 4401; missing gateway id header → 4400', async () => {
    fx.repo.rows.get(gwId)!.tokenHash = sha256Hex('right');
    const c = await gw().connect({ token: 'wrong' });
    expect((await c.waitClose()).code).toBe(RELAY_CLOSE_CODES.tokenRejected);
    const d = await gw().connect({ noId: true });
    expect((await d.waitClose()).code).toBe(4400);
  });

  it('unregistered gateway, foreign key, bad signature → 4403', async () => {
    const unknown = await gw(key, newGatewayId()).connect();
    expect((await unknown.waitClose()).code).toBe(4403);

    const other = new GwKey(); // 등록 키와 다른 키로 서명
    const c = await gw(other).connect();
    const ch0 = await c.waitFrame('challenge');
    c.send(c.hello(String(ch0.nonce)));
    expect((await c.waitClose()).code).toBe(4403);

    const d = await gw().connect();
    const ch = await d.waitFrame('challenge');
    d.send(d.hello(String(ch.nonce), { sig: key.sign('other-nonce') }));
    expect((await d.waitClose()).code).toBe(4403);
    expect(fx.cache.log).toEqual([]);
  });

  // ---------------------------------------------------------------- 정상 접속
  it('challenge → hello → welcome; same cfgVersion → snapshot processed at once, then evt and ack', async () => {
    const c = await gw().connect();
    const ch = await c.waitFrame('challenge');
    expect(String(ch.nonce).length).toBeGreaterThanOrEqual(16);
    c.send(c.hello(String(ch.nonce)));
    const w = await c.waitFrame('welcome');
    expect(w).toMatchObject({ heartbeatSec: 10, deadSec: 25, cfgVersion: 0 });
    expect(fx.relay.isOnline(gwId)).toBe(true);
    c.send(c.snapshot(0));
    c.send(c.evt(1));
    await until(() => fx.cache.log.includes('evt:1'));
    expect(fx.cache.log).toEqual(['online:true', 'snapshot:0', 'evt:1']);
    expect(fx.outbox.types()).toEqual(['gateway.online']);
    expect(fx.outbox.events[0]!.orgId).toBe(fx.repo.rows.get(gwId)!.orgId);
    expect(c.frames.some((f) => f.t === 'cfg')).toBe(false);
  });

  it('valid bearer token connection is accepted', async () => {
    fx.repo.rows.get(gwId)!.tokenHash = sha256Hex('tok-ok');
    Object.assign(fx.repo.rows.get(gwId)!, { status: 'bound', siteId: SITE_ID });
    const c = await gw().connect({ token: 'tok-ok' });
    await c.handshake();
    await sleep(50);
    expect(c.frames.some((f) => f.t === 'bind')).toBe(false); // 토큰 접속은 재발급하지 않음
    expect(fx.repo.reissues).toEqual([]);
  });

  // ---------------------------------------------------------------- 접속 순서(cfg → 보류 → cfg_ack)
  it('server cfgVersion higher → cfg right after welcome; snapshot/evt held until cfg_ack, then in order', async () => {
    Object.assign(fx.repo.rows.get(gwId)!, { status: 'bound', siteId: SITE_ID, cfgVersion: 3, tokenHash: sha256Hex('t') });
    const c = await gw().connect({ token: 't' });
    const w = await c.handshake({ cfgVersion: 1 });
    expect(w.cfgVersion).toBe(3);
    const cfg = await c.waitFrame('cfg');
    expect(cfg).toMatchObject({ cfgVersion: 3, siteId: SITE_ID, rules: { version: 0, rules: [] } });
    expect('thread' in cfg).toBe(false);
    expect(c.frames.findIndex((f) => f.t === 'cfg')).toBeGreaterThan(c.frames.findIndex((f) => f.t === 'welcome'));
    // GW 가 순서를 어기고 cfg_ack 전에 보내도 서버는 보류한다
    c.send(c.snapshot(2));
    c.send(c.evt(1, { replayed: true }));
    c.send(c.evt(2, { replayed: true }));
    await sleep(100);
    expect(fx.cache.log).toEqual(['online:true']);
    c.send(c.cfgAck(3));
    c.send(c.evt(3));
    await until(() => fx.cache.log.includes('evt:3'));
    expect(fx.cache.log).toEqual(['online:true', 'snapshot:2', 'evt:1r', 'evt:2r', 'evt:3']);
    expect(fx.repo.calls.find((x) => x.op === 'cfg_ack')?.arg).toBe(3);
  });

  it('no cfg_ack within cfgAckTimeout → connection closed (4408), held frames never applied', async () => {
    await fx.app.close();
    await setup({ cfgAckTimeoutMs: 200 });
    Object.assign(fx.repo.rows.get(gwId)!, { status: 'bound', siteId: SITE_ID, cfgVersion: 2, tokenHash: sha256Hex('t') });
    const c = await gw().connect({ token: 't' });
    await c.handshake();
    await c.waitFrame('cfg');
    c.send(c.snapshot(0));
    const t0 = Date.now();
    expect((await c.waitClose()).code).toBe(4408);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fx.cache.log).not.toContain('snapshot:0');
    await until(() => fx.cache.online.get(gwId) === false);
  });

  it('held buffer over pendingMax → closed (4413)', async () => {
    await fx.app.close();
    await setup({ pendingMax: 5 });
    Object.assign(fx.repo.rows.get(gwId)!, { status: 'bound', siteId: SITE_ID, cfgVersion: 2, tokenHash: sha256Hex('t') });
    const c = await gw().connect({ token: 't' });
    await c.handshake();
    await c.waitFrame('cfg');
    for (let i = 1; i <= 6; i++) c.send(c.evt(i));
    expect((await c.waitClose()).code).toBe(4413);
  });

  it('site_reset_pending with token: cfg is sent first even before snapshot', async () => {
    Object.assign(fx.repo.rows.get(gwId)!, { status: 'site_reset_pending', siteId: SITE_ID, cfgVersion: 5, tokenHash: sha256Hex('t') });
    const c = await gw().connect({ token: 't' });
    await c.handshake({ cfgVersion: 4 });
    expect((await c.waitFrame('cfg')).cfgVersion).toBe(5);
  });

  // ---------------------------------------------------------------- 하트비트·offline
  it('heartbeat: server pings; silent GW dropped after deadSec → offline (cache, outbox, metric, hook)', async () => {
    await fx.app.close();
    await setup({ heartbeatSec: 0.05, deadSec: 0.3 });
    const offline: string[] = [];
    fx.relay.onOffline((i) => void offline.push(i.reason));
    const c = await gw().connect();
    await c.handshake();
    await c.waitFrame('ping');
    c.send({ t: 'ping' });
    await c.waitFrame('pong');
    const t0 = Date.now();
    await c.waitClose(2000); // 이후 GW 는 아무것도 보내지 않는다
    expect(Date.now() - t0).toBeLessThan(1500);
    await until(() => offline.length > 0);
    expect(offline).toEqual(['heartbeat']);
    expect(fx.relay.isOnline(gwId)).toBe(false);
    expect(fx.cache.online.get(gwId)).toBe(false);
    expect(fx.outbox.types()).toEqual(['gateway.online', 'gateway.offline']);
    expect(fx.outbox.events[1]!.ev.data).toEqual({ reason: 'heartbeat' });
    expect(fx.metrics.heartbeatTimeouts.n).toBe(1);
    expect(fx.metrics.gatewaysOnline.v).toBe(0);
    await expect(fx.relay.request(gwId, { method: 'GET', path: '/x' }, 1000)).rejects.toBeInstanceOf(GatewayOfflineError);
  });

  it('within deploy grace window gateway.offline is not enqueued (online still is)', async () => {
    await fx.app.close();
    await setup({ offlineGraceMs: 60_000 }, new Date());
    const c = await gw().connect();
    await c.handshake();
    c.close();
    await until(() => fx.cache.online.get(gwId) === false);
    expect(fx.outbox.types()).toEqual(['gateway.online']);
  });

  it('reconnect counts relayReconnects; new connection replaces old (4409) without offline webhook', async () => {
    const a = await gw().connect();
    await a.handshake();
    const b = await gw().connect();
    await b.handshake();
    expect((await a.waitClose()).code).toBe(4409);
    await sleep(50);
    expect(fx.relay.isOnline(gwId)).toBe(true);
    expect(fx.outbox.types()).toEqual(['gateway.online']);
    expect(fx.cache.online.get(gwId)).toBe(true);
    expect(fx.metrics.relayReconnects.n).toBe(1);
  });

  // ---------------------------------------------------------------- replay·ack
  it('replay order preserved through a slow cache; cumulative ack upTo after ackEvery', async () => {
    await fx.app.close();
    await setup({ ackEvery: 3, ackIntervalMs: 5000 });
    fx.cache.delayMs = 15;
    const c = await gw().connect();
    await c.handshake();
    c.send(c.snapshot(2));
    c.send(c.evt(1, { replayed: true }));
    c.send(c.evt(2, { replayed: true }));
    c.send(c.evt(3));
    const ack = await c.waitFrame('ack');
    expect(ack).toEqual({ t: 'ack', bootId: c.bootId, upTo: 3 });
    expect(fx.cache.log).toEqual(['online:true', 'snapshot:2', 'evt:1r', 'evt:2r', 'evt:3']);
  });

  it('ack also flushes on the interval timer', async () => {
    await fx.app.close();
    await setup({ ackEvery: 50, ackIntervalMs: 100 });
    const c = await gw().connect();
    await c.handshake();
    c.send(c.snapshot(0));
    c.send(c.evt(1));
    const ack = await c.waitFrame('ack', 0, 1000);
    expect(ack.upTo).toBe(1);
  });

  // ---------------------------------------------------------------- bind 유실 재발급
  it('bound GW with signed hello but no token → new token, old hash revoked, bind re-sent; alert after >3 in 24h', async () => {
    const row = fx.repo.rows.get(gwId)!;
    Object.assign(row, { status: 'bound', siteId: SITE_ID, cfgVersion: 1, tokenHash: sha256Hex('old-token') });
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await gw().connect();
      await c.handshake();
      const bind = await c.waitFrame('bind');
      expect(bind.siteId).toBe(SITE_ID);
      const tok = String(bind.gatewayToken);
      expect(tok).toMatch(/^[0-9a-f]{64}$/);
      expect(row.tokenHash).toBe(sha256Hex(tok));
      tokens.push(tok);
      expect(c.frames.findIndex((f) => f.t === 'bind')).toBeGreaterThan(c.frames.findIndex((f) => f.t === 'welcome'));
      expect(c.frames.some((f) => f.t === 'cfg')).toBe(false);
      c.send({ t: 'bound' });
      await until(() => fx.repo.calls.filter((x) => x.op === 'bound').length === i + 1);
      c.close();
      await c.waitClose();
    }
    expect(new Set(tokens).size).toBe(4);
    expect(fx.alerts.calls).toHaveLength(1);
    expect(fx.alerts.calls[0]!.key).toBe(`gateway.token_reissue:${gwId}`);
    // 옛 토큰은 즉시 무효
    const stale = await gw().connect({ token: tokens[0] });
    expect((await stale.waitClose()).code).toBe(4401);
    const fresh = await gw().connect({ token: tokens[3] });
    await fresh.handshake();
  });

  it('unbound GW connecting without token is not reissued', async () => {
    const c = await gw().connect();
    await c.handshake();
    await sleep(50);
    expect(c.frames.map((f) => f.t)).toEqual(['challenge', 'welcome']);
  });

  // ---------------------------------------------------------------- GatewayBus
  it('request/res matching by id, timeout, offline-on-close; sendCfg/sendBind', async () => {
    const c = await gw().connect();
    await c.handshake();
    const p = fx.relay.request(gwId, { method: 'POST', path: '/siot-app/api/v1/devices/matter:1:1/control', headers: { 'content-type': 'application/json' }, body: 'e30=' }, 2000);
    const req = await c.waitFrame('req');
    expect(req).toMatchObject({ method: 'POST', path: '/siot-app/api/v1/devices/matter:1:1/control', body: 'e30=' });
    c.send({ t: 'res', id: 'unrelated', status: 500 });
    c.send({ t: 'res', id: req.id, status: 200, headers: { 'content-type': 'application/json' }, body: 'e30=' });
    await expect(p).resolves.toEqual({ id: req.id, status: 200, headers: { 'content-type': 'application/json' }, body: 'e30=' });
    expect(fx.metrics.relayRequests.n).toBe(1);

    await expect(fx.relay.request(gwId, { method: 'GET', path: '/slow' }, 100)).rejects.toBeInstanceOf(GatewayTimeoutError);

    expect(await fx.relay.sendCfg(gwId, { cfgVersion: 1, siteId: SITE_ID, keys: [{ v: 1, key: 'B'.repeat(43) }], peers: [], rules: { version: 0, rules: [] } })).toBe(true);
    await c.waitFrame('cfg');
    const bindP = fx.relay.sendBind(gwId, { gatewayToken: 'x'.repeat(64), siteId: SITE_ID });
    await c.waitFrame('bind');
    c.send({ t: 'bound' });
    await expect(bindP).resolves.toBe(true);

    const pending = fx.relay.request(gwId, { method: 'GET', path: '/hang' }, 5000);
    await c.waitFrame('req', c.frames.filter((f) => f.t === 'req').length > 0 ? c.frames.length - 1 : 0);
    c.close();
    await expect(pending).rejects.toBeInstanceOf(GatewayOfflineError);
    expect(await fx.relay.sendCfg(gwId, { cfgVersion: 2, siteId: SITE_ID, keys: [{ v: 1, key: 'B'.repeat(43) }], peers: [], rules: { version: 0, rules: [] } })).toBe(false);
    expect(await fx.relay.sendBind(gwId, { gatewayToken: 'x'.repeat(64), siteId: SITE_ID })).toBe(false);
  });

  it('hooks: onOnline / onSnapshot / onEvt fire in order', async () => {
    const seen: string[] = [];
    fx.relay.onOnline((i) => void seen.push(`online:${i.hello.bootId === c.bootId}`));
    fx.relay.onSnapshot((_g, f) => void seen.push(`snapshot:${f.seq}`));
    const off = fx.relay.onEvt((_g, f) => void seen.push(`evt:${f.seq}`));
    const c = await gw().connect();
    await c.handshake();
    c.send(c.snapshot(0));
    c.send(c.evt(1));
    await until(() => seen.length === 3);
    off();
    c.send(c.evt(2));
    await until(() => fx.cache.log.includes('evt:2'));
    expect(seen).toEqual(['online:true', 'snapshot:0', 'evt:1']);
  });
});
