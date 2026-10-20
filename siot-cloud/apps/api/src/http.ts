// HTTP 공통: 오류 형식 {error:{code,message}}, cursor 페이지(limit 기본 100, 최대 500).
import type { FastifyReply } from 'fastify';
import type { ApiKeyPrincipal } from './auth/apiKey.js';
import type { SessionUser } from './auth/session.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const errorBody = (code: string, message: string) => ({ error: { code, message } });

export function sendError(reply: FastifyReply, err: HttpError): FastifyReply {
  for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
  return reply.code(err.statusCode).send(errorBody(err.code, err.message));
}

export const forbidden = (message = '이 자원에 접근할 수 없습니다', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (message = '찾을 수 없습니다') => new HttpError(404, 'NOT_FOUND', message);
export const badRequest = (message: string, code = 'VALIDATION_FAILED') => new HttpError(400, code, message);
export const unauthorized = (message = '인증이 필요합니다', code = 'UNAUTHORIZED') => new HttpError(401, code, message);

export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 500;

export interface PageQuery {
  limit: number;
  /** 이 id 보다 큰 항목부터 */
  after: string | null;
}

export function parsePage(query: unknown): PageQuery {
  const q = (query ?? {}) as Record<string, unknown>;
  let limit = PAGE_DEFAULT;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX) throw badRequest(`limit 은 1~${PAGE_MAX} 정수여야 합니다`);
    limit = n;
  }
  let after: string | null = null;
  if (q.cursor !== undefined && q.cursor !== '') {
    try {
      const v = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString('utf8')) as { a?: unknown };
      if (typeof v.a !== 'string') throw new Error('bad');
      after = v.a;
    } catch {
      throw badRequest('cursor 가 올바르지 않습니다', 'INVALID_CURSOR');
    }
  }
  return { limit, after };
}

export const encodeCursor = (id: string) => Buffer.from(JSON.stringify({ a: id }), 'utf8').toString('base64url');

/** id 오름차순으로 정렬된 전체 목록에서 한 페이지 */
export function pageOf<T>(sorted: T[], idOf: (t: T) => string, page: PageQuery): { data: T[]; nextCursor: string | null } {
  const start = page.after === null ? 0 : sorted.findIndex((t) => idOf(t) > page.after!);
  const from = start < 0 ? sorted.length : start;
  const data = sorted.slice(from, from + page.limit);
  const more = from + page.limit < sorted.length;
  return { data, nextCursor: more && data.length ? encodeCursor(idOf(data[data.length - 1]!)) : null };
}

/** DB 에서 limit+1 개를 읽은 결과로 페이지 구성 */
export function pageFromRows<T>(rows: T[], idOf: (t: T) => string, limit: number): { data: T[]; nextCursor: string | null } {
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit && data.length ? encodeCursor(idOf(data[data.length - 1]!)) : null };
}


declare module 'fastify' {
  interface FastifyRequest {
    /** onRequest 시각(performance.now) — 제어 deadline 기준 */
    t0: number;
    /** 공개 API 키 인증 결과 */
    principal: ApiKeyPrincipal | null;
    /** 앱 세션 사용자 */
    sessionUser: SessionUser | null;
  }
}
