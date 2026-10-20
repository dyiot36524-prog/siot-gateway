import type { FastifyInstance } from 'fastify';

export interface HealthDeps {
  /** DB 왕복 확인. 실패하면 throw */
  pingDb: () => Promise<void>;
  /** ping 타임아웃(ms) */
  timeoutMs?: number;
}

/** GET /healthz — Fly [checks] 대상. DB ping 실패·지연이면 503. */
export function registerHealthz(app: FastifyInstance, deps: HealthDeps): void {
  const timeoutMs = deps.timeoutMs ?? 2000;
  app.get('/healthz', async (_req, reply) => {
    const started = performance.now();
    try {
      await Promise.race([
        deps.pingDb(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('db ping timeout')), timeoutMs).unref()),
      ]);
      return reply.code(200).send({ ok: true, db: 'ok', latencyMs: Math.round(performance.now() - started) });
    } catch (err) {
      app.log.warn({ err }, 'healthz db ping failed');
      return reply.code(503).send({ ok: false, db: 'down', error: { code: 'DB_UNAVAILABLE', message: 'database ping failed' } });
    }
  });
}
