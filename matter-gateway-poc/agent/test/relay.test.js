// relay-v2 클라이언트 왕복 테스트 — 로컬 가짜 릴레이 서버(ws)와 가짜 로컬 API(http)로 실 백엔드 없이 검증한다.
// GW 가 보낸 모든 프레임은 siot-cloud/packages/protocol/schema/relay-v2.json 이 있으면 ajv 로 검증한다(없으면 그 단계만 skip).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { createPublicKey, verify, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GatewayStore } from '../src/platform/store.js';
import { Identity } from '../src/platform/identity.js';
import { SiteConfig } from '../src/site/siteConfig.js';
import { normalizeNode } from '../src/model/normalize.js';
import { toSiotDevices } from '../src/platform/siotMapper.js';
import { SIM_PLUG } from '../src/matterSim.js';
import { RelayAgent, EventRing, backoffDelay, frames, RING_SIZE, BACKOFF } from '../src/platform/relay.js';
import { RulesEngine } from '../src/rules.js';

const GW = 'gw_0e1a0001-aaaa-bbbb-cccc-ddddeeeeffff';
const b64 = (s) => Buffer.from(s).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 스키마 검증기(있을 때만) ----------
const protocolDir = fileURLToPath(new URL('../../../siot-cloud/packages/protocol/', import.meta.url));
let g2s = null;
before(async () => {
  if (!existsSync(path.join(protocolDir, 'schema/relay-v2.json'))) return;
  try {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const load = (p) => JSON.parse(readFileSync(path.join(protocolDir, p), 'utf8'));
    const relay = load('schema/relay-v2.json');
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    addFormats(ajv); ajv.addKeyword('x-direction');
    ajv.addSchema(load('schema/siot-device.json')); ajv.addSchema(relay);
    g2s = ajv.getSchema(`${relay.$id}#/$defs/GatewayToServer`);
  } catch { g2s = null; }
});
const sent = [];   // GW → 서버 전체 프레임(스키마 검증용)

