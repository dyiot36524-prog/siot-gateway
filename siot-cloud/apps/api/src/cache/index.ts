// 소유: Step 1 실행자.
import type { Db } from '../db/client.js';
import type { StateCache } from './StateCache.js';

export type { StateCache, ApplyResult, DeviceListener } from './StateCache.js';

export interface CacheDeps {
  db: Db;
}

/** TODO(Step 1): DB 에서 devices·gateways 를 읽어 인메모리 캐시를 만든다. */
export async function createStateCache(_deps: CacheDeps): Promise<StateCache> {
  throw new Error('createStateCache: not implemented (Step 1)');
}
