// GatewayRepo 의 drizzle(Postgres) 구현과 cfg 본문 생성(claim 과 공유).
import { and, asc, count, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import type { CfgAckFrame, HelloFrame } from '@siot/protocol';
import type { Db } from '../db/client.js';
import { auditLog, automationRules, gateways, siteKeys } from '../db/schema.js';
import { compileForGateway, type AutomationRule } from '../automations/compile.js';
import { loadRuleDevices } from '../automations/service.js';
import { decryptSecret } from './crypto.js';
import type { CfgBody, GatewayRecord, GatewayRepo } from './deps.js';

export const TOKEN_REISSUED_ACTION = 'gateway.token_reissued';
const DAY_MS = 24 * 3600 * 1000;

/** drizzle 트랜잭션도 받는다 */
type Q = Pick<Db, 'select' | 'insert' | 'update'>;

/**
 * gatewayId 의 현재 cfgVersion cfg. M1: keys = 세대의 유효 키(retired 아님 또는 유예 중), peers = 같은 세대 다른 GW(lan [] / mleid null),
 * rules = {version: 세대 규칙 version, rules: 이 GW 기기만으로 된 규칙(컴파일)} — 규칙이 없어도 같은 version 의 빈 배열(지운 규칙이 남지 않게), thread 없음.
 */
export async function buildCfgBody(q: Q, dataEncKey: string, gatewayId: string, now = new Date()): Promise<CfgBody | null> {
  const [gw] = await q.select({ siteId: gateways.siteId, cfgVersion: gateways.cfgVersion }).from(gateways).where(eq(gateways.gatewayId, gatewayId));
  if (!gw?.siteId || gw.cfgVersion < 1) return null;
  const keys = await q
    .select({ v: siteKeys.version, keyEnc: siteKeys.keyEnc })
    .from(siteKeys)
    .where(and(eq(siteKeys.siteId, gw.siteId), or(isNull(siteKeys.retiredAt), gt(siteKeys.retiredAt, now))))
    .orderBy(asc(siteKeys.version));
  const [first, ...rest] = keys.map((k) => ({ v: k.v, key: decryptSecret(dataEncKey, k.keyEnc).toString('base64url') }));
  if (!first) return null;
  const peers = await q
    .select({ gatewayId: gateways.gatewayId })
    .from(gateways)
    .where(and(eq(gateways.siteId, gw.siteId), ne(gateways.gatewayId, gatewayId)))
    .orderBy(asc(gateways.gatewayId));
  const [ar] = await q.select({ version: automationRules.version, rules: automationRules.rules }).from(automationRules).where(eq(automationRules.siteId, gw.siteId));
  const rules = ar?.rules.length ? compileForGateway(ar.rules as AutomationRule[], await loadRuleDevices(q, gw.siteId), gatewayId) : [];
  return {
    cfgVersion: gw.cfgVersion,
    siteId: gw.siteId,
    keys: [first, ...rest],
    peers: peers.map((p) => ({ gatewayId: p.gatewayId, lan: [], mleid: null })),
    rules: { version: ar?.version ?? 0, rules },
  };
}

export function createDbGatewayRepo(db: Db, dataEncKey: string): GatewayRepo {
  return {
    async get(gatewayId) {
      const [r] = await db
        .select({
          gatewayId: gateways.gatewayId,
          orgId: gateways.orgId,
          siteId: gateways.siteId,
          status: gateways.status,
          pubkey: gateways.pubkey,
          tokenHash: gateways.tokenHash,
          cfgVersion: gateways.cfgVersion,
        })
        .from(gateways)
        .where(eq(gateways.gatewayId, gatewayId));
      return (r as GatewayRecord | undefined) ?? null;
    },
    async markOnline(gatewayId, hello: HelloFrame, at) {
      await db
        .update(gateways)
        .set({
          online: true,
          lastSeenAt: at,
          bootId: hello.bootId,
          agentVersion: hello.agentVersion,
          matterServerVersion: hello.matterServerVersion,
          cfgAckedVersion: hello.cfgVersion,
        })
        .where(eq(gateways.gatewayId, gatewayId));
    },
    async markOffline(gatewayId, at) {
      await db.update(gateways).set({ online: false, lastSeenAt: at }).where(eq(gateways.gatewayId, gatewayId));
    },
    async recordCfgAck(gatewayId, ack: CfgAckFrame) {
      await db
        .update(gateways)
        .set({
          cfgAckedVersion: ack.cfgVersion,
          keyVersion: ack.keyVersion,
          rulesAckedVersion: ack.rulesVersion,
          status: sql`case when ${gateways.status} = 'site_reset_pending' and ${gateways.cfgVersion} <= ${ack.cfgVersion} then 'bound'::gateway_status else ${gateways.status} end`,
        })
        .where(eq(gateways.gatewayId, gatewayId));
    },
    async recordBound(gatewayId) {
      const [gw] = await db.select({ orgId: gateways.orgId, siteId: gateways.siteId }).from(gateways).where(eq(gateways.gatewayId, gatewayId));
      await db.insert(auditLog).values({
        actorType: 'gateway',
        actorId: gatewayId,
        orgId: gw?.orgId ?? null,
        action: 'gateway.bound',
        targetType: 'gateway',
        targetId: gatewayId,
        data: { siteId: gw?.siteId ?? null },
      });
    },
    async reissueToken(gatewayId, newTokenHash, at) {
      return db.transaction(async (tx) => {
        const [gw] = await tx
          .update(gateways)
          .set({ tokenHash: newTokenHash })
          .where(eq(gateways.gatewayId, gatewayId))
          .returning({ orgId: gateways.orgId, siteId: gateways.siteId });
        await tx.insert(auditLog).values({
          at,
          actorType: 'system',
          actorId: 'relay',
          orgId: gw?.orgId ?? null,
          action: TOKEN_REISSUED_ACTION,
          targetType: 'gateway',
          targetId: gatewayId,
          data: { siteId: gw?.siteId ?? null, reason: 'signed hello without valid token while bound' },
        });
        const [c] = await tx
          .select({ n: count() })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, TOKEN_REISSUED_ACTION),
              eq(auditLog.targetType, 'gateway'),
              eq(auditLog.targetId, gatewayId),
              gt(auditLog.at, new Date(at.getTime() - DAY_MS)),
            ),
          );
        return { recentCount: Number(c?.n ?? 0) };
      });
    },
    buildCfg: (gatewayId) => buildCfgBody(db, dataEncKey, gatewayId),
  };
}
