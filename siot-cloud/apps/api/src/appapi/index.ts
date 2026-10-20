// 소유: Step 1 실행자(단 gateways.ts 의 claim 은 Step 2). 계약: openapi/app-v1.yaml (/app/v1/*).
// 전역 훅: CSRF(상태 변경 요청은 Origin == APP_ORIGIN, 아니면 403 CSRF_ORIGIN_MISMATCH) → 세션(로그인 제외 401).
// 역할 403 규칙은 auth/roles.ts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { sites, gateways } from '../db/schema.js';
import type { SessionService, SessionUser } from '../auth/session.js';
import { requireControl, requireFull, requireVisible } from '../auth/roles.js';
import { TokenBucket } from '../auth/rateLimit.js';
import type { StateCache } from '../cache/StateCache.js';
import type { GatewayBus } from '../relay/GatewayBus.js';
import type { Outbox } from '../webhooks/Outbox.js';
import type { Metrics } from '../metrics/index.js';
import { HttpError, badRequest, forbidden, notFound, pageFromRows, parsePage, unauthorized } from '../http.js';
import { ID_PATTERNS, newId } from '../ids.js';
import type { ControlCoordinator } from '../public/ControlCoordinator.js';
import { parseControlBody } from '../public/index.js';
import { toAppSite } from '../public/views.js';
import { registerGatewayClaim } from './gateways.js';
import { PairingQueue } from './pairing.js';
import { registerSiteEvents } from './events.js';

