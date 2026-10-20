// 플랫폼 API 계약 테스트 — siot-app 의 응답 형태와 claim/인증 흐름을 가짜 Matter 백엔드로 검증.
// SIOT_MODE=dev(기존 단일 서버) 고정. 출고 모드는 production.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GatewayStore } from '../src/platform/store.js';
import { Identity, uuidv5, deriveGatewayId, shouldReprovision, SIOT_NAMESPACE } from '../src/platform/identity.js';
import { PlatformServer } from '../src/platform/server.js';
import { DeviceRegistry } from '../src/model/registry.js';
import { PairingManager } from '../src/pairing.js';
import { toSiotDevices, resolveAction, parseSiotId } from '../src/platform/siotMapper.js';
import { isCodeValid } from '../src/platform/registration.js';
import { MatterSim, SIM_PLUG, SIM_DOOR } from '../src/matterSim.js';

const plugNode = SIM_PLUG;
const sensorNode = SIM_DOOR;

let dir, server, base, store, matter, registry;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'siot-'));
  process.env.SIOT_SERIAL_FILE = path.join(dir, 'nope'); process.env.SIOT_MACHINE_ID_FILE = path.join(dir, 'nope');
  process.env.SIOT_GATEWAY_ID = 'gw_test00001234-aaaa-bbbb-cccc-ddddeeeeffff';
  store = new GatewayStore(dir);
  const identity = new Identity(store);
  registry = new DeviceRegistry();
  matter = new MatterSim();
  const pairing = new PairingManager(matter, registry);
  const execute = async (cmd) => { const d = registry.get(cmd.deviceId); await matter.deviceCommand(d.nodeId, cmd.endpoint, 6, cmd.action === 'on' ? 'On' : cmd.action === 'off' ? 'Off' : 'Toggle', {}); };
  server = new PlatformServer({ store, identity, registry, execute, pairing, matter, opts: { mode: 'dev', port: 0, version: '9.9.9' } });
  await new Promise((r) => server.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.server.address().port}`;
  registry.upsertNode(plugNode); registry.upsertNode(sensorNode);
});
after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); delete process.env.SIOT_GATEWAY_ID; });

const j = (p, opt) => fetch(base + p, opt).then(async (r) => ({ status: r.status, body: await r.json() }));

test('uuidv5 matches RFC 4122 test vector and gatewayId derivation', () => {
  // RFC 4122 / uuid 패키지 알려진 값: v5(DNS namespace, "www.example.com")
  assert.equal(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  assert.match(deriveGatewayId('10000000abcdef01'), /^gw_[0-9a-f-]{36}$/);
  assert.equal(deriveGatewayId('serial-A'), deriveGatewayId('serial-A'));
  assert.notEqual(deriveGatewayId('serial-A'), deriveGatewayId('serial-B'));
  assert.equal(deriveGatewayId('x').startsWith('gw_'), true);
  assert.equal(shouldReprovision('a', 'b'), true); assert.equal(shouldReprovision(null, 'b'), false); assert.equal(shouldReprovision('a', 'a'), false);
  assert.equal(SIOT_NAMESPACE, '6f1d2c9e-7a3b-5c4d-8e2f-1a2b3c4d5e6f');
});

test('registration code validity', () => {
  assert.equal(isCodeValid('A', '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), true);
  assert.equal(isCodeValid('A', '2020-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), false);
  assert.equal(isCodeValid(null, '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), false);
});

test('mapper: plug → PLUG with switch/power, contact → BINARY_SENSOR with active/battery', () => {
  const plug = toSiotDevices(registry.get('matter:1'));
  assert.equal(plug.length, 1); assert.equal(plug[0].id, 'matter:1:1'); assert.equal(plug[0].deviceType, 'PLUG');
  assert.deepEqual(plug[0].data, { switch: false, power: 12.5 }); assert.equal(plug[0].name, 'GRILLPLATS');
  const s = toSiotDevices(registry.get('matter:2'))[0];
  assert.equal(s.deviceType, 'BINARY_SENSOR'); assert.equal(s.data.active, false); assert.equal(s.data.battery, 90); assert.equal(s.data.measurement, 'door');
  assert.deepEqual(parseSiotId('matter:12:1'), { deviceId: 'matter:12', endpoint: 1 });
  assert.equal(resolveAction('plug_on').action, 'on'); assert.equal(resolveAction('nope'), null);
});

test('platform API rejects unauthenticated calls before and after claim', async () => {
  let r = await j('/siot-app/api/v1/devices'); assert.equal(r.status, 401); assert.equal(r.body.ok, false);
  r = await j('/siot-app/api/v1/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ registrationCode: 'WRONG' }) });
  assert.equal(r.status, 400);
});

let token;
test('local register → platform claim → token works (Bearer and ?token=)', async () => {
  let r = await j('/api/gateway'); assert.equal(r.body.registered, false); assert.equal(r.body.gatewayId, process.env.SIOT_GATEWAY_ID);
  r = await j('/api/register', { method: 'POST' }); assert.equal(r.status, 200); assert.match(r.body.registrationCode, /^[0-9A-F]{8}$/);
  const code = r.body.registrationCode;
  r = await j('/siot-app/api/v1/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ registrationCode: code }) });
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.gatewayId, process.env.SIOT_GATEWAY_ID); assert.match(r.body.gatewayToken, /^[0-9a-f]{64}$/);
  token = r.body.gatewayToken;
  // 토큰이 이미 있으면 재claim 불가(409) — 코드 재사용도 여기서 막힌다
  r = await j('/siot-app/api/v1/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ registrationCode: code }) }); assert.equal(r.status, 409); assert.equal(r.body.ok, false);
  r = await j('/siot-app/api/v1/gateway', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200); assert.equal(r.body.apiVersion, 'v1'); assert.equal(r.body.engine.kind, 'matter'); assert.equal(r.body.version, '9.9.9');
  r = await j(`/siot-app/api/v1/system?token=${token}`); assert.equal(r.status, 200); assert.equal(r.body.registered, true); assert.equal(r.body.deviceCount, 2); assert.ok(r.body.startedAt);
  r = await j('/siot-app/api/v1/gateway', { headers: { authorization: 'Bearer ' + 'f'.repeat(64) } }); assert.equal(r.status, 401);
});

test('devices list/detail/control match siot-app shapes', async () => {
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let r = await j('/siot-app/api/v1/devices', { headers: h });
  assert.equal(r.status, 200); assert.equal(r.body.count, 2); assert.equal(r.body.gatewayId, process.env.SIOT_GATEWAY_ID);
  for (const d of r.body.devices) for (const k of ['id', 'name', 'deviceType', 'online', 'data', 'lastUpdated']) assert.ok(k in d, `missing ${k}`);
  r = await j('/siot-app/api/v1/devices/matter:1:1', { headers: h }); assert.equal(r.status, 200); assert.equal(r.body.device.deviceType, 'PLUG');
  r = await j('/siot-app/api/v1/devices/matter:1:1/control', { method: 'POST', headers: h, body: JSON.stringify({ action: 'ON' }) });
  assert.equal(r.status, 200); assert.equal(r.body.action, 'ON'); assert.equal(r.body.service, 'matter.onoff.on'); assert.equal(r.body.device.data.switch, true);
  assert.equal(matter.commands.at(-1).name, 'On');
  r = await j('/siot-app/api/v1/devices/matter:1:1/control', { method: 'POST', headers: h, body: JSON.stringify({ action: 'DANCE' }) });
  assert.equal(r.status, 400); assert.ok(Array.isArray(r.body.supported));
  r = await j('/siot-app/api/v1/devices/nope:9:1/control', { method: 'POST', headers: h, body: JSON.stringify({ action: 'ON' }) }); assert.equal(r.status, 404);
});

test('SSE events stream delivers {type:"device"} on state change', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/siot-app/api/v1/events?token=${token}`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = ''; const first = await reader.read(); buf += dec.decode(first.value); assert.ok(buf.includes(': connected'));
  registry.applyAttribute(2, '1/69/0', false);   // 문 열림
  while (!buf.includes('"type":"device"')) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
  const line = buf.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"device"'));
  const ev = JSON.parse(line.slice(6));
  assert.equal(ev.device.id, 'matter:2:1'); assert.equal(ev.device.data.active, true);
  ctrl.abort();
});

