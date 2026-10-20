// 공개 API 키(계획 §2 키 수명·회전): sk_live_|sk_test_ + 32자 base62, SHA-256 해시, 앞 12자 표시,
// 만료 365일(최대 730일), 조직당 활성 최대 2개, 폐기 후 다음 요청부터 401.
// 폐기는 다른 프로세스(운영자 CLI)에서도 일어나므로 인증은 매 요청 DB(해시 유니크 인덱스)를 본다.
import { createHash, randomInt } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { and, count, eq, gt, isNull, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { apiKeys, organizations } from '../db/schema.js';
import { newId } from '../ids.js';

export const API_KEY_PATTERN = /^sk_(live|test)_[0-9A-Za-z]{32}$/;
export const API_KEY_PREFIX_LEN = 12;
export const API_KEY_MAX_ACTIVE_PER_ORG = 2;
export const API_KEY_DEFAULT_TTL_DAYS = 365;
export const API_KEY_MAX_TTL_DAYS = 730;
export const API_SCOPES = ['devices:read', 'devices:control', 'webhooks:manage'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyPrincipal {
  apiKeyId: string;
  orgId: string;
  mode: 'live' | 'test';
  scopes: ApiScope[];
}

export interface IssuedApiKey {
  apiKeyId: string;
  /** 원문. 발급 시 한 번만 */
  key: string;
  prefix: string;
  expiresAt: Date;
}

export interface ApiKeyService {
  issue(orgId: string, opts: { name: string; mode: 'live' | 'test'; scopes: ApiScope[]; ttlDays?: number }): Promise<IssuedApiKey>;
  revoke(apiKeyId: string): Promise<void>;
  /** Authorization: Bearer 를 검증. 실패면 null(→ 401) */
  authenticate(req: FastifyRequest): Promise<ApiKeyPrincipal | null>;
}

export class ApiKeyLimitError extends Error {
  readonly code = 'API_KEY_LIMIT';
  constructor(readonly orgId: string) {
    super(`조직 ${orgId} 의 활성 키가 이미 ${API_KEY_MAX_ACTIVE_PER_ORG}개입니다. 기존 키를 폐기한 뒤 발급하세요`);
  }
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generateApiKey(mode: 'live' | 'test'): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += BASE62[randomInt(62)];
  return `sk_${mode}_${s}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

export function createApiKeyService(db: Db, opts: { now?: () => Date } = {}): ApiKeyService {
  const now = opts.now ?? (() => new Date());
  const lastTouched = new Map<string, number>();

  return {
    async issue(orgId, o) {
      const ttlDays = o.ttlDays ?? API_KEY_DEFAULT_TTL_DAYS;
      if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > API_KEY_MAX_TTL_DAYS) {
        throw new RangeError(`ttlDays 는 1~${API_KEY_MAX_TTL_DAYS} 이어야 합니다`);
      }
      const scopes = [...new Set(o.scopes)];
      if (!scopes.length || scopes.some((s) => !API_SCOPES.includes(s))) throw new RangeError(`scopes 는 ${API_SCOPES.join('|')} 중 1개 이상`);
      return db.transaction(async (tx) => {
        // 조직 행 잠금으로 "최대 2개" 검사를 직렬화
        const org = await tx.select({ orgId: organizations.orgId }).from(organizations).where(eq(organizations.orgId, orgId)).for('update');
        if (!org.length) throw new RangeError(`조직 ${orgId} 이 없습니다`);
        const t = now();
        const [active] = await tx
          .select({ n: count() })
          .from(apiKeys)
          .where(and(eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt), gt(apiKeys.expiresAt, t)));
        if ((active?.n ?? 0) >= API_KEY_MAX_ACTIVE_PER_ORG) throw new ApiKeyLimitError(orgId);
        const expiresAt = new Date(t.getTime() + ttlDays * 86_400_000);
        for (let attempt = 0; ; attempt++) {
          const key = generateApiKey(o.mode);
          const prefix = key.slice(0, API_KEY_PREFIX_LEN);
          const apiKeyId = newId('key');
          const r = await tx
            .insert(apiKeys)
            .values({ apiKeyId, orgId, name: o.name, mode: o.mode, prefix, hash: hashApiKey(key), scopes, createdAt: t, expiresAt })
            .onConflictDoNothing()
            .returning({ apiKeyId: apiKeys.apiKeyId });
          if (r.length) return { apiKeyId, key, prefix, expiresAt };
          if (attempt >= 4) throw new Error('API 키 prefix 충돌이 반복됩니다');
        }
      });
    },

    async revoke(apiKeyId) {
      await db.update(apiKeys).set({ revokedAt: now() }).where(and(eq(apiKeys.apiKeyId, apiKeyId), isNull(apiKeys.revokedAt)));
    },

    async authenticate(req) {
      const key = bearerToken(req);
      if (!key || !API_KEY_PATTERN.test(key)) return null;
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.hash, hashApiKey(key))).limit(1);
      const t = now();
      if (!row || row.revokedAt || row.expiresAt <= t) return null;
      const last = lastTouched.get(row.apiKeyId) ?? 0;
      if (t.getTime() - last > 60_000) {
        lastTouched.set(row.apiKeyId, t.getTime());
        db.update(apiKeys)
          .set({ lastUsedAt: t })
          .where(eq(apiKeys.apiKeyId, row.apiKeyId))
          .catch((err: unknown) => req.log.warn({ err }, 'api key lastUsedAt update failed'));
      }
      return { apiKeyId: row.apiKeyId, orgId: row.orgId, mode: row.mode, scopes: row.scopes as ApiScope[] };
    },
  };
}

/** 만료 30일 전 미통지 키(api_key.expiring 웹훅 대상) */
export async function findExpiringKeys(db: Db, at: Date, withinDays = 30) {
  return db
    .select({ apiKeyId: apiKeys.apiKeyId, orgId: apiKeys.orgId, prefix: apiKeys.prefix, expiresAt: apiKeys.expiresAt })
    .from(apiKeys)
    .where(
      and(
        isNull(apiKeys.revokedAt),
        isNull(apiKeys.expiringNotifiedAt),
        gt(apiKeys.expiresAt, at),
        lte(apiKeys.expiresAt, new Date(at.getTime() + withinDays * 86_400_000)),
      ),
    );
}