// ---------- 가짜 릴레이 서버 ----------
class FakeRelay {
  constructor() { this.conns = []; this.waiters = []; }
  async start() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on('connection', (ws, req) => {
      const c = { ws, req, frames: [], waiters: [], closed: false };
      ws.on('message', (raw) => { const f = JSON.parse(raw.toString()); sent.push(f); c.frames.push(f); for (const w of [...c.waiters]) w(); });
      ws.on('close', () => { c.closed = true; for (const w of [...c.waiters]) w(); });
      this.conns.push(c); for (const w of [...this.waiters]) w();
    });
    await once(this.wss, 'listening');
    this.url = `ws://127.0.0.1:${this.wss.address().port}/gateway`;
    return this;
  }
  async nextConn(n, ms = 3000) {
    const t0 = Date.now();
    while (this.conns.length < n) { if (Date.now() - t0 > ms) throw new Error(`no connection #${n}`); await new Promise((r) => { this.waiters.push(r); setTimeout(r, 50); }); this.waiters = []; }
    return this.conns[n - 1];
  }
  stop() { for (const c of this.wss.clients) c.terminate(); return new Promise((r) => this.wss.close(() => r())); }
}
/** 연결 c 에서 type t 프레임을 기다린다(이미 받은 것 중 from 인덱스 이후) */
async function waitFrame(c, t, { from = 0, ms = 3000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const i = c.frames.findIndex((f, k) => k >= from && f.t === t);
    if (i >= 0) return { frame: c.frames[i], index: i };
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting ${t}; got ${c.frames.map((f) => f.t).join(',')}`);
    await new Promise((r) => { c.waiters.push(r); setTimeout(r, 30); }); c.waiters.length = 0;
  }
}
const send = (c, f) => c.ws.send(JSON.stringify(f));
async function handshake(c, welcome) {
  const nonce = randomUUID();
  send(c, { t: 'challenge', nonce });
  const { frame: hello } = await waitFrame(c, 'hello');
  send(c, { t: 'welcome', serverTime: new Date().toISOString(), heartbeatSec: 10, deadSec: 25, cfgVersion: 0, ...welcome });
  return { hello, nonce };
}

// ---------- 가짜 로컬 API(프록시 대상) ----------
let api, apiPort, dir, store, identity, site;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'siot-relay-'));
  process.env.SIOT_GATEWAY_ID = GW;
  store = new GatewayStore(dir); identity = new Identity(store); site = new SiteConfig(dir); await site.load();
  api = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (req.url === '/slow') await sleep(500);
      const out = JSON.stringify({ method: req.method, path: req.url, auth: req.headers.authorization ?? null, body });
      res.writeHead(200, { 'content-type': 'application/json', 'x-test': '1' }); res.end(out);
    });
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening'); apiPort = api.address().port;
});
after(async () => { api.close(); await rm(dir, { recursive: true, force: true }); delete process.env.SIOT_GATEWAY_ID; });

function makeAgent(relayUrl, extra = {}) {
  return new RelayAgent({
    relayUrl, identity, store, siteConfig: site, bootId: randomUUID(), startedAt: new Date().toISOString(), version: '1.2.3', proxyPort: apiPort,
    getSnapshot: () => ({ gateway: { gatewayId: GW, agentVersion: '1.2.3', engineOnline: true, deviceCount: 1 }, devices: toSiotDevices(normalizeNode(SIM_PLUG)) }),
    timing: { tickMs: 20, cfgWaitMs: 2000, backoff: { baseMs: 10, maxMs: 40, jitter: 0 } },
    ...extra,
  });
}

// ---------- 단위 ----------
test('backoff: max 20s ±20% (never above 24s), grows from 1s', () => {
  assert.equal(backoffDelay(0, BACKOFF, () => 0.5), 1000);
  assert.equal(backoffDelay(3, BACKOFF, () => 0.5), 8000);
  for (let a = 0; a < 50; a++) {
    assert.ok(backoffDelay(a, BACKOFF, () => 1) <= 24_000);
    assert.ok(backoffDelay(a, BACKOFF, () => 0) >= 800);
  }
  assert.equal(backoffDelay(10, BACKOFF, () => 0.5), 20_000);
  assert.equal(backoffDelay(10, BACKOFF, () => 1), 24_000);
  assert.equal(backoffDelay(10, BACKOFF, () => 0), 16_000);
});

test('EventRing: (bootId, seq) from 1, capacity 1000, ack clears ≤ upTo for same bootId only', () => {
  const r = new EventRing('boot-a');
  for (let i = 0; i < RING_SIZE + 5; i++) r.push({ kind: 'log', data: { i } });
  assert.equal(r.size, RING_SIZE); assert.equal(r.lastSeq, 1005); assert.equal(r.unacked()[0].seq, 6); assert.equal(r.dropped, 5);
  assert.equal(r.ack('boot-other', 2000), 0); assert.equal(r.size, RING_SIZE);
  assert.equal(r.ack('boot-a', 500), 495); assert.equal(r.unacked()[0].seq, 501);
  const e = r.unacked()[0];
  assert.deepEqual(Object.keys(e), ['t', 'bootId', 'seq', 'keyVersion', 'kind', 'at', 'data']);
  assert.equal(e.t, 'evt'); assert.equal(e.bootId, 'boot-a');
  r.ack('boot-a', 1005); assert.equal(r.size, 0);
});

test('frame builders emit exactly the §2 b fields', () => {
  assert.deepEqual(Object.keys(frames.hello({})), ['t', 'proto', 'gatewayId', 'bootId', 'agentVersion', 'matterServerVersion', 'startedAt', 'clock', 'cfgVersion', 'keyVersion', 'pubKey', 'sig']);
  assert.deepEqual(frames.bound(), { t: 'bound' });
  assert.deepEqual(Object.keys(frames.cfgAck({})), ['t', 'cfgVersion', 'keyVersion', 'rulesVersion']);
  assert.deepEqual(Object.keys(frames.snapshot({})), ['t', 'bootId', 'seq', 'keyVersion', 'gateway', 'devices']);
  assert.deepEqual(Object.keys(frames.res({})), ['t', 'id', 'status', 'headers', 'body']);
  assert.deepEqual(frames.ping(), { t: 'ping' }); assert.deepEqual(frames.pong(), { t: 'pong' });
  assert.equal('replayed' in frames.evt({ seq: 1 }), false); assert.equal(frames.evt({ seq: 1, replayed: true }).replayed, true);
});

// ---------- 왕복 ----------
test('round trip: unbound connect → hello sig → welcome → snapshot+replay → bind → token reconnect → cfg → cfg_ack → snapshot → ack → evt → req → ping', async () => {
  const relay = await new FakeRelay().start();
  const agent = makeAgent(relay.url);
  const rules = new RulesEngine(new EventEmitter(), async () => {}, { file: path.join(dir, 'rules.json') });
  agent.on('cfg', (cfg) => rules.onCfg(cfg));            // index.js 와 같은 연결
  agent.publish('gateway', { booted: true });           // 접속 전 이벤트 → seq 1, 링버퍼에 남음
  await agent.start();

  // 1) 미바인딩 접속: 토큰 없이, 쿼리 없이, 게이트웨이 ID 헤더
  const c1 = await relay.nextConn(1);
  assert.equal(c1.req.url, '/gateway');
  assert.equal(c1.req.headers['x-siot-gateway-id'], GW);
  assert.equal(c1.req.headers.authorization, undefined);
  const { hello, nonce } = await handshake(c1, { cfgVersion: 0 });
  assert.equal(hello.proto, 2); assert.equal(hello.gatewayId, GW); assert.equal(hello.agentVersion, '1.2.3'); assert.equal(hello.cfgVersion, 0); assert.equal(hello.keyVersion, 0);
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: hello.pubKey }, format: 'jwk' });
  assert.ok(verify(null, Buffer.from(nonce), pub, Buffer.from(hello.sig, 'base64url')), 'hello.sig verifies with pubKey');
  assert.equal(hello.pubKey, (await identity.deviceKey()).publicKey);
  // welcome(cfg 같음) → snapshot 바로, 그 뒤 미확인 evt replayed
  const s1 = await waitFrame(c1, 'snapshot');
  assert.equal(s1.frame.seq, 1); assert.equal(s1.frame.bootId, agent.bootId);
  const r1 = await waitFrame(c1, 'evt');
  assert.ok(r1.index > s1.index, 'snapshot before evt'); assert.equal(r1.frame.seq, 1); assert.equal(r1.frame.replayed, true);
  assert.equal(agent.connected, true);

  // 2) bind → 토큰 저장 + bound + 토큰으로 재접속
  send(c1, { t: 'bind', gatewayToken: 'tok-123', siteId: 'site_1' });
  await waitFrame(c1, 'bound');
  const c2 = await relay.nextConn(2);
  assert.equal(c2.req.headers.authorization, 'Bearer tok-123');
  const saved = await store.load(); assert.equal(saved.gatewayToken, 'tok-123'); assert.equal(saved.siteId, 'site_1');
  assert.equal((await stat(path.join(dir, 'gateway.json'))).mode & 0o777, 0o600);

  // 3) welcome.cfgVersion 이 더 높음 → cfg 전에는 snapshot 을 보내지 않는다
  await handshake(c2, { cfgVersion: 3 });
  await sleep(150);
  assert.equal(c2.frames.some((f) => f.t === 'snapshot'), false, 'snapshot held until cfg_ack');
  send(c2, { t: 'cfg', cfgVersion: 3, siteId: 'site_1', keys: [{ v: 1, key: 'a2V5' }], peers: [], rules: { version: 2, rules: [] } });
  const ack = await waitFrame(c2, 'cfg_ack');
  assert.deepEqual(ack.frame, { t: 'cfg_ack', cfgVersion: 3, keyVersion: 1, rulesVersion: 2 });
  await rules.saving; assert.equal(rules.version, 2);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'rules.json'), 'utf8')), { version: 2, rules: [] }, 'cfg.rules → rules.json');
  const s2 = await waitFrame(c2, 'snapshot');
  assert.ok(s2.index > ack.index, 'cfg_ack before snapshot');
  assert.equal(s2.frame.keyVersion, 1);
  const r2 = await waitFrame(c2, 'evt', { from: s2.index });
  assert.equal(r2.frame.seq, 1); assert.equal(r2.frame.replayed, true);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'site.json'), 'utf8')).cfgVersion, 3);

  // 4) ack 로 비우고, 새 evt 는 실시간(replayed 없음, 현재 keyVersion)
  send(c2, { t: 'ack', bootId: agent.bootId, upTo: 1 });
  await sleep(50);
  assert.equal(agent.ring.size, 0);
  agent.publish('device', { devices: toSiotDevices(normalizeNode(SIM_PLUG)) });
  const live = await waitFrame(c2, 'evt', { from: r2.index + 1 });
  assert.equal(live.frame.seq, 2); assert.equal('replayed' in live.frame, false); assert.equal(live.frame.keyVersion, 1); assert.equal(live.frame.kind, 'device');

  // 5) req → 로컬 API 프록시: 클라우드 Authorization 은 버리고 자기 토큰 주입, 본문 base64
  send(c2, { t: 'req', id: 'r1', method: 'POST', path: '/siot-app/api/v1/devices/matter:1:1/control', headers: { authorization: 'Bearer evil', 'content-type': 'application/json' }, body: b64('{"action":"ON"}'), timeoutMs: 2000 });
  const res = await waitFrame(c2, 'res');
  assert.equal(res.frame.id, 'r1'); assert.equal(res.frame.status, 200); assert.equal(res.frame.headers['x-test'], '1');
  const echoed = JSON.parse(unb64(res.frame.body));
  assert.equal(echoed.auth, 'Bearer tok-123'); assert.equal(echoed.body, '{"action":"ON"}'); assert.equal(echoed.path, '/siot-app/api/v1/devices/matter:1:1/control');
  // timeoutMs 초과 → 504
  send(c2, { t: 'req', id: 'r2', method: 'GET', path: '/slow', headers: {}, body: '', timeoutMs: 100 });
  const slow = await waitFrame(c2, 'res', { from: res.index + 1 });
  assert.equal(slow.frame.id, 'r2'); assert.equal(slow.frame.status, 504);
  // 경로가 / 로 시작하지 않으면 400 (다른 호스트로 새지 않음)
  send(c2, { t: 'req', id: 'r3', method: 'GET', path: 'http://evil/', headers: {} });
  const bad = await waitFrame(c2, 'res', { from: slow.index + 1 });
  assert.equal(bad.frame.status, 400);
  // ping → pong
  send(c2, { t: 'ping' });
  await waitFrame(c2, 'pong');

  // 6) 재접속(서버가 끊음): cfg 같음 → welcome 직후 snapshot, 그 뒤 미확인 seq 2 replayed
  c2.ws.close();
  const c3 = await relay.nextConn(3);
  assert.equal(c3.req.headers.authorization, 'Bearer tok-123');
  const h3 = await handshake(c3, { cfgVersion: 3 });
  assert.equal(h3.hello.cfgVersion, 3); assert.equal(h3.hello.keyVersion, 1); assert.equal(h3.hello.bootId, agent.bootId);
  const s3 = await waitFrame(c3, 'snapshot');
  assert.equal(s3.frame.seq, 2);
  const r3 = await waitFrame(c3, 'evt');
  assert.ok(r3.index > s3.index); assert.equal(r3.frame.seq, 2); assert.equal(r3.frame.replayed, true);

  agent.stop(); await relay.stop();
});

test('heartbeat: pings at heartbeatSec and drops a silent connection after deadSec, then reconnects', async () => {
  const relay = await new FakeRelay().start();
  const agent = makeAgent(relay.url);
  await agent.start();
  const c1 = await relay.nextConn(1);
  await handshake(c1, { heartbeatSec: 0.05, deadSec: 0.3 });   // 테스트용 짧은 주기. 서버는 pong 을 보내지 않는다
  await waitFrame(c1, 'ping');
  const t0 = Date.now();
  await new Promise((r) => (c1.closed ? r() : c1.ws.once('close', r)));
  assert.ok(Date.now() - t0 < 2000, 'dead connection terminated');
  assert.ok(c1.frames.filter((f) => f.t === 'ping').length >= 2);
  await relay.nextConn(2);
  agent.stop(); await relay.stop();
});

test('4401 on a token connection → next attempt is signature-only (bind re-issue path)', async () => {
  await store.save({ gatewayToken: 'stale-token' });
  const relay = await new FakeRelay().start();
  const agent = makeAgent(relay.url);
  await agent.start();
  const c1 = await relay.nextConn(1);
  assert.equal(c1.req.headers.authorization, 'Bearer stale-token');
  c1.ws.close(4401, 'bad token');
  const c2 = await relay.nextConn(2);
  assert.equal(c2.req.headers.authorization, undefined);
  agent.stop(); await relay.stop();
});

test('every frame the agent sent validates against relay-v2 GatewayToServer schema', (t) => {
  if (!g2s) return t.skip('siot-cloud/packages/protocol/schema/relay-v2.json 없음');
  assert.ok(sent.length > 10);
  const types = new Set();
  for (const f of sent) { types.add(f.t); assert.ok(g2s(f), `${f.t}: ${JSON.stringify(g2s.errors)}`); }
  for (const tt of ['hello', 'bound', 'cfg_ack', 'snapshot', 'evt', 'res', 'ping', 'pong']) assert.ok(types.has(tt), `covered ${tt}`);
});
