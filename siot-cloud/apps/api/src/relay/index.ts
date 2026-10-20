// 소유: Step 2 백엔드 실행자. app.ts 는 registerRelay(app, deps) 만 호출한다.
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { StateCache } from '../cache/StateCache.js';
import type { GatewayBus } from './GatewayBus.js';

export type { GatewayBus } from './GatewayBus.js';

export interface RelayDeps {
  config: Config;
  db: Db;
  cache: StateCache;
}

/**
 * GET /gateway (WebSocket) 를 등록하고 GatewayBus 구현을 돌려준다.
 * TODO(Step 2): challenge/hello 검증(사전 등록 공개키만, 미등록 4403, 쿼리 토큰 4401), 연결 레지스트리,
 * 하트비트 10s/25s, 접속 순서(cfg 보낸 연결은 cfg_ack 전 snapshot·evt 보류, 최대 1,000건/10초),
 * bind 유실 재발급(옛 해시 즉시 폐기 + 감사 로그), snapshot·evt → cache, ack, offline 판정.
 */
export async function registerRelay(_app: FastifyInstance, _deps: RelayDeps): Promise<GatewayBus> {
  throw new Error('registerRelay: not implemented (Step 2)');
}
