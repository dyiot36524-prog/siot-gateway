// 운영자 CLI 명령 구현(테스트 가능하게 db 를 받는다). 모든 변경은 audit_log(actor_type=operator_cli) 에 남긴다.
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog, gateways, organizations, users } from '../db/schema.js';
import { createApiKeyService, API_SCOPES, type ApiScope } from '../auth/apiKey.js';
import { hashPassword, type Role } from '../auth/session.js';
import { claimSecretFor } from '../relay/crypto.js';
import { ID_PATTERNS, newId, shortIdOf } from '../ids.js';

export const CLAIM_WINDOW_HOURS = 24;
const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;

const audit = (db: Db, action: string, targetType: string, targetId: string, orgId: string | null, data: Record<string, unknown>) =>
  db.insert(auditLog).values({ actorType: 'operator_cli', actorId: process.env.USER ?? null, orgId, action, targetType, targetId, data });

export class AdminError extends Error {}

export async function orgCreate(db: Db, o: { name: string }) {
  if (!o.name?.trim()) throw new AdminError('--name 이 필요합니다');
  const orgId = newId('org');
  await db.insert(organizations).values({ orgId, name: o.name.trim() });
  await audit(db, 'org.create', 'org', orgId, orgId, { name: o.name.trim() });
  return { orgId };
}

export async function userCreate(db: Db, o: { email: string; name: string; role: string; org?: string; password?: string }) {
  if (!['installer', 'resident', 'operator'].includes(o.role)) throw new AdminError('--role 은 installer|resident|operator');
  if (!o.email || !/^[^@\s]+@[^@\s]+$/.test(o.email)) throw new AdminError('--email 이 올바르지 않습니다');
  const role = o.role as Role;
  if (role === 'installer' && !o.org) throw new AdminError('installer 는 --org 가 필요합니다');
  if (o.org && !ID_PATTERNS.org.test(o.org)) throw new AdminError('--org 형식(org_ULID)이 올바르지 않습니다');
  const password = o.password ?? randomBytes(12).toString('base64url');
  if (password.length < 8) throw new AdminError('비밀번호는 8자 이상');
  const userId = newId('usr');
  await db.insert(users).values({
    userId,
    orgId: role === 'resident' ? null : (o.org ?? null),
    role,
    email: o.email,
    name: o.name || o.email,
    passwordHash: await hashPassword(password),
  });
  await audit(db, 'user.create', 'user', userId, o.org ?? null, { email: o.email, role });
  return { userId, password: o.password ? undefined : password };
}

export async function apikeyCreate(db: Db, o: { org: string; name?: string; mode?: string; scopes?: string; ttlDays?: number }) {
  const mode = (o.mode ?? 'live') as 'live' | 'test';
  if (mode !== 'live' && mode !== 'test') throw new AdminError('--mode 는 live|test');
  const scopes = (o.scopes ?? API_SCOPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean) as ApiScope[];
  const issued = await createApiKeyService(db).issue(o.org, { name: o.name ?? 'default', mode, scopes, ttlDays: o.ttlDays });
  await audit(db, 'apikey.create', 'api_key', issued.apiKeyId, o.org, { prefix: issued.prefix, scopes, expiresAt: issued.expiresAt.toISOString() });
  return issued;
}

export async function apikeyRevoke(db: Db, o: { id: string }) {
  await createApiKeyService(db).revoke(o.id);
  await audit(db, 'apikey.revoke', 'api_key', o.id, null, {});
  return { apiKeyId: o.id };
}

/** 라벨 코드 4-4-4-4 표기 */
export const formatClaimSecret = (s: string) => s.match(/.{4}/g)!.join('-');

/**
 * 출고 등록: 공개키·소속 조직 등록 + 라벨 secret 출력(FLEET.md compute-id 흐름 뒤).
 * 같은 공개키로 다시 부르면 멱등. 다른 공개키(SSD 복제 감지로 키 재생성)는 --force 로만 교체.
 */
