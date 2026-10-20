// A4 권한 매트릭스(공개 API), 키 수명(만료·폐기 401, 최대 2개), 속도 제한 429, A5 offline p99, C2 조회 중 req 0.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { apiKeys, webhooks } from '../../src/db/schema.js';
import { ApiKeyLimitError, API_KEY_PATTERN, hashApiKey } from '../../src/auth/apiKey.js';
import { encryptSecret } from '../../src/auth/secretBox.js';
import { newId } from '../../src/ids.js';
import { BOOT_A, connect, makeApp, plug, seedGateway, seedOrg, seedSite, testConfig, useTestDb, type TestApp } from './helpers.js';

const t = useTestDb();
let T: TestApp;
const A = { org: '', site: '', gw: '', dev: '', wh: '', key: '' };
const B = { org: '', site: '', gw: '', dev: '', wh: '', key: '' };

async function seedTenant(x: typeof A, n: number) {
  x.org = await seedOrg(t.db, `org${n}`);
  x.site = await seedSite(t.db, x.org);
  x.gw = await seedGateway(t.db, x.org, x.site, n);
  await connect(T, x.gw, [plug('matter:5:1', false)], BOOT_A);
  x.dev = T.ctx.cache.getDeviceByLocal(x.gw, 'matter:5:1')!.deviceId;
  x.wh = newId('wh');
  await t.db.insert(webhooks).values({ webhookId: x.wh, orgId: x.org, url: 'https://p.example.com', secretEnc: encryptSecret('s', testConfig.DATA_ENC_KEY), events: ['gateway.online'] });
  x.key = (await T.ctx.apiKeys.issue(x.org, { name: 'k', mode: 'live', scopes: ['devices:read', 'devices:control', 'webhooks:manage'] })).key;
}

const req = (method: 'GET' | 'POST' | 'DELETE', url: string, key: string, payload?: object) =>
  T.app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });

describe('A4 권한 매트릭스', () => {
  beforeAll(async () => {
    await t.truncate();
    T = await makeApp(t.db);
    await seedTenant(A, 1);
    await seedTenant(B, 2);
  });
  afterAll(async () => {
    await T.app.close();
  });

  it('다른 조직의 세대·GW·기기·웹훅은 전부 403', async () => {
    const cases: [string, 'GET' | 'POST' | 'DELETE', string, object?][] = [
      ['site', 'GET', `/v1/sites/${B.site}`],
      ['site gateways', 'GET', `/v1/sites/${B.site}/gateways`],
      ['site devices', 'GET', `/v1/sites/${B.site}/devices`],
      ['gateway', 'GET', `/v1/gateways/${B.gw}`],
      ['device', 'GET', `/v1/devices/${B.dev}`],
      ['control', 'POST', `/v1/devices/${B.dev}/control`, { action: 'ON' }],
      ['webhook delete', 'DELETE', `/v1/webhooks/${B.wh}`],
      ['webhook test', 'POST', `/v1/webhooks/${B.wh}/test`],
      ['unknown site', 'GET', '/v1/sites/site_00000000000000000000000000'],
      ['unknown device', 'GET', '/v1/devices/dev_00000000000000000000000000'],
    ];
    for (const [name, m, url, body] of cases) {
      const r = await req(m, url, A.key, body);
      expect(r.statusCode, name).toBe(403);
      expect(r.json().error.code, name).toBe('FORBIDDEN');
    }
    expect(T.bus.requests).toHaveLength(0); // 다른 조직 제어는 GW 까지 가지 않는다
    // 목록은 자기 조직만
    const sites = (await req('GET', '/v1/sites', A.key)).json().data.map((s: { siteId: string }) => s.siteId);
    expect(sites).toEqual([A.site]);
    const whs = (await req('GET', '/v1/webhooks', A.key)).json().data.map((w: { webhookId: string }) => w.webhookId);
    expect(whs).toEqual([A.wh]);
    // 자기 조직은 200
    expect((await req('GET', `/v1/devices/${A.dev}`, A.key)).statusCode).toBe(200);
  });

  it('스코프 부족 403 INSUFFICIENT_SCOPE', async () => {
    const ro = (await T.ctx.apiKeys.issue(A.org, { name: 'ro', mode: 'test', scopes: ['devices:read'], ttlDays: 1 })).key;
    expect((await req('GET', `/v1/devices/${A.dev}`, ro)).statusCode).toBe(200);
    const c = await req('POST', `/v1/devices/${A.dev}/control`, ro, { action: 'ON' });
    expect(c.statusCode).toBe(403);
    expect(c.json().error.code).toBe('INSUFFICIENT_SCOPE');
    expect((await req('GET', '/v1/webhooks', ro)).json().error.code).toBe('INSUFFICIENT_SCOPE');
    // 조직당 활성 키 최대 2개
    await expect(T.ctx.apiKeys.issue(A.org, { name: 'third', mode: 'live', scopes: ['devices:read'] })).rejects.toBeInstanceOf(ApiKeyLimitError);
    const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.hash, hashApiKey(ro)));
    await T.ctx.apiKeys.revoke(row!.apiKeyId);
  });

  it('만료·폐기 키는 401(폐기 직후 첫 요청부터), 형식·누락 401', async () => {
    const issued = await T.ctx.apiKeys.issue(A.org, { name: 'tmp', mode: 'test', scopes: ['devices:read'] });
    expect(issued.key).toMatch(API_KEY_PATTERN);
    expect(issued.prefix).toBe(issued.key.slice(0, 12));
    const [stored] = await t.db.select().from(apiKeys).where(eq(apiKeys.apiKeyId, issued.apiKeyId));
    expect(stored!.hash).toBe(hashApiKey(issued.key));
    expect(JSON.stringify(stored)).not.toContain(issued.key);
    expect(Math.round((stored!.expiresAt.getTime() - stored!.createdAt.getTime()) / 86_400_000)).toBe(365);
    await expect(T.ctx.apiKeys.issue(A.org, { name: 'x', mode: 'test', scopes: ['devices:read'], ttlDays: 731 })).rejects.toBeInstanceOf(RangeError);

    expect((await req('GET', '/v1/sites', issued.key)).statusCode).toBe(200);
    await T.ctx.apiKeys.revoke(issued.apiKeyId);
    const after = await req('GET', '/v1/sites', issued.key);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('UNAUTHORIZED');

    const exp = await T.ctx.apiKeys.issue(A.org, { name: 'exp', mode: 'test', scopes: ['devices:read'] });
    await t.db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.apiKeyId, exp.apiKeyId));
    expect((await req('GET', '/v1/sites', exp.key)).statusCode).toBe(401);
    expect((await T.app.inject({ url: '/v1/sites' })).statusCode).toBe(401);
    expect((await req('GET', '/v1/sites', 'sk_live_short')).statusCode).toBe(401);
  });

  it('키당 20 req/s 버스트 40 → 429 + Retry-After', async () => {
    const codes: number[] = [];
    let retry: string | undefined;
    for (let i = 0; i < 45; i++) {
      const r = await req('GET', `/v1/sites/${B.site}`, B.key);
      codes.push(r.statusCode);
      if (r.statusCode === 429) retry = r.headers['retry-after'] as string;
    }
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(40);
    expect(codes).toContain(429);
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
  });

  it('기기당 제어 5 req/s → 429', async () => {
    T.bus.handler = async () => ({ id: '1', status: 404 });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await req('POST', `/v1/devices/${A.dev}/control`, A.key, { action: 'ON' })).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toContain(429);
  });
});

