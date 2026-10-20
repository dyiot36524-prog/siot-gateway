// sim 백엔드 · siteConfig · health.json · 장치 키 · registry/pairing → relay evt 형태(스키마) 테스트
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatterSim } from '../src/matterSim.js';
import { SiteConfig } from '../src/site/siteConfig.js';
import { writeHealth, startHealthWriter } from '../src/health.js';
import { GatewayStore } from '../src/platform/store.js';
import { Identity } from '../src/platform/identity.js';
import { DeviceRegistry } from '../src/model/registry.js';
import { PairingManager } from '../src/pairing.js';
import { EventRing } from '../src/platform/relay.js';
import { wireRelayEvents } from '../src/platform/relayEvents.js';

let dir;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'siot-parts-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

test('MatterSim: initial nodes, OnOff commands, door toggle (manual and timer), commissioning outcomes', async () => {
  const sim = new MatterSim({ doorToggleMs: 20 });
  const reg = new DeviceRegistry();
  sim.on('attribute_updated', ([n, p, v]) => reg.applyAttribute(n, p, v));
  const nodes = await sim.startListening();
  assert.deepEqual(nodes.map((n) => n.node_id), [1, 2]);
  for (const n of nodes) reg.upsertNode(n);
  const states = []; reg.on('state', (c) => states.push(c));
  await sim.deviceCommand(1, 1, 6, 'On'); await sim.deviceCommand(1, 1, 6, 'Toggle');
  assert.equal(sim.nodes.get(1).attributes['1/6/0'], false);
  const r = sim.toggleDoor(); assert.equal(r.nodeId, 2); assert.equal(r.closed, false);
  await new Promise((x) => setTimeout(x, 70));
  sim.close();
  const doorChanges = states.filter((c) => c.deviceId === 'matter:2');
  assert.ok(doorChanges.length >= 3, `door toggled by timer (${doorChanges.length})`);
  await assert.rejects(sim.commissionWithCode('MT:FAIL'), /no device found/);
  await assert.rejects(sim.commissionWithCode('MT:THREAD'), /thread dataset not set/);
  const added = await sim.commissionWithCode('MT:OK');
  assert.equal(added.node_id, 3); assert.equal(sim.serverInfo.backend, 'sim');
});

