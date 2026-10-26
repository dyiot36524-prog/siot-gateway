// 자동화 규칙 컴파일(계약 §3): 공개 field/action → capability.field, 로컬 ID → deviceId+endpoint, 오류 코드. DB 없음.
import { describe, expect, it } from 'vitest';
import { newId } from '../../src/ids.js';
import { HttpError } from '../../src/http.js';
import { validateServerFrame } from '../../src/relay/frames.js';
import { compileForGateway, compileSite, parseAutomationsBody, type AutomationRule, type RuleDevice } from '../../src/automations/compile.js';

const GW1 = 'gw_00000001-0000-4000-8000-000000000001';
const GW2 = 'gw_00000002-0000-4000-8000-000000000002';
const mk = (gatewayId: string, localId: string, deviceType: string, data: RuleDevice['data']): RuleDevice => ({ deviceId: newId('dev'), gatewayId, localId, deviceType, data });
const door = mk(GW1, 'matter:6:1', 'BINARY_SENSOR', { active: false, measurement: 'door', battery: 100, batteryLow: false });
const motion = mk(GW1, 'matter:7:1', 'BINARY_SENSOR', { active: false, measurement: 'motion' });
const plug = mk(GW1, 'matter:5:1', 'PLUG', { switch: false, power: 3.2, energy: 0.1 });
const light = mk(GW1, 'matter:8:1', 'LIGHT', { switch: true, brightness: 50 });
const temp = mk(GW1, 'matter:9:1', 'SENSOR', { value: 21.5, unit: '°C', measurement: 'temperature' });
const humid = mk(GW1, 'matter:9:2', 'SENSOR', { value: 40, unit: '%', measurement: 'humidity' });
const plug2 = mk(GW2, 'matter:3:1', 'PLUG', { switch: true });
const devs = new Map([door, motion, plug, light, temp, humid, plug2].map((d) => [d.deviceId, d]));

/** 본문 검증 + id 채우기 */
const rules = (raw: object[]): AutomationRule[] => parseAutomationsBody({ rules: raw }).map((r, i) => ({ ...r, id: r.id ?? `aut_${String(i).padStart(26, '0')}` }));
const cmd = (d: RuleDevice, action = 'ON') => ({ type: 'command', deviceId: d.deviceId, action });
const devTrigger = (d: RuleDevice, field: string, v: object = { changedTo: true }) => ({ type: 'device', deviceId: d.deviceId, field, ...v });
const compileOne = (raw: object) => compileSite(rules([raw]), devs).get(GW1)![0]!;
const err = (fn: () => unknown): HttpError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected HttpError');
};

