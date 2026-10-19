// 페어링 재시도: BLE 링크 계층의 일시적 실패(Pi 5 BT ↔ IKEA 기기에서 관측)는 재시도하고, 영구 실패는 즉시 포기한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PairingManager, isTransientCommissionError } from '../src/pairing.js';
import { DeviceRegistry } from '../src/model/registry.js';

const node = { node_id: 7, available: true, attributes: { '1/29/0': [{ deviceType: 266, revision: 3 }], '1/6/0': false } };
const BLE_ERR = 'matter error 1: Commission failed: discovery of node with discriminator 1671 failed: No device could be commissioned (1 of 1 started attempt(s) failed, 1 discovered)';

function fake(script) {
  let i = 0;
  return { serverInfo: { thread_credentials_set: true }, calls: 0,
    async commissionWithCode() { this.calls++; const s = script[Math.min(i++, script.length - 1)]; if (s instanceof Error) throw s; return s; } };
}
const stages = (pm) => { const out = []; pm.on('progress', (p) => out.push(p)); return out; };

test('transient vs permanent classification', () => {
  assert.equal(isTransientCommissionError(new Error(BLE_ERR)), true);
  assert.equal(isTransientCommissionError(new Error('[ble] Error while connecting to peripheral C5:04:2B:FA:A0:41')), true);
  assert.equal(isTransientCommissionError(new Error('Caused by: le-connection-abort-by-local')), true);
  assert.equal(isTransientCommissionError(new Error('matter error 1: Commission failed: Operation aborted')), true);
  assert.equal(isTransientCommissionError(new Error('[ble-channel-closed] BLE transport closed on @0:0•7996(ble)')), true);
  assert.equal(isTransientCommissionError(new Error('discovery failed: No commissionable device was discovered')), false);
  assert.equal(isTransientCommissionError(new Error('Attestation rejected: test cert')), false);
  assert.equal(isTransientCommissionError(new Error('no device found')), false);
});

test('BLE connect failure is retried and succeeds on 2nd attempt; events carry attempt', async () => {
  const m = fake([new Error(BLE_ERR), node]);
  const pm = new PairingManager(m, new DeviceRegistry(), { maxAttempts: 3, retryDelayMs: 0 });
  const ev = stages(pm);
  const device = await pm.start({ sessionId: 's1', code: 'MT:X' });
  assert.equal(device.id, 'matter:7'); assert.equal(m.calls, 2);
  const comm = ev.filter((e) => e.stage === 'commissioning');
  assert.deepEqual(comm.map((e) => e.attempt), [1, 2]); assert.equal(comm[1].maxAttempts, 3); assert.match(comm[1].lastError, /1 discovered/);
  assert.deepEqual(ev.map((e) => e.stage), ['commissioning', 'commissioning', 'interviewing', 'done']);
  assert.equal(pm.active, null);
});

test('gives up after maxAttempts transient failures', async () => {
  const m = fake([new Error(BLE_ERR)]);
  const pm = new PairingManager(m, new DeviceRegistry(), { maxAttempts: 3, retryDelayMs: 0 });
  const ev = stages(pm);
  await assert.rejects(pm.start({ sessionId: 's2', code: 'MT:X' }), /1 discovered/);
  assert.equal(m.calls, 3); assert.equal(ev.at(-1).stage, 'failed');
});

test('permanent failure is not retried', async () => {
  const m = fake([new Error('discovery failed: No commissionable device was discovered')]);
  const pm = new PairingManager(m, new DeviceRegistry(), { maxAttempts: 3, retryDelayMs: 0 });
  await assert.rejects(pm.start({ sessionId: 's3', code: 'MT:X' }), /No commissionable/);
  assert.equal(m.calls, 1);
});

test('PAIRING_MAX_ATTEMPTS env is honoured', () => {
  process.env.PAIRING_MAX_ATTEMPTS = '5';
  try { assert.equal(new PairingManager(fake([node]), new DeviceRegistry()).maxAttempts, 5); } finally { delete process.env.PAIRING_MAX_ATTEMPTS; }
});
