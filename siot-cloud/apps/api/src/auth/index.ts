// 소유: Step 1 실행자.
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { ApiKeyService } from './apiKey.js';
import type { SessionService } from './session.js';

export type { ApiKeyService, ApiKeyPrincipal, ApiScope } from './apiKey.js';
export type { SessionService, SessionUser, Role } from './session.js';

export interface AuthDeps {
  config: Config;
  db: Db;
}

/** TODO(Step 1): @fastify/cookie 등록, API 키·세션 서비스 생성, 속도 제한(키당 20 req/s 버스트 40). */
export async function registerAuth(_app: FastifyInstance, _deps: AuthDeps): Promise<{ apiKeys: ApiKeyService; sessions: SessionService }> {
  throw new Error('registerAuth: not implemented (Step 1)');
}
