// 트랜잭셔널 outbox 의 좁은 인터페이스. src/relay 와 cache 가 호출한다.
// - 완성된 이벤트(eventId 포함)는 그대로, gateway.online/offline 입력({type, gatewayId, siteId, at})은 outbox 가 봉투를 만든다.
// - tx 를 넘기면 같은 트랜잭션에 적재하고, 커밋 후 호출자가 kick() 한다(넘기지 않으면 enqueue 가 kick).
import { and, arrayContains, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { webhookDeliveries, webhooks } from '../db/schema.js';
import { newId } from '../ids.js';

export const WEBHOOK_EVENT_TYPES = ['device.state_changed', 'device.removed', 'gateway.online', 'gateway.offline', 'api_key.expiring'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEvent {
  eventId: string;
  type: WebhookEventType;
  createdAt: string;
  replayed: boolean;
  [k: string]: unknown;
}

export interface GatewayStatusInput {
  type: 'gateway.online' | 'gateway.offline';
  gatewayId: string;
  siteId: string | null;
  at: string;
  data?: unknown;
}

export type OutboxInput = WebhookEvent | GatewayStatusInput;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Outbox {
  enqueue(orgId: string, event: OutboxInput, tx?: Tx): Promise<void>;
}

/** gateway.online/offline 봉투의 data.gateway(public-v1 Gateway). 없거나 세대 미소속이면 null */
export type GatewayDescriber = (gatewayId: string) => Record<string, unknown> | null;

export class PgOutbox implements Outbox {
  describeGateway: GatewayDescriber = () => null;
  onEnqueued: () => void = () => {};

  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  kick(): void {
    this.onEnqueued();
  }

  async enqueue(orgId: string, input: OutboxInput, tx?: Tx): Promise<void> {
    const q = tx ?? this.db;
    let ev: WebhookEvent;
    if ('eventId' in input) {
      ev = input;
    } else {
      if (!input.siteId) return;
      const gateway = this.describeGateway(input.gatewayId);
      if (!gateway || !gateway.siteId) return;
      // 같은 GW 의 직전 상태 이벤트와 같으면 억제(배포 후 재접속의 online 등)
      const [last] = await q
        .select({ type: webhookDeliveries.eventType })
        .from(webhookDeliveries)
        .innerJoin(webhooks, eq(webhooks.webhookId, webhookDeliveries.webhookId))
        .where(
          and(
            eq(webhooks.orgId, orgId),
            inArray(webhookDeliveries.eventType, ['gateway.online', 'gateway.offline']),
            sql`${webhookDeliveries.payload}->'data'->'gateway'->>'gatewayId' = ${input.gatewayId}`,
          ),
        )
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(1);
      if (last?.type === input.type) return;
      ev = { eventId: newId('evt'), type: input.type, createdAt: this.now().toISOString(), replayed: false, data: { gateway } };
    }
    const subs = await q
      .select({ webhookId: webhooks.webhookId })
      .from(webhooks)
      .where(and(eq(webhooks.orgId, orgId), isNull(webhooks.deletedAt), isNull(webhooks.disabledAt), arrayContains(webhooks.events, [ev.type])));
    if (!subs.length) return;
    await this.insert(q, ev, subs.map((s) => s.webhookId));
    if (!tx) this.kick();
  }

  /** 특정 웹훅 하나에만(POST /v1/webhooks/{id}/test) */
  async enqueueTo(webhookId: string, ev: WebhookEvent): Promise<void> {
    await this.insert(this.db, ev, [webhookId]);
    this.kick();
  }

  private async insert(q: Db | Tx, ev: WebhookEvent, webhookIds: string[]): Promise<void> {
    const t = this.now();
    await q
      .insert(webhookDeliveries)
      .values(webhookIds.map((webhookId) => ({ deliveryId: newId('whd'), eventId: ev.eventId, webhookId, eventType: ev.type, payload: ev, createdAt: t, nextAt: t })))
      .onConflictDoNothing();
  }
}
