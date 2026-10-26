// 세대 자동화 규칙 저장·조회(계약 §1·§4). 저장은 공개 형식 그대로(automation_rules.rules), GW 별 컴파일은 cfg 생성 때(buildCfgBody).
// PUT: 한 트랜잭션에서 규칙 upsert(version+1, id 발급) + 세대 모든 GW cfgVersion+1. push 는 호출자가 커밋 후 한다.
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { automationRules, devices, gateways } from '../db/schema.js';
import { newId } from '../ids.js';
import { compileSite, type AutomationRule, type AutomationRuleInput, type RuleDevice } from './compile.js';

export interface AutomationSet {
  version: number;
  updatedAt: string | null;
  rules: AutomationRule[];
  gateways: { gatewayId: string; online: boolean; appliedVersion: number }[];
}

/** 세대 GW(세대 소속 기준)의 제거되지 않은 기기 */
export async function loadRuleDevices(q: Pick<Db, 'select'>, siteId: string): Promise<Map<string, RuleDevice>> {
  const rows = await q
    .select({ deviceId: devices.deviceId, gatewayId: devices.gatewayId, localId: devices.localId, deviceType: devices.deviceType, data: devices.data })
    .from(devices)
    .innerJoin(gateways, eq(gateways.gatewayId, devices.gatewayId))
    .where(and(eq(gateways.siteId, siteId), isNull(devices.removedAt)));
  return new Map(rows.map((r) => [r.deviceId, r]));
}

async function view(db: Db, siteId: string, row: { version: number; rules: unknown[]; updatedAt: Date } | undefined, isOnline: (gatewayId: string) => boolean): Promise<AutomationSet> {
  const gws = await db
    .select({ gatewayId: gateways.gatewayId, appliedVersion: gateways.rulesAckedVersion })
    .from(gateways)
    .where(eq(gateways.siteId, siteId))
    .orderBy(asc(gateways.gatewayId));
  return {
    version: row?.version ?? 0,
    updatedAt: row ? row.updatedAt.toISOString() : null,
    rules: (row?.rules ?? []) as AutomationRule[],
    gateways: gws.map((g) => ({ gatewayId: g.gatewayId, online: isOnline(g.gatewayId), appliedVersion: g.appliedVersion })),
  };
}

export async function getAutomations(db: Db, siteId: string, isOnline: (gatewayId: string) => boolean): Promise<AutomationSet> {
  const [row] = await db.select().from(automationRules).where(eq(automationRules.siteId, siteId));
  return view(db, siteId, row, isOnline);
}

/** 전체 교체. 검증·컴파일 실패는 400(저장 안 함). gatewayIds = cfg 를 다시 보내야 할 세대 GW */
export async function putAutomations(
  db: Db,
  site: { siteId: string; orgId: string },
  input: AutomationRuleInput[],
  isOnline: (gatewayId: string) => boolean,
): Promise<{ set: AutomationSet; gatewayIds: string[] }> {
  const rules: AutomationRule[] = input.map(({ id, ...rest }) => ({ id: id ?? newId('aut'), ...rest }));
  compileSite(rules, await loadRuleDevices(db, site.siteId));
  const { row, gatewayIds } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(automationRules)
      .values({ siteId: site.siteId, orgId: site.orgId, version: 1, rules })
      .onConflictDoUpdate({ target: automationRules.siteId, set: { version: sql`${automationRules.version} + 1`, rules, updatedAt: sql`now()` } })
      .returning();
    const bumped = await tx
      .update(gateways)
      .set({ cfgVersion: sql`${gateways.cfgVersion} + 1` })
      .where(eq(gateways.siteId, site.siteId))
      .returning({ gatewayId: gateways.gatewayId });
    return { row: row!, gatewayIds: bumped.map((g) => g.gatewayId) };
  });
  return { set: await view(db, site.siteId, row, isOnline), gatewayIds };
}
