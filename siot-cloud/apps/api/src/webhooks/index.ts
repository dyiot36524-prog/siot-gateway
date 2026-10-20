// 소유: Step 1 실행자. 트랜잭셔널 outbox(webhook_deliveries) + 인프로세스 워커.
// 재시도 10s,30s,2m,10m,30m,1h,3h,6h 후 dead-letter, 24h 연속 실패 자동 비활성, 배포 후 90초 offline 유예.
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';

export const WEBHOOK_RETRY_DELAYS_SEC = [10, 30, 120, 600, 1800, 3600, 10800, 21600] as const;
export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;
export const OFFLINE_GRACE_AFTER_DEPLOY_SEC = 90;

export interface WebhookDeps {
  config: Config;
  db: Db;
}

export interface WebhookWorker {
  /** 같은 트랜잭션 커밋 직후 1차 시도를 깨운다 */
  kick(): void;
  stop(): Promise<void>;
}

/** TODO(Step 1) */
export async function registerWebhooks(_app: FastifyInstance, _deps: WebhookDeps): Promise<WebhookWorker> {
  throw new Error('registerWebhooks: not implemented (Step 1)');
}
