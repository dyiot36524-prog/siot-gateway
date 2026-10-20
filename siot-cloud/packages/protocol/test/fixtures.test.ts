import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { allSchemas, CONTROL_STATUSES, EVT_KINDS, FRAME_DIRECTIONS, SCHEMA_IDS, schemas } from '../src/index.js';

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;
const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureDir = join(root, 'fixtures/relay-v2');
const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort();
const load = (f: string): Record<string, unknown> => JSON.parse(readFileSync(join(fixtureDir, f), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addKeyword('x-direction');
for (const s of allSchemas) ajv.addSchema(s);
const v = (id: string) => {
  const fn = ajv.getSchema(id);
  if (!fn) throw new Error(`schema ${id} missing`);
  return fn;
};
const any = v(SCHEMA_IDS.relayV2);
const s2g = v(SCHEMA_IDS.relayV2ServerToGateway);
const g2s = v(SCHEMA_IDS.relayV2GatewayToServer);

describe('relay-v2 fixtures', () => {
  const valid = files.filter((f) => f.startsWith('valid.'));
  const invalid = files.filter((f) => f.startsWith('invalid.'));

  it('has at least one valid fixture per frame type and evt kind, and ≥2 invalid', () => {
    const frames = valid.map(load);
    expect(new Set(frames.map((f) => f.t))).toEqual(new Set(Object.keys(FRAME_DIRECTIONS)));
    expect(new Set(frames.filter((f) => f.t === 'evt').map((f) => f.kind))).toEqual(new Set(EVT_KINDS));
    expect(invalid.length).toBeGreaterThanOrEqual(2);
  });

  it('FRAME_DIRECTIONS matches x-direction in the schema', () => {
    const fromSchema: Record<string, string> = {};
    for (const def of Object.values(schemas.relayV2.$defs) as Array<{ properties?: { t?: { const?: string } }; 'x-direction'?: string }>) {
      const t = def.properties?.t?.const;
      if (t && def['x-direction']) fromSchema[t] = def['x-direction'];
    }
    expect(fromSchema).toEqual(FRAME_DIRECTIONS);
  });

  it.each(valid)('valid: %s', (f) => {
    const frame = load(f);
    expect(any(frame), JSON.stringify(any.errors)).toBe(true);
    const dir = FRAME_DIRECTIONS[frame.t as keyof typeof FRAME_DIRECTIONS];
    expect(s2g(frame)).toBe(dir !== 'gateway_to_server');
    expect(g2s(frame)).toBe(dir !== 'server_to_gateway');
  });

  it.each(invalid)('invalid: %s', (f) => {
    expect(any(load(f))).toBe(false);
  });
});

describe('peer-v1 / public-v1-control', () => {
  const peer = v(SCHEMA_IDS.peerV1);
  const control = v(SCHEMA_IDS.publicV1Control);
  const gw = 'gw_739f694e-76be-5888-be41-639544c21b5b';
  const boot = '0b7d2f3e-8c1a-4e5b-9f6d-2a3c4b5d6e7f';

  it('peer frames', () => {
    expect(peer({ t: 'hello', siteTag: '0a1b2c3d', gatewayId: gw, bootId: boot, keyVersion: 1 })).toBe(true);
    expect(peer({ t: 'evt', from: gw, bootId: boot, seq: 1, kind: 'device', data: {} })).toBe(true);
    expect(peer({ t: 'ack', bootId: boot, upTo: 1 })).toBe(true);
    expect(peer({ t: 'ping' }) && peer({ t: 'pong' })).toBe(true);
    expect(peer({ t: 'hello', siteTag: 'XYZ', gatewayId: gw, bootId: boot, keyVersion: 1 })).toBe(false);
    expect(peer({ t: 'req', id: '1' })).toBe(false);
  });

  it('control result', () => {
    const device = {
      deviceId: 'dev_01JZ8Q0V4Y4W6P1M2N3B5C7D9E', gatewayId: gw, siteId: 'site_01JZ8Q0V4Y4W6P1M2N3B5C7D9E',
      name: '거실 플러그', room: '거실', deviceType: 'PLUG', online: true, data: { switch: true, power: 3.2 },
      lastUpdated: '2026-10-20T00:40:00.000Z', vendor: 'IKEA of Sweden', model: 'GRILLPLATS',
    };
    for (const status of CONTROL_STATUSES) expect(control({ status, device, latencyMs: 812 }), status).toBe(true);
    expect(control({ status: 'not_found', device: null, latencyMs: 40 })).toBe(true);
    expect(control({ status: 'failed', device, latencyMs: 90, reason: 'DEVICE_UNREACHABLE' })).toBe(true);
    expect(control({ status: 'ok', device, latencyMs: 1 })).toBe(false);
    expect(control({ status: 'confirmed', device: { ...device, deviceId: 'matter:5:1' }, latencyMs: 1 })).toBe(false);
  });
});