export interface AppApiDeps {
  config: Config;
  db: Db;
  cache: StateCache;
  bus: GatewayBus;
  sessions: SessionService;
  outbox: Outbox;
  metrics: Metrics;
  control: ControlCoordinator;
  /** 페어링 정체 정리 주기(0 이면 끔, 테스트) */
  pairingSweepMs?: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOGIN_PATH = '/app/v1/auth/login';

export function sessionUser(req: FastifyRequest): SessionUser {
  if (!req.sessionUser) throw unauthorized();
  return req.sessionUser;
}

function check(kind: keyof typeof ID_PATTERNS, v: string, label: string): void {
  if (!ID_PATTERNS[kind].test(v)) throw badRequest(`${label} 형식이 올바르지 않습니다`);
}

function strictBody(body: unknown, allowed: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('JSON 본문이 필요합니다');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw badRequest(`알 수 없는 필드: ${k}`);
  return body as Record<string, unknown>;
}

export async function registerAppApi(app: FastifyInstance, deps: AppApiDeps): Promise<{ pairing: PairingQueue }> {
  const { db, cache, config } = deps;
  const loginLimiter = new TokenBucket(0.2, 10);
  const pairing = new PairingQueue({ db, bus: deps.bus, cache, encKey: config.DATA_ENC_KEY, log: app.log });
  app.addHook('onReady', async () => pairing.start(deps.pairingSweepMs));
  app.addHook('onClose', async () => pairing.stop());

  async function loadSite(siteId: string) {
    check('site', siteId, 'siteId');
    const [s] = await db.select().from(sites).where(eq(sites.siteId, siteId)).limit(1);
    if (!s) throw notFound('세대가 없습니다');
    return s;
  }

  async function gatewayView(gatewayId: string) {
    check('gateway', gatewayId, 'gatewayId');
    let g = cache.getGateway(gatewayId);
    if (!g) {
      await cache.reloadGateway(gatewayId);
      g = cache.getGateway(gatewayId);
    }
    if (!g) throw notFound('게이트웨이가 없습니다');
    return g;
  }

  async function gatewayCounts(siteIds: string[]) {
    if (!siteIds.length) return new Map<string, number>();
    const rows = await db
      .select({ siteId: gateways.siteId, n: count() })
      .from(gateways)
      .where(inArray(gateways.siteId, siteIds))
      .groupBy(gateways.siteId);
    return new Map(rows.map((r) => [r.siteId!, r.n]));
  }

  async function deviceSite(deviceId: string) {
    check('dev', deviceId, 'deviceId');
    const ref = cache.resolveDevice(deviceId);
    if (!ref?.siteId || !cache.getDevice(deviceId)) throw notFound('기기가 없습니다');
    return loadSite(ref.siteId);
  }

  await app.register(async (r) => {
    r.addHook('onRequest', async (req, reply) => {
      if (!SAFE_METHODS.has(req.method)) {
        const origin = req.headers.origin;
        if (origin !== config.APP_ORIGIN) throw forbidden('요청 출처(Origin)가 앱과 다릅니다', 'CSRF_ORIGIN_MISMATCH');
      }
      if (req.url.split('?')[0] === LOGIN_PATH) return;
      const user = await deps.sessions.authenticate(req, reply);
      if (!user) throw unauthorized('로그인이 필요합니다');
      req.sessionUser = user;
      req.log = req.log.child({ userId: user.userId });
    });

    // ---- auth ----
    r.post<{ Body: unknown }>(LOGIN_PATH, async (req, reply) => {
      const rl = loginLimiter.take(req.ip);
      if (!rl.ok) throw new HttpError(429, 'RATE_LIMITED', '로그인 시도가 너무 많습니다', { 'Retry-After': String(rl.retryAfterSec) });
      const b = strictBody(req.body, ['email', 'password']);
      if (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(b.email) || b.email.length > 320) throw badRequest('email 이 올바르지 않습니다');
      if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 256) throw badRequest('password 는 8~256자입니다');
      const user = await deps.sessions.login(b.email, b.password, reply, req.headers['user-agent']);
      if (!user) throw unauthorized('이메일 또는 비밀번호가 올바르지 않습니다', 'INVALID_CREDENTIALS');
      return { user };
    });

    r.post('/app/v1/auth/logout', async (req, reply) => {
      await deps.sessions.logout(req, reply);
      return reply.code(204).send();
    });

    r.get('/app/v1/me', async (req) => ({ user: sessionUser(req) }));

    // ---- sites ----
    r.get('/app/v1/sites', async (req) => {
      const user = sessionUser(req);
      const page = parsePage(req.query);
      const scope =
        user.role === 'operator' ? undefined : user.role === 'installer' ? eq(sites.orgId, user.orgId ?? '') : eq(sites.ownerUserId, user.userId);
      const rows = await db
        .select()
        .from(sites)
        .where(and(scope, page.after ? gt(sites.siteId, page.after) : undefined))
        .orderBy(asc(sites.siteId))
        .limit(page.limit + 1);
      const p = pageFromRows(rows, (s) => s.siteId, page.limit);
      const counts = await gatewayCounts(p.data.map((s) => s.siteId));
      return { data: p.data.map((s) => toAppSite(s, counts.get(s.siteId) ?? 0)), nextCursor: p.nextCursor };
    });

    r.post<{ Body: unknown }>('/app/v1/sites', async (req, reply) => {
      const user = sessionUser(req);
      if (user.role !== 'installer' || !user.orgId) throw forbidden('세대는 기사만 만들 수 있습니다');
      const b = strictBody(req.body, ['name', 'address']);
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) throw badRequest('name 은 1~100자입니다');
      if (b.address !== undefined && b.address !== null && (typeof b.address !== 'string' || b.address.length > 300)) throw badRequest('address 는 300자 이하입니다');
      const [s] = await db
        .insert(sites)
        .values({ siteId: newId('site'), orgId: user.orgId, name: b.name.trim(), address: (b.address as string | null | undefined) ?? null, createdByUserId: user.userId })
        .returning();
      return reply.code(201).send(toAppSite(s!, 0));
    });

    r.get<{ Params: { siteId: string } }>('/app/v1/sites/:siteId', async (req) => {
      const s = await loadSite(req.params.siteId);
      requireVisible(sessionUser(req), s);
      const counts = await gatewayCounts([s.siteId]);
      return toAppSite(s, counts.get(s.siteId) ?? 0);
    });

    // GET /app/v1/sites/{siteId}/gateways, GET /app/v1/gateways/{gatewayId} 는 gateways.ts(Step 2) 가 등록한다.

    // ---- devices ----
    r.get<{ Params: { siteId: string } }>('/app/v1/sites/:siteId/devices', async (req) => {
      const s = await loadSite(req.params.siteId);
      requireFull(sessionUser(req), s);
      return { data: cache.getSiteDevices(s.siteId) };
    });

    r.patch<{ Params: { deviceId: string }; Body: unknown }>('/app/v1/devices/:deviceId', async (req) => {
      const s = await deviceSite(req.params.deviceId);
      requireFull(sessionUser(req), s);
      const b = strictBody(req.body, ['name', 'room']);
      if (!Object.keys(b).length) throw badRequest('name 또는 room 이 필요합니다');
      const patch: { name?: string; room?: string | null } = {};
      if (b.name !== undefined) {
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) throw badRequest('name 은 1~100자입니다');
        patch.name = b.name.trim();
      }
      if (b.room !== undefined) {
        if (b.room !== null && (typeof b.room !== 'string' || b.room.length > 50)) throw badRequest('room 은 50자 이하 또는 null 입니다');
        patch.room = b.room as string | null;
      }
      const d = await cache.updateDeviceMeta(req.params.deviceId, patch);
      if (!d) throw notFound('기기가 없습니다');
      return d;
    });

