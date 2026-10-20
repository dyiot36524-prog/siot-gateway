// 페어링 재시도: BLE 링크 계층의 일시적 실패(Pi 5 BT ↔ IKEA 기기에서 관측)는 재시도하고, 영구 실패는 즉시 포기한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PairingManager, isTransientCommissionError, classifyCommissionError, finalErrorCode, PAIRING_ERROR_CODES } from '../src/pairing.js';
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

// 분류기(계획 E2): pairing.js 의 TRANSIENT/PERMANENT 전 패턴을 덮는다
test('classifyCommissionError covers every transient and permanent pattern', () => {
  const cases = [
    // BLE 일시(TRANSIENT_PATTERNS 10개)
    ['[ble] Error while connecting to peripheral C5:04:2B:FA:A0:41', 'BLE_TRANSIENT'],
    ['Failed to connect to peripheral AA:BB', 'BLE_TRANSIENT'],
    ['peripheral in unexpected state "error"', 'BLE_TRANSIENT'],
    ['Caused by: le-connection-abort-by-local', 'BLE_TRANSIENT'],
    ['HCI: Connection Failed to be Established (0x3e)', 'BLE_TRANSIENT'],
    ['Timeout while connecting', 'BLE_TRANSIENT'], ['Timeout while interviewing', 'BLE_TRANSIENT'], ['Timeout while disconnecting', 'BLE_TRANSIENT'],
    ['peripheral disconnected while trying to connect', 'BLE_TRANSIENT'],
    [BLE_ERR, 'BLE_TRANSIENT'],
    ['[ble-channel-closed] BLE transport closed on @0:0•7996(ble)', 'BLE_TRANSIENT'],
    ['matter error 1: Commission failed: Operation aborted', 'BLE_TRANSIENT'],
    // 영구(PERMANENT_PATTERNS 5개)
    ['discovery failed: No commissionable device was discovered', 'DEVICE_NOT_FOUND'],
    ['invalid arguments', 'CODE_INVALID'], ['invalid pairing code', 'CODE_INVALID'], ['invalid passcode', 'CODE_INVALID'], ['invalid QR', 'CODE_INVALID'],
    ['Attestation rejected: test cert', 'ATTESTATION_REJECTED'],
    ['PASE failed: passcode mismatch', 'CODE_INVALID'], ['PASE invalid', 'CODE_INVALID'], ['PASE wrong verifier', 'CODE_INVALID'],
    ['thread dataset not set (run: cli dataset <hex>)', 'THREAD_NOT_READY'],
    // 추가
    ['no device found', 'DEVICE_NOT_FOUND'],
    ['No device could be commissioned (1 of 1 started attempt(s) failed, 0 discovered)', 'DEVICE_NOT_FOUND'],
    ['Unable to parse pairing code', 'CODE_INVALID'],
    ['something else entirely', 'UNKNOWN'], ['', 'UNKNOWN'],
  ];
  for (const [msg, code] of cases) assert.equal(classifyCommissionError(new Error(msg)), code, msg);
  assert.equal(classifyCommissionError('Attestation rejected'), 'ATTESTATION_REJECTED');   // 문자열도 허용
  assert.equal(classifyCommissionError(null), 'UNKNOWN');
  for (const [, code] of cases) assert.ok(PAIRING_ERROR_CODES.includes(code));
  // 세션 최종 코드: BLE 재시도 소진은 "기기 안 잡힘"
  assert.equal(finalErrorCode(new Error(BLE_ERR)), 'DEVICE_NOT_FOUND');
  assert.equal(finalErrorCode(new Error('Attestation rejected')), 'ATTESTATION_REJECTED');
});

test('failed progress carries errorCode; retry progress carries lastErrorCode', async () => {
  const m = fake([new Error(BLE_ERR)]);
  const pm = new PairingManager(m, new DeviceRegistry(), { maxAttempts: 2, retryDelayMs: 0 });
  const ev = stages(pm);
  await assert.rejects(pm.start({ sessionId: 's5', code: 'MT:X' }));
  assert.equal(ev.find((e) => e.attempt === 2).lastErrorCode, 'BLE_TRANSIENT');
  assert.equal(ev.at(-1).stage, 'failed'); assert.equal(ev.at(-1).errorCode, 'DEVICE_NOT_FOUND');
  const pm2 = new PairingManager({ serverInfo: { thread_credentials_set: false } }, new DeviceRegistry());
  const ev2 = stages(pm2);
  await assert.rejects(pm2.start({ sessionId: 's6', code: 'MT:X' }));
  assert.equal(ev2.at(-1).errorCode, 'THREAD_NOT_READY');
});