describe('compile: field 매핑(siotMapper 역방향)', () => {
  it.each([
    [door, 'active', { endpoint: 1, capability: 'contact', field: 'open' }],
    [motion, 'active', { endpoint: 1, capability: 'motion', field: 'detected' }],
    [plug, 'switch', { endpoint: 1, capability: 'onoff', field: 'on' }],
    [light, 'switch', { endpoint: 1, capability: 'onoff', field: 'on' }],
    [light, 'brightness', { endpoint: 1, capability: 'level', field: 'percent' }],
    [door, 'battery', { capability: 'battery', field: 'percent' }],
    [door, 'batteryLow', { capability: 'battery', field: 'low' }],
    [plug, 'power', { capability: 'power', field: 'watts' }],
    [plug, 'energy', { capability: 'energy', field: 'kwh' }],
    [temp, 'value', { endpoint: 1, capability: 'temperature', field: 'celsius' }],
    [humid, 'value', { endpoint: 2, capability: 'humidity', field: 'percent' }],
  ] as const)('%#: %s.%s', (d, field, want) => {
    const boolean = ['switch', 'active', 'batteryLow'].includes(field);
    const r = compileOne({ trigger: devTrigger(d, field, { equals: boolean ? true : 10 }), actions: [cmd(plug)] });
    const node = d.localId.replace(/:\d+$/, '');
    expect(r.trigger).toEqual({ type: 'device', deviceId: node, ...want, equals: boolean ? true : 10 });
  });

  it('문열림 → 플러그 ON: 게이트웨이 형식 전체', () => {
    const [r] = rules([
      {
        name: '문 열리면 플러그 켜기',
        trigger: devTrigger(door, 'active'),
        conditions: [{ deviceId: plug.deviceId, field: 'switch', equals: false }, { deviceId: temp.deviceId, field: 'value', gt: 18 }],
        actions: [cmd(plug, 'ON'), { type: 'delay', ms: 5000 }, cmd(light, 'TOGGLE'), cmd(plug, 'OFF')],
      },
    ]);
    expect(compileSite([r!], devs).get(GW1)).toEqual([
      {
        id: r!.id,
        name: '문 열리면 플러그 켜기',
        enabled: true,
        trigger: { type: 'device', deviceId: 'matter:6', endpoint: 1, capability: 'contact', field: 'open', changedTo: true },
        conditions: [
          { deviceId: 'matter:5', endpoint: 1, capability: 'onoff', field: 'on', equals: false },
          { deviceId: 'matter:9', endpoint: 1, capability: 'temperature', field: 'celsius', gt: 18 },
        ],
        actions: [
          { type: 'command', deviceId: 'matter:5', endpoint: 1, capability: 'onoff', action: 'on' },
          { type: 'delay', ms: 5000 },
          { type: 'command', deviceId: 'matter:8', endpoint: 1, capability: 'onoff', action: 'toggle' },
          { type: 'command', deviceId: 'matter:5', endpoint: 1, capability: 'onoff', action: 'off' },
        ],
      },
    ]);
  });

  it('schedule: tz 기본 Asia/Seoul, days 는 있을 때만', () => {
    expect(compileOne({ trigger: { type: 'schedule', at: '22:00' }, actions: [cmd(plug, 'OFF')] }).trigger).toEqual({ type: 'schedule', at: '22:00', tz: 'Asia/Seoul' });
    expect(compileOne({ trigger: { type: 'schedule', at: '07:30', days: ['sat', 'sun'], tz: 'UTC' }, actions: [cmd(plug)] }).trigger).toEqual({
      type: 'schedule', at: '07:30', days: ['sat', 'sun'], tz: 'UTC',
    });
  });

  it('컴파일 결과는 relay-v2 cfg 스키마를 지킨다(GW 별로 나뉨)', () => {
    const rs = rules([
      { trigger: devTrigger(door, 'active'), actions: [cmd(plug)] },
      { enabled: false, trigger: { type: 'schedule', at: '23:59', days: ['mon'] }, actions: [{ type: 'delay', ms: 0 }, cmd(plug, 'OFF')] },
      { trigger: devTrigger(plug2, 'switch', { changedTo: false }), actions: [cmd(plug2, 'ON')] },
    ]);
    const by = compileSite(rs, devs);
    expect(by.get(GW1)).toHaveLength(2);
    expect(by.get(GW2)).toHaveLength(1);
    for (const g of [GW1, GW2]) {
      const frame = { t: 'cfg', cfgVersion: 2, siteId: 'site_01JZ8Q0V4Y4W6P1M2N3B5C7D9E', keys: [{ v: 1, key: 'A'.repeat(43) }], peers: [], rules: { version: 7, rules: compileForGateway(rs, devs, g) } };
      expect(validateServerFrame(frame)).toEqual({ ok: true });
    }
  });
});

