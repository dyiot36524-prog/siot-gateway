// 소유: Step 1 실행자. 계약: openapi/public-v1.yaml (/v1/*).
// 인증(API 키 401) → 속도 제한(키당 20 req/s 버스트 40, 429+Retry-After) → 스코프(403 INSUFFICIENT_SCOPE) → 조직 격리(403).
// 조회는 캐시만 본다(C2: 릴레이 req 0). 다른 조직이거나 존재하지 않는 자원은 존재 여부와 관계없이 403,
// 자기 조직의 제거된 기기는 404.
import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { devices, gateways, sites } from '../db/schema.js';
import type { ApiKeyService } from '../auth/apiKey.js';
import { TokenBucket } from '../auth/rateLimit.js';
import type { StateCache } from '../cache/StateCache.js';
import type { GatewayBus } from '../relay/GatewayBus.js';
import type { PgOutbox } from '../webhooks/Outbox.js';
import { HttpError, badRequest, forbidden, notFound, pageFromRows, pageOf, parsePage, unauthorized } from '../http.js';
import { CONTROL_ACTIONS, type ControlAction, type ControlCoordinator } from './ControlCoordinator.js';
import { toPublicGateway, toPublicSite } from './views.js';
import { registerPublicWebhooks } from './webhooks.js';
import { checkId, requireScope } from './guards.js';
import { parseAutomationsBody } from '../automations/compile.js';
import { getAutomations, putAutomations } from '../automations/service.js';
import { buildCfgBody } from '../relay/repo.js';

export { checkId, requireScope } from './guards.js';

export const API_VERSIONS = ['2026-10-01'] as const;
export const API_VERSION_LATEST = API_VERSIONS[API_VERSIONS.length - 1]!;
export const KEY_RATE_PER_SEC = 20;
export const KEY_RATE_BURST = 40;

export interface PublicApiDeps {
  db: Db;
  cache: StateCache;
  bus: GatewayBus;
  apiKeys: ApiKeyService;
  control: ControlCoordinator;
  outbox: PgOutbox;
  config: Pick<Config, 'NODE_ENV' | 'DATA_ENC_KEY'>;
  now?: () => Date;
  /** 키당 속도 제한(기본 20 req/s, 버스트 40) */
  keyRate?: { perSec: number; burst: number };
}

/** 요청 날짜 이하의 가장 최근 지원 버전(없으면 가장 오래된 것) */
export function resolveApiVersion(requested: string | undefined): string {
  if (requested === undefined || requested === '') return API_VERSION_LATEST;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) throw badRequest('Siot-Api-Version 은 YYYY-MM-DD 형식입니다');
  const ok = API_VERSIONS.filter((v) => v <= requested);
  return ok.length ? ok[ok.length - 1]! : API_VERSIONS[0];
}

