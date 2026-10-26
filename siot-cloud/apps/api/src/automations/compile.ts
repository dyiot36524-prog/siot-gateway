// 자동화 규칙(계약 §1·§3): 공개 AutomationRule 검증(zod) → 게이트웨이 Rule(relay-v2 $defs/Rule) 컴파일.
// field·action 매핑은 에이전트 siotMapper.js(toSiotDevices) 의 역방향이고 기기의 deviceType·data 로 정한다.
// 로컬 ID matter:<node>:<ep> → 규칙 deviceId "matter:<node>" + endpoint <ep>.
import { z } from 'zod';
import type { Rule, RuleCommandAction, RuleCondition } from '@siot/protocol';
import { ID_PATTERNS } from '../ids.js';
import { badRequest } from '../http.js';

export const MAX_RULES = 100;
export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 10;
export const MAX_DELAY_MS = 3_600_000;
export const DEFAULT_TZ = 'Asia/Seoul';
/** 공개 Device.data 키 중 규칙에 쓸 수 있는 것 */
export const AUTOMATION_FIELDS = ['switch', 'active', 'battery', 'batteryLow', 'power', 'energy', 'brightness', 'value'] as const;
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Field = (typeof AUTOMATION_FIELDS)[number];
const BOOLEAN_FIELDS = new Set<Field>(['switch', 'active', 'batteryLow']);

const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const DeviceId = z.string().regex(ID_PATTERNS.dev, 'deviceId 는 dev_ + ULID 입니다');
const Scalar = z.union([z.boolean(), z.number()]);
const FieldSchema = z.enum(AUTOMATION_FIELDS);

const DeviceTrigger = z
  .object({ type: z.literal('device'), deviceId: DeviceId, field: FieldSchema, changedTo: Scalar.optional(), equals: Scalar.optional() })
  .strict()
  .refine((t) => (t.changedTo === undefined) !== (t.equals === undefined), 'changedTo 와 equals 중 정확히 하나가 필요합니다');
const ScheduleTrigger = z
  .object({
    type: z.literal('schedule'),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'at 은 HH:MM(00:00~23:59) 입니다'),
    days: z.array(z.enum(WEEKDAYS)).min(1).refine((d) => new Set(d).size === d.length, '요일이 중복되었습니다').optional(),
    tz: z.string().refine(validTz, '알 수 없는 시간대(IANA)입니다').optional(),
  })
  .strict();
const Condition = z
  .object({ deviceId: DeviceId, field: FieldSchema, equals: Scalar.optional(), gt: z.number().optional(), lt: z.number().optional() })
  .strict()
  .refine((c) => [c.equals, c.gt, c.lt].filter((x) => x !== undefined).length === 1, 'equals, gt, lt 중 정확히 하나가 필요합니다');
const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), deviceId: DeviceId, action: z.enum(['ON', 'OFF', 'TOGGLE']) }).strict(),
  z.object({ type: z.literal('delay'), ms: z.number().int().min(0).max(MAX_DELAY_MS) }).strict(),
]);
const RuleSchema = z
  .object({
    id: z.string().regex(ID_PATTERNS.aut, 'id 는 aut_ + ULID 입니다').optional(),
    name: z.string().min(1).max(100).optional(),
    enabled: z.boolean().default(true),
    trigger: z.discriminatedUnion('type', [DeviceTrigger, ScheduleTrigger]),
    conditions: z.array(Condition).max(MAX_CONDITIONS).default([]),
    actions: z.array(Action).min(1).max(MAX_ACTIONS),
  })
  .strict();
const PutBody = z.object({ rules: z.array(RuleSchema).max(MAX_RULES) }).strict();

export type AutomationRuleInput = z.infer<typeof RuleSchema>;
/** 저장·응답 형식(id 발급 후) */
export type AutomationRule = AutomationRuleInput & { id: string };

const fmtPath = (path: PropertyKey[]) =>
  path.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)), '') || 'body';

