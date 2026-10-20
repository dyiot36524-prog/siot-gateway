// 소유: Step 2 백엔드 실행자. 게이트웨이 바인딩(claim)과 조회 (계획 B2, B4, §2 claim 창).
//  POST /app/v1/gateways/claim            installer 만. 세대 행 FOR UPDATE → 조직·상태·창 검사 → 토큰(해시만 저장) + 세대 키 v1 → bind + cfg
//  GET  /app/v1/sites/{siteId}/gateways   인계 후 installer·operator 는 GatewayDiagnostics
//  GET  /app/v1/gateways/{gatewayId}      〃
import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, isNull, max, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { siteAccess } from '../auth/roles.js';
import type { SessionUser } from '../auth/session.js';
import type { Db } from '../db/client.js';
import { auditLog, devices, gateways, siteKeys, sites } from '../db/schema.js';
import { claimSecretMatches, encryptSecret, newGatewayToken } from '../relay/crypto.js';
import { buildCfgBody } from '../relay/repo.js';
import type { AppApiDeps } from './index.js';

export type ClaimErrorCode =
  | 'INVALID_CLAIM_SECRET'
  | 'GATEWAY_NOT_PROVISIONED'
  | 'GATEWAY_ALREADY_BOUND'
  | 'GATEWAY_ORG_MISMATCH'
  | 'CLAIM_WINDOW_CLOSED';

export const CLAIM_ERROR_STATUS: Record<ClaimErrorCode, number> = {
  INVALID_CLAIM_SECRET: 400,
  GATEWAY_NOT_PROVISIONED: 409,
  GATEWAY_ALREADY_BOUND: 409,
  GATEWAY_ORG_MISMATCH: 403,
  CLAIM_WINDOW_CLOSED: 423,
};

/** claim 후 bound 를 기다리는 최대 시간(응답 지연 상한). 못 받으면 다음 접속의 재발급 경로가 처리한다 */
export const CLAIM_BIND_WAIT_MS = 3000;

const GATEWAY_ID_RE = /^gw_[0-9a-f-]{36}$/;
const SITE_ID_RE = /^site_[0-9A-HJKMNP-TV-Z]{26}$/;

const ClaimBody = z
  .object({
    gatewayId: z.string().regex(GATEWAY_ID_RE).optional(),
    shortId: z.string().regex(/^(siot-)?[0-9a-f]{8}$/).optional(),
    claimSecret: z.string().regex(/^[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}$/),
    siteId: z.string().regex(SITE_ID_RE),
  })
  .strict()
  .refine((b) => (b.gatewayId === undefined) !== (b.shortId === undefined), { message: 'gatewayId 와 shortId 중 정확히 하나' });

class ApiFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: ClaimErrorCode, message: string) => new ApiFail(CLAIM_ERROR_STATUS[code], code, message);

const sendError = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });

type GatewayRow = typeof gateways.$inferSelect;
type SiteRow = typeof sites.$inferSelect;

export interface GatewayJson {
  gatewayId: string;
  shortId: string;
  siteId: string | null;
  status: GatewayRow['status'];
  online: boolean;
  lastSeen: string | null;
  agentVersion: string | null;
  matterServerVersion: string | null;
  deviceCount: number;
  lastErrorCode: string | null;
  claimWindowUntil: string | null;
}
export type GatewayDiagnosticsJson = Pick<GatewayJson, 'online' | 'lastSeen' | 'agentVersion' | 'matterServerVersion' | 'deviceCount' | 'lastErrorCode'>;

async function deviceCounts(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ gatewayId: devices.gatewayId, n: count() })
    .from(devices)
    .where(and(inArray(devices.gatewayId, ids), isNull(devices.removedAt)))
    .groupBy(devices.gatewayId);
  return new Map(rows.map((r) => [r.gatewayId, Number(r.n)]));
}

function toGatewayJson(g: GatewayRow, online: boolean, deviceCount: number): GatewayJson {
  return {
    gatewayId: g.gatewayId,
    shortId: g.shortId,
    siteId: g.siteId,
    status: g.status,
    online,
    lastSeen: g.lastSeenAt?.toISOString() ?? null,
    agentVersion: g.agentVersion,
    matterServerVersion: g.matterServerVersion,
    deviceCount,
    lastErrorCode: g.lastErrorCode,
    claimWindowUntil: g.claimWindowUntil?.toISOString() ?? null,
  };
}