export async function registerPublicApi(app: FastifyInstance, deps: PublicApiDeps): Promise<void> {
  const { db, cache } = deps;
  const perKey = new TokenBucket(deps.keyRate?.perSec ?? KEY_RATE_PER_SEC, deps.keyRate?.burst ?? KEY_RATE_BURST);
  const siteOrg = new Map<string, string>(); // 세대의 조직은 바뀌지 않는다

  async function orgOfSite(siteId: string): Promise<string | undefined> {
    const hit = siteOrg.get(siteId);
    if (hit) return hit;
    const [s] = await db.select({ orgId: sites.orgId }).from(sites).where(eq(sites.siteId, siteId)).limit(1);
    if (s) siteOrg.set(siteId, s.orgId);
    return s?.orgId;
  }

  async function ownSite(orgId: string, siteId: string) {
    checkId('site', siteId, 'siteId');
    const [s] = await db.select().from(sites).where(eq(sites.siteId, siteId)).limit(1);
    if (!s || s.orgId !== orgId) throw forbidden();
    siteOrg.set(s.siteId, s.orgId);
    return s;
  }

  async function gatewayView(gatewayId: string) {
    let g = cache.getGateway(gatewayId);
    if (!g) {
      await cache.reloadGateway(gatewayId);
      g = cache.getGateway(gatewayId);
    }
    return g;
  }

  /** 자기 조직 기기(캐시). 제거된 자기 기기는 404, 그 밖은 403 */
  async function ownDevice(orgId: string, deviceId: string) {
    checkId('dev', deviceId, 'deviceId');
    const d = cache.getDevice(deviceId);
    if (d) {
      if ((await orgOfSite(d.siteId)) !== orgId) throw forbidden();
      return d;
    }
    const [row] = await db.select({ siteId: devices.siteId }).from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (row?.siteId && (await orgOfSite(row.siteId)) === orgId) throw notFound('기기가 제거되었습니다');
    throw forbidden();
  }

  await app.register(async (r) => {
    r.addHook('onRequest', async (req, reply) => {
      const raw = req.headers['siot-api-version'];
      reply.header('Siot-Api-Version', resolveApiVersion(Array.isArray(raw) ? raw[0] : raw));
      const p = await deps.apiKeys.authenticate(req);
      if (!p) throw unauthorized('API 키가 없거나 만료·폐기되었습니다');
      const rl = perKey.take(p.apiKeyId);
      if (!rl.ok) throw new HttpError(429, 'RATE_LIMITED', '요청이 너무 많습니다', { 'Retry-After': String(rl.retryAfterSec) });
      req.principal = p;
    });

    r.get('/v1/sites', async (req) => {
      const orgId = requireScope(req, 'devices:read');
      const page = parsePage(req.query);
      const rows = await db
        .select()
        .from(sites)
        .where(and(eq(sites.orgId, orgId), page.after ? gt(sites.siteId, page.after) : undefined))
        .orderBy(asc(sites.siteId))
        .limit(page.limit + 1);
      const p = pageFromRows(rows, (s) => s.siteId, page.limit);
      const counts = p.data.length
        ? await db
            .select({ siteId: gateways.siteId, n: count() })
            .from(gateways)
            .where(inArray(gateways.siteId, p.data.map((s) => s.siteId)))
            .groupBy(gateways.siteId)
        : [];
      const byId = new Map(counts.map((c) => [c.siteId, c.n]));
      return { data: p.data.map((s) => toPublicSite(s, byId.get(s.siteId) ?? 0)), nextCursor: p.nextCursor };
    });

    r.get<{ Params: { siteId: string } }>('/v1/sites/:siteId', async (req) => {
      const orgId = requireScope(req, 'devices:read');
      const s = await ownSite(orgId, req.params.siteId);
      const [c] = await db.select({ n: count() }).from(gateways).where(eq(gateways.siteId, s.siteId));
      return toPublicSite(s, c?.n ?? 0);
    });

    r.get<{ Params: { siteId: string } }>('/v1/sites/:siteId/gateways', async (req) => {
      const orgId = requireScope(req, 'devices:read');
      const page = parsePage(req.query);
      const s = await ownSite(orgId, req.params.siteId);
      const rows = await db
        .select({ gatewayId: gateways.gatewayId, rulesVersion: gateways.rulesAckedVersion })
        .from(gateways)
        .where(eq(gateways.siteId, s.siteId))
        .orderBy(asc(gateways.gatewayId));
      const views = [];
      for (const { gatewayId, rulesVersion } of rows) {
        const g = await gatewayView(gatewayId);
        if (g?.siteId === s.siteId) views.push(toPublicGateway(g, rulesVersion));
      }
      return pageOf(views, (g) => g.gatewayId, page);
    });

    r.get<{ Params: { siteId: string } }>('/v1/sites/:siteId/devices', async (req) => {
      const orgId = requireScope(req, 'devices:read');
      const page = parsePage(req.query);
      const s = await ownSite(orgId, req.params.siteId);
      return pageOf(cache.getSiteDevices(s.siteId), (d) => d.deviceId, page);
    });

    r.get<{ Params: { gatewayId: string } }>('/v1/gateways/:gatewayId', async (req) => {
      const orgId = requireScope(req, 'devices:read');
      checkId('gateway', req.params.gatewayId, 'gatewayId');
      const g = await gatewayView(req.params.gatewayId);
      if (!g || g.orgId !== orgId) throw forbidden();
      if (!g.siteId) throw notFound('세대에 연결되지 않은 게이트웨이입니다');
      if ((await orgOfSite(g.siteId)) !== orgId) throw forbidden();
      const [row] = await db.select({ rulesVersion: gateways.rulesAckedVersion }).from(gateways).where(eq(gateways.gatewayId, g.gatewayId));
      return toPublicGateway(g, row?.rulesVersion ?? 0);
    });

    // 자동화 규칙(계약 §1): 세대 전체 교체. 저장 후 접속 중인 GW 에 cfg push(응답은 기다리지 않음), 나머지는 다음 접속 때 cfgVersion 비교로
    const online = (gatewayId: string) => cache.isGatewayOnline(gatewayId);
    r.get<{ Params: { siteId: string } }>('/v1/sites/:siteId/automations', async (req) => {
      const orgId = requireScope(req, 'devices:read');
      const s = await ownSite(orgId, req.params.siteId);
      return getAutomations(db, s.siteId, online);
    });

    r.put<{ Params: { siteId: string }; Body: unknown }>('/v1/sites/:siteId/automations', async (req) => {
      const orgId = requireScope(req, 'devices:control');
      const s = await ownSite(orgId, req.params.siteId);
      const { set, gatewayIds } = await putAutomations(db, s, parseAutomationsBody(req.body), online);
      for (const gatewayId of gatewayIds) {
        if (!deps.bus.isOnline(gatewayId)) continue;
        void buildCfgBody(db, deps.config.DATA_ENC_KEY, gatewayId)
          .then((cfg) => (cfg ? deps.bus.sendCfg(gatewayId, cfg) : false))
          .catch((err) => req.log.error({ err, gatewayId }, 'automation cfg push failed'));
      }
      return set;
    });

    r.get<{ Params: { deviceId: string } }>('/v1/devices/:deviceId', async (req) => {
      const orgId = requireScope(req, 'devices:read');
      return ownDevice(orgId, req.params.deviceId);
    });

    r.post<{ Params: { deviceId: string }; Body: unknown }>('/v1/devices/:deviceId/control', async (req, reply) => {
      const orgId = requireScope(req, 'devices:control');
      const action = parseControlBody(req.body);
      const d = await ownDevice(orgId, req.params.deviceId);
      const retry = deps.control.rateLimit(d.deviceId);
      if (retry !== null) throw new HttpError(429, 'RATE_LIMITED', '이 기기에 대한 제어 요청이 너무 많습니다', { 'Retry-After': String(retry) });
      const result = await deps.control.control(d.deviceId, action, req.t0);
      return reply.code(200).send(result);
    });

    await registerPublicWebhooks(r, deps);
  });
}

export function parseControlBody(body: unknown): ControlAction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('JSON 본문 {"action":"ON|OFF|TOGGLE"} 이 필요합니다');
  const keys = Object.keys(body);
  const action = (body as { action?: unknown }).action;
  if (keys.some((k) => k !== 'action') || typeof action !== 'string' || !CONTROL_ACTIONS.includes(action as ControlAction)) {
    throw badRequest('action 은 ON, OFF, TOGGLE 중 하나입니다');
  }
  return action as ControlAction;
}
