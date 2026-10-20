// GET|POST /v1/webhooks, DELETE /v1/webhooks/{id}, POST /v1/webhooks/{id}/test (스코프 webhooks:manage).
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { webhooks } from '../db/schema.js';
import { encryptSecret } from '../auth/secretBox.js';
import { newId } from '../ids.js';
import { badRequest, forbidden, notFound, pageFromRows, parsePage } from '../http.js';
import { WEBHOOK_EVENT_TYPES, type WebhookEvent, type WebhookEventType } from '../webhooks/Outbox.js';
import { generateWebhookSecret } from '../webhooks/sign.js';
import type { PublicApiDeps } from './index.js';
import { checkId, requireScope } from './guards.js';

type WebhookRow = typeof webhooks.$inferSelect;

const toWebhook = (w: WebhookRow) => ({
  webhookId: w.webhookId,
  url: w.url,
  events: w.events,
  createdAt: w.createdAt.toISOString(),
  disabledAt: w.disabledAt ? w.disabledAt.toISOString() : null,
});

/** https 만. 개발·테스트에서는 http://localhost|127.0.0.1 도 허용(partner-sim) */
export function validateWebhookUrl(raw: unknown, nodeEnv: string): string {
  if (typeof raw !== 'string' || raw.length > 2000) throw badRequest('url 이 필요합니다');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('url 형식이 올바르지 않습니다');
  }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && nodeEnv !== 'production')) throw badRequest('url 은 https:// 여야 합니다');
  if (u.username || u.password) throw badRequest('url 에 자격 증명을 넣을 수 없습니다');
  return u.toString();
}

export async function registerPublicWebhooks(r: FastifyInstance, deps: PublicApiDeps): Promise<void> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function own(orgId: string, webhookId: string): Promise<WebhookRow> {
    checkId('wh', webhookId, 'webhookId');
    const [w] = await db.select().from(webhooks).where(eq(webhooks.webhookId, webhookId)).limit(1);
    if (!w || w.orgId !== orgId) throw forbidden();
    if (w.deletedAt) throw notFound('삭제된 웹훅입니다');
    return w;
  }

  r.get('/v1/webhooks', async (req) => {
    const orgId = requireScope(req, 'webhooks:manage');
    const page = parsePage(req.query);
    const rows = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.orgId, orgId), isNull(webhooks.deletedAt), page.after ? gt(webhooks.webhookId, page.after) : undefined))
      .orderBy(asc(webhooks.webhookId))
      .limit(page.limit + 1);
    const p = pageFromRows(rows, (w) => w.webhookId, page.limit);
    return { data: p.data.map(toWebhook), nextCursor: p.nextCursor };
  });

  r.post<{ Body: unknown }>('/v1/webhooks', async (req, reply) => {
    const orgId = requireScope(req, 'webhooks:manage');
    const body = req.body as { url?: unknown; events?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('JSON 본문 {url, events} 가 필요합니다');
    if (Object.keys(body).some((k) => k !== 'url' && k !== 'events')) throw badRequest('알 수 없는 필드가 있습니다');
    const url = validateWebhookUrl(body.url, deps.config.NODE_ENV);
    const ev = body.events;
    if (!Array.isArray(ev) || !ev.length || ev.some((e) => !WEBHOOK_EVENT_TYPES.includes(e as WebhookEventType)) || new Set(ev).size !== ev.length) {
      throw badRequest(`events 는 ${WEBHOOK_EVENT_TYPES.join(', ')} 중 중복 없는 1개 이상입니다`);
    }
    const secret = generateWebhookSecret();
    const [w] = await db
      .insert(webhooks)
      .values({ webhookId: newId('wh'), orgId, url, secretEnc: encryptSecret(secret, deps.config.DATA_ENC_KEY), events: ev as string[], createdAt: now() })
      .returning();
    return reply.code(201).send({ ...toWebhook(w!), secret });
  });

  r.delete<{ Params: { webhookId: string } }>('/v1/webhooks/:webhookId', async (req, reply) => {
    const orgId = requireScope(req, 'webhooks:manage');
    const w = await own(orgId, req.params.webhookId);
    await db.update(webhooks).set({ deletedAt: now() }).where(eq(webhooks.webhookId, w.webhookId));
    return reply.code(204).send();
  });

  r.post<{ Params: { webhookId: string } }>('/v1/webhooks/:webhookId/test', async (req, reply) => {
    const orgId = requireScope(req, 'webhooks:manage');
    const w = await own(orgId, req.params.webhookId);
    const t = now().toISOString();
    const ev: WebhookEvent = {
      eventId: newId('evt'),
      type: 'device.state_changed',
      createdAt: t,
      replayed: false,
      gatewayId: 'gw_00000000-0000-0000-0000-000000000000',
      siteId: 'site_00000000000000000000000000',
      siteEpoch: 1,
      bootId: '00000000-0000-4000-8000-000000000000',
      seq: 0,
      data: {
        test: true,
        source: 'event',
        at: t,
        device: {
          deviceId: 'dev_00000000000000000000000000',
          gatewayId: 'gw_00000000-0000-0000-0000-000000000000',
          siteId: 'site_00000000000000000000000000',
          name: '시험 기기',
          room: null,
          deviceType: 'PLUG',
          online: true,
          data: { switch: true },
          lastUpdated: t,
          vendor: null,
          model: null,
        },
      },
    };
    await deps.outbox.enqueueTo(w.webhookId, ev);
    return reply.code(202).send({ eventId: ev.eventId });
  });
}