describe('A5 감지된 offline 제어 p99 ≤300ms, 조회는 캐시 + online:false / C2 조회 1,000회 req 0', () => {
  beforeAll(async () => {
    await t.truncate();
    T = await makeApp(t.db, { rateLimits: { keyPerSec: 100_000, keyBurst: 100_000, devicePerSec: 100_000 } });
    await seedTenant(A, 3);
  });
  afterAll(async () => {
    await T.app.close();
  });

  it('A5: offline 100회', async () => {
    T.bus.online.delete(A.gw); // 감지된 미연결(WS 종료/25초 무응답)
    await T.ctx.cache.setGatewayOnline(A.gw, false);
    const lat: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const r = await req('POST', `/v1/devices/${A.dev}/control`, A.key, { action: i % 2 ? 'OFF' : 'ON' });
      lat.push(performance.now() - t0);
      expect(r.statusCode).toBe(200);
      expect(r.json().status).toBe('offline');
    }
    lat.sort((a, b) => a - b);
    const p99 = lat[98]!;
    expect(p99).toBeLessThanOrEqual(300);
    const d = (await req('GET', `/v1/devices/${A.dev}`, A.key)).json();
    expect(d.online).toBe(false);
    expect(d.data).toEqual({ switch: false });
    const g = (await req('GET', `/v1/gateways/${A.gw}`, A.key)).json();
    expect(g.online).toBe(false);
    expect(T.bus.requests).toHaveLength(0);
  });

  it('C2: 조회 1,000회 동안 relay req 0', async () => {
    T.bus.online.add(A.gw);
    await T.ctx.cache.setGatewayOnline(A.gw, true);
    const before = T.bus.requests.length;
    const urls = [`/v1/devices/${A.dev}`, `/v1/sites/${A.site}/devices`, `/v1/gateways/${A.gw}`, `/v1/sites/${A.site}/gateways`];
    let ok = 0;
    for (let i = 0; i < 1000; i++) {
      const r = await req('GET', urls[i % urls.length]!, A.key);
      if (r.statusCode === 200) ok++;
    }
    expect(ok).toBe(1000);
    expect(T.bus.requests.length - before).toBe(0);
    expect(await T.ctx.metrics.relayRequests.get().then((m) => m.values[0]?.value ?? 0)).toBe(0);
  });
});
