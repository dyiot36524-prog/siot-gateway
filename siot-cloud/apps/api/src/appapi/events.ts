// GET /app/v1/sites/{siteId}/events — SSE. 이벤트 이름: device | device_removed | gateway | pairing, 15초 keepalive 주석.
// 기기 data 를 보므로 'full' 접근(인계 전 installer, 소유 resident)만. operator·인계 후 installer 는 403.
import type { FastifyInstance } from 'fastify';
import type { StateCache } from '../cache/StateCache.js';
import { requireFull, type SiteLike } from '../auth/roles.js';
import { unauthorized } from '../http.js';
import { toAppGateway } from '../public/views.js';
import type { PairingQueue } from './pairing.js';

export const SSE_KEEPALIVE_MS = 15_000;

export interface SiteEventsDeps {
  cache: StateCache;
  pairing: PairingQueue;
  loadSite: (siteId: string) => Promise<SiteLike & { siteId: string }>;
}

export function registerSiteEvents(r: FastifyInstance, deps: SiteEventsDeps): void {
  r.get<{ Params: { siteId: string } }>('/app/v1/sites/:siteId/events', async (req, reply) => {
    const site = await deps.loadSite(req.params.siteId);
    if (!req.sessionUser) throw unauthorized();
    requireFull(req.sessionUser, site);
    const siteId = site.siteId;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.write(': connected\n\n');
    const offCache = deps.cache.subscribeEvents((ev) => {
      if (ev.siteId !== siteId) return;
      if (ev.type === 'device') send('device', ev.device);
      else if (ev.type === 'device_removed') send('device_removed', { deviceId: ev.deviceId });
      else if (ev.type === 'gateway') send('gateway', toAppGateway(ev.gateway));
    });
    const offPairing = deps.pairing.onChange((sid, s) => {
      if (sid === siteId) send('pairing', s);
    });
    const ka = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, SSE_KEEPALIVE_MS);
    const close = () => {
      clearInterval(ka);
      offCache();
      offPairing();
    };
    req.raw.on('close', close);
    res.on('close', close);
  });
}
