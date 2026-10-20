// 계약 테스트(P0): 클라우드 relay-v2 스키마(siot-cloud/packages/protocol)로 프레임 fixture 를 검증한다.
// 스키마가 바뀌어 에이전트 쪽 가정과 어긋나면 여기서 먼저 깨진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const protocolDir = fileURLToPath(new URL('../../../siot-cloud/packages/protocol/', import.meta.url));
const load = (p) => JSON.parse(readFileSync(join(protocolDir, p), 'utf8'));
const relay = load('schema/relay-v2.json');

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addKeyword('x-direction');
ajv.addSchema(load('schema/siot-device.json'));
ajv.addSchema(relay);
const any = ajv.getSchema(relay.$id);
const s2g = ajv.getSchema(`${relay.$id}#/$defs/ServerToGateway`);
const g2s = ajv.getSchema(`${relay.$id}#/$defs/GatewayToServer`);

const fixtureDir = join(protocolDir, 'fixtures/relay-v2');
const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort();
const valid = files.filter((f) => f.startsWith('valid.'));
const invalid = files.filter((f) => f.startsWith('invalid.'));

/** 프레임 t → x-direction (evt 는 oneOf 묶음이라 별도) */
const direction = {};
for (const def of Object.values(relay.$defs)) {
  const t = def.properties?.t?.const;
  if (t && def['x-direction']) direction[t] = def['x-direction'];
}

test('relay-v2: every frame type from §2 b has a direction and a valid fixture', () => {
  const s2gTypes = ['challenge', 'welcome', 'bind', 'cfg', 'ack', 'req', 'ping', 'pong'];
  const g2sTypes = ['hello', 'bound', 'cfg_ack', 'snapshot', 'evt', 'res', 'ping', 'pong'];
  for (const t of s2gTypes) assert.ok(['server_to_gateway', 'both'].includes(direction[t]), `server→gw ${t}`);
  for (const t of g2sTypes) assert.ok(['gateway_to_server', 'both'].includes(direction[t]), `gw→server ${t}`);
  const covered = new Set(valid.map((f) => load(`fixtures/relay-v2/${f}`).t));
  for (const t of new Set([...s2gTypes, ...g2sTypes])) assert.ok(covered.has(t), `fixture for ${t}`);
  const kinds = new Set(valid.map((f) => load(`fixtures/relay-v2/${f}`)).filter((fr) => fr.t === 'evt').map((fr) => fr.kind));
  assert.deepEqual([...kinds].sort(), [...relay.$defs.EvtKind.enum].sort(), 'fixture for every evt.kind');
  assert.ok(invalid.length >= 2);
});

for (const f of valid) {
  test(`relay-v2 valid: ${f}`, () => {
    const frame = load(`fixtures/relay-v2/${f}`);
    assert.ok(any(frame), JSON.stringify(any.errors));
    const dir = direction[frame.t];
    if (dir === 'server_to_gateway' || dir === 'both') assert.ok(s2g(frame), `server→gw ${JSON.stringify(s2g.errors)}`);
    if (dir === 'gateway_to_server' || dir === 'both') assert.ok(g2s(frame), `gw→server ${JSON.stringify(g2s.errors)}`);
    if (dir === 'server_to_gateway') assert.equal(g2s(frame), false, 'server→gw frame must not validate as gw→server');
    if (dir === 'gateway_to_server') assert.equal(s2g(frame), false, 'gw→server frame must not validate as server→gw');
  });
}

for (const f of invalid) {
  test(`relay-v2 invalid: ${f}`, () => {
    assert.equal(any(load(`fixtures/relay-v2/${f}`)), false);
  });
}

test('relay-v2: snapshot devices accept toSiotDevices() output shape', async () => {
  const { normalizeNode } = await import('../src/model/normalize.js');
  const { toSiotDevices } = await import('../src/platform/siotMapper.js');
  const node = { node_id: 5, available: true, attributes: { '0/40/1': 'IKEA of Sweden', '0/40/3': 'GRILLPLATS Plug', '1/29/0': [{ '0': 266, '1': 3 }], '1/6/0': true } };
  const devices = toSiotDevices(normalizeNode(node));
  const frame = { t: 'snapshot', bootId: '0b7d2f3e-8c1a-4e5b-9f6d-2a3c4b5d6e7f', seq: 0, keyVersion: 0, gateway: { gatewayId: 'gw_739f694e-76be-5888-be41-639544c21b5b', agentVersion: '0.2.0', engineOnline: true, deviceCount: devices.length }, devices: JSON.parse(JSON.stringify(devices)) };
  assert.ok(g2s(frame), JSON.stringify(g2s.errors));
});