/** PUT 본문 검증. 실패는 400 VALIDATION_FAILED(메시지에 rules[i].… 경로) */
export function parseAutomationsBody(body: unknown): AutomationRuleInput[] {
  const r = PutBody.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw badRequest(`${fmtPath(issue.path)}: ${issue.message}`);
  }
  const seen = new Set<string>();
  r.data.rules.forEach((rule, i) => {
    if (!rule.id) return;
    if (seen.has(rule.id)) throw badRequest(`rules[${i}].id: 중복된 id 입니다`);
    seen.add(rule.id);
  });
  return r.data.rules;
}

/** 컴파일에 필요한 기기 정보(devices 행) */
export interface RuleDevice {
  deviceId: string;
  gatewayId: string;
  localId: string;
  deviceType: string;
  data: Record<string, string | number | boolean | null>;
}

/** matter:5:1 → {deviceId:"matter:5", endpoint:1}. 엔드포인트가 없으면 deviceId 만 */
export function localNode(localId: string): { deviceId: string; endpoint?: number } {
  const m = /^(.+):(\d+)$/.exec(localId);
  return m ? { deviceId: m[1]!, endpoint: Number(m[2]) } : { deviceId: localId };
}

const SWITCHABLE = new Set(['PLUG', 'SWITCH', 'LIGHT', 'FAN']);
const SENSOR_VALUE: Record<string, [string, string]> = {
  temperature: ['temperature', 'celsius'],
  humidity: ['humidity', 'percent'],
  illuminance: ['illuminance', 'lux'],
  power: ['power', 'watts'],
};
/** 다른 엔드포인트에서 합쳐질 수 있는 값(루트 배터리, 전력 측정 전용 엔드포인트) → endpoint 를 생략해 노드 전체로 본다 */
const NODE_WIDE = new Set(['battery', 'power', 'energy']);

function capabilityOf(d: RuleDevice, field: Field): [string, string] | null {
  switch (field) {
    case 'switch':
      return SWITCHABLE.has(d.deviceType) ? ['onoff', 'on'] : null;
    case 'active':
      if (d.deviceType !== 'BINARY_SENSOR') return null;
      return d.data.measurement === 'door' ? ['contact', 'open'] : d.data.measurement === 'motion' ? ['motion', 'detected'] : null;
    case 'battery':
      return ['battery', 'percent'];
    case 'batteryLow':
      return ['battery', 'low'];
    case 'power':
      return ['power', 'watts'];
    case 'energy':
      return ['energy', 'kwh'];
    case 'brightness':
      return d.deviceType === 'LIGHT' ? ['level', 'percent'] : null;
    case 'value':
      return d.deviceType === 'SENSOR' ? (SENSOR_VALUE[String(d.data.measurement)] ?? null) : null;
  }
}

function selector(d: RuleDevice, field: Field, path: string) {
  const cap = field in d.data ? capabilityOf(d, field) : null;
  if (!cap) throw badRequest(`${path}.field: 이 기기(${d.deviceType})에는 ${field} 값이 없습니다`);
  const n = localNode(d.localId);
  return { deviceId: n.deviceId, ...(n.endpoint !== undefined && !NODE_WIDE.has(cap[0]) ? { endpoint: n.endpoint } : {}), capability: cap[0], field: cap[1] };
}

function checkValue(field: Field, v: boolean | number, path: string, op: string): void {
  const want = BOOLEAN_FIELDS.has(field) ? 'boolean' : 'number';
  if (typeof v !== want) throw badRequest(`${path}.${op}: ${field} 는 ${want} 값입니다`);
}

