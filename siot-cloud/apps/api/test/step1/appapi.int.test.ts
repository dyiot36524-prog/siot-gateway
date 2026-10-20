// app-v1: 세션(argon2id·쿠키·30일 슬라이딩), CSRF, 역할 403 규칙(계획 §2 역할 권한, B4), 페어링 큐(GW 별 직렬·GW 간 병렬), SSE.
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EvtFrame } from '@siot/protocol';
import { pairingSessions, sessions, sites } from '../../src/db/schema.js';
import { BOOT_A, connect, evtDevice, jsonBody, makeApp, openapiValidator, plug, seedGateway, seedOrg, seedSite, seedUser, testConfig, useTestDb, type TestApp } from './helpers.js';

const t = useTestDb();
const v = openapiValidator('app-v1.yaml');
const ORIGIN = testConfig.APP_ORIGIN;

let T: TestApp;
const ids = { org: '', org2: '', siteOpen: '', siteHanded: '', siteOther: '', gw1: '', gw2: '', gw3: '', dev1: '', dev3: '' };
const cookies: Record<string, string> = {};

async function login(email: string, password: string) {
  const r = await T.app.inject({ method: 'POST', url: '/app/v1/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
  expect(r.statusCode, r.body).toBe(200);
  expect(v.response('POST', '/app/v1/auth/login', 200, r.json())).toEqual([]);
  const c = r.cookies.find((x) => x.name === 'siot_session')!;
  return { cookie: `siot_session=${c.value}`, raw: c, body: r.json() };
}

async function as(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, template: string, payload?: object) {
  const r = await T.app.inject({ method, url, headers: { cookie: cookies[who]!, ...(method === 'GET' ? {} : { origin: ORIGIN }) }, ...(payload ? { payload } : {}) });
  const body = r.body ? r.json() : undefined;
  expect(v.response(method, template, r.statusCode, body), `${who} ${method} ${url} → ${r.statusCode} ${r.body}`).toEqual([]);
  return r;
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('app-v1', () => {
  beforeAll(async () => {
    await t.truncate();
    T = await makeApp(t.db);
    ids.org = await seedOrg(t.db, 'A');
    ids.org2 = await seedOrg(t.db, 'B');
    const installer = await seedUser(t.db, 'installer', ids.org);
    const installer2 = await seedUser(t.db, 'installer', ids.org2);
    const resident = await seedUser(t.db, 'resident', null);
    const operator = await seedUser(t.db, 'operator', ids.org);
    ids.siteOpen = await seedSite(t.db, ids.org);
    ids.siteHanded = await seedSite(t.db, ids.org, { ownerUserId: resident.userId });
    ids.siteOther = await seedSite(t.db, ids.org2);
    ids.gw1 = await seedGateway(t.db, ids.org, ids.siteOpen, 11);
    ids.gw2 = await seedGateway(t.db, ids.org, ids.siteOpen, 12);
    ids.gw3 = await seedGateway(t.db, ids.org, ids.siteHanded, 13);
    await connect(T, ids.gw1, [plug('matter:5:1', false)], BOOT_A);
    await connect(T, ids.gw2, [], BOOT_A);
    await connect(T, ids.gw3, [plug('matter:5:1', true)], BOOT_A);
    ids.dev1 = T.ctx.cache.getDeviceByLocal(ids.gw1, 'matter:5:1')!.deviceId;
    ids.dev3 = T.ctx.cache.getDeviceByLocal(ids.gw3, 'matter:5:1')!.deviceId;
    for (const [k, u] of Object.entries({ installer, installer2, resident, operator })) cookies[k] = (await login(u.email, u.password)).cookie;
  });
  afterAll(async () => {
    await T.app.close();
  });

  it('로그인: httpOnly·SameSite=Lax 쿠키 30일, 원문은 저장하지 않음, 틀린 비번 401, me, logout', async () => {
    const u = await seedUser(t.db, 'installer', ids.org, 'correct-horse-1');
    const bad = await T.app.inject({ method: 'POST', url: '/app/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: u.email, password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_CREDENTIALS');
    const { cookie, raw, body } = await login(u.email.toUpperCase(), 'correct-horse-1');
    expect(body.user).toMatchObject({ userId: u.userId, role: 'installer', orgId: ids.org });
    expect(raw).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 2_592_000 });
    const rows = await t.db.select().from(sessions).where(eq(sessions.userId, u.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionHash).not.toBe(raw.value);
    expect(Math.round((rows[0]!.expiresAt.getTime() - Date.now()) / 86_400_000)).toBe(30);
    const me = await T.app.inject({ url: '/app/v1/me', headers: { cookie } });
    expect(me.json().user.userId).toBe(u.userId);
    expect((await T.app.inject({ url: '/app/v1/me' })).statusCode).toBe(401);
    const out = await T.app.inject({ method: 'POST', url: '/app/v1/auth/logout', headers: { cookie, origin: ORIGIN } });
    expect(out.statusCode).toBe(204);
    expect((await T.app.inject({ url: '/app/v1/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('CSRF: 상태 변경 요청은 Origin 이 앱과 같아야 한다', async () => {
    const r = await T.app.inject({ method: 'POST', url: '/app/v1/sites', headers: { cookie: cookies.installer!, origin: 'https://evil.example' }, payload: { name: 'x' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CSRF_ORIGIN_MISMATCH');
    const none = await T.app.inject({ method: 'POST', url: '/app/v1/sites', headers: { cookie: cookies.installer! }, payload: { name: 'x' } });
    expect(none.statusCode).toBe(403);
  });

  it('세대: installer 는 자기 조직, resident 는 소유, operator 는 전체. 생성은 installer 만', async () => {
    const list = async (who: string) => (await as(who, 'GET', '/app/v1/sites', '/app/v1/sites')).json().data.map((s: { siteId: string }) => s.siteId).sort();
    expect(await list('installer')).toEqual([ids.siteOpen, ids.siteHanded].sort());
    expect(await list('resident')).toEqual([ids.siteHanded]);
    expect(await list('operator')).toEqual([ids.siteOpen, ids.siteHanded, ids.siteOther].sort());
    const c = await as('installer', 'POST', '/app/v1/sites', '/app/v1/sites', { name: '101동 1203호', address: null });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ orgId: ids.org, handedOver: false, epoch: 1, gatewayCount: 0 });
    expect((await as('resident', 'POST', '/app/v1/sites', '/app/v1/sites', { name: 'x' })).statusCode).toBe(403);
    expect((await as('operator', 'POST', '/app/v1/sites', '/app/v1/sites', { name: 'x' })).statusCode).toBe(403);
    expect((await as('installer', 'POST', '/app/v1/sites', '/app/v1/sites', { name: '' })).statusCode).toBe(400);
    expect((await as('installer', 'GET', `/app/v1/sites/${ids.siteOther}`, '/app/v1/sites/{siteId}')).statusCode).toBe(403);
    expect((await as('installer2', 'GET', `/app/v1/sites/${ids.siteOpen}`, '/app/v1/sites/{siteId}')).statusCode).toBe(403);
    expect((await as('operator', 'GET', `/app/v1/sites/${ids.siteOpen}`, '/app/v1/sites/{siteId}')).statusCode).toBe(200);
    await t.db.delete(sites).where(eq(sites.siteId, c.json().siteId));
  });

  it('역할 403 매트릭스: operator 제어·기기 403, 인계 후 installer HANDED_OVER, 다른 세대 resident 403', async () => {
    T.bus.handler = async () => ({ id: '1', status: 404 });
    const ctl = (who: string, dev: string) => as(who, 'POST', `/app/v1/devices/${dev}/control`, '/app/v1/devices/{deviceId}/control', { action: 'ON' });
    const devs = (who: string, site: string) => as(who, 'GET', `/app/v1/sites/${site}/devices`, '/app/v1/sites/{siteId}/devices');

    expect((await ctl('installer', ids.dev1)).statusCode).toBe(200); // 인계 전 installer 제어 가능
    expect((await devs('installer', ids.siteOpen)).json().data).toHaveLength(1);

    const op = await ctl('operator', ids.dev1);
    expect(op.statusCode).toBe(403);
    expect((await devs('operator', ids.siteOpen)).statusCode).toBe(403);

    const handed = await ctl('installer', ids.dev3);
    expect(handed.statusCode).toBe(403);
    expect(handed.json().error.code).toBe('HANDED_OVER');
    expect((await devs('installer', ids.siteHanded)).json().error.code).toBe('HANDED_OVER');
    expect((await as('installer', 'PATCH', `/app/v1/devices/${ids.dev3}`, '/app/v1/devices/{deviceId}', { name: 'x' })).statusCode).toBe(403);

    expect((await ctl('resident', ids.dev3)).statusCode).toBe(200);
    expect((await devs('resident', ids.siteHanded)).json().data).toHaveLength(1);
    expect((await ctl('resident', ids.dev1)).statusCode).toBe(403);
    expect((await devs('resident', ids.siteOpen)).statusCode).toBe(403);
    expect((await ctl('installer2', ids.dev1)).statusCode).toBe(403);

    const patched = await as('resident', 'PATCH', `/app/v1/devices/${ids.dev3}`, '/app/v1/devices/{deviceId}', { name: '거실 플러그', room: '거실' });
    expect(patched.json()).toMatchObject({ name: '거실 플러그', room: '거실' });
    // 진단 응답(B4, gateways.ts): data 키 없음
    const diag = await as('installer', 'GET', `/app/v1/gateways/${ids.gw3}`, '/app/v1/gateways/{gatewayId}');
    expect(Object.keys(diag.json()).sort()).toEqual(['agentVersion', 'deviceCount', 'lastErrorCode', 'lastSeen', 'matterServerVersion', 'online']);
  });

  it('페어링 큐: GW 별 직렬, GW 간 병렬, evt pairing 으로 상태 갱신', async () => {
    let n = 0;
    const started: { gatewayId: string; local: string; code: string }[] = [];
    T.bus.handler = async (gatewayId, req) => {
      if (req.path !== '/siot-app/api/v1/pairing') return { id: '1', status: 404 };
      const local = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      started.push({ gatewayId, local, code: JSON.parse(Buffer.from(req.body!, 'base64').toString()).code });
      return { id: '1', status: 202, body: jsonBody({ ok: true, status: 'started', session: { sessionId: local, stage: 'queued' } }) };
    };
    const enq = (gw: string, code: string) => as('installer', 'POST', `/app/v1/gateways/${gw}/pairing`, '/app/v1/gateways/{gatewayId}/pairing', { code });
    const a = (await enq(ids.gw1, 'MT:AAAAAAAA')).json();
    const b = (await enq(ids.gw1, 'MT:BBBBBBBB')).json();
    const c = (await enq(ids.gw2, '34970112332')).json();
    expect([a.queuePosition, b.queuePosition, c.queuePosition]).toEqual([0, 1, 0]);
    await until(() => started.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(started.map((s) => [s.gatewayId, s.code])).toEqual(
      expect.arrayContaining([
        [ids.gw1, 'MT:AAAAAAAA'],
        [ids.gw2, '34970112332'],
      ]),
    );
    expect(started).toHaveLength(2); // gw1 의 두 번째는 대기
    const getP = (id: string) => as('installer', 'GET', `/app/v1/pairing/${id}`, '/app/v1/pairing/{pairingSessionId}');
    expect((await getP(b.pairingSessionId)).json()).toMatchObject({ status: 'queued', queuePosition: 1 });
    expect((await getP(a.pairingSessionId)).json()).toMatchObject({ status: 'running', queuePosition: 0 });

    const localA = started.find((s) => s.code === 'MT:AAAAAAAA')!.local;
    const pairEvt = (seq: number, stage: 'commissioning' | 'done', devices?: ReturnType<typeof plug>[]): EvtFrame => ({
      t: 'evt',
      bootId: BOOT_A,
      seq,
      keyVersion: 0,
      kind: 'pairing',
      at: new Date().toISOString(),
      data: { sessionId: localA, stage, ...(devices ? { deviceId: 'matter:9', devices } : {}) },
    });
    await T.ctx.cache.applyEvt(ids.gw1, pairEvt(1, 'commissioning'));
    await until(async () => (await getP(a.pairingSessionId)).json().stage === 'commissioning');
    await T.ctx.cache.applyEvt(ids.gw1, evtDevice(BOOT_A, 2, [plug('matter:9:1', false)]));
    await T.ctx.cache.applyEvt(ids.gw1, pairEvt(3, 'done', [plug('matter:9:1', false)]));
    await until(async () => (await getP(a.pairingSessionId)).json().status === 'done');
    const done = (await getP(a.pairingSessionId)).json();
    expect(done.deviceIds).toEqual([T.ctx.cache.getDeviceByLocal(ids.gw1, 'matter:9:1')!.deviceId]);
    const [row] = await t.db.select().from(pairingSessions).where(eq(pairingSessions.pairingSessionId, a.pairingSessionId));
    expect(row!.codeEnc).toBeNull(); // 완료 후 코드 삭제
    await until(() => started.length === 3); // gw1 다음 차례 시작
    expect(started[2]).toMatchObject({ gatewayId: ids.gw1, code: 'MT:BBBBBBBB' });
    // 권한: operator·다른 조직 403
    expect((await as('operator', 'POST', `/app/v1/gateways/${ids.gw1}/pairing`, '/app/v1/gateways/{gatewayId}/pairing', { code: 'MT:CCCCCCCC' })).statusCode).toBe(403);
    expect((await as('installer2', 'GET', `/app/v1/pairing/${a.pairingSessionId}`, '/app/v1/pairing/{pairingSessionId}')).statusCode).toBe(403);
  });

  it('SSE: device 이벤트가 흐르고 다른 세대 이벤트는 오지 않는다', async () => {
    await T.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (T.app.server.address() as AddressInfo).port;
    const chunks: string[] = [];
    const req = httpRequest({ host: '127.0.0.1', port, path: `/app/v1/sites/${ids.siteOpen}/events`, headers: { cookie: cookies.installer! } });
    const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      req.on('response', resolve).on('error', reject);
      req.end();
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    res.setEncoding('utf8');
    res.on('data', (c: string) => chunks.push(c));
    await until(() => chunks.join('').includes(': connected'));
    await T.ctx.cache.applyEvt(ids.gw3, evtDevice(BOOT_A, 1, [plug('matter:5:1', false)])); // 다른 세대
    await T.ctx.cache.applyEvt(ids.gw1, evtDevice(BOOT_A, 10, [plug('matter:5:1', true)]));
    await until(() => chunks.join('').includes('event: device\n'));
    const text = chunks.join('');
    const data = text
      .split('\n\n')
      .filter((b) => b.startsWith('event: device\n'))
      .map((b) => JSON.parse(b.split('\ndata: ')[1]!));
    expect(data.every((d) => d.siteId === ids.siteOpen)).toBe(true);
    expect(data.some((d) => d.deviceId === ids.dev1 && d.data.switch === true)).toBe(true);
    expect(v.schema('Device', data[0])).toEqual([]);
    req.destroy();
    // operator 는 403
    const op = await T.app.inject({ url: `/app/v1/sites/${ids.siteOpen}/events`, headers: { cookie: cookies.operator! } });
    expect(op.statusCode).toBe(403);
  });
});
