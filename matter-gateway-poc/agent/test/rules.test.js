// 로컬 규칙 엔진: device 트리거 · schedule(가짜 시계, 분당 1회, 요일, tz) · 시계 게이트 · replace 버전 가드/영속/재로드 · cfg 연결
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RulesEngine, localParts } from '../src/rules.js';
import { onLog } from '../src/log.js';

let dir;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'rules-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const flush = () => new Promise((r) => setImmediate(r));
const PLUG_ON = { type: 'command', deviceId: 'matter:5', endpoint: 1, capability: 'onoff', action: 'on' };
const PLUG_OFF = { ...PLUG_ON, action: 'off' };

function makeEngine(opts = {}) {
  const registry = new EventEmitter();
  const devices = { 'matter:5': { endpoints: { 1: { id: 1, capabilities: { onoff: { on: false } } } } } };
  registry.get = (id) => devices[id];
  const calls = [];
  const eng = new RulesEngine(registry, async (a) => { calls.push(a.action); }, { file: path.join(dir, 'unused.json'), ...opts });
  return { eng, registry, devices, calls };
}
const sched = (id, trigger, action = PLUG_OFF) => ({ id, enabled: true, trigger: { type: 'schedule', ...trigger }, actions: [action] });

test('device trigger: changedTo fires on change only; type 생략 = device; condition 확인; mqtt 무시', async () => {
  const { eng, registry, devices, calls } = makeEngine();
  eng.rules = [
    { id: 'a', trigger: { deviceId: 'matter:6', capability: 'contact', field: 'open', changedTo: true }, conditions: [{ deviceId: 'matter:5', capability: 'onoff', field: 'on', equals: false }],
      actions: [{ type: 'mqtt', topic: 'x', payload: {} }, PLUG_ON] },
    { id: 'b', trigger: { type: 'schedule', at: '00:00' }, actions: [PLUG_OFF] },   // 상태 변경으로는 발동하지 않음
  ];
  const ch = (value, prev) => ({ deviceId: 'matter:6', endpoint: 1, capability: 'contact', field: 'open', value, prev });
  registry.emit('state', ch(true, false)); await flush();
  assert.deepEqual(calls, ['on']);
  registry.emit('state', ch(true, true)); await flush();               // 값 변화 없음
  registry.emit('state', ch(false, true)); await flush();              // 다른 값
  assert.deepEqual(calls, ['on']);
  devices['matter:5'].endpoints[1].capabilities.onoff.on = true;        // 조건 불만족
  registry.emit('state', ch(true, false)); await flush();
  assert.deepEqual(calls, ['on']);
  eng.rules[0].trigger.type = 'device'; devices['matter:5'].endpoints[1].capabilities.onoff.on = false;
  registry.emit('state', ch(true, false)); await flush();
  assert.deepEqual(calls, ['on', 'on']);
});

test('localParts: tz 기준 키/시/분/요일 (Asia/Seoul 과 UTC 가 날짜·요일이 다른 시각)', () => {
  const t = new Date('2026-10-25T15:30:00Z');   // UTC 일 15:30 = 서울 월 00:30
  assert.deepEqual(localParts(t, 'Asia/Seoul'), { key: '2026-10-26 00:30', hour: 0, minute: 30, weekday: 'mon' });
  assert.deepEqual(localParts(t, 'UTC'), { key: '2026-10-25 15:30', hour: 15, minute: 30, weekday: 'sun' });
});

test('schedule: 맞는 분에만, 분당 1회, days·tz 반영(기본 tz Asia/Seoul)', async () => {
  let now = new Date('2026-10-25T15:29:50Z');
  const { eng, calls } = makeEngine({ now: () => now });
  eng.rules = [
    sched('seoul-mon', { at: '00:30', days: ['mon'] }, { ...PLUG_OFF, action: 'seoul-mon' }),              // tz 생략 = Asia/Seoul
    sched('seoul-sun', { at: '00:30', days: ['sun'], tz: 'Asia/Seoul' }, { ...PLUG_OFF, action: 'seoul-sun' }),
    sched('utc-sun', { at: '15:30', days: ['sun'], tz: 'UTC' }, { ...PLUG_OFF, action: 'utc-sun' }),
    sched('utc-0030', { at: '00:30', tz: 'UTC' }, { ...PLUG_OFF, action: 'utc-0030' }),
    { ...sched('off', { at: '00:30' }), enabled: false },
  ];
  eng.tick(); await flush();
  assert.deepEqual(calls, [], '15:29 UTC 에는 아무것도');
  now = new Date('2026-10-25T15:30:05Z'); eng.tick(); await flush();
  assert.deepEqual(calls.sort(), ['seoul-mon', 'utc-sun']);
  now = new Date('2026-10-25T15:30:35Z'); eng.tick(); await flush();   // 같은 분 두 번째 틱
  assert.equal(calls.length, 2, '분당 1회');
  await eng.replace(eng.rules, 1, null); eng.tick(); await flush();     // 같은 분에 규칙 재설치돼도 재발동 없음
  assert.equal(calls.length, 2);
  now = new Date('2026-10-26T15:30:00Z'); eng.tick(); await flush();   // 하루 뒤: UTC 월 / 서울 화 → 요일 필터로 둘 다 안 됨
  assert.equal(calls.length, 2);
  now = new Date('2026-11-01T15:30:00Z'); eng.tick(); await flush();   // 일주일 뒤 같은 시각 → 다시 발동
  assert.equal(calls.length, 4);
});

