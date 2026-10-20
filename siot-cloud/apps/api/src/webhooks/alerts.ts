// 운영 경보(계획 §2 알림 채널): Slack 호환 incoming webhook(ALERT_WEBHOOK_URL). 같은 키는 30분 중복 억제.
import type { FastifyBaseLogger } from 'fastify';

export const ALERT_DEDUPE_MS = 30 * 60_000;

export interface Alerts {
  notify(key: string, message: string, data?: Record<string, unknown>): Promise<void>;
}

export function createAlerts(opts: { url?: string; log: Pick<FastifyBaseLogger, 'warn' | 'error'>; now?: () => number; fetchImpl?: typeof fetch }): Alerts {
  const last = new Map<string, number>();
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async notify(key, message, data) {
      const t = now();
      const prev = last.get(key);
      if (prev !== undefined && t - prev < ALERT_DEDUPE_MS) return;
      last.set(key, t);
      opts.log.warn({ alert: key, ...data }, message);
      if (!opts.url) return;
      try {
        const text = data ? `${message}\n\`\`\`${JSON.stringify(data)}\`\`\`` : message;
        await doFetch(opts.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) });
      } catch (err) {
        opts.log.error({ err, alert: key }, 'alert delivery failed');
      }
    },
  };
}
