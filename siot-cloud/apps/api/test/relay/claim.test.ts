// claim API(B2) — 실제 Postgres(siot_relay_test). 응답 코드 전부, FOR UPDATE 직렬화, 세대 키 v1, 인수(takeover), 조회 권한(B4),
// 그리고 drizzle GatewayRepo(재발급 횟수, site_reset_pending → bound).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type postgres from 'postgres';
import type { Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { auditLog, gateways, organizations, siteKeys, sites, users } from '../../src/db/schema.js';
import type { SessionService, SessionUser } from '../../src/auth/session.js';
import type { AppApiDeps } from '../../src/appapi/index.js';
import type { GatewayBus } from '../../src/relay/GatewayBus.js';
import { registerGatewayClaim } from '../../src/appapi/gateways.js';
import { claimSecretFor, decryptSecret, sha256Hex } from '../../src/relay/crypto.js';
import { createDbGatewayRepo } from '../../src/relay/repo.js';
import { freshDb, GwKey, pgAvailable, TEST_CONFIG } from './helpers.js';

const config = TEST_CONFIG as unknown as Config;
const hasPg = await pgAvailable();

const id = (p: string) => `${p}_${ulid()}`;
const gwId = () => `gw_${crypto.randomUUID()}`;
const secret = (g: string) => claimSecretFor(config.LABEL_MASTER_KEY, g);
const dashed = (s: string) => s.match(/.{4}/g)!.join('-').toUpperCase();

class FakeBus implements Partial<GatewayBus> {
  binds: Array<{ gatewayId: string; gatewayToken: string; siteId: string }> = [];
  cfgs: Array<{ gatewayId: string; cfg: unknown }> = [];
  online = new Set<string>();
  bindResult = false;
  isOnline = (g: string) => this.online.has(g);
  sendBind = async (gatewayId: string, b: { gatewayToken: string; siteId: string }) => {
    this.binds.push({ gatewayId, ...b });
    return this.bindResult;
  };
  sendCfg = async (gatewayId: string, cfg: unknown) => {
    this.cfgs.push({ gatewayId, cfg });
    return this.online.has(gatewayId);
  };
}

describe.skipIf(!hasPg)('claim API (Postgres)', () => {
  let db: Db;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let bus: FakeBus;
  const sessionUsers = new Map<string, SessionUser>();
  const reloaded: string[] = [];

  const orgA = id('org');
  const orgB = id('org');
  const instA: SessionUser = { userId: id('usr'), orgId: orgA, role: 'installer', email: 'a@x', name: 'A' };
  const instB: SessionUser = { userId: id('usr'), orgId: orgB, role: 'installer', email: 'b@x', name: 'B' };
  const opA: SessionUser = { userId: id('usr'), orgId: orgA, role: 'operator', email: 'o@x', name: 'O' };
  const resident: SessionUser = { userId: id('usr'), orgId: null, role: 'resident', email: 'r@x', name: 'R' };

  async function provision(orgId = orgA, over: Partial<typeof gateways.$inferInsert> = {}) {
    const g = gwId();
    await db.insert(gateways).values({ gatewayId: g, shortId: g.slice(3, 11), orgId, pubkey: new GwKey().pubKey, ...over });
    return g;
  }
  async function site(orgId = orgA, over: Partial<typeof sites.$inferInsert> = {}) {
    const s = id('site');
    await db.insert(sites).values({ siteId: s, orgId, name: '101동 101호', ...over });
    return s;
  }
  const claim = (body: object, user: SessionUser | null = instA) =>
    app.inject({ method: 'POST', url: '/app/v1/gateways/claim', payload: body, headers: user ? { 'x-test-user': user.userId } : {} });
  const getRow = async (g: string) => (await db.select().from(gateways).where(eq(gateways.gatewayId, g)))[0]!;

  beforeAll(async () => {
    ({ db, sql } = await freshDb('siot_relay_test'));
    await db.insert(organizations).values([
      { orgId: orgA, name: 'A 설치사' },
      { orgId: orgB, name: 'B 설치사' },
    ]);
    for (const u of [instA, instB, opA, resident]) {
      sessionUsers.set(u.userId, u);
      await db.insert(users).values({ userId: u.userId, orgId: u.orgId, role: u.role, email: u.email, name: u.name, passwordHash: 'x' });
    }
    const sessions: SessionService = {
      login: async () => null,
      logout: async () => {},
      authenticate: async (req: FastifyRequest) => sessionUsers.get(String(req.headers['x-test-user'])) ?? null,
      hashPassword: async (p) => p,
    };
    bus = new FakeBus();
    app = Fastify({ logger: false });
    const deps = { config, db, bus: bus as unknown as GatewayBus, sessions, cache: { reloadGateway: async (g: string) => void reloaded.push(g) } } as unknown as AppApiDeps;
    await registerGatewayClaim(app, deps);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });
  beforeEach(() => {
    bus.binds = [];
    bus.cfgs = [];
    bus.bindResult = false;
    reloaded.length = 0;
  });

  // ---------------------------------------------------------------- 인증·검증
  it('401 without session, 403 FORBIDDEN for non-installer, 400 VALIDATION_FAILED for bad body', async () => {
    const g = await provision();
    const s = await site();
    expect((await claim({ gatewayId: g, claimSecret: secret(g), siteId: s }, null)).statusCode).toBe(401);
    const op = await claim({ gatewayId: g, claimSecret: secret(g), siteId: s }, opA);
    expect(op.statusCode).toBe(403);
    expect(op.json().error.code).toBe('FORBIDDEN');
    const both = await claim({ gatewayId: g, shortId: g.slice(3, 11), claimSecret: secret(g), siteId: s });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe('VALIDATION_FAILED');
    expect((await claim({ gatewayId: g, claimSecret: 'zz', siteId: s })).statusCode).toBe(400);
  });

  it('400 INVALID_CLAIM_SECRET (gatewayId and shortId paths)', async () => {
    const g = await provision();
    const s = await site();
    for (const body of [
      { gatewayId: g, claimSecret: '0000000000000000', siteId: s },
      { shortId: `siot-${g.slice(3, 11)}`, claimSecret: '0000-0000-0000-0000', siteId: s },
    ]) {
      const r = await claim(body);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('INVALID_CLAIM_SECRET');
    }
    expect((await getRow(g)).status).toBe('unbound');
  });

  it('409 GATEWAY_NOT_PROVISIONED for unknown gateway (id or shortId) and empty pubkey', async () => {
    const s = await site();
    const g = gwId();
    let r = await claim({ gatewayId: g, claimSecret: secret(g), siteId: s });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'GATEWAY_NOT_PROVISIONED']);
    r = await claim({ shortId: g.slice(3, 11), claimSecret: secret(g), siteId: s });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'GATEWAY_NOT_PROVISIONED']);
    const nokey = await provision(orgA, { pubkey: '' });
    r = await claim({ gatewayId: nokey, claimSecret: secret(nokey), siteId: s });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'GATEWAY_NOT_PROVISIONED']);
  });

  it('403 GATEWAY_ORG_MISMATCH; 404 site; 403 FORBIDDEN other-org site; 403 HANDED_OVER', async () => {
    const gA = await provision(orgA);
    const sB = await site(orgB);
    let r = await claim({ gatewayId: gA, claimSecret: secret(gA), siteId: sB }, instB);
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'GATEWAY_ORG_MISMATCH']);
    r = await claim({ gatewayId: gA, claimSecret: secret(gA), siteId: id('site') });
    expect([r.statusCode, r.json().error.code]).toEqual([404, 'NOT_FOUND']);
    r = await claim({ gatewayId: gA, claimSecret: secret(gA), siteId: sB });
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'FORBIDDEN']);
    const handed = await site(orgA, { ownerUserId: resident.userId, handedOverAt: new Date() });
    r = await claim({ gatewayId: gA, claimSecret: secret(gA), siteId: handed });
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'HANDED_OVER']);
  });

  // ---------------------------------------------------------------- 성공
  it('200: token hash only, status bound, cfg_version+1, site key v1 (AES-GCM), audit, bind + cfg; then 409 ALREADY_BOUND', async () => {
    const g = await provision();
    const s = await site();
    const r = await claim({ shortId: `siot-${g.slice(3, 11)}`, claimSecret: dashed(secret(g)), siteId: s });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ gatewayId: g, shortId: g.slice(3, 11), siteId: s, status: 'bound', online: false, deviceCount: 0, claimWindowUntil: null });
    expect(JSON.stringify(body)).not.toMatch(/token/i);

    const row = await getRow(g);
    expect(row).toMatchObject({ status: 'bound', siteId: s, cfgVersion: 1, keyVersion: 1, claimWindowUntil: null });
    expect(bus.binds).toHaveLength(1);
    expect(bus.binds[0]!.siteId).toBe(s);
    expect(bus.binds[0]!.gatewayToken).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).toBe(sha256Hex(bus.binds[0]!.gatewayToken));

    const keys = await db.select().from(siteKeys).where(eq(siteKeys.siteId, s));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ version: 1, epoch: 1, retiredAt: null });
    const raw = decryptSecret(config.DATA_ENC_KEY, keys[0]!.keyEnc);
    expect(raw.length).toBe(32);

    // bound 를 못 받았으므로(미접속) cfg 도 시도: M1 cfg — keys v1, peers 없음, rules v0, thread 없음
    expect(bus.cfgs).toHaveLength(1);
    expect(bus.cfgs[0]!.cfg).toEqual({ cfgVersion: 1, siteId: s, keys: [{ v: 1, key: raw.toString('base64url') }], peers: [], rules: { version: 0, rules: [] } });
    expect(reloaded).toEqual([g]);

    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, 'gateway.claim'), eq(auditLog.targetId, g)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'user', actorId: instA.userId, orgId: orgA });

    const again = await claim({ gatewayId: g, claimSecret: secret(g), siteId: s });
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'GATEWAY_ALREADY_BOUND']);
  });

  it('second GW in the same site reuses the site key; both get cfg with each other as peers; bound → no direct cfg', async () => {
    const s = await site();
    const g1 = await provision();
    const g2 = await provision();
    expect((await claim({ gatewayId: g1, claimSecret: secret(g1), siteId: s })).statusCode).toBe(200);
    bus.cfgs = [];
    bus.online.add(g1);
    bus.bindResult = true; // g2 는 접속 중이라 bound 를 받음 → 토큰 재접속의 cfg 단계에서 cfg 를 받는다
    expect((await claim({ gatewayId: g2, claimSecret: secret(g2), siteId: s })).statusCode).toBe(200);
    expect(await db.select().from(siteKeys).where(eq(siteKeys.siteId, s))).toHaveLength(1);
    expect(bus.cfgs.map((c) => c.gatewayId)).toEqual([g1]);
    expect((bus.cfgs[0]!.cfg as { peers: unknown[]; cfgVersion: number }).peers).toEqual([{ gatewayId: g2, lan: [], mleid: null }]);
    expect((await getRow(g1)).cfgVersion).toBe(2);
    expect((await getRow(g2)).cfgVersion).toBe(1);
    bus.online.delete(g1);
  });

  it('concurrent claims of the same GW are serialized by FOR UPDATE: exactly one 200, the other 409', async () => {
    const g = await provision();
    const s1 = await site();
    const s2 = await site();
    const rs = await Promise.all([claim({ gatewayId: g, claimSecret: secret(g), siteId: s1 }), claim({ gatewayId: g, claimSecret: secret(g), siteId: s2 })]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.statusCode === 409)!.json().error.code).toBe('GATEWAY_ALREADY_BOUND');
  });

  // ---------------------------------------------------------------- claim 창
  it('423 CLAIM_WINDOW_CLOSED outside the 24h window (bound after reset, or factory-reset unbound)', async () => {
    const old = await site();
    const s = await site();
    const past = new Date(Date.now() - 1000);
    const g1 = await provision(orgA, { status: 'bound', siteId: old, claimWindowUntil: past, tokenHash: sha256Hex('a') });
    const g2 = await provision(orgA, { status: 'unbound', claimWindowUntil: past });
    for (const g of [g1, g2]) {
      const r = await claim({ gatewayId: g, claimSecret: secret(g), siteId: s });
      expect([r.statusCode, r.json().error.code]).toEqual([423, 'CLAIM_WINDOW_CLOSED']);
    }
  });

  it('inside the window after site reset: claimer takes over every GW of the vacant site (audit gateway.takeover)', async () => {
    const vacant = await site(orgA, { epoch: 2 });
    const target = await site();
    const until = new Date(Date.now() + 3600_000);
    const g1 = await provision(orgA, { status: 'bound', siteId: vacant, claimWindowUntil: until, cfgVersion: 4, tokenHash: sha256Hex('old1') });
    const g2 = await provision(orgA, { status: 'site_reset_pending', siteId: vacant, claimWindowUntil: until, cfgVersion: 4, tokenHash: sha256Hex('old2') });
    const r = await claim({ gatewayId: g1, claimSecret: secret(g1), siteId: target });
    expect(r.statusCode).toBe(200);
    const [r1, r2] = [await getRow(g1), await getRow(g2)];
    expect(r1).toMatchObject({ siteId: target, status: 'bound', cfgVersion: 5, claimWindowUntil: null });
    expect(r1.tokenHash).not.toBe(sha256Hex('old1'));
    expect(r2).toMatchObject({ siteId: target, status: 'bound', cfgVersion: 5, claimWindowUntil: null, tokenHash: sha256Hex('old2') });
    const t = await db.select().from(auditLog).where(and(eq(auditLog.action, 'gateway.takeover'), eq(auditLog.targetId, target)));
    expect(t).toHaveLength(1);
    expect((t[0]!.data as { gatewayIds: string[] }).gatewayIds.sort()).toEqual([g1, g2].sort());
    expect(reloaded.sort()).toEqual([g1, g2].sort());
  });

  // ---------------------------------------------------------------- 조회(B4)
  it('GET gateway(s): full before handover, diagnostics only after (no data key); resident sees own site only', async () => {
    const s = await site();
    const g = await provision();
    expect((await claim({ gatewayId: g, claimSecret: secret(g), siteId: s })).statusCode).toBe(200);
    const get = (url: string, u: SessionUser) => app.inject({ url, headers: { 'x-test-user': u.userId } });

    let r = await get(`/app/v1/gateways/${g}`, instA);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveProperty('status', 'bound');
    expect((await get(`/app/v1/gateways/${g}`, instB)).statusCode).toBe(403);
    expect((await get(`/app/v1/gateways/${g}`, resident)).statusCode).toBe(403);
    expect((await get(`/app/v1/gateways/${gwId()}`, instA)).statusCode).toBe(404);
    // operator 는 조직과 무관하게 진단만(계획 §2 역할 권한)
    const opB: SessionUser = { userId: instB.userId, orgId: orgB, role: 'operator', email: 'ob@x', name: 'OB' };
    sessionUsers.set('op-b', opB);
    r = await app.inject({ url: `/app/v1/gateways/${g}`, headers: { 'x-test-user': 'op-b' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).not.toHaveProperty('status');

    await db.update(sites).set({ ownerUserId: resident.userId, handedOverAt: new Date() }).where(eq(sites.siteId, s));
    const diagKeys = ['agentVersion', 'deviceCount', 'lastErrorCode', 'lastSeen', 'matterServerVersion', 'online'];
    for (const u of [instA, opA]) {
      r = await get(`/app/v1/gateways/${g}`, u);
      expect(Object.keys(r.json()).sort()).toEqual(diagKeys);
      expect(r.json()).not.toHaveProperty('data');
      r = await get(`/app/v1/sites/${s}/gateways`, u);
      expect(Object.keys(r.json().data[0]).sort()).toEqual(diagKeys);
    }
    r = await get(`/app/v1/sites/${s}/gateways`, resident);
    expect(r.json().data[0]).toMatchObject({ gatewayId: g, siteId: s });
  });

  // ---------------------------------------------------------------- drizzle repo
  it('repo: reissueToken replaces hash and counts 24h reissues; cfg_ack moves site_reset_pending → bound', async () => {
    const repo = createDbGatewayRepo(db, config.DATA_ENC_KEY);
    const s = await site();
    const g = await provision(orgA, { status: 'site_reset_pending', siteId: s, cfgVersion: 3, tokenHash: sha256Hex('x') });
    const at = new Date();
    expect((await repo.reissueToken(g, sha256Hex('n1'), at)).recentCount).toBe(1);
    expect((await repo.reissueToken(g, sha256Hex('n2'), at)).recentCount).toBe(2);
    expect((await getRow(g)).tokenHash).toBe(sha256Hex('n2'));
    await repo.recordCfgAck(g, { t: 'cfg_ack', cfgVersion: 2, keyVersion: 1, rulesVersion: 0 });
    expect((await getRow(g)).status).toBe('site_reset_pending');
    await repo.recordCfgAck(g, { t: 'cfg_ack', cfgVersion: 3, keyVersion: 2, rulesVersion: 0 });
    expect(await getRow(g)).toMatchObject({ status: 'bound', cfgAckedVersion: 3, keyVersion: 2 });
    expect(await repo.get(g)).toMatchObject({ gatewayId: g, orgId: orgA, siteId: s, status: 'bound', cfgVersion: 3 });
  });
});