test('schedule: start()/stop() 실제 타이머 — 여러 틱에도 1회', async () => {
  const { eng, calls } = makeEngine({ now: () => new Date('2026-10-26T13:00:10Z'), tickMs: 5 });   // 서울 22:00
  eng.rules = [sched('s', { at: '22:00' })];
  eng.start(); eng.start();
  await new Promise((r) => setTimeout(r, 60)); eng.stop();
  assert.deepEqual(calls, ['off']);
  assert.equal(eng.timer, null);
});

test('clock gate: 동기 파일 전엔 보류(WARN 1회), 동기 후 밀린 분은 재생하지 않음', async () => {
  const syncFile = path.join(dir, 'synchronized');
  let now = new Date('2026-10-26T13:00:00Z');   // 서울 22:00
  const { eng, calls } = makeEngine({ now: () => now, clockSyncFile: syncFile });
  eng.rules = [sched('s', { at: '22:00' })];
  const warns = []; const off = onLog((l) => { if (l.scope === 'rules') warns.push(l.msg); });
  assert.equal(eng.clockOk(), false);
  eng.tick(); eng.tick(); await flush();
  assert.deepEqual(calls, []); assert.equal(warns.length, 1);
  await writeFile(syncFile, '');
  assert.equal(eng.clockOk(), true);
  now = new Date('2026-10-26T13:01:00Z'); eng.tick(); await flush();   // 22:01 — 22:00 은 지나감 → 건너뜀
  assert.deepEqual(calls, []);
  now = new Date('2026-10-27T13:00:00Z'); eng.tick(); await flush();   // 다음 날 22:00
  assert.deepEqual(calls, ['off']);
  off();
  assert.equal(makeEngine().eng.clockOk(), true, 'clockSyncFile 미설정 = ok');
});

test('replace: 옛 {rules} 로드(v0), v0+빈 배열 무시, 버전 가드, 원자적 저장, 재로드', async () => {
  const file = path.join(dir, 'sub', 'rules.json');
  const { eng } = makeEngine({ file });
  await eng.load(); assert.equal(eng.version, 0); assert.deepEqual(eng.rules, []);   // 파일 없음
  await mkdir(path.dirname(file), { recursive: true });
  const hand = { id: 'hand', trigger: { deviceId: 'matter:6', capability: 'contact', field: 'open', changedTo: true }, actions: [PLUG_ON] };
  await writeFile(file, JSON.stringify({ rules: [hand] }));
  await eng.load(); assert.equal(eng.version, 0); assert.equal(eng.rules.length, 1);
  assert.equal(await eng.replace([], 0), false, 'v0 + 빈 배열은 손으로 쓴 규칙을 지우지 않음');
  assert.equal(eng.rules.length, 1);
  const r3 = sched('aut_3', { at: '07:00' });
  assert.equal(await eng.replace([r3], 3), true);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 3, rules: [r3] });
  assert.deepEqual((await readdir(path.dirname(file))).filter((f) => f !== 'rules.json'), [], 'tmp 없음');
  assert.equal(await eng.replace([hand], 3), false, '같은 버전 무시');
  assert.equal(await eng.replace([hand], 2), false, '낮은 버전 무시');
  assert.equal(await eng.replace([hand], 0), false, 'v>0 이후 v0 무시');
  assert.deepEqual(eng.rules, [r3]);
  const [a, b] = await Promise.all([eng.replace([hand], 4), eng.replace([r3, hand], 5)]);   // 연달아 와도 마지막이 남음
  assert.deepEqual([a, b], [true, true]);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 5);
  assert.equal(await eng.replace([], 6), true, 'v>0 의 빈 배열 = 전부 삭제');
  const { eng: eng2 } = makeEngine({ file });
  await eng2.load();
  assert.equal(eng2.version, 6); assert.deepEqual(eng2.rules, []);
});

test('onCfg: relay cfg 프레임 → replace (rules 없는 cfg 는 무시)', async () => {
  const file = path.join(dir, 'cfg-rules.json');
  const { eng } = makeEngine({ file });
  const relay = new EventEmitter();
  const done = [];
  relay.on('cfg', (cfg) => done.push(eng.onCfg(cfg)));
  relay.emit('cfg', { t: 'cfg', cfgVersion: 1, keys: [] });
  relay.emit('cfg', { t: 'cfg', cfgVersion: 2, rules: { version: 7, rules: [sched('s', { at: '06:00' })] } });
  assert.deepEqual(await Promise.all(done), [false, true]);
  assert.equal(eng.version, 7);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 7);
});