test('SiteConfig: stores cfg (0600), acks versions, ignores older cfg, survives reload', async () => {
  const sc = new SiteConfig(dir);
  await sc.load();
  assert.deepEqual(sc.ack(), { cfgVersion: 0, keyVersion: 0, rulesVersion: 0 });
  const ack = await sc.apply({ t: 'cfg', cfgVersion: 4, siteId: 's1', keys: [{ v: 1, key: 'x' }, { v: 2, key: 'y' }], peers: [], rules: { version: 7, rules: [] } });
  assert.deepEqual(ack, { cfgVersion: 4, keyVersion: 2, rulesVersion: 7 });
  assert.equal((await stat(path.join(dir, 'site.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await sc.apply({ cfgVersion: 3, keys: [], rules: { version: 1 } }), { cfgVersion: 4, keyVersion: 2, rulesVersion: 7 });
  const again = new SiteConfig(dir); await again.load();
  assert.deepEqual(again.ack(), { cfgVersion: 4, keyVersion: 2, rulesVersion: 7 });
  assert.equal('t' in JSON.parse(await readFile(path.join(dir, 'site.json'), 'utf8')), false);
  await assert.rejects(sc.apply({ cfgVersion: 'x' }), /invalid cfgVersion/);
});

test('health.json: exact shape, atomic write (no tmp left), periodic writer', async () => {
  const hdir = path.join(dir, 'state', 'health');
  const body = await writeHealth(hdir, { bootId: 'b1', version: '1.0.0', engineOnline: 1, deviceCount: '3', relay: { connected: true }, extra: 'no' });
  assert.deepEqual(Object.keys(body), ['bootId', 'version', 'engineOnline', 'deviceCount', 'relay', 'writtenAt']);
  const onDisk = JSON.parse(await readFile(path.join(hdir, 'health.json'), 'utf8'));
  assert.equal(onDisk.engineOnline, true); assert.equal(onDisk.deviceCount, 3); assert.deepEqual(onDisk.relay, { connected: true });
  assert.ok(!Number.isNaN(Date.parse(onDisk.writtenAt)));
  let n = 0;
  const stop = startHealthWriter(hdir, () => ({ bootId: 'b2', version: '1.0.0', engineOnline: false, deviceCount: ++n, relay: { connected: false } }), 20);
  await new Promise((x) => setTimeout(x, 70)); stop();
  const last = JSON.parse(await readFile(path.join(hdir, 'health.json'), 'utf8'));
  assert.equal(last.bootId, 'b2'); assert.ok(last.deviceCount >= 2);
  assert.deepEqual((await readdir(hdir)).filter((f) => f !== 'health.json'), []);
});

test('device key: Ed25519 kept in gateway.json (0600), stable across restarts, regenerated on SSD clone', async () => {
  const kdir = path.join(dir, 'key');
  const serial = path.join(dir, 'serial');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(serial, 'serial-A');
  process.env.SIOT_SERIAL_FILE = serial;
  delete process.env.SIOT_GATEWAY_ID;
  try {
    const store = new GatewayStore(kdir);
    const k1 = await new Identity(store).deviceKey();
    assert.match(k1.publicKey, /^[A-Za-z0-9_-]{43}$/);
    assert.match(k1.sign('nonce'), /^[A-Za-z0-9_-]{86}$/);
    assert.equal((await stat(path.join(kdir, 'gateway.json'))).mode & 0o777, 0o600);
    assert.equal((await new Identity(store).deviceKey()).publicKey, k1.publicKey, 'same key after restart');
    await store.save({ gatewayToken: 'tok' });
    await writeFile(serial, 'serial-B');   // SSD 를 다른 Pi 에 꽂음
    const id2 = new Identity(store);
    const k2 = await id2.deviceKey();
    assert.notEqual(k2.publicKey, k1.publicKey, 'clone → new key');
    const s = await store.load(); assert.equal(s.gatewayToken, null); assert.equal(s.deviceKey.publicKey, k2.publicKey);
  } finally { delete process.env.SIOT_SERIAL_FILE; }
});

// ---- registry/pairing → evt, relay-v2 스키마 검증(스키마 없으면 형태만) ----
const protocolDir = fileURLToPath(new URL('../../../siot-cloud/packages/protocol/', import.meta.url));
async function loadG2S() {
  if (!existsSync(path.join(protocolDir, 'schema/relay-v2.json'))) return null;
  try {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const load = (p) => JSON.parse(readFileSync(path.join(protocolDir, p), 'utf8'));
    const relay = load('schema/relay-v2.json');
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    addFormats(ajv); ajv.addKeyword('x-direction');
    ajv.addSchema(load('schema/siot-device.json')); ajv.addSchema(relay);
    return ajv.getSchema(`${relay.$id}#/$defs/GatewayToServer`);
  } catch { return null; }
}

test('registry + pairing events become device / device_removed / pairing evt frames', async () => {
  const ring = new EventRing('8a1f0b2c-1111-4222-8333-944445555666');
  const registry = new DeviceRegistry();
  const sim = new MatterSim();
  const pairing = new PairingManager(sim, registry, { retryDelayMs: 0, maxAttempts: 1 });
  wireRelayEvents({ registry, pairing, publish: (kind, data) => ring.push({ kind, data, keyVersion: 1 }) });
  for (const n of await sim.startListening()) registry.upsertNode(n);
  registry.applyAttribute(2, '1/69/0', false);
  await pairing.start({ sessionId: 'p1', code: 'MT:OK' });
  await assert.rejects(pairing.start({ sessionId: 'p2', code: 'MT:FAIL' }));
  registry.removeNode(3);
  const evts = ring.unacked();
  const kinds = evts.map((e) => e.kind);
  for (const k of ['device', 'device_removed', 'pairing']) assert.ok(kinds.includes(k), k);
  const removed = evts.find((e) => e.kind === 'device_removed');
  assert.deepEqual(removed.data, { deviceId: 'matter:3', ids: ['matter:3:1'] });
  const failed = evts.find((e) => e.kind === 'pairing' && e.data.stage === 'failed');
  assert.equal(failed.data.errorCode, 'DEVICE_NOT_FOUND');
  const done = evts.find((e) => e.kind === 'pairing' && e.data.stage === 'done');
  assert.equal(done.data.devices[0].id, 'matter:3:1');
  const commissioning = evts.find((e) => e.kind === 'pairing' && e.data.stage === 'commissioning');
  assert.equal(commissioning.data.attempt, 1); assert.equal(commissioning.data.maxAttempts, 1);
  const doorEvt = evts.filter((e) => e.kind === 'device').at(-1);
  assert.ok(doorEvt.data.devices.length >= 1);
  registry.removeNode(99);   // 모르는 노드 제거는 evt 없음(ids 필수)
  assert.equal(ring.unacked().length, evts.length);
  const g2s = await loadG2S();
  if (!g2s) return;
  for (const e of evts) assert.ok(g2s(e), `${e.kind}/${e.data.stage ?? ''}: ${JSON.stringify(g2s.errors)}`);
  assert.ok(g2s({ ...evts[0], replayed: true }));
});
