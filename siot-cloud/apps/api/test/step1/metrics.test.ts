// /metrics(N5) 와 JSON 로그 비밀 마스킹.
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp, LOG_REDACT } from '../../src/app.js';
import { METRIC_NAMES } from '../../src/metrics/index.js';

describe('metrics & logs', () => {
  it('GET /metrics 에 5개 지표가 노출된다', async () => {
    const app = await buildApp({ logger: false });
    const r = await app.inject({ url: '/metrics' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    for (const n of METRIC_NAMES) expect(r.body).toContain(n);
    await app.close();
  });

  it('JSON 로그에 requestId 가 붙고 Authorization·Cookie·비밀은 가려진다', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(c, _e, cb) {
        lines.push(String(c));
        cb();
      },
    });
    const app = await buildApp({ logger: { level: 'info', redact: LOG_REDACT, stream } });
    app.get('/echo', async (req) => {
      req.log.info({ secret: 'whsec_TOPSECRET', password: 'hunter22', gatewayToken: 'tok' }, 'echo');
      return { ok: true };
    });
    await app.inject({ url: '/echo', headers: { authorization: 'Bearer sk_live_TOPSECRET', cookie: 'siot_session=TOPSECRET', 'x-request-id': 'req-123' } });
    await app.close();
    const all = lines.join('');
    expect(all).not.toContain('TOPSECRET');
    expect(all).not.toContain('hunter22');
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.some((l) => l.reqId === 'req-123')).toBe(true);
  });
});