test('pairing session via platform API and local API, commissioning window, remove', async () => {
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let r = await j('/siot-app/api/v1/pairing', { method: 'POST', headers: h, body: JSON.stringify({ code: 'MT:OK' }) });
  assert.equal(r.status, 202); const sid = r.body.session.sessionId;
  for (let i = 0; i < 50; i++) { r = await j(`/siot-app/api/v1/pairing/${sid}`, { headers: h }); if (['done', 'failed'].includes(r.body.session.stage)) break; await new Promise((x) => setTimeout(x, 20)); }
  assert.equal(r.body.session.stage, 'done'); assert.equal(r.body.session.deviceId, 'matter:3'); assert.equal(r.body.session.devices[0].deviceType, 'BINARY_SENSOR');
  r = await j('/siot-app/api/v1/devices', { headers: h }); assert.equal(r.body.count, 3);
  r = await j('/api/pairing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'MT:FAIL' }) });
  assert.equal(r.status, 202);
  for (let i = 0; i < 50; i++) { r = await j(`/api/pairing/${r.body.session.sessionId}`); if (['done', 'failed'].includes(r.body.session.stage)) break; await new Promise((x) => setTimeout(x, 20)); }
  assert.equal(r.body.session.stage, 'failed'); assert.match(r.body.session.error, /no device/); assert.equal(r.body.session.errorCode, 'DEVICE_NOT_FOUND');
  r = await j('/siot-app/api/v1/devices/matter:3:1/commissioning-window', { method: 'POST', headers: h, body: '{}' });
  assert.equal(r.status, 200); assert.equal(r.body.setup_manual_code, '34970112332');
  r = await j('/siot-app/api/v1/devices/matter:3:1', { method: 'DELETE', headers: h }); assert.equal(r.status, 200);
  r = await j('/siot-app/api/v1/devices', { headers: h }); assert.equal(r.body.count, 2);
  r = await j('/api/pairing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'ZIGBEE', code: 'x' }) }); assert.equal(r.status, 400);
});

test('local page and healthz are served', async () => {
  const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.ok((await r.text()).includes('시옷 Matter 게이트웨이'));
  const h = await j('/healthz'); assert.equal(h.body.ok, true);
});