export async function gatewayProvision(db: Db, o: { id: string; pubkey: string; org: string; labelMasterKey: string; appOrigin: string; force?: boolean }) {
  if (!ID_PATTERNS.gateway.test(o.id)) throw new AdminError('--id 는 gw_<uuid> 형식');
  if (!PUBKEY_RE.test(o.pubkey)) throw new AdminError('--pubkey 는 Ed25519 raw 32B base64url(43자)');
  if (!ID_PATTERNS.org.test(o.org)) throw new AdminError('--org 형식(org_ULID)이 올바르지 않습니다');
  if (!o.labelMasterKey || o.labelMasterKey.length < 32) throw new AdminError('LABEL_MASTER_KEY(32자 이상) 환경 변수가 필요합니다');
  const [org] = await db.select().from(organizations).where(eq(organizations.orgId, o.org));
  if (!org) throw new AdminError(`조직 ${o.org} 이 없습니다`);
  const [existing] = await db.select().from(gateways).where(eq(gateways.gatewayId, o.id));
  let action = 'gateway.provision';
  if (existing) {
    if (existing.pubkey !== o.pubkey) {
      if (!o.force) throw new AdminError('이미 다른 공개키로 등록된 GW 입니다. 키 재생성(SSD 복제 등)이면 --force');
      await db.update(gateways).set({ pubkey: o.pubkey }).where(eq(gateways.gatewayId, o.id));
      action = 'gateway.pubkey_replaced';
    } else if (existing.orgId !== o.org) {
      throw new AdminError(`이미 ${existing.orgId} 로 등록되었습니다. 조직 이전은 gateway:transfer-org`);
    } else {
      action = 'gateway.provision_repeat';
    }
  } else {
    await db.insert(gateways).values({ gatewayId: o.id, shortId: shortIdOf(o.id), orgId: o.org, pubkey: o.pubkey, status: 'unbound' });
  }
  await audit(db, action, 'gateway', o.id, o.org, { pubkey: o.pubkey });
  const claimSecret = claimSecretFor(o.labelMasterKey, o.id);
  return {
    gatewayId: o.id,
    shortId: shortIdOf(o.id),
    label: `siot-${shortIdOf(o.id)}`,
    claimSecret,
    labelCode: formatClaimSecret(claimSecret),
    qrUrl: `${o.appOrigin.replace(/\/$/, '')}/g/${o.id}#${claimSecret}`,
    action,
  };
}

export async function gatewayClaimWindow(db: Db, o: { id: string; hours?: number; now?: Date }) {
  const hours = o.hours ?? CLAIM_WINDOW_HOURS;
  const until = new Date((o.now ?? new Date()).getTime() + hours * 3600_000);
  const r = await db.update(gateways).set({ claimWindowUntil: until }).where(eq(gateways.gatewayId, o.id)).returning({ orgId: gateways.orgId });
  if (!r.length) throw new AdminError(`게이트웨이 ${o.id} 가 없습니다`);
  await audit(db, 'gateway.claim_window_open', 'gateway', o.id, r[0]!.orgId, { until: until.toISOString() });
  return { gatewayId: o.id, claimWindowUntil: until.toISOString() };
}

export async function gatewayTransferOrg(db: Db, o: { id: string; org: string }) {
  if (!ID_PATTERNS.org.test(o.org)) throw new AdminError('--org 형식(org_ULID)이 올바르지 않습니다');
  const [org] = await db.select().from(organizations).where(eq(organizations.orgId, o.org));
  if (!org) throw new AdminError(`조직 ${o.org} 이 없습니다`);
  const [gw] = await db.select().from(gateways).where(eq(gateways.gatewayId, o.id));
  if (!gw) throw new AdminError(`게이트웨이 ${o.id} 가 없습니다`);
  if (gw.siteId) throw new AdminError('세대에 연결된 GW 는 이전할 수 없습니다(세대 초기화·공장초기화 후)');
  await db.update(gateways).set({ orgId: o.org }).where(eq(gateways.gatewayId, o.id));
  await audit(db, 'gateway.transfer_org', 'gateway', o.id, o.org, { from: gw.orgId, to: o.org });
  return { gatewayId: o.id, from: gw.orgId, to: o.org };
}
