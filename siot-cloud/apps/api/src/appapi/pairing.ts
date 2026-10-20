// 페어링 큐(app-v1 /gateways/{id}/pairing): pairing_sessions 에 저장, GW 별 직렬·GW 간 병렬.
// 차례가 되면 GatewayBus.request 로 `POST /siot-app/api/v1/pairing {code}` 를 보내고, relay-v2 evt pairing 으로 상태를 갱신한다.
// 에이전트 메모리 세션은 재시작에 사라지므로(server.js:37) 5분 동안 진행이 없으면 PAIRING_TIMEOUT 으로 끝내고 다음으로 넘어간다.
import { and, asc, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { EvtPairingFrame } from '@siot/protocol';
import type { Db } from '../db/client.js';
import { pairingSessions } from '../db/schema.js';
import type { StateCache } from '../cache/StateCache.js';
import { GatewayOfflineError, type GatewayBus } from '../relay/GatewayBus.js';
import { decryptSecret, encryptSecret } from '../auth/secretBox.js';
import { newId } from '../ids.js';

export const PAIRING_LOCAL_PATH = '/siot-app/api/v1/pairing';
export const PAIRING_STALL_MS = 5 * 60_000;
const STAGES = new Set(['queued', 'thread_dataset', 'commissioning', 'interviewing', 'done', 'failed']);

type Row = typeof pairingSessions.$inferSelect;

export interface PairingSessionView {
  pairingSessionId: string;
  gatewayId: string;
  status: Row['status'];
  stage: string | null;
  errorCode: string | null;
  error: string | null;
  deviceIds: string[];
  queuePosition: number;
  createdAt: string;
  updatedAt: string;
}

export interface PairingQueueDeps {
  db: Db;
  bus: Pick<GatewayBus, 'request' | 'isOnline'>;
  cache: Pick<StateCache, 'subscribeEvents'>;
  encKey: string;
  log: Pick<FastifyBaseLogger, 'warn' | 'error'>;
  now?: () => Date;
  /** 로컬 409(다른 페어링 진행 중) 후 재시도 간격 */
  retryMs?: number;
  requestTimeoutMs?: number;
}

export class PairingQueue {
  private readonly now: () => Date;
  private readonly pumping = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly listeners = new Set<(siteId: string, s: PairingSessionView) => void>();
  private unsub: (() => void) | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly d: PairingQueueDeps) {
    this.now = d.now ?? (() => new Date());
  }

  start(sweepMs = 30_000): void {
    this.unsub = this.d.cache.subscribeEvents((ev) => {
      if (ev.type === 'pairing') void this.onPairingEvt(ev.gatewayId, ev.frame, ev.deviceIds).catch((err) => this.d.log.error({ err }, 'pairing evt failed'));
      else if (ev.type === 'gateway' && ev.gateway.online) void this.pump(ev.gateway.gatewayId);
    });
    if (sweepMs > 0) {
      this.sweeper = setInterval(() => void this.sweep().catch((err) => this.d.log.error({ err }, 'pairing sweep failed')), sweepMs);
      this.sweeper.unref();
    }
  }

  async stop(): Promise<void> {
    this.unsub?.();
    if (this.sweeper) clearInterval(this.sweeper);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await Promise.all(this.pumping.values());
  }

  onChange(l: (siteId: string, s: PairingSessionView) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async enqueue(o: { gatewayId: string; siteId: string; userId: string; code: string; name?: string | null }): Promise<{ pairingSessionId: string; queuePosition: number }> {
    const t = this.now();
    const pairingSessionId = newId('pair');
    await this.d.db.insert(pairingSessions).values({
      pairingSessionId,
      gatewayId: o.gatewayId,
      siteId: o.siteId,
      requestedByUserId: o.userId,
      codeEnc: encryptSecret(o.code, this.d.encKey),
      name: o.name ?? null,
      status: 'queued',
      stage: 'queued',
      createdAt: t,
      updatedAt: t,
    });
    const [row] = await this.d.db.select().from(pairingSessions).where(eq(pairingSessions.pairingSessionId, pairingSessionId));
    const queuePosition = await this.position(row!);
    void this.pump(o.gatewayId);
    return { pairingSessionId, queuePosition };
  }

  async get(pairingSessionId: string): Promise<(PairingSessionView & { siteId: string; requestedByUserId: string }) | null> {
    const [row] = await this.d.db.select().from(pairingSessions).where(eq(pairingSessions.pairingSessionId, pairingSessionId)).limit(1);
    if (!row) return null;
    return { ...(await this.view(row)), siteId: row.siteId, requestedByUserId: row.requestedByUserId };
  }

  /** 이 GW 의 다음 세션을 시작한다(진행 중이면 아무것도 안 함). 동시 호출은 한 번 더 돌린다 */
  pump(gatewayId: string): Promise<void> {
    const cur = this.pumping.get(gatewayId);
    if (cur) {
      this.again.add(gatewayId);
      return cur;
    }
    const p = (async () => {
      do {
        this.again.delete(gatewayId);
        try {
          await this.pumpOnce(gatewayId);
        } catch (err) {
          this.d.log.error({ err, gatewayId }, 'pairing pump failed');
        }
      } while (this.again.has(gatewayId));
    })().finally(() => this.pumping.delete(gatewayId));
    this.pumping.set(gatewayId, p);
    return p;
  }

  private async pumpOnce(gatewayId: string): Promise<void> {
    const { db } = this.d;
    for (;;) {
      const [running] = await db
        .select({ id: pairingSessions.pairingSessionId })
        .from(pairingSessions)
        .where(and(eq(pairingSessions.gatewayId, gatewayId), eq(pairingSessions.status, 'running')))
        .limit(1);
      if (running) return;
      const [next] = await db
        .select()
        .from(pairingSessions)
        .where(and(eq(pairingSessions.gatewayId, gatewayId), eq(pairingSessions.status, 'queued')))
        .orderBy(asc(pairingSessions.createdAt), asc(pairingSessions.pairingSessionId))
        .limit(1);
      if (!next) return;
      if (!this.d.bus.isOnline(gatewayId)) return; // 접속하면 gateway 이벤트로 다시 pump
      const t = this.now();
      const claimed = await db
        .update(pairingSessions)
        .set({ status: 'running', startedAt: t, updatedAt: t })
        .where(and(eq(pairingSessions.pairingSessionId, next.pairingSessionId), eq(pairingSessions.status, 'queued')))
        .returning();
      if (!claimed.length) continue;
      await this.notify(claimed[0]!);
      let code: string;
      try {
        code = decryptSecret(next.codeEnc ?? '', this.d.encKey);
      } catch {
        await this.finish(next.pairingSessionId, 'failed', { errorCode: 'CODE_UNAVAILABLE', error: '페어링 코드를 읽을 수 없습니다' });
        continue;
      }
      try {
        const res = await this.d.bus.request(
          gatewayId,
          {
            method: 'POST',
            path: PAIRING_LOCAL_PATH,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ code }), 'utf8').toString('base64'),
          },
          this.d.requestTimeoutMs ?? 15_000,
        );
        const body = parseBody(res.body);
        if (res.status === 200 || res.status === 202) {
          const s = (body?.session ?? {}) as { sessionId?: unknown; stage?: unknown };
          const [row] = await db
            .update(pairingSessions)
            .set({
              localSessionId: typeof s.sessionId === 'string' ? s.sessionId : null,
              stage: typeof s.stage === 'string' && STAGES.has(s.stage) ? s.stage : 'queued',
              updatedAt: this.now(),
            })
            .where(and(eq(pairingSessions.pairingSessionId, next.pairingSessionId), eq(pairingSessions.status, 'running')))
            .returning();
          if (row) await this.notify(row);
          return; // 진행은 evt pairing 으로
        }
        if (res.status === 409) {
          // 로컬에서 다른 페어링이 진행 중 → 대기열로 돌려놓고 나중에 다시
          await this.requeue(next.pairingSessionId);
          this.later(gatewayId);
          return;
        }
        await this.finish(next.pairingSessionId, 'failed', {
          errorCode: `LOCAL_HTTP_${res.status}`,
          error: typeof body?.error === 'string' ? body.error : null,
        });
      } catch (err) {
        if (err instanceof GatewayOfflineError) {
          await this.requeue(next.pairingSessionId);
          return;
        }
        await this.finish(next.pairingSessionId, 'failed', { errorCode: 'GATEWAY_TIMEOUT', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private later(gatewayId: string): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.pump(gatewayId);
    }, this.d.retryMs ?? 5000);
    t.unref();
    this.timers.add(t);
  }

  private async requeue(id: string): Promise<void> {
    const [row] = await this.d.db
      .update(pairingSessions)
      .set({ status: 'queued', startedAt: null, updatedAt: this.now() })
      .where(eq(pairingSessions.pairingSessionId, id))
      .returning();
    if (row) await this.notify(row);
  }

  private async finish(
    id: string,
    status: 'done' | 'failed',
    f: { errorCode?: string | null; error?: string | null; stage?: string; deviceIds?: string[] },
  ): Promise<void> {
    const t = this.now();
    const [row] = await this.d.db
      .update(pairingSessions)
      .set({
        status,
        stage: f.stage ?? status,
        errorCode: f.errorCode ?? null,
        error: f.error ?? null,
        ...(f.deviceIds ? { deviceIds: f.deviceIds } : {}),
        codeEnc: null,
        finishedAt: t,
        updatedAt: t,
      })
      .where(eq(pairingSessions.pairingSessionId, id))
      .returning();
    if (row) await this.notify(row);
  }

  async onPairingEvt(gatewayId: string, frame: EvtPairingFrame, deviceIds: string[]): Promise<void> {
    const { db } = this.d;
    const local = frame.data.sessionId;
    let [row] = await db
      .select()
      .from(pairingSessions)
      .where(and(eq(pairingSessions.gatewayId, gatewayId), eq(pairingSessions.localSessionId, local)))
      .limit(1);
    if (!row) {
      // res(202) 보다 evt 가 먼저 온 경우: 이 GW 의 진행 중 세션에 붙인다
      const [r] = await db
        .update(pairingSessions)
        .set({ localSessionId: local })
        .where(and(eq(pairingSessions.gatewayId, gatewayId), eq(pairingSessions.status, 'running'), isNull(pairingSessions.localSessionId)))
        .returning();
      row = r;
    }
    if (!row || row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') return;
    const stage = frame.data.stage;
    if (stage === 'done') {
      await this.finish(row.pairingSessionId, 'done', { deviceIds });
      void this.pump(gatewayId);
    } else if (stage === 'failed') {
      await this.finish(row.pairingSessionId, 'failed', { errorCode: frame.data.errorCode ?? 'UNKNOWN', error: frame.data.error ?? null });
      void this.pump(gatewayId);
    } else {
      const [r] = await db
        .update(pairingSessions)
        .set({ stage: STAGES.has(stage) ? stage : row.stage, updatedAt: this.now() })
        .where(eq(pairingSessions.pairingSessionId, row.pairingSessionId))
        .returning();
      if (r) await this.notify(r);
    }
  }

  /** 진행이 멈춘 세션 정리 + 대기열이 있는 GW 다시 pump */
  async sweep(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - PAIRING_STALL_MS);
    const stalled = await this.d.db
      .select({ id: pairingSessions.pairingSessionId, gatewayId: pairingSessions.gatewayId })
      .from(pairingSessions)
      .where(and(eq(pairingSessions.status, 'running'), lt(pairingSessions.updatedAt, cutoff)));
    for (const s of stalled) await this.finish(s.id, 'failed', { errorCode: 'PAIRING_TIMEOUT', error: '게이트웨이에서 진행 소식이 없습니다' });
    const gws = await this.d.db
      .selectDistinct({ gatewayId: pairingSessions.gatewayId })
      .from(pairingSessions)
      .where(or(eq(pairingSessions.status, 'queued')));
    await Promise.all(gws.map((g) => this.pump(g.gatewayId)));
  }

  private async position(row: Row): Promise<number> {
    if (row.status !== 'queued') return 0;
    const [r] = await this.d.db
      .select({ n: count() })
      .from(pairingSessions)
      .where(
        and(
          eq(pairingSessions.gatewayId, row.gatewayId),
          or(
            eq(pairingSessions.status, 'running'),
            and(eq(pairingSessions.status, 'queued'), sql`(${pairingSessions.createdAt}, ${pairingSessions.pairingSessionId}) < (${row.createdAt.toISOString()}::timestamptz, ${row.pairingSessionId})`),
          ),
        ),
      );
    return r?.n ?? 0;
  }

  private async view(row: Row): Promise<PairingSessionView> {
    return {
      pairingSessionId: row.pairingSessionId,
      gatewayId: row.gatewayId,
      status: row.status,
      stage: row.stage && STAGES.has(row.stage) ? row.stage : null,
      errorCode: row.errorCode,
      error: row.error,
      deviceIds: row.deviceIds,
      queuePosition: await this.position(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async notify(row: Row): Promise<void> {
    if (!this.listeners.size) return;
    const v = await this.view(row);
    for (const l of this.listeners) l(row.siteId, v);
  }
}

function parseBody(b64: string | undefined): Record<string, unknown> | null {
  if (!b64) return null;
  try {
    const v = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
