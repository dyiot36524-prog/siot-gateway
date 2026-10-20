// 소유: Step 2 백엔드 실행자. POST /app/v1/gateways/claim (계획 B2).
import type { FastifyInstance } from 'fastify';
import type { AppApiDeps } from './index.js';

export type ClaimErrorCode =
  | 'INVALID_CLAIM_SECRET'
  | 'GATEWAY_NOT_PROVISIONED'
  | 'GATEWAY_ALREADY_BOUND'
  | 'GATEWAY_ORG_MISMATCH'
  | 'CLAIM_WINDOW_CLOSED';

export const CLAIM_ERROR_STATUS: Record<ClaimErrorCode, number> = {
  INVALID_CLAIM_SECRET: 400,
  GATEWAY_NOT_PROVISIONED: 409,
  GATEWAY_ALREADY_BOUND: 409,
  GATEWAY_ORG_MISMATCH: 403,
  CLAIM_WINDOW_CLOSED: 423,
};

/**
 * TODO(Step 2): 조직 일치·상태·claim 창 검사(세대 행 FOR UPDATE) → 토큰 + 세대 키 v1 → bus.sendBind + bus.sendCfg.
 * registerAppApi 가 이 함수를 호출한다.
 */
export async function registerGatewayClaim(_app: FastifyInstance, _deps: AppApiDeps): Promise<void> {
  throw new Error('registerGatewayClaim: not implemented (Step 2)');
}