describe('compile: 오류', () => {
  it('다른 게이트웨이 기기를 섞으면 CROSS_GATEWAY_NOT_SUPPORTED', () => {
    const e = err(() => compileSite(rules([{ trigger: devTrigger(door, 'active'), actions: [cmd(plug2)] }]), devs));
    expect([e.statusCode, e.code]).toEqual([400, 'CROSS_GATEWAY_NOT_SUPPORTED']);
    expect(e.message).toContain('rules[0]');
  });

  it('세대에 없는 기기는 UNKNOWN_DEVICE(경로 포함)', () => {
    const ghost = newId('dev');
    const e = err(() => compileSite(rules([{ trigger: devTrigger(door, 'active'), actions: [cmd(plug)] }, { trigger: devTrigger(door, 'active'), actions: [{ type: 'command', deviceId: ghost, action: 'ON' }] }]), devs));
    expect([e.statusCode, e.code]).toEqual([400, 'UNKNOWN_DEVICE']);
    expect(e.message).toContain('rules[1].actions[0].deviceId');
  });

  it('기기에 없는 field·켤 수 없는 대상·값 타입 불일치는 VALIDATION_FAILED', () => {
    const cases: [object, string][] = [
      [{ trigger: devTrigger(plug, 'active'), actions: [cmd(plug)] }, 'rules[0].trigger.field'],
      [{ trigger: devTrigger(door, 'brightness', { equals: 1 }), actions: [cmd(plug)] }, 'rules[0].trigger.field'],
      [{ trigger: devTrigger(door, 'active'), actions: [cmd(door)] }, 'rules[0].actions[0].action'],
      [{ trigger: devTrigger(door, 'active', { changedTo: 1 }), actions: [cmd(plug)] }, 'rules[0].trigger.changedTo'],
      [{ trigger: devTrigger(door, 'active'), conditions: [{ deviceId: plug.deviceId, field: 'switch', gt: 0 }], actions: [cmd(plug)] }, 'rules[0].conditions[0].gt'],
      [{ trigger: { type: 'schedule', at: '22:00' }, actions: [{ type: 'delay', ms: 1 }] }, 'rules[0].actions'],
    ];
    for (const [raw, path] of cases) {
      const e = err(() => compileSite(rules([raw]), devs));
      expect([e.code, e.message.split(':')[0]], JSON.stringify(raw)).toEqual(['VALIDATION_FAILED', path]);
    }
  });

  it('본문 검증: 경로가 들어간 VALIDATION_FAILED', () => {
    const bad: [unknown, string][] = [
      [null, 'body'],
      [{ rules: [], extra: 1 }, 'body'],
      [{ rules: [{ trigger: { type: 'schedule', at: '24:00' }, actions: [cmd(plug)] }] }, 'rules[0].trigger.at'],
      [{ rules: [{ trigger: { type: 'schedule', at: '22:00', tz: 'Mars/Base' }, actions: [cmd(plug)] }] }, 'rules[0].trigger.tz'],
      [{ rules: [{ trigger: { type: 'schedule', at: '22:00', days: ['mon', 'mon'] }, actions: [cmd(plug)] }] }, 'rules[0].trigger.days'],
      [{ rules: [{ trigger: devTrigger(door, 'active', { changedTo: true, equals: true }), actions: [cmd(plug)] }] }, 'rules[0].trigger'],
      [{ rules: [{ trigger: devTrigger(door, 'active'), actions: [] }] }, 'rules[0].actions'],
      [{ rules: [{ trigger: devTrigger(door, 'active'), actions: Array(11).fill(cmd(plug)) }] }, 'rules[0].actions'],
      [{ rules: [{ trigger: devTrigger(door, 'active'), actions: [{ type: 'delay', ms: 3_600_001 }] }] }, 'rules[0].actions[0].ms'],
      [{ rules: [{ trigger: devTrigger(door, 'active'), actions: [{ type: 'mqtt', topic: 'x' }] }] }, 'rules[0].actions[0].type'],
      [{ rules: [{ id: 'r1', trigger: devTrigger(door, 'active'), actions: [cmd(plug)] }] }, 'rules[0].id'],
      [{ rules: Array(101).fill({ trigger: devTrigger(door, 'active'), actions: [cmd(plug)] }) }, 'rules'],
    ];
    for (const [body, path] of bad) {
      const e = err(() => parseAutomationsBody(body));
      expect([e.code, e.message.split(':')[0]], JSON.stringify(body).slice(0, 120)).toEqual(['VALIDATION_FAILED', path]);
    }
    const id = newId('aut');
    const e = err(() => parseAutomationsBody({ rules: [0, 1].map(() => ({ id, trigger: devTrigger(door, 'active'), actions: [cmd(plug)] })) }));
    expect(e.message).toContain('rules[1].id');
  });

  it('cfg 생성(compileForGateway)은 제거된 기기의 규칙을 건너뛴다', () => {
    const rs = rules([{ trigger: devTrigger(door, 'active'), actions: [cmd(plug)] }, { trigger: { type: 'schedule', at: '01:00' }, actions: [cmd(light)] }]);
    const without = new Map(devs);
    without.delete(door.deviceId);
    expect(compileForGateway(rs, without, GW1).map((r) => r.id)).toEqual([rs[1]!.id]);
  });
});
