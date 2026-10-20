// A1: public-v1 전 엔드포인트의 모든 응답을 OpenAPI 스키마로 검증 + deviceType/data 가 siotMapper 결과와 같음(실측 fixture).
// A2 일부: POST /v1/webhooks/{id}/test 가 서명된 시험 이벤트를 큐에 넣음.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { SiotDevice } from '@siot/protocol';
import { webhookDeliveries } from '../../src/db/schema.js';
import { BOOT_A, connect, evtDevice, makeApp, openapiValidator, seedGateway, seedOrg, seedSite, useTestDb, type TestApp } from './helpers.js';

const t = useTestDb();
const v = openapiValidator('public-v1.yaml');
const agent = '../../../../../matter-gateway-poc/agent/src';

// agent/test/siotMapper.test.js 의 실기기 스냅샷(IKEA GRILLPLATS 플러그, MYGGBETT 도어 센서, 2026-10-20)
const grillplats = {
  node_id: 5, available: true, date_commissioned: '2026-10-20T00:35:21.617000',
  attributes: {
    '0/29/0': [{ '0': 22, '1': 4 }], '0/40/1': 'IKEA of Sweden', '0/40/2': 4476, '0/40/3': 'GRILLPLATS Plug', '0/40/4': 4096, '0/40/5': '', '0/40/10': '1.4.6',
    '1/29/0': [{ '0': 266, '1': 3 }], '1/29/1': [3, 4, 6, 29], '1/6/0': false, '1/6/16384': true,
    '2/29/0': [{ '0': 1296, '1': 1 }], '2/29/1': [29, 144, 145, 156],
    '2/144/4': 230000, '2/144/5': 0, '2/144/8': 0, '2/144/14': 60,
    '2/145/1': { '0': 0, '4': 61264 }, '2/145/5': { '0': 0, '1': 0, '2': 0, '3': 0 },
  },
};
const myggbett = {
  node_id: 6, available: true,
  attributes: {
    '0/29/0': [{ '0': 18, '1': 1 }, { '0': 17, '1': 1 }, { '0': 22, '1': 2 }],
    '0/40/1': 'IKEA of Sweden', '0/40/2': 4476, '0/40/3': 'MYGGBETT door/window sensor', '0/40/4': 32775, '0/40/10': '1.0.9',
    '0/47/0': 1, '0/47/2': 'Primary Battery', '0/47/11': 1588, '0/47/12': 200, '0/47/14': 0, '0/47/15': false,
    '1/29/0': [{ '0': 21, '1': 1 }], '1/69/0': false,
  },
};