/** 규칙 1개 컴파일. 기기가 세대에 없으면 UNKNOWN_DEVICE, 게이트웨이가 둘 이상이면 CROSS_GATEWAY_NOT_SUPPORTED */
export function compileRule(rule: AutomationRule, i: number, devs: Map<string, RuleDevice>): { gatewayId: string; rule: Rule } {
  const p = `rules[${i}]`;
  const gws = new Set<string>();
  const dev = (deviceId: string, path: string) => {
    const d = devs.get(deviceId);
    if (!d) throw badRequest(`${path}.deviceId: 이 세대에 없는 기기입니다(${deviceId})`, 'UNKNOWN_DEVICE');
    gws.add(d.gatewayId);
    return d;
  };

  const t = rule.trigger;
  let trigger: Rule['trigger'];
  if (t.type === 'device') {
    const path = `${p}.trigger`;
    const d = dev(t.deviceId, path);
    const op = t.changedTo !== undefined ? 'changedTo' : 'equals';
    checkValue(t.field, t[op]!, path, op);
    trigger = { type: 'device', ...selector(d, t.field, path), [op]: t[op]! };
  } else {
    trigger = { type: 'schedule', at: t.at, ...(t.days ? { days: t.days as [(typeof WEEKDAYS)[number], ...(typeof WEEKDAYS)[number][]] } : {}), tz: t.tz ?? DEFAULT_TZ };
  }

  const conditions = rule.conditions.map((c, j): RuleCondition => {
    const path = `${p}.conditions[${j}]`;
    const d = dev(c.deviceId, path);
    const op = c.equals !== undefined ? 'equals' : c.gt !== undefined ? 'gt' : 'lt';
    checkValue(c.field, op === 'equals' ? c.equals! : c[op]!, path, op);
    if (op !== 'equals' && BOOLEAN_FIELDS.has(c.field)) throw badRequest(`${path}.${op}: ${c.field} 는 boolean 값이라 비교할 수 없습니다`);
    return { ...selector(d, c.field, path), [op]: c[op]! };
  });

  const actions = rule.actions.map((a, j): Rule['actions'][number] => {
    if (a.type === 'delay') return { type: 'delay', ms: a.ms };
    const path = `${p}.actions[${j}]`;
    const d = dev(a.deviceId, path);
    if (!SWITCHABLE.has(d.deviceType) || !('switch' in d.data)) throw badRequest(`${path}.action: 켜고 끌 수 없는 기기(${d.deviceType})입니다`);
    const n = localNode(d.localId);
    const cmd: RuleCommandAction = { type: 'command', deviceId: n.deviceId, ...(n.endpoint !== undefined ? { endpoint: n.endpoint } : {}), capability: 'onoff', action: a.action.toLowerCase() as RuleCommandAction['action'] };
    return cmd;
  });

  if (gws.size === 0) throw badRequest(`${p}.actions: 기기 명령이 하나 이상 필요합니다`);
  if (gws.size > 1) throw badRequest(`${p}: 한 규칙의 기기는 모두 같은 게이트웨이에 있어야 합니다`, 'CROSS_GATEWAY_NOT_SUPPORTED');
  return {
    gatewayId: [...gws][0]!,
    rule: { id: rule.id, ...(rule.name ? { name: rule.name } : {}), enabled: rule.enabled, trigger, conditions, actions: actions as Rule['actions'] },
  };
}

/** 세대 규칙 전체를 게이트웨이별로 컴파일(PUT 검증). 첫 오류에서 400 */
export function compileSite(rules: AutomationRule[], devs: Map<string, RuleDevice>): Map<string, Rule[]> {
  const out = new Map<string, Rule[]>();
  rules.forEach((r, i) => {
    const c = compileRule(r, i, devs);
    out.set(c.gatewayId, [...(out.get(c.gatewayId) ?? []), c.rule]);
  });
  return out;
}

/** cfg 생성용: 이 게이트웨이 몫만. 저장 후 기기가 제거되는 등 컴파일이 안 되는 규칙은 건너뛴다 */
export function compileForGateway(rules: AutomationRule[], devs: Map<string, RuleDevice>, gatewayId: string): Rule[] {
  const out: Rule[] = [];
  rules.forEach((r, i) => {
    try {
      const c = compileRule(r, i, devs);
      if (c.gatewayId === gatewayId) out.push(c.rule);
    } catch {
      // 건너뜀
    }
  });
  return out;
}
