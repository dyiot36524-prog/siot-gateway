// P0 계약 테스트: protocol 스키마 fixture, OpenAPI ↔ JSON Schema 일치, drizzle M1 테이블, healthz.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { parse } from 'yaml';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { allSchemas, CONTROL_STATUSES, SCHEMA_IDS, schemas } from '@siot/protocol';
import * as dbSchema from '../src/db/schema.js';
import { buildApp } from '../src/app.js';

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;
const require = createRequire(import.meta.url);
const protocolRoot = dirname(require.resolve('@siot/protocol/schema/relay-v2.json'));
const fixtureDir = join(protocolRoot, '../fixtures/relay-v2');
const openapi = (name: string) => parse(readFileSync(new URL(`../openapi/${name}`, import.meta.url), 'utf8'));

describe('@siot/protocol relay-v2 fixtures (consumer side)', () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addKeyword('x-direction');
  for (const s of allSchemas) ajv.addSchema(s);
  const validate = ajv.getSchema(SCHEMA_IDS.relayV2)!;
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));

  it.each(files)('%s', (f) => {
    const frame = JSON.parse(readFileSync(join(fixtureDir, f), 'utf8'));
    expect(validate(frame)).toBe(f.startsWith('valid.'));
  });
});

describe('OpenAPI ↔ protocol schema', () => {
  const pub = openapi('public-v1.yaml');
  const app = openapi('app-v1.yaml');

  it('ControlResult.status enum is identical everywhere', () => {
    expect(pub.components.schemas.ControlResult.properties.status.enum).toEqual([...CONTROL_STATUSES]);
    expect(app.components.schemas.ControlResult.properties.status.enum).toEqual([...CONTROL_STATUSES]);
    expect(schemas.publicV1Control.$defs.ControlStatus.enum).toEqual([...CONTROL_STATUSES]);
  });

  it('public Device fields match public-v1-control $defs/Device', () => {
    const fromJson = schemas.publicV1Control.$defs.Device;
    for (const doc of [pub, app]) {
      const d = doc.components.schemas.Device;
      expect(Object.keys(d.properties).sort()).toEqual(Object.keys(fromJson.properties).sort());
      expect([...d.required].sort()).toEqual([...fromJson.required].sort());
    }
    expect(pub.components.schemas.DeviceType.enum).toEqual(schemas.siotDevice.$defs.DeviceType.enum);
  });

  it('public-v1 has every §3 A1 endpoint', () => {
    const ops = Object.entries(pub.paths as Record<string, Record<string, unknown>>).flatMap(([p, item]) =>
      Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`),
    );
    expect(ops.sort()).toEqual(
      [
        'GET /v1/sites',
        'GET /v1/sites/{siteId}',
        'GET /v1/sites/{siteId}/gateways',
        'GET /v1/sites/{siteId}/devices',
        'GET /v1/sites/{siteId}/automations',
        'PUT /v1/sites/{siteId}/automations',
        'GET /v1/gateways/{gatewayId}',
        'GET /v1/devices/{deviceId}',
        'POST /v1/devices/{deviceId}/control',
        'GET /v1/webhooks',
        'POST /v1/webhooks',
        'DELETE /v1/webhooks/{webhookId}',
        'POST /v1/webhooks/{webhookId}/test',
      ].sort(),
    );
    expect(Object.keys(pub.webhooks).sort()).toEqual(
      ['api_key.expiring', 'device.removed', 'device.state_changed', 'gateway.offline', 'gateway.online'].sort(),
    );
    expect(pub.components.parameters.Limit.schema).toMatchObject({ default: 100, maximum: 500 });
  });

  it('app-v1 GatewayDiagnostics exposes only the B4 fields', () => {
    expect(Object.keys(app.components.schemas.GatewayDiagnostics.properties).sort()).toEqual(
      ['agentVersion', 'deviceCount', 'lastErrorCode', 'lastSeen', 'matterServerVersion', 'online'].sort(),
    );
  });
});

describe('drizzle M1 schema', () => {
  const tables = (Object.values(dbSchema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getTableConfig(t));

  it('defines exactly the M1 tables (13 + automation_rules)', () => {
    expect(tables.map((t) => t.name).sort()).toEqual([...dbSchema.M1_TABLES].sort());
  });

  it('has the required unique keys', () => {
    const uniques = (name: string) =>
      tables.find((t) => t.name === name)!.uniqueConstraints.map((u) => u.columns.map((c) => c.name).join(','));
    expect(uniques('devices')).toContain('gateway_id,local_id');
    expect(uniques('events')).toContain('gateway_id,boot_id,seq,sub');
    const devices = tables.find((t) => t.name === 'devices')!;
    expect(devices.columns.find((c) => c.primary)?.name).toBe('device_id');
    expect(tables.find((t) => t.name === 'events')!.columns.map((c) => c.name)).toContain('site_epoch');
  });

  it('migration SQL is generated and committed', () => {
    const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
    expect(journal.entries.length).toBeGreaterThanOrEqual(1);
    const sql = journal.entries.map((e: { tag: string }) => readFileSync(new URL(`../drizzle/${e.tag}.sql`, import.meta.url), 'utf8')).join('\n');
    for (const t of dbSchema.M1_TABLES) expect(sql).toContain(`CREATE TABLE "${t}"`);
  });
});

describe('healthz', () => {
  it('200 when db ping succeeds, 503 when it fails', async () => {
    const ok = await buildApp({ logger: false, pingDb: async () => {} });
    expect((await ok.inject({ url: '/healthz' })).statusCode).toBe(200);
    await ok.close();
    const down = await buildApp({ logger: false, pingDb: async () => Promise.reject(new Error('down')) });
    const res = await down.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('DB_UNAVAILABLE');
    await down.close();
  });
});
