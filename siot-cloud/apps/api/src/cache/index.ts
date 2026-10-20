// 소유: Step 1 실행자.
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import { PgStateCache, type CacheOutbox } from './PgStateCache.js';
import type { StateCache } from './StateCache.js';

export type { StateCache, ApplyResult, DeviceListener, GatewayView, CacheEvent, DeviceRef } from './StateCache.js';
export { PgStateCache } from './PgStateCache.js';

export interface CacheDeps {
  db: Db;
  outbox?: CacheOutbox;
  log?: Pick<FastifyBaseLogger, 'warn' | 'error'>;
  now?: () => Date;
  onOnlineCount?: (n: number) => void;
}

/** DB 에서 devices·gateways 를 읽어 인메모리 캐시를 만든다(모든 GW offline 으로 시작). */
export async function createStateCache(deps: CacheDeps): Promise<StateCache> {
  const cache = new PgStateCache(deps);
  await cache.load();
  return cache;
}
