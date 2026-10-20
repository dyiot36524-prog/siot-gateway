// 소유: Step 1 실행자.
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { createApiKeyService, type ApiKeyService } from './apiKey.js';
import { createSessionService, type SessionService } from './session.js';

export type { ApiKeyService, ApiKeyPrincipal, ApiScope } from './apiKey.js';
export type { SessionService, SessionUser, Role } from './session.js';

export interface AuthDeps {
  config: Config;
  db: Db;
  now?: () => Date;
}

/** API 키·세션 서비스 생성. 쿠키 플러그인은 app.ts 가 등록하고, 속도 제한은 public/ 의 onRequest 훅이 건다. */
export async function registerAuth(_app: FastifyInstance, deps: AuthDeps): Promise<{ apiKeys: ApiKeyService; sessions: SessionService }> {
  const apiKeys = createApiKeyService(deps.db, { now: deps.now });
  const sessions = createSessionService(deps.db, {
    secureCookie: deps.config.APP_ORIGIN.startsWith('https://'),
    now: deps.now,
  });
  return { apiKeys, sessions };
}
