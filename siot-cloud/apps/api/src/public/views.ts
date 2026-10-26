// 응답 모양(public-v1·app-v1 components.schemas)으로 바꾸는 함수들.
import type { GatewayView } from '../cache/StateCache.js';
import type { sites } from '../db/schema.js';

type SiteRow = typeof sites.$inferSelect;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** public-v1 Gateway (siteId 필수 — 세대 미소속 GW 는 호출하지 않는다). rulesVersion 은 조회 API 만 넘긴다(gateways.rules_acked_version) */
export function toPublicGateway(g: GatewayView, rulesVersion?: number) {
  return {
    gatewayId: g.gatewayId,
    siteId: g.siteId!,
    online: g.online,
    lastSeenAt: iso(g.lastSeenAt),
    agentVersion: g.agentVersion,
    matterServerVersion: g.matterServerVersion,
    deviceCount: g.deviceCount,
    ...(rulesVersion !== undefined ? { rulesVersion } : {}),
  };
}

export function toPublicSite(s: SiteRow, gatewayCount: number) {
  return { siteId: s.siteId, name: s.name, gatewayCount, createdAt: s.createdAt.toISOString() };
}

/** app-v1 Gateway(전체) */
export function toAppGateway(g: GatewayView) {
  return {
    gatewayId: g.gatewayId,
    shortId: g.shortId,
    siteId: g.siteId,
    status: g.status,
    online: g.online,
    lastSeen: iso(g.lastSeenAt),
    agentVersion: g.agentVersion,
    matterServerVersion: g.matterServerVersion,
    deviceCount: g.deviceCount,
    lastErrorCode: g.lastErrorCode,
    claimWindowUntil: iso(g.claimWindowUntil),
  };
}

/** app-v1 GatewayDiagnostics — 계획 B4 의 6개 필드만(data 키 없음) */
export function toDiagnostics(g: GatewayView) {
  return {
    online: g.online,
    lastSeen: iso(g.lastSeenAt),
    agentVersion: g.agentVersion,
    matterServerVersion: g.matterServerVersion,
    deviceCount: g.deviceCount,
    lastErrorCode: g.lastErrorCode,
  };
}

export function toAppSite(s: SiteRow, gatewayCount: number) {
  return {
    siteId: s.siteId,
    name: s.name,
    address: s.address,
    orgId: s.orgId,
    ownerUserId: s.ownerUserId,
    handedOver: s.ownerUserId !== null,
    epoch: s.epoch,
    gatewayCount,
    createdAt: s.createdAt.toISOString(),
  };
}
