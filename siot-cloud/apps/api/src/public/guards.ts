// 공개 API 가드: 스코프(403 INSUFFICIENT_SCOPE), ID 형식(400).
import type { FastifyRequest } from 'fastify';
import type { ApiScope } from '../auth/apiKey.js';
import { ID_PATTERNS } from '../ids.js';
import { badRequest, forbidden, unauthorized } from '../http.js';

export function requireScope(req: FastifyRequest, scope: ApiScope): string {
  const p = req.principal;
  if (!p) throw unauthorized();
  if (!p.scopes.includes(scope)) throw forbidden(`이 키에는 ${scope} 스코프가 없습니다`, 'INSUFFICIENT_SCOPE');
  return p.orgId;
}

export function checkId(kind: keyof typeof ID_PATTERNS, value: string, label: string): void {
  if (!ID_PATTERNS[kind].test(value)) throw badRequest(`${label} 형식이 올바르지 않습니다`);
}

