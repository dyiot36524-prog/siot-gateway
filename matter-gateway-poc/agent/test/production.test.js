// 출고 모드(SIOT_MODE=production, 기본) 서버 구성 테스트 — 계획 B7 / openapi 2.0 보안 예외 3건.
//  LAN 3000: healthz + 축소 /api/gateway + 상태 페이지만, 나머지 404
//  loopback 3001: 전체 v1 API, Bearer 헤더만(쿼리 토큰 401), claim/register 없음
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GatewayStore } from '../src/platform/store.js';
import { Identity } from '../src/platform/identity.js';
import { PlatformServer } from '../src/platform/server.js';
import { DeviceRegistry } from '../src/model/registry.js';
import { PairingManager } from '../src/pairing.js';
import { MatterSim } from '../src/matterSim.js';
import { executeCommand } from '../src/commands.js';

const GW = 'gw_0f0d0001-aaaa-bbbb-cccc-ddddeeeeffff';
const TOKEN = 'a'.repeat(64);
let dir, server, lan, admin, store, matter, registry;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'siot-prod-'));
  process.env.SIOT_GATEWAY_ID = GW;
  store = new GatewayStore(dir);
  const identity = new Identity(store);
  registry = new DeviceRegistry();
  matter = new MatterSim();
  matter.on('attribute_updated', ([n, p, v]) => registry.applyAttribute(n, p, v));
  for (const n of await matter.startListening()) registry.upsertNode(n);
  const pairing = new PairingManager(matter, registry, { retryDelayMs: 0 });
  server = new PlatformServer({ store, identity, registry, execute: (c) => executeCommand(matter, registry, c), pairing, matter, opts: { port: 0, adminPort: 0, lanHost: '127.0.0.1', version: '2.0.0' } });
  await server.listen();
  lan = `http://127.0.0.1:${server.server.address().port}`;
  admin = `http://127.0.0.1:${server.adminServer.address().port}`;
});
after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); delete process.env.SIOT_GATEWAY_ID; });

const j = (url, opt) => fetch(url, opt).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

test('production is the default mode and the admin API binds to loopback only', () => {
  assert.equal(server.mode, 'production');
  assert.equal(server.adminServer.address().address, '127.0.0.1');
});

test('LAN: healthz and reduced /api/gateway {gatewayId, shortId, bound, version, pubKey}', async () => {
  assert.deepEqual((await j(lan + '/healthz')).body, { ok: true });
  const g = await j(lan + '/api/gateway');
  assert.equal(g.status, 200);
  assert.deepEqual(Object.keys(g.body).sort(), ['bound', 'gatewayId', 'ok', 'pubKey', 'shortId', 'version']);
  assert.equal(g.body.gatewayId, GW); assert.equal(g.body.shortId, GW.slice(3, 11)); assert.equal(g.body.bound, false); assert.equal(g.body.version, '2.0.0');
  assert.match(g.body.pubKey, /^[A-Za-z0-9_-]{43}$/);
  const page = await fetch(lan + '/'); const html = await page.text();
  assert.equal(page.status, 200); assert.ok(html.includes('/status.js')); assert.ok(!html.includes('btnRegister')); assert.ok(!html.includes('btnPair'));
  const js = await (await fetch(lan + '/status.js')).text();
  for (const banned of ['/api/register', '/api/pairing', '/api/devices', '/api/stream', 'EventSource']) assert.ok(!js.includes(banned), `status page must not call ${banned}`);
});

test('LAN: everything else is 404 (register, local devices/pairing/control/stream, v1 API, claim, dev page script)', async () => {
  for (const [m, p] of [['POST', '/api/register'], ['GET', '/api/devices'], ['GET', '/api/system'], ['POST', '/api/pairing'], ['GET', '/api/stream'],
    ['POST', '/api/devices/matter:1:1/control'], ['GET', '/siot-app/api/v1/devices'], ['POST', '/siot-app/api/v1/claim'], ['GET', '/app.js'], ['GET', `/siot-app/api/v1/devices?token=${TOKEN}`]]) {
    const r = await fetch(lan + p, { method: m, headers: bearer, body: m === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
});

test('admin 3001: unbound → 401, claim/register 404', async () => {
  assert.equal((await j(admin + '/siot-app/api/v1/devices', { headers: bearer })).status, 401);
  assert.equal((await j(admin + '/siot-app/api/v1/claim', { method: 'POST', headers: bearer, body: '{"registrationCode":"AAAAAAAA"}' })).status, 404);
  assert.equal((await j(admin + '/api/register', { method: 'POST' })).status, 404);
  assert.equal((await j(admin + '/healthz')).status, 200);
});

test('admin 3001: Bearer works, ?token= is 401 even with the right token', async () => {
  await store.save({ gatewayToken: TOKEN });
  let r = await j(admin + '/siot-app/api/v1/devices', { headers: bearer });
  assert.equal(r.status, 200); assert.equal(r.body.count, 2); assert.equal(r.body.gatewayId, GW);
  r = await j(`${admin}/siot-app/api/v1/devices?token=${TOKEN}`);
  assert.equal(r.status, 401); assert.match(r.body.error, /쿼리 토큰/);
  r = await j(`${admin}/siot-app/api/v1/events?token=${TOKEN}`);
  assert.equal(r.status, 401);
  r = await j(admin + '/siot-app/api/v1/devices', { headers: { authorization: 'Bearer ' + 'b'.repeat(64) } });
  assert.equal(r.status, 401);
  assert.equal((await j(lan + '/api/gateway')).body.bound, true);
});

test('admin 3001: control, pairing with errorCode, sim door toggle', async () => {
  let r = await j(admin + '/siot-app/api/v1/devices/matter:1:1/control', { method: 'POST', headers: bearer, body: JSON.stringify({ action: 'ON' }) });
  assert.equal(r.status, 200); assert.equal(matter.commands.at(-1).name, 'On');
  assert.equal(registry.get('matter:1').endpoints[1].capabilities.onoff.on, true);
  r = await j(admin + '/siot-app/api/v1/pairing', { method: 'POST', headers: bearer, body: JSON.stringify({ code: 'MT:THREAD' }) });
  assert.equal(r.status, 202);
  const sid = r.body.session.sessionId;
  for (let i = 0; i < 50; i++) { r = await j(`${admin}/siot-app/api/v1/pairing/${sid}`, { headers: bearer }); if (['done', 'failed'].includes(r.body.session.stage)) break; await new Promise((x) => setTimeout(x, 20)); }
  assert.equal(r.body.session.stage, 'failed'); assert.equal(r.body.session.errorCode, 'THREAD_NOT_READY');
  assert.equal(r.body.session.events.at(-1).errorCode, 'THREAD_NOT_READY');
  const before = registry.get('matter:2').endpoints[1].capabilities;
  const was = JSON.stringify(before);
  r = await j(admin + '/siot-app/api/v1/sim/door', { method: 'POST', headers: bearer, body: '{}' });
  assert.equal(r.status, 200); assert.equal(r.body.nodeId, 2);
  assert.notEqual(JSON.stringify(registry.get('matter:2').endpoints[1].capabilities), was);
});
