// 실기기 스냅샷(IKEA GRILLPLATS, 2026-10-20 커미셔닝) 기반: ep1=On/Off Plug(0x010A), ep2=Electrical Sensor(0x0510)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNode } from '../src/model/normalize.js';
import { DeviceRegistry } from '../src/model/registry.js';
import { toSiotDevices } from '../src/platform/siotMapper.js';

const grillplats = {
  node_id: 5, available: true, date_commissioned: '2026-10-20T00:35:21.617000',
  attributes: {
    '0/29/0': [{ '0': 22, '1': 4 }], '0/40/1': 'IKEA of Sweden', '0/40/2': 4476, '0/40/3': 'GRILLPLATS Plug', '0/40/4': 4096, '0/40/5': '', '0/40/10': '1.4.6',
    '1/29/0': [{ '0': 266, '1': 3 }], '1/29/1': [3, 4, 6, 29], '1/6/0': false, '1/6/16384': true,
    '2/29/0': [{ '0': 1296, '1': 1 }], '2/29/1': [29, 144, 145, 156],
    '2/144/4': 230000, '2/144/5': 0, '2/144/8': 0, '2/144/14': 60,
    '2/145/1': { '0': 0, '4': 61264 }, '2/145/5': { '0': 0, '1': 0, '2': 0, '3': 0 },
  },
};

test('GRILLPLATS: electrical-sensor endpoint folds into the PLUG device', () => {
  const d = normalizeNode(grillplats);
  assert.deepEqual(d.endpoints[2].kinds, ['electrical_sensor']);
  assert.equal(d.endpoints[2].capabilities.power.watts, 0);
  assert.equal(d.endpoints[2].capabilities.power.volts, 230);
  assert.equal(d.endpoints[2].capabilities.energy.kwh, 0);
  const sd = toSiotDevices(d);
  assert.equal(sd.length, 1, 'no separate empty SENSOR for endpoint 2');
  assert.equal(sd[0].id, 'matter:5:1'); assert.equal(sd[0].deviceType, 'PLUG'); assert.equal(sd[0].name, 'GRILLPLATS Plug');
  assert.deepEqual(sd[0].data, { switch: false, power: 0, energy: 0 });
  assert.deepEqual(sd[0].endpointIds, [1, 2]);
  assert.equal(JSON.stringify(sd[0]).includes('endpointIds'), false, 'endpointIds is not serialized');
});

test('GRILLPLATS: power update on endpoint 2 is reflected in the plug device', () => {
  const r = new DeviceRegistry(); r.upsertNode(grillplats);
  const change = r.applyAttribute(5, '2/144/8', 12500);
  assert.equal(change.endpoint, 2); assert.equal(change.capability, 'power');
  const sd = toSiotDevices(r.get('matter:5'));
  assert.equal(sd[0].data.power, 12.5);
  assert.ok(sd[0].endpointIds.includes(change.endpoint));
});

test('standalone electrical sensor (no on/off sibling) stays a SENSOR with power value', () => {
  const d = normalizeNode({ node_id: 9, available: true, attributes: { '1/29/0': [{ '0': 1296, '1': 1 }], '1/144/8': 1500, '1/145/1': { '0': 3000000 } } });
  const sd = toSiotDevices(d);
  assert.equal(sd.length, 1); assert.equal(sd[0].deviceType, 'SENSOR');
  assert.deepEqual(sd[0].data, { value: 1.5, unit: 'W', measurement: 'power', energy: 3 });
});

// 실기기 스냅샷(IKEA MYGGBETT, 2026-10-20): ep0 에 PowerSource(배터리 200=100%), ep1 Contact Sensor(0x0015) BooleanState
const myggbett = {
  node_id: 6, available: true,
  attributes: {
    '0/29/0': [{ '0': 18, '1': 1 }, { '0': 17, '1': 1 }, { '0': 22, '1': 2 }],
    '0/40/1': 'IKEA of Sweden', '0/40/2': 4476, '0/40/3': 'MYGGBETT door/window sensor', '0/40/4': 32775, '0/40/10': '1.0.9',
    '0/47/0': 1, '0/47/2': 'Primary Battery', '0/47/11': 1588, '0/47/12': 200, '0/47/14': 0, '0/47/15': false,
    '1/29/0': [{ '0': 21, '1': 1 }], '1/69/0': false,
  },
};

test('MYGGBETT: root-endpoint battery is folded into the contact sensor device', () => {
  const r = new DeviceRegistry(); r.upsertNode(myggbett);
  let sd = toSiotDevices(r.get('matter:6'));
  assert.equal(sd.length, 1); assert.equal(sd[0].id, 'matter:6:1'); assert.equal(sd[0].deviceType, 'BINARY_SENSOR');
  assert.deepEqual(sd[0].data, { active: true, measurement: 'door', battery: 100, batteryLow: false });
  assert.deepEqual(sd[0].endpointIds, [1, 0]);
  // 배터리 변화(ep0) 도 기기 이벤트로 흘러야 함
  const c = r.applyAttribute(6, '0/47/12', 120);
  assert.ok(sd[0].endpointIds.includes(c.endpoint));
  sd = toSiotDevices(r.get('matter:6')); assert.equal(sd[0].data.battery, 60);
  // 문 닫힘: BooleanState true → active=false
  r.applyAttribute(6, '1/69/0', true); assert.equal(toSiotDevices(r.get('matter:6'))[0].data.active, false);
});
