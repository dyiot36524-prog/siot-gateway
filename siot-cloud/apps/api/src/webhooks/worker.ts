// 인프로세스 웹훅 워커: 적재 직후 1차 시도(kick), 실패하면 10s,30s,2m,10m,30m,1h,3h,6h 후 재시도(8회), 그 뒤 dead-letter.
// 24h 연속 실패한 웹훅은 자동 비활성 + 경보. 시도당 5초 타임아웃. 시계(now)를 주입할 수 있다(재시도 간격 시험).
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import { apiKeys, webhookDeliveries, webhooks } from '../db/schema.js';
import { decryptSecret } from '../auth/secretBox.js';
import { findExpiringKeys } from '../auth/apiKey.js';
import { newId } from '../ids.js';
import type { Metrics } from '../metrics/index.js';
import type { Alerts } from './alerts.js';
import type { PgOutbox } from './Outbox.js';
import { signPayload } from './sign.js';

export const WEBHOOK_RETRY_DELAYS_SEC = [10, 30, 120, 600, 1800, 3600, 10800, 21600] as const;
export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_DISABLE_AFTER_MS = 24 * 3600_000;

export interface WorkerOptions {
  db: Db;
  encKey: string;
  outbox: PgOutbox;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  metrics?: Pick<Metrics, 'webhookLatency'>;
  alerts?: Alerts;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** 대기 중 재시도 폴링 간격(ms). 0 이면 폴링 안 함(테스트에서 runOnce 직접 호출) */
  pollMs?: number;
}

export class WebhookWorker {
  private readonly now: () => Date;
  private readonly doFetch: typeof fetch;
  private readonly inflight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private expiringTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;

  constructor(private readonly o: WorkerOptions) {
    this.now = o.now ?? (() => new Date());
    this.doFetch = o.fetchImpl ?? fetch;
    o.outbox.onEnqueued = () => this.kick();
  }

