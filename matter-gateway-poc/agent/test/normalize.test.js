import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNode, attributeToCapability } from '../src/model/normalize.js';
import { DeviceRegistry } from '../src/model/registry.js';

const plugNode = {
  node_id: 1, available: true, date_commissioned: '2026-10-14T00:00:00Z',
  attributes: {
    '0/29/0': [{ deviceType: 22, revision: 1 }],
    '0/40/1': 'IKEA of Sweden', '0/40/2': 4476, '0/40/3': 'GRILLPLATS smart plug', '0/40/10': '1.0.0',
    '1/29/0': [{ deviceType: 266, revision: 3 }],
    '1/6/0': false,
    '1/144/8': 12500,
    '1/145/1': { energy: 2500000 },
  },
};
const sensorNode = {
  node_id: 2, available: true,
  attributes: {
    '0/29/0': [{ '0': 22, '1': 1 }],
    '1/29/0': [{ '0': 21, '1': 1 }],
    '1/69/0': true,
    '1/47/12': 180,
    '1/47/14': 0,
  },
};

test('plug normalizes to onoff/power/energy', () => {
  const d = normalizeNode(plugNode);
  assert.equal(d.id, 'matter:1');
  assert.equal(d.info.vendorName, 'IKEA of Sweden');
  assert.deepEqual(d.endpoints[1].kinds, ['onoff_plug']);
  assert.equal(d.endpoints[1].capabilities.onoff.on, false);
  assert.equal(d.endpoints[1].capabilities.power.watts, 12.5);
  assert.equal(d.endpoints[1].capabilities.energy.kwh, 2.5);
  assert.equal(d.endpoints[0], undefined, 'root endpoint hidden when it has no state');
});

test('contact sensor: BooleanState true means closed', () => {
  const d = normalizeNode(sensorNode);
  assert.deepEqual(d.endpoints[1].kinds, ['contact_sensor']);
  assert.equal(d.endpoints[1].capabilities.contact.open, false);
  assert.equal(d.endpoints[1].capabilities.battery.percent, 90);
  assert.equal(d.endpoints[1].capabilities.battery.low, false);
});

test('registry applies attribute updates and emits state', () => {
  const r = new DeviceRegistry();
  r.upsertNode(sensorNode);
  const seen = [];
  r.on('state', (c) => seen.push(c));
  r.applyAttribute(2, '1/69/0', false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].capability, 'contact');
  assert.equal(seen[0].value, true);
  assert.equal(seen[0].prev, false);
  assert.equal(r.get('matter:2').endpoints[1].capabilities.contact.open, true);
});

test('unknown attributes are ignored', () => {
  assert.equal(attributeToCapability('1/999/0', 1), null);
});
