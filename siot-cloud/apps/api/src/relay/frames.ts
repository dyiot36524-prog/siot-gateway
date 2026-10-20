// relay-v2 프레임 검증(C1, 양방향). 원본은 @siot/protocol schema/relay-v2.json.
// - 송신(서버→GW): 생산자는 엄격 — 스키마 위반이면 예외(프로그래밍 오류).
// - 수신(GW→서버): 수신자는 모르는 필드를 무시 — 오류가 전부 additionalProperties 면 통과, 그 밖의 위반은 거부.
//   oneOf 오류가 섞이지 않도록 t(evt 는 kind)로 정의를 골라 검증한다.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { allSchemas, SCHEMA_IDS, type GatewayToServerFrame, type ServerToGatewayFrame } from '@siot/protocol';

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addKeyword('x-direction');
for (const s of allSchemas) ajv.addSchema(s);

const def = (name: string): ValidateFunction => {
  const fn = ajv.getSchema(`${SCHEMA_IDS.relayV2}#/$defs/${name}`);
  if (!fn) throw new Error(`relay-v2 $defs/${name} missing`);
  return fn;
};

const G2S_DEFS: Record<string, string> = { hello: 'Hello', bound: 'Bound', cfg_ack: 'CfgAck', snapshot: 'Snapshot', res: 'Res', ping: 'Ping', pong: 'Pong' };
const EVT_DEFS: Record<string, string> = {
  device: 'EvtDevice', device_removed: 'EvtDeviceRemoved', gateway: 'EvtGateway', pairing: 'EvtPairing', thread: 'EvtThread', error: 'EvtError', log: 'EvtLog',
};
const g2sValidators = new Map<string, ValidateFunction>();
for (const [t, name] of Object.entries(G2S_DEFS)) g2sValidators.set(t, def(name));
for (const [k, name] of Object.entries(EVT_DEFS)) g2sValidators.set(`evt:${k}`, def(name));
const s2g = def('ServerToGateway');

export type ParseResult = { ok: true; frame: GatewayToServerFrame } | { ok: false; error: string };

const fmt = (errs: ErrorObject[] | null | undefined) => (errs ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');

/** GW → 서버 원문 텍스트를 파싱·검증한다 */
export function parseGatewayFrame(raw: string): ParseResult {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid json' };
  }
  return validateGatewayFrame(msg);
}

export function validateGatewayFrame(msg: unknown): ParseResult {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: 'not an object' };
  const m = msg as { t?: unknown; kind?: unknown };
  if (typeof m.t !== 'string') return { ok: false, error: 'missing t' };
  const key = m.t === 'evt' ? `evt:${String(m.kind)}` : m.t;
  const v = g2sValidators.get(key);
  if (!v) return { ok: false, error: `unknown frame ${key}` };
  if (v(msg)) return { ok: true, frame: msg as GatewayToServerFrame };
  const errs = v.errors ?? [];
  if (errs.length > 0 && errs.every((e) => e.keyword === 'additionalProperties')) return { ok: true, frame: msg as GatewayToServerFrame };
  return { ok: false, error: `${key}: ${fmt(errs)}` };
}

/** 서버 → GW 프레임이 스키마를 엄격히 지키는지 */
export function validateServerFrame(frame: unknown): { ok: true } | { ok: false; error: string } {
  return s2g(frame) ? { ok: true } : { ok: false, error: fmt(s2g.errors) };
}

export function assertServerFrame(frame: ServerToGatewayFrame): void {
  const r = validateServerFrame(frame);
  if (!r.ok) throw new Error(`invalid server frame ${frame.t}: ${r.error}`);
}
