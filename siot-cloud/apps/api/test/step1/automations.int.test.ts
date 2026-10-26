// 자동화 규칙 공개 API(계약 §1·§4): PUT→GET(version·id·400·조직 격리), 저장 후 cfgVersion+1 과 cfg push(컴파일 규칙·세대 version),
// 그리고 릴레이 쪽 cfg_ack.rulesVersion → gateways.rules_acked_version → appliedVersion·rulesVersion. 실제 Postgres(siot_test).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import type { SiotDevice } from '@siot/protocol';
import { gateways, siteKeys } from '../../src/db/schema.js';
import { encryptSecret } from '../../src/relay/crypto.js';
import { validateServerFrame } from '../../src/relay/frames.js';
import { buildCfgBody, createDbGatewayRepo } from '../../src/relay/repo.js';
import { until } from '../relay/helpers.js';
import { BOOT_A, connect, makeApp, openapiValidator, plug, seedGateway, seedOrg, seedSite, testConfig, useTestDb, type TestApp } from './helpers.js';

const t = useTestDb();
const v = openapiValidator('public-v1.yaml');
const TPL = '/v1/sites/{siteId}/automations';

const door = (localId: string): SiotDevice => ({
  id: localId, name: '현관 문', deviceType: 'BINARY_SENSOR', online: true, data: { active: false, measurement: 'door', battery: 100, batteryLow: false },
  lastUpdated: '2026-10-26T00:00:00.000Z', vendor: 'IKEA of Sweden', model: 'MYGGBETT',
});

let T: TestApp;
let key: string;
let readOnlyKey: string;
let otherKey: string;
let siteId: string;
let otherSite: string;
let gw1: string;
let gw2: string;
let gw3: string;
const dev: Record<string, string> = {};

