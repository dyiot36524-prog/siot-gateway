// 공개 API 키(계획 §2 키 수명·회전): sk_live_|sk_test_ + 32자 base62, SHA-256 해시, 앞 12자 표시,
// 만료 365일(최대 730일), 조직당 활성 최대 2개, 폐기 후 다음 요청부터 401.
import type { FastifyRequest } from 'fastify';

export const API_KEY_PATTERN = /^sk_(live|test)_[0-9A-Za-z]{32}$/;
export const API_KEY_PREFIX_LEN = 12;
export const API_KEY_MAX_ACTIVE_PER_ORG = 2;
export type ApiScope = 'devices:read' | 'devices:control' | 'webhooks:manage';

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

/** TODO(Step 1) */
export function hashApiKey(_key: string): string {
  throw new Error('hashApiKey: not implemented (Step 1)');
}