let T: TestApp;
let key: string;
let siteId: string;
let site2: string;
let gw: string;
let mapped: SiotDevice[];

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, template: string, payload?: unknown, k = key): Promise<LightMyRequestResponse> {
  const res = await T.app.inject({ method, url, headers: { authorization: `Bearer ${k}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const body = res.body ? res.json() : undefined;
  const errors = v.response(method, template, res.statusCode, body);
  expect(errors, `${method} ${url} → ${res.statusCode} ${res.body}`).toEqual([]);
  expect(res.headers['siot-api-version']).toBe('2026-10-01');
  return res;
}

describe('public-v1 (A1)', () => {
  beforeAll(async () => {
    await t.truncate();
    T = await makeApp(t.db);
    const orgId = await seedOrg(t.db);
    siteId = await seedSite(t.db, orgId);
    site2 = await seedSite(t.db, orgId);
    gw = await seedGateway(t.db, orgId, siteId, 1);
    await seedGateway(t.db, orgId, site2, 2);
    key = (await T.ctx.apiKeys.issue(orgId, { name: 'partner', mode: 'test', scopes: ['devices:read', 'devices:control', 'webhooks:manage'] })).key;

    const { normalizeNode } = await import(`${agent}/model/normalize.js`);
    const { toSiotDevices } = await import(`${agent}/platform/siotMapper.js`);
    mapped = [...toSiotDevices(normalizeNode(grillplats)), ...toSiotDevices(normalizeNode(myggbett))].map((d: SiotDevice) => JSON.parse(JSON.stringify(d)));
    await connect(T, gw, mapped, BOOT_A, 0);
  });
  afterAll(async () => {
    await T.app.close();
  });

  it('deviceType/data 가 toSiotDevices(실측 fixture) 결과와 같다', async () => {
    const res = await call('GET', `/v1/sites/${siteId}/devices`, '/v1/sites/{siteId}/devices');
    const data = res.json().data as { deviceId: string; deviceType: string; data: unknown; name: string; vendor: string }[];
    expect(data).toHaveLength(2);
    for (const sd of mapped) {
      const d = T.ctx.cache.getDeviceByLocal(gw, sd.id)!;
      const api = data.find((x) => x.deviceId === d.deviceId)!;
      expect(api.deviceType).toBe(sd.deviceType);
      expect(api.data).toEqual(sd.data);
      expect(api.name).toBe(sd.name);
      expect(api.vendor).toBe(sd.vendor);
    }
    expect(data.map((d) => d.deviceType).sort()).toEqual(['BINARY_SENSOR', 'PLUG']);
  });

  it('모든 조회 엔드포인트 응답이 스키마와 일치', async () => {
    const sites = (await call('GET', '/v1/sites', '/v1/sites')).json();
    expect(sites.data).toHaveLength(2);
    expect(sites.nextCursor).toBeNull();
    const p1 = (await call('GET', '/v1/sites?limit=1', '/v1/sites')).json();
    expect(p1.data).toHaveLength(1);
    const p2 = (await call('GET', `/v1/sites?limit=1&cursor=${p1.nextCursor}`, '/v1/sites')).json();
    expect(p2.data[0].siteId).not.toBe(p1.data[0].siteId);
    expect(p2.nextCursor).toBeNull();
    expect((await call('GET', `/v1/sites/${siteId}`, '/v1/sites/{siteId}')).json()).toMatchObject({ siteId, gatewayCount: 1 });
    const gws = (await call('GET', `/v1/sites/${siteId}/gateways`, '/v1/sites/{siteId}/gateways')).json();
    expect(gws.data).toEqual([expect.objectContaining({ gatewayId: gw, online: true, deviceCount: 2, agentVersion: '0.9.0' })]);
    expect((await call('GET', `/v1/gateways/${gw}`, '/v1/gateways/{gatewayId}')).json().online).toBe(true);
    const dev = T.ctx.cache.getDeviceByLocal(gw, 'matter:5:1')!;
    expect((await call('GET', `/v1/devices/${dev.deviceId}`, '/v1/devices/{deviceId}')).json()).toMatchObject({ deviceId: dev.deviceId, siteId, gatewayId: gw });
    // 오류 응답도 스키마대로
    await call('GET', '/v1/sites?limit=0', '/v1/sites');
    await call('GET', '/v1/sites?cursor=@@', '/v1/sites');
    await call('GET', '/v1/sites/site_00000000000000000000000000', '/v1/sites/{siteId}');
    await call('GET', '/v1/sites/nope', '/v1/sites/{siteId}').then((r) => expect(r.statusCode).toBe(400));
    await call('GET', '/v1/sites', '/v1/sites', undefined, 'sk_test_' + 'x'.repeat(32)).then((r) => expect(r.statusCode).toBe(401));
  });

  it('제어: 결과는 HTTP 200 ControlResult(confirmed/offline/not_found), 잘못된 action 400', async () => {
    const dev = T.ctx.cache.getDeviceByLocal(gw, 'matter:5:1')!;
    let seq = 1;
    T.bus.handler = async (g, req) => {
      const body = JSON.parse(Buffer.from(req.body!, 'base64').toString());
      expect(req.path).toBe('/siot-app/api/v1/devices/matter%3A5%3A1/control');
      setTimeout(() => void T.ctx.cache.applyEvt(g, evtDevice(BOOT_A, seq++, [{ ...mapped[0]!, data: { ...mapped[0]!.data, switch: body.action === 'ON' } }])), 30);
      return { id: '1', status: 200 };
    };
    const on = (await call('POST', `/v1/devices/${dev.deviceId}/control`, '/v1/devices/{deviceId}/control', { action: 'ON' })).json();
    expect(on).toMatchObject({ status: 'confirmed', device: { data: { switch: true } } });
    const off = (await call('POST', `/v1/devices/${dev.deviceId}/control`, '/v1/devices/{deviceId}/control', { action: 'OFF' })).json();
    expect(off.status).toBe('confirmed');
    T.bus.handler = async () => ({ id: '1', status: 404 });
    expect((await call('POST', `/v1/devices/${dev.deviceId}/control`, '/v1/devices/{deviceId}/control', { action: 'ON' })).json()).toMatchObject({ status: 'not_found', device: null });
    await call('POST', `/v1/devices/${dev.deviceId}/control`, '/v1/devices/{deviceId}/control', { action: 'BLINK' }).then((r) => expect(r.statusCode).toBe(400));
    T.bus.online.delete(gw);
    expect((await call('POST', `/v1/devices/${dev.deviceId}/control`, '/v1/devices/{deviceId}/control', { action: 'ON' })).json().status).toBe('offline');
    T.bus.online.add(gw);
  });

  it('웹훅 CRUD + test(202, 서명된 시험 이벤트 적재)', async () => {
    const created = await call('POST', '/v1/webhooks', '/v1/webhooks', { url: 'https://partner.example.com/hook', events: ['device.state_changed', 'gateway.offline'] });
    expect(created.statusCode).toBe(201);
    const wh = created.json();
    expect(wh.secret).toMatch(/^whsec_[0-9A-Za-z]{32}$/);
    await call('POST', '/v1/webhooks', '/v1/webhooks', { url: 'http://partner.example.com/hook', events: ['device.state_changed'] }).then((r) => expect(r.statusCode).toBe(400));
    await call('POST', '/v1/webhooks', '/v1/webhooks', { url: 'https://x.example.com', events: ['nope'] }).then((r) => expect(r.statusCode).toBe(400));
    const list = (await call('GET', '/v1/webhooks', '/v1/webhooks')).json();
    expect(list.data).toEqual([expect.objectContaining({ webhookId: wh.webhookId, disabledAt: null })]);
    expect(list.data[0].secret).toBeUndefined();
    const test = await call('POST', `/v1/webhooks/${wh.webhookId}/test`, '/v1/webhooks/{webhookId}/test');
    expect(test.statusCode).toBe(202);
    const rows = await t.db.select().from(webhookDeliveries);
    const row = rows.find((r) => r.eventId === test.json().eventId)!;
    expect(v.schema('DeviceStateChangedEvent', row.payload)).toEqual([]);
    expect(row.payload).toMatchObject({ data: { test: true } });
    expect((await call('DELETE', `/v1/webhooks/${wh.webhookId}`, '/v1/webhooks/{webhookId}')).statusCode).toBe(204);
    expect((await call('DELETE', `/v1/webhooks/${wh.webhookId}`, '/v1/webhooks/{webhookId}')).statusCode).toBe(404);
    expect((await call('GET', '/v1/webhooks', '/v1/webhooks')).json().data).toHaveLength(0);
  });

  it('Siot-Api-Version: 요청 날짜 이하 최신 지원 버전, 형식 오류 400', async () => {
    const r = await T.app.inject({ url: '/v1/sites', headers: { authorization: `Bearer ${key}`, 'siot-api-version': '2027-01-01' } });
    expect(r.headers['siot-api-version']).toBe('2026-10-01');
    const bad = await T.app.inject({ url: '/v1/sites', headers: { authorization: `Bearer ${key}`, 'siot-api-version': 'latest' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_FAILED');
  });
});