async function call(method: 'GET' | 'PUT', url: string, template: string, payload?: unknown, k = key): Promise<LightMyRequestResponse> {
  const res = await T.app.inject({ method, url, headers: { authorization: `Bearer ${k}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  expect(v.response(method, template, res.statusCode, res.body ? res.json() : undefined), `${method} ${url} → ${res.statusCode} ${res.body}`).toEqual([]);
  return res;
}
const get = (k = key, s = siteId) => call('GET', `/v1/sites/${s}/automations`, TPL, undefined, k);
const put = (rules: unknown, k = key, s = siteId) => call('PUT', `/v1/sites/${s}/automations`, TPL, { rules }, k);
const cfgVersion = async (g: string) => (await t.db.select({ v: gateways.cfgVersion }).from(gateways).where(eq(gateways.gatewayId, g)))[0]!.v;
const lastCfg = (g: string) => T.bus.cfgs.filter((c) => c.gatewayId === g).at(-1)?.cfg;

const doorToPlug = () => ({ name: '문 열리면 플러그 켜기', trigger: { type: 'device', deviceId: dev.door, field: 'active', changedTo: true }, actions: [{ type: 'command', deviceId: dev.plug, action: 'ON' }] });
const nightOff = () => ({ name: '밤 10시 플러그 끄기', trigger: { type: 'schedule', at: '22:00' }, actions: [{ type: 'command', deviceId: dev.plug, action: 'OFF' }] });

describe('public-v1 automations', () => {
  beforeAll(async () => {
    await t.truncate();
    T = await makeApp(t.db);
    const orgId = await seedOrg(t.db);
    const orgB = await seedOrg(t.db, '다른 설치사');
    siteId = await seedSite(t.db, orgId);
    otherSite = await seedSite(t.db, orgB);
    gw1 = await seedGateway(t.db, orgId, siteId, 11);
    gw2 = await seedGateway(t.db, orgId, siteId, 12);
    gw3 = await seedGateway(t.db, orgB, otherSite, 13);
    for (const [s, gs] of [[siteId, [gw1, gw2]], [otherSite, [gw3]]] as const) {
      await t.db.insert(siteKeys).values({ siteId: s, version: 1, keyEnc: encryptSecret(testConfig.DATA_ENC_KEY, randomBytes(32)), epoch: 1 });
      for (const g of gs) await t.db.update(gateways).set({ cfgVersion: 1, keyVersion: 1 }).where(eq(gateways.gatewayId, g));
    }
    key = (await T.ctx.apiKeys.issue(orgId, { name: 'partner', mode: 'test', scopes: ['devices:read', 'devices:control'] })).key;
    readOnlyKey = (await T.ctx.apiKeys.issue(orgId, { name: 'ro', mode: 'test', scopes: ['devices:read'] })).key;
    otherKey = (await T.ctx.apiKeys.issue(orgB, { name: 'b', mode: 'test', scopes: ['devices:read', 'devices:control'] })).key;
    await connect(T, gw1, [door('matter:6:1'), plug('matter:5:1', false)], BOOT_A, 0);
    await connect(T, gw2, [plug('matter:3:1', true)], BOOT_A, 0);
    await connect(T, gw3, [plug('matter:9:1', true)], BOOT_A, 0);
    dev.door = T.ctx.cache.getDeviceByLocal(gw1, 'matter:6:1')!.deviceId;
    dev.plug = T.ctx.cache.getDeviceByLocal(gw1, 'matter:5:1')!.deviceId;
    dev.plug2 = T.ctx.cache.getDeviceByLocal(gw2, 'matter:3:1')!.deviceId;
    dev.foreign = T.ctx.cache.getDeviceByLocal(gw3, 'matter:9:1')!.deviceId;
  });
  afterAll(async () => {
    await T.app.close();
  });

  it('저장 전 GET: version 0, rules [], updatedAt null, GW 별 appliedVersion 0', async () => {
    expect((await get()).json()).toEqual({
      version: 0, updatedAt: null, rules: [],
      gateways: [{ gatewayId: gw1, online: true, appliedVersion: 0 }, { gatewayId: gw2, online: true, appliedVersion: 0 }],
    });
  });

  it('PUT → version 1·id 발급, 세대 GW cfgVersion+1, 접속 GW 에 컴파일 규칙 push(규칙 없는 GW 도 같은 version 빈 배열)', async () => {
    const res = await put([doorToPlug(), nightOff()]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe(1);
    expect(body.updatedAt).toEqual(expect.any(String));
    expect(body.rules).toEqual([
      { id: expect.stringMatching(/^aut_[0-9A-HJKMNP-TV-Z]{26}$/), ...doorToPlug(), enabled: true, conditions: [] },
      { id: expect.stringMatching(/^aut_/), ...nightOff(), enabled: true, conditions: [] },
    ]);
    expect((await get()).json()).toEqual(body);
    expect([await cfgVersion(gw1), await cfgVersion(gw2), await cfgVersion(gw3)]).toEqual([2, 2, 1]);

    await until(() => lastCfg(gw1) && lastCfg(gw2), 3000, 'cfg push');
    const c1 = lastCfg(gw1)!;
    expect(c1.cfgVersion).toBe(2);
    expect(c1.rules).toEqual({
      version: 1,
      rules: [
        {
          id: body.rules[0].id, name: '문 열리면 플러그 켜기', enabled: true,
          trigger: { type: 'device', deviceId: 'matter:6', endpoint: 1, capability: 'contact', field: 'open', changedTo: true },
          conditions: [],
          actions: [{ type: 'command', deviceId: 'matter:5', endpoint: 1, capability: 'onoff', action: 'on' }],
        },
        {
          id: body.rules[1].id, name: '밤 10시 플러그 끄기', enabled: true,
          trigger: { type: 'schedule', at: '22:00', tz: 'Asia/Seoul' },
          conditions: [],
          actions: [{ type: 'command', deviceId: 'matter:5', endpoint: 1, capability: 'onoff', action: 'off' }],
        },
      ],
    });
    expect(lastCfg(gw2)!.rules).toEqual({ version: 1, rules: [] });
    for (const g of [gw1, gw2]) expect(validateServerFrame({ t: 'cfg', ...lastCfg(g)! })).toEqual({ ok: true });
    // 오프라인 GW 는 다음 접속 때 buildCfgBody(같은 본문)
    expect(await buildCfgBody(t.db, testConfig.DATA_ENC_KEY, gw1)).toEqual(c1);
  });

  it('다시 PUT: 있는 id 는 유지, 빠진 규칙은 삭제, version·cfgVersion +1', async () => {
    const before = (await get()).json();
    const keep = { ...before.rules[0], enabled: false };
    const onGw2 = { trigger: { type: 'device', deviceId: dev.plug2, field: 'switch', changedTo: false }, actions: [{ type: 'delay', ms: 1000 }, { type: 'command', deviceId: dev.plug2, action: 'TOGGLE' }] };
    T.bus.cfgs.length = 0;
    const body = (await put([keep, onGw2])).json();
    expect(body.version).toBe(2);
    expect(body.rules.map((r: { id: string }) => r.id)).toEqual([keep.id, expect.stringMatching(/^aut_/)]);
    expect(body.rules[0].enabled).toBe(false);
    expect([await cfgVersion(gw1), await cfgVersion(gw2)]).toEqual([3, 3]);
    await until(() => lastCfg(gw1) && lastCfg(gw2), 3000, 'cfg push');
    expect(lastCfg(gw1)!.rules.rules.map((r) => [r.id, r.enabled])).toEqual([[keep.id, false]]);
    expect(lastCfg(gw2)!.rules).toMatchObject({ version: 2, rules: [{ id: body.rules[1].id, trigger: { deviceId: 'matter:3', endpoint: 1, capability: 'onoff', field: 'on' } }] });
  });

  it('400: UNKNOWN_DEVICE(다른 조직 기기), CROSS_GATEWAY_NOT_SUPPORTED, VALIDATION_FAILED — 저장·cfgVersion 변화 없음', async () => {
    const cases: [unknown, string, string][] = [
      [[doorToPlug(), { ...doorToPlug(), actions: [{ type: 'command', deviceId: dev.foreign, action: 'ON' }] }], 'UNKNOWN_DEVICE', 'rules[1].actions[0].deviceId'],
      [[{ ...doorToPlug(), actions: [{ type: 'command', deviceId: dev.plug2, action: 'ON' }] }], 'CROSS_GATEWAY_NOT_SUPPORTED', 'rules[0]'],
      [[{ ...doorToPlug(), trigger: { type: 'device', deviceId: dev.plug, field: 'active', changedTo: true } }], 'VALIDATION_FAILED', 'rules[0].trigger.field'],
      [[{ ...nightOff(), trigger: { type: 'schedule', at: '9:00' } }], 'VALIDATION_FAILED', 'rules[0].trigger.at'],
      ['nope', 'VALIDATION_FAILED', 'rules'],
    ];
    for (const [rules, code, path] of cases) {
      const res = await put(rules);
      expect([res.statusCode, res.json().error.code], res.body).toEqual([400, code]);
      expect(res.json().error.message.startsWith(path), res.body).toBe(true);
    }
    expect((await get()).json().version).toBe(2);
    expect([await cfgVersion(gw1), await cfgVersion(gw2)]).toEqual([3, 3]);
  });

  it('조직 격리 403, 스코프 부족 403 INSUFFICIENT_SCOPE', async () => {
    expect((await get(otherKey)).statusCode).toBe(403);
    expect((await put([], otherKey)).statusCode).toBe(403);
    const ro = await put([], readOnlyKey);
    expect([ro.statusCode, ro.json().error.code]).toEqual([403, 'INSUFFICIENT_SCOPE']);
    expect((await get(readOnlyKey)).statusCode).toBe(200);
    expect((await get(otherKey, otherSite)).json()).toMatchObject({ version: 0, gateways: [{ gatewayId: gw3 }] });
  });

  it('릴레이: cfg_ack.rulesVersion → rules_acked_version → appliedVersion·Gateway.rulesVersion (hello 는 그대로)', async () => {
    const repo = createDbGatewayRepo(t.db, testConfig.DATA_ENC_KEY);
    await repo.recordCfgAck(gw1, { t: 'cfg_ack', cfgVersion: 3, keyVersion: 1, rulesVersion: 2 });
    const row = (await t.db.select().from(gateways).where(eq(gateways.gatewayId, gw1)))[0]!;
    expect([row.cfgAckedVersion, row.rulesAckedVersion]).toEqual([3, 2]);
    await repo.markOnline(gw1, { t: 'hello', proto: 2, gatewayId: gw1, bootId: BOOT_A, agentVersion: '0.9.0', matterServerVersion: null, startedAt: row.createdAt.toISOString(), clock: new Date().toISOString(), cfgVersion: 3, keyVersion: 1, pubKey: 'A'.repeat(43), sig: 'x' }, new Date());
    expect((await t.db.select().from(gateways).where(eq(gateways.gatewayId, gw1)))[0]!.rulesAckedVersion).toBe(2);

    const set = (await get()).json();
    expect(set.gateways).toEqual([{ gatewayId: gw1, online: true, appliedVersion: 2 }, { gatewayId: gw2, online: true, appliedVersion: 0 }]);
    expect((await call('GET', `/v1/gateways/${gw1}`, '/v1/gateways/{gatewayId}')).json().rulesVersion).toBe(2);
    const list = (await call('GET', `/v1/sites/${siteId}/gateways`, '/v1/sites/{siteId}/gateways')).json();
    expect(list.data.map((g: { rulesVersion: number }) => g.rulesVersion)).toEqual([2, 0]);
  });

  it('규칙 0개 PUT = 전부 삭제(version+1), GW 는 빈 규칙을 받는다', async () => {
    T.bus.cfgs.length = 0;
    const body = (await put([])).json();
    expect(body).toMatchObject({ version: 3, rules: [] });
    await until(() => lastCfg(gw1), 3000, 'cfg push');
    expect(lastCfg(gw1)!.rules).toEqual({ version: 3, rules: [] });
    // 오프라인 GW 에는 push 하지 않는다(다음 접속 때 cfgVersion 비교로)
    T.bus.online.delete(gw2);
    T.bus.cfgs.length = 0;
    await put([nightOff()]);
    await until(() => lastCfg(gw1), 3000, 'cfg push');
    expect(lastCfg(gw2)).toBeUndefined();
    expect((await buildCfgBody(t.db, testConfig.DATA_ENC_KEY, gw2))!.rules).toEqual({ version: 4, rules: [] });
  });
});
