// 소유: Step 1 실행자. 계약: openapi/public-v1.yaml (/v1/*).
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { ApiKeyService } from '../auth/apiKey.js';
import type { StateCache } from '../cache/StateCache.js';
import type { GatewayBus } from '../relay/GatewayBus.js';

export interface PublicApiDeps {
  db: Db;
  cache: StateCache;
  bus: GatewayBus;
  apiKeys: ApiKeyService;
}

/** TODO(Step 1): /v1/sites·gateways·devices·control·webhooks. 제어 확정 로직 N1(deadline 3000ms). */
export async function registerPublicApi(_app: FastifyInstance, _deps: PublicApiDeps): Promise<void> {
  throw new Error('registerPublicApi: not implemented (Step 1)');
}
