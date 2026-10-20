// 소유: Step 1 실행자(단 gateways.ts 의 claim 은 Step 2). 계약: openapi/app-v1.yaml (/app/v1/*).
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { SessionService } from '../auth/session.js';
import type { StateCache } from '../cache/StateCache.js';
import type { GatewayBus } from '../relay/GatewayBus.js';

export interface AppApiDeps {
  config: Config;
  db: Db;
  cache: StateCache;
  bus: GatewayBus;
  sessions: SessionService;
}

/** TODO(Step 1): auth/me/sites/devices/control/pairing/events(SSE). 역할 403 규칙은 app-v1.yaml 설명대로. */
export async function registerAppApi(_app: FastifyInstance, _deps: AppApiDeps): Promise<void> {
  throw new Error('registerAppApi: not implemented (Step 1)');
}
