// 앱 세션(계획 Step 3a): 이메일+비밀번호(argon2id), httpOnly Secure SameSite=Lax 쿠키, 30일 슬라이딩.
// 쿠키 원문은 저장하지 않고 sessions.session_hash = SHA-256(token) 만 둔다.
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

export const SESSION_COOKIE = 'siot_session';
export const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 86_400_000;
/** 슬라이딩 연장 쓰기 간격(매 요청 UPDATE 방지) */
const SLIDE_EVERY_MS = 5 * 60_000;
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

export const hashSessionToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function createSessionService(db: Db, opts: { secureCookie: boolean; now?: () => Date }): SessionService {
  const now = opts.now ?? (() => new Date());
  let dummyHash: Promise<string> | null = null;
  const cookieOpts = { httpOnly: true, secure: opts.secureCookie, sameSite: 'lax' as const, path: '/', maxAge: SESSION_TTL_MS / 1000 };

  const toUser = (u: typeof users.$inferSelect): SessionUser => ({ userId: u.userId, orgId: u.orgId, role: u.role, email: u.email, name: u.name });

  return {
    hashPassword,

    async login(email, password, reply, userAgent) {
      const [u] = await db
        .select()
        .from(users)
        .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.disabledAt)))
        .limit(1);
      if (!u) {
        // 존재하지 않는 계정도 같은 시간이 걸리게
        dummyHash ??= hashPassword('dummy-password-for-timing');
        await argon2.verify(await dummyHash, password).catch(() => false);
        return null;
      }
      const ok = await argon2.verify(u.passwordHash, password).catch(() => false);
      if (!ok) return null;
      const token = randomBytes(32).toString('base64url');
      const t = now();
      await db.insert(sessions).values({
        sessionHash: hashSessionToken(token),
        userId: u.userId,
        createdAt: t,
        lastSeenAt: t,
        expiresAt: new Date(t.getTime() + SESSION_TTL_MS),
        userAgent: userAgent?.slice(0, 300) ?? null,
      });
      reply.setCookie(SESSION_COOKIE, token, cookieOpts);
      return toUser(u);
    },

    async logout(req, reply) {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) await db.delete(sessions).where(eq(sessions.sessionHash, hashSessionToken(token)));
      reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: opts.secureCookie, sameSite: 'lax' });
    },

    async authenticate(req, reply) {
      const token = req.cookies?.[SESSION_COOKIE];
      if (!token || token.length > 100) return null;
      const h = hashSessionToken(token);
      const t = now();
      const [row] = await db
        .select({ s: sessions, u: users })
        .from(sessions)
        .innerJoin(users, eq(users.userId, sessions.userId))
        .where(and(eq(sessions.sessionHash, h), gt(sessions.expiresAt, t), isNull(users.disabledAt)))
        .limit(1);
      if (!row) return null;
      if (t.getTime() - row.s.lastSeenAt.getTime() > SLIDE_EVERY_MS) {
        await db
          .update(sessions)
          .set({ lastSeenAt: t, expiresAt: new Date(t.getTime() + SESSION_TTL_MS) })
          .where(eq(sessions.sessionHash, h));
        reply.setCookie(SESSION_COOKIE, token, cookieOpts);
      }
      return toUser(row.u);
    },
  };
}
