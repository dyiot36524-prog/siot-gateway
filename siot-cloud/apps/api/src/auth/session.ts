// 앱 세션(계획 Step 3a): 이메일+비밀번호(argon2id), httpOnly Secure SameSite=Lax 쿠키, 30일 슬라이딩.
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'siot_session';
export const SESSION_TTL_DAYS = 30;
export type Role = 'installer' | 'resident' | 'operator';

export interface SessionUser {
  userId: string;
  orgId: string | null;
  role: Role;
  email: string;
  name: string;
}

export interface SessionService {
  /** 성공하면 쿠키를 심고 사용자 반환, 실패면 null(→ 401 INVALID_CREDENTIALS) */
  login(email: string, password: string, reply: FastifyReply, userAgent?: string): Promise<SessionUser | null>;
  logout(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** 쿠키 검증 + 슬라이딩 연장. 없거나 만료면 null(→ 401) */
  authenticate(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null>;
  hashPassword(password: string): Promise<string>;
}