  start(): void {
    this.stopped = false;
    const poll = this.o.pollMs ?? 1000;
    if (poll > 0) {
      this.timer = setInterval(() => this.kick(), poll);
      this.timer.unref();
      this.expiringTimer = setInterval(() => void this.notifyExpiringKeys().catch((err) => this.o.log.error({ err }, 'api_key.expiring job failed')), 3600_000);
      this.expiringTimer.unref();
      void this.notifyExpiringKeys().catch((err) => this.o.log.error({ err }, 'api_key.expiring job failed'));
    }
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.expiringTimer) clearInterval(this.expiringTimer);
    this.timer = this.expiringTimer = null;
    await this.running;
  }

  /** 지금 처리할 것이 있으면 처리(동시 1회, 진행 중이면 끝난 뒤 한 번 더) */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.runOnce();
        } catch (err) {
          this.o.log.error({ err }, 'webhook worker run failed');
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
  }

  /** 지금 기한이 된 전달을 모두 1회 시도한다. 시도한 수를 반환 */
  async runOnce(): Promise<number> {
    const t = this.now();
    const due = await this.o.db
      .select({ d: webhookDeliveries, w: webhooks })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.webhookId, webhookDeliveries.webhookId))
      .where(and(inArray(webhookDeliveries.status, ['pending', 'failed']), lte(webhookDeliveries.nextAt, t)))
      .orderBy(asc(webhookDeliveries.nextAt), asc(webhookDeliveries.createdAt))
      .limit(100);
    const todo = due.filter((r) => !this.inflight.has(r.d.deliveryId));
    await Promise.all(todo.map((r) => this.attempt(r.d, r.w)));
    return todo.length;
  }

  private async attempt(d: typeof webhookDeliveries.$inferSelect, w: typeof webhooks.$inferSelect): Promise<void> {
    this.inflight.add(d.deliveryId);
    try {
      if (w.deletedAt || w.disabledAt) {
        await this.o.db
          .update(webhookDeliveries)
          .set({ status: 'dead', lastError: w.deletedAt ? 'WEBHOOK_DELETED' : 'WEBHOOK_DISABLED' })
          .where(eq(webhookDeliveries.deliveryId, d.deliveryId));
        return;
      }
      const body = JSON.stringify(d.payload);
      const started = this.now();
      let statusCode: number | null = null;
      let error: string | null = null;
      try {
        const secret = decryptSecret(w.secretEnc, this.o.encKey);
        const res = await this.doFetch(w.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'siot-webhooks/1',
            'siot-signature': signPayload(secret, body, Math.floor(started.getTime() / 1000)),
            'siot-event-id': d.eventId,
            'siot-event-type': d.eventType,
          },
          body,
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          redirect: 'manual',
        });
        statusCode = res.status;
        await res.arrayBuffer().catch(() => undefined);
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (err) {
        error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      const attempt = d.attempt + 1;
      const t = this.now();
      if (!error) {
        await this.o.db
          .update(webhookDeliveries)
          .set({ status: 'delivered', attempt, lastStatusCode: statusCode, lastError: null, deliveredAt: t })
          .where(eq(webhookDeliveries.deliveryId, d.deliveryId));
        if (w.failingSince) await this.o.db.update(webhooks).set({ failingSince: null }).where(eq(webhooks.webhookId, w.webhookId));
        this.o.metrics?.webhookLatency.observe(Math.max(0, (t.getTime() - d.createdAt.getTime()) / 1000));
        return;
      }
      const delay = WEBHOOK_RETRY_DELAYS_SEC[attempt - 1];
      await this.o.db
        .update(webhookDeliveries)
        .set(
          delay === undefined
            ? { status: 'dead', attempt, lastStatusCode: statusCode, lastError: error }
            : { status: 'failed', attempt, lastStatusCode: statusCode, lastError: error, nextAt: new Date(t.getTime() + delay * 1000) },
        )
        .where(eq(webhookDeliveries.deliveryId, d.deliveryId));
      if (delay === undefined) this.o.log.warn({ webhookId: w.webhookId, eventId: d.eventId }, 'webhook delivery dead-lettered');
      // 연속 실패 시작 시각 기록, 24h 넘으면 자동 비활성 + 경보
      const [cur] = await this.o.db
        .update(webhooks)
        .set({ failingSince: sql`coalesce(${webhooks.failingSince}, ${started.toISOString()}::timestamptz)` })
        .where(eq(webhooks.webhookId, w.webhookId))
        .returning({ failingSince: webhooks.failingSince, disabledAt: webhooks.disabledAt });
      if (cur?.failingSince && !cur.disabledAt && t.getTime() - cur.failingSince.getTime() >= WEBHOOK_DISABLE_AFTER_MS) {
        await this.o.db.update(webhooks).set({ disabledAt: t }).where(and(eq(webhooks.webhookId, w.webhookId), isNull(webhooks.disabledAt)));
        await this.o.alerts?.notify(`webhook.disabled:${w.webhookId}`, `웹훅 ${w.webhookId} 가 24시간 연속 실패로 자동 비활성되었습니다`, {
          orgId: w.orgId,
          url: w.url,
          lastError: error,
        });
      }
    } finally {
      this.inflight.delete(d.deliveryId);
    }
  }

  /** 만료 30일 전 키에 api_key.expiring 1회 */
  async notifyExpiringKeys(): Promise<number> {
    const t = this.now();
    const keys = await findExpiringKeys(this.o.db, t);
    for (const k of keys) {
      await this.o.db.transaction(async (tx) => {
        const r = await tx
          .update(apiKeys)
          .set({ expiringNotifiedAt: t })
          .where(and(eq(apiKeys.apiKeyId, k.apiKeyId), isNull(apiKeys.expiringNotifiedAt)))
          .returning({ id: apiKeys.apiKeyId });
        if (!r.length) return;
        await this.o.outbox.enqueue(
          k.orgId,
          { eventId: newId('evt'), type: 'api_key.expiring', createdAt: t.toISOString(), replayed: false, data: { prefix: k.prefix, expiresAt: k.expiresAt.toISOString() } },
          tx,
        );
      });
    }
    if (keys.length) this.kick();
    return keys.length;
  }
}
