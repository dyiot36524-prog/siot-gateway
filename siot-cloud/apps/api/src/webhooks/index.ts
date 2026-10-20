// 소유: Step 1 실행자. 트랜잭셔널 outbox(webhook_deliveries) + 인프로세스 워커.
// 재시도 10s,30s,2m,10m,30m,1h,3h,6h 후 dead-letter, 24h 연속 실패 자동 비활성, 배포 후 90초 offline 유예(relay 가 deployedAt 기준 적용).
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { Metrics } from '../metrics/index.js';
import { createAlerts, type Alerts } from './alerts.js';
import { PgOutbox } from './Outbox.js';
import { WebhookWorker } from './worker.js';

export { WEBHOOK_RETRY_DELAYS_SEC, WEBHOOK_TIMEOUT_MS, WebhookWorker } from './worker.js';
export { WEBHOOK_SIGNATURE_TOLERANCE_SEC, signPayload, verifySignature } from './sign.js';
export { PgOutbox, type Outbox, type OutboxInput, type WebhookEvent, type WebhookEventType, WEBHOOK_EVENT_TYPES } from './Outbox.js';
export const OFFLINE_GRACE_AFTER_DEPLOY_SEC = 90;

export interface WebhookDeps {
  config: Pick<Config, 'DATA_ENC_KEY' | 'ALERT_WEBHOOK_URL'>;
  db: Db;
  metrics?: Metrics;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** false 면 워커를 자동 시작하지 않는다(테스트) */
  autoStart?: boolean;
  pollMs?: number;
}

export interface WebhookModule {
  outbox: PgOutbox;
  worker: WebhookWorker;
  alerts: Alerts;
}

export async function registerWebhooks(app: FastifyInstance, deps: WebhookDeps): Promise<WebhookModule> {
  const outbox = new PgOutbox(deps.db, deps.now);
  const alerts = createAlerts({ url: deps.config.ALERT_WEBHOOK_URL, log: app.log, fetchImpl: deps.fetchImpl });
  const worker = new WebhookWorker({
    db: deps.db,
    encKey: deps.config.DATA_ENC_KEY,
    outbox,
    log: app.log,
    metrics: deps.metrics,
    alerts,
    now: deps.now,
    fetchImpl: deps.fetchImpl,
    pollMs: deps.pollMs,
  });
  if (deps.autoStart !== false) app.addHook('onReady', async () => worker.start());
  app.addHook('onClose', async () => worker.stop());
  return { outbox, worker, alerts };
}