/** B4: 인계 후 진단 필드만(data 키 없음) */
export function toDiagnostics(g: GatewayJson): GatewayDiagnosticsJson {
  const { online, lastSeen, agentVersion, matterServerVersion, deviceCount, lastErrorCode } = g;
  return { online, lastSeen, agentVersion, matterServerVersion, deviceCount, lastErrorCode };
}

/** 조회 권한(규칙은 auth/roles.ts siteAccess 한 곳). 세대 미소속 GW 는 출고 조직으로 판단(installer full, operator diagnostics) */
function viewLevel(user: SessionUser, gwOrgId: string, site: SiteRow | null): 'full' | 'diagnostics' | null {
  const a = siteAccess(user, site ?? { orgId: gwOrgId, ownerUserId: null });
  if (!site && user.role === 'resident') return null;
  return a === 'none' ? null : a;
}

interface ClaimTxResult {
  gatewayToken: string;
  gatewayId: string;
  siteId: string;
  /** cfg 를 다시 받아야 하는 GW(claim 대상 포함) */
  cfgTargets: string[];
}

export async function registerGatewayClaim(app: FastifyInstance, deps: AppApiDeps): Promise<void> {
  const { db, bus, sessions, config } = deps;
  const reloadGateway = (id: string) => (deps.cache as { reloadGateway?: (id: string) => Promise<void> }).reloadGateway?.(id);

  async function auth(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
    const user = await sessions.authenticate(req, reply);
    if (!user) {
      await sendError(reply, 401, 'UNAUTHORIZED', '로그인이 필요합니다');
      return null;
    }
    return user;
  }

  const gatewayJson = async (rows: GatewayRow[]) => {
    const counts = await deviceCounts(db, rows.map((r) => r.gatewayId));
    return rows.map((r) => toGatewayJson(r, bus.isOnline(r.gatewayId), counts.get(r.gatewayId) ?? 0));
  };

  // ---------------------------------------------------------------- claim
  app.post('/app/v1/gateways/claim', async (req, reply) => {
    const user = await auth(req, reply);
    if (!user) return reply;
    if (user.role !== 'installer' || !user.orgId) return sendError(reply, 403, 'FORBIDDEN', '기사 계정만 게이트웨이를 연결할 수 있습니다');
    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '));
    const body = parsed.data;
    const userOrg = user.orgId;

    let result: ClaimTxResult;
    try {
      result = await db.transaction(async (tx) => {
        // 1) 대상 GW 식별 + (gatewayId 가 주어지면) 라벨 secret 을 먼저 확인
        if (body.gatewayId && !claimSecretMatches(config.LABEL_MASTER_KEY, body.gatewayId, body.claimSecret)) {
          throw fail('INVALID_CLAIM_SECRET', '라벨 코드가 맞지 않습니다');
        }
        const shortId = body.shortId?.replace(/^siot-/, '');
        const [peek] = await tx
          .select({ gatewayId: gateways.gatewayId, siteId: gateways.siteId })
          .from(gateways)
          .where(body.gatewayId ? eq(gateways.gatewayId, body.gatewayId) : eq(gateways.shortId, shortId!));
        if (!peek) throw fail('GATEWAY_NOT_PROVISIONED', '출고 등록되지 않은 게이트웨이입니다');

        // 2) 세대 행 잠금(대상 세대 + GW 의 현재 세대, 정렬 순서로 교착 방지) → 관련 GW 행 잠금
        const siteIds = [...new Set([body.siteId, ...(peek.siteId ? [peek.siteId] : [])])].sort();
        const lockedSites = await tx.select().from(sites).where(inArray(sites.siteId, siteIds)).orderBy(asc(sites.siteId)).for('update');
        const target = lockedSites.find((s) => s.siteId === body.siteId);
        const lockedGws = await tx
          .select()
          .from(gateways)
          .where(or(eq(gateways.gatewayId, peek.gatewayId), inArray(gateways.siteId, siteIds)))
          .orderBy(asc(gateways.gatewayId))
          .for('update');
        const gw = lockedGws.find((g) => g.gatewayId === peek.gatewayId);
        if (!gw || !gw.pubkey) throw fail('GATEWAY_NOT_PROVISIONED', '출고 등록되지 않은 게이트웨이입니다');
        if (!body.gatewayId && !claimSecretMatches(config.LABEL_MASTER_KEY, gw.gatewayId, body.claimSecret)) {
          throw fail('INVALID_CLAIM_SECRET', '라벨 코드가 맞지 않습니다');
        }

        // 3) 조직·세대 권한
        if (gw.orgId !== userOrg) throw fail('GATEWAY_ORG_MISMATCH', '다른 조직에 출고된 게이트웨이입니다');
        if (!target) throw new ApiFail(404, 'NOT_FOUND', '세대를 찾을 수 없습니다');
        if (target.orgId !== userOrg) throw new ApiFail(403, 'FORBIDDEN', '다른 조직의 세대입니다');
        if (target.ownerUserId) throw new ApiFail(403, 'HANDED_OVER', '인계된 세대에는 게이트웨이를 연결할 수 없습니다');

        // 4) 상태·claim 창: 창(claimWindowUntil)은 세대/공장 초기화 때 열린다. 출고 직후(창 null·unbound)는 제한 없음
        const now = new Date();
        if (gw.claimWindowUntil) {
          if (gw.claimWindowUntil.getTime() < now.getTime()) throw fail('CLAIM_WINDOW_CLOSED', 'claim 창이 닫혔습니다. 창을 다시 열어 주세요');
        } else if (gw.status !== 'unbound') {
          throw fail('GATEWAY_ALREADY_BOUND', '이미 다른 세대에 연결된 게이트웨이입니다');
        }

        // 5) 초기화 후 claim: 그 세대(vacant)의 GW 전체(Thread 망·세대 키 공유 단위)를 인수
        const prevSiteId = gw.siteId;
        const takeover =
          prevSiteId !== null ? lockedGws.filter((g) => g.siteId === prevSiteId && g.gatewayId !== gw.gatewayId && g.orgId === userOrg).map((g) => g.gatewayId) : [];

        // 6) 세대 키: 유효 키가 없으면 새 버전(첫 claim 이면 v1)
        const [active] = await tx
          .select({ v: max(siteKeys.version) })
          .from(siteKeys)
          .where(and(eq(siteKeys.siteId, target.siteId), or(isNull(siteKeys.retiredAt), gt(siteKeys.retiredAt, now))));
        let keyVersion = active?.v ?? null;
        let keyCreated: number | null = null;
        if (keyVersion === null) {
          const [all] = await tx.select({ v: max(siteKeys.version) }).from(siteKeys).where(eq(siteKeys.siteId, target.siteId));
          keyVersion = (all?.v ?? 0) + 1;
          keyCreated = keyVersion;
          await tx.insert(siteKeys).values({
            siteId: target.siteId,
            version: keyVersion,
            keyEnc: encryptSecret(config.DATA_ENC_KEY, randomBytes(32)),
            epoch: target.epoch,
          });
        }

        // 7) 대상 GW: 토큰(해시만) + 세대 + cfg 버전 증가
        const { token, hash } = newGatewayToken();
        await tx
          .update(gateways)
          .set({ siteId: target.siteId, status: 'bound', tokenHash: hash, cfgVersion: gw.cfgVersion + 1, keyVersion, claimWindowUntil: null })
          .where(eq(gateways.gatewayId, gw.gatewayId));

        // 8) 인수 GW 와 대상 세대의 다른 GW: 세대·피어 목록이 바뀌므로 cfg 버전 증가
        const others = lockedGws.filter((g) => g.gatewayId !== gw.gatewayId && (g.siteId === target.siteId || takeover.includes(g.gatewayId)));
        for (const g of others) {
          await tx
            .update(gateways)
            .set({ siteId: target.siteId, cfgVersion: g.cfgVersion + 1, keyVersion, claimWindowUntil: null, ...(takeover.includes(g.gatewayId) ? { status: 'bound' as const } : {}) })
            .where(eq(gateways.gatewayId, g.gatewayId));
        }
        if (prevSiteId !== null || takeover.length > 0) {
          await tx.update(sites).set({ createdByUserId: user.userId, updatedAt: now }).where(eq(sites.siteId, target.siteId));
        }

        // 9) 감사 로그
        await tx.insert(auditLog).values({
          actorType: 'user',
          actorId: user.userId,
          orgId: userOrg,
          action: 'gateway.claim',
          targetType: 'gateway',
          targetId: gw.gatewayId,
          data: { siteId: target.siteId, previousSiteId: prevSiteId, previousStatus: gw.status, keyCreated, via: body.gatewayId ? 'qr' : 'manual' },
          ip: req.ip,
        });
        if (takeover.length > 0) {
          await tx.insert(auditLog).values({
            actorType: 'user',
            actorId: user.userId,
            orgId: userOrg,
            action: 'gateway.takeover',
            targetType: 'site',
            targetId: target.siteId,
            data: { fromSiteId: prevSiteId, gatewayIds: [gw.gatewayId, ...takeover] },
            ip: req.ip,
          });
        }
        return { gatewayToken: token, gatewayId: gw.gatewayId, siteId: target.siteId, cfgTargets: [gw.gatewayId, ...others.map((g) => g.gatewayId)] };
      });
    } catch (e) {
      if (e instanceof ApiFail) return sendError(reply, e.status, e.code, e.message);
      throw e;
    }

    // 커밋 후: bind(토큰) → GW 가 토큰으로 재접속하면 접속 순서의 cfg 단계에서 cfg 를 받는다.
    // bound 를 못 받았으면(미접속·유실) cfg 를 지금 시도하고, 미접속이면 다음 접속의 재발급 경로가 bind 를 다시 보낸다.
    const bound = await Promise.race([
      bus.sendBind(result.gatewayId, { gatewayToken: result.gatewayToken, siteId: result.siteId }),
      new Promise<boolean>((r) => setTimeout(() => r(false), CLAIM_BIND_WAIT_MS).unref()),
    ]);
    for (const id of result.cfgTargets) {
      if (id === result.gatewayId && bound) continue;
      const cfg = await buildCfgBody(db, config.DATA_ENC_KEY, id);
      if (cfg) await bus.sendCfg(id, cfg);
    }
    for (const id of result.cfgTargets) await reloadGateway(id);
    req.log.info({ gatewayId: result.gatewayId, siteId: result.siteId, bound }, 'gateway claimed');

    const [row] = await db.select().from(gateways).where(eq(gateways.gatewayId, result.gatewayId));
    const [json] = await gatewayJson([row!]);
    return reply.code(200).send(json);
  });

  // ---------------------------------------------------------------- 조회
  app.get<{ Params: { siteId: string } }>('/app/v1/sites/:siteId/gateways', async (req, reply) => {
    const user = await auth(req, reply);
    if (!user) return reply;
    if (!SITE_ID_RE.test(req.params.siteId)) return sendError(reply, 404, 'NOT_FOUND', '세대를 찾을 수 없습니다');
    const [site] = await db.select().from(sites).where(eq(sites.siteId, req.params.siteId));
    if (!site) return sendError(reply, 404, 'NOT_FOUND', '세대를 찾을 수 없습니다');
    const level = viewLevel(user, site.orgId, site);
    if (!level) return sendError(reply, 403, 'FORBIDDEN', '권한이 없습니다');
    const rows = await db.select().from(gateways).where(eq(gateways.siteId, site.siteId)).orderBy(asc(gateways.gatewayId));
    const data = await gatewayJson(rows);
    return { data: level === 'full' ? data : data.map(toDiagnostics) };
  });

  app.get<{ Params: { gatewayId: string } }>('/app/v1/gateways/:gatewayId', async (req, reply) => {
    const user = await auth(req, reply);
    if (!user) return reply;
    if (!GATEWAY_ID_RE.test(req.params.gatewayId)) return sendError(reply, 404, 'NOT_FOUND', '게이트웨이를 찾을 수 없습니다');
    const [row] = await db.select().from(gateways).where(eq(gateways.gatewayId, req.params.gatewayId));
    if (!row) return sendError(reply, 404, 'NOT_FOUND', '게이트웨이를 찾을 수 없습니다');
    const [site] = row.siteId ? await db.select().from(sites).where(eq(sites.siteId, row.siteId)) : [];
    const level = viewLevel(user, row.orgId, site ?? null);
    if (!level) return sendError(reply, 403, 'FORBIDDEN', '권한이 없습니다');
    const [json] = await gatewayJson([row]);
    return level === 'full' ? json : toDiagnostics(json!);
  });
}