    r.post<{ Params: { deviceId: string }; Body: unknown }>('/app/v1/devices/:deviceId/control', async (req) => {
      const action = parseControlBody(req.body);
      const s = await deviceSite(req.params.deviceId);
      requireControl(sessionUser(req), s);
      const retry = deps.control.rateLimit(req.params.deviceId);
      if (retry !== null) throw new HttpError(429, 'RATE_LIMITED', '이 기기에 대한 제어 요청이 너무 많습니다', { 'Retry-After': String(retry) });
      return deps.control.control(req.params.deviceId, action, req.t0);
    });

    // ---- pairing ----
    r.post<{ Params: { gatewayId: string }; Body: unknown }>('/app/v1/gateways/:gatewayId/pairing', async (req, reply) => {
      const user = sessionUser(req);
      const g = await gatewayView(req.params.gatewayId);
      if (!g.siteId) throw forbidden('세대에 연결되지 않은 게이트웨이입니다');
      const s = await loadSite(g.siteId);
      requireControl(user, s);
      const b = strictBody(req.body, ['code', 'name']);
      if (typeof b.code !== 'string' || b.code.trim().length < 8 || b.code.length > 64) throw badRequest('code 는 8~64자입니다');
      if (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > 100)) throw badRequest('name 은 100자 이하입니다');
      const r2 = await pairing.enqueue({ gatewayId: g.gatewayId, siteId: s.siteId, userId: user.userId, code: b.code.trim(), name: (b.name as string | undefined) ?? null });
      return reply.code(202).send(r2);
    });

    r.get<{ Params: { pairingSessionId: string } }>('/app/v1/pairing/:pairingSessionId', async (req) => {
      check('pair', req.params.pairingSessionId, 'pairingSessionId');
      const p = await pairing.get(req.params.pairingSessionId);
      if (!p) throw notFound('페어링 세션이 없습니다');
      const user = sessionUser(req);
      const s = await loadSite(p.siteId);
      if (p.requestedByUserId !== user.userId) requireFull(user, s);
      const { siteId: _s, requestedByUserId: _u, ...view } = p;
      return view;
    });

    registerSiteEvents(r, { cache, pairing, loadSite });

    // claim(Step 2 소유) — 같은 CSRF·세션 훅 아래
    await registerGatewayClaim(r, deps);
  });

  return { pairing };
}
