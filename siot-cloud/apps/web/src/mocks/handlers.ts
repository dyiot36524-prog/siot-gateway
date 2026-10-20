// msw 핸들러: app-v1.yaml 의 경로·상태 코드·오류 형식을 따른다.
import { http, HttpResponse, type HttpResponseResolver } from 'msw';
import { db, strip } from './db';

const err = (status: number, code: string, message = code) => HttpResponse.json({ error: { code, message } }, { status });

function authed<T extends HttpResponseResolver>(fn: T): HttpResponseResolver {
  return (info) => {
    if (!db.me()) return err(401, 'UNAUTHORIZED', '로그인이 필요합니다');
    return fn(info);
  };
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function log(request: Request, b?: unknown) {
  db.requests.push({ method: request.method, path: new URL(request.url).pathname, body: b });
}

export const handlers = [
  http.post('/app/v1/auth/login', async ({ request }) => {
    const b = await body<{ email?: string; password?: string }>(request);
    log(request, { email: b.email });
    const u = db.users.find((x) => x.email === b.email && x.password === b.password);
    if (!u) return err(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 맞지 않습니다');
    db.session = u.email;
    return HttpResponse.json(u.me);
  }),

  http.post('/app/v1/auth/logout', ({ request }) => {
    log(request);
    if (!db.me()) return err(401, 'UNAUTHORIZED');
    db.session = null;
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/app/v1/me', authed(() => HttpResponse.json(db.me()!.me))),

  http.get(
    '/app/v1/sites',
    authed(() => HttpResponse.json({ data: db.sites.filter((s) => s.orgId === db.me()!.me.user.orgId), nextCursor: null })),
  ),

  http.post(
    '/app/v1/sites',
    authed(async ({ request }) => {
      const b = await body<{ name?: string; address?: string | null }>(request);
      log(request, b);
      if (db.me()!.me.user.role !== 'installer') return err(403, 'FORBIDDEN');
      if (!b.name || b.name.length > 100) return err(400, 'VALIDATION_FAILED', 'name 필요');
      const s = db.addSite(b.name, { address: b.address ?? null, orgId: db.me()!.me.user.orgId! });
      return HttpResponse.json(s, { status: 201 });
    }),
  ),

  http.get(
    '/app/v1/sites/:siteId',
    authed(({ params }) => {
      const s = db.sites.find((x) => x.siteId === params.siteId);
      return s ? HttpResponse.json(s) : err(404, 'NOT_FOUND');
    }),
  ),

  http.get(
    '/app/v1/sites/:siteId/gateways',
    authed(({ params }) => {
      const s = db.sites.find((x) => x.siteId === params.siteId);
      if (!s) return err(404, 'NOT_FOUND');
      return HttpResponse.json({ data: db.gateways.filter((g) => g.siteId === s.siteId) });
    }),
  ),

  http.get(
    '/app/v1/sites/:siteId/devices',
    authed(({ params }) => {
      const s = db.sites.find((x) => x.siteId === params.siteId);
      if (!s) return err(404, 'NOT_FOUND');
      if (s.handedOver) return err(403, 'HANDED_OVER');
      return HttpResponse.json({ data: db.devices.filter((d) => d.siteId === s.siteId) });
    }),
  ),

  http.post(
    '/app/v1/gateways/claim',
    authed(async ({ request }) => {
      const b = await body<{ gatewayId?: string; shortId?: string; claimSecret?: string; siteId?: string }>(request);
      log(request, b);
      const me = db.me()!.me.user;
      if (!!b.gatewayId === !!b.shortId || !b.claimSecret || !b.siteId) return err(400, 'VALIDATION_FAILED');
      if (!/^[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}$/.test(b.claimSecret)) return err(400, 'VALIDATION_FAILED');
      const site = db.sites.find((s) => s.siteId === b.siteId);
      if (!site) return err(404, 'NOT_FOUND');
      if (me.role !== 'installer' || site.orgId !== me.orgId) return err(403, 'FORBIDDEN');
      const short = b.shortId?.replace(/^siot-/, '');
      const label = db.labels.find((l) => (b.gatewayId ? l.gatewayId === b.gatewayId : l.gatewayId.slice(3, 11) === short));
      if (!label) return err(404, 'NOT_FOUND', '게이트웨이를 찾을 수 없습니다');
      if (label.claimSecret !== b.claimSecret.replace(/-/g, '').toLowerCase()) return err(400, 'INVALID_CLAIM_SECRET', '라벨 코드가 맞지 않습니다');
      if (!label.provisioned) return err(409, 'GATEWAY_NOT_PROVISIONED', '출고 등록되지 않은 게이트웨이입니다');
      if (label.orgId !== me.orgId) return err(403, 'GATEWAY_ORG_MISMATCH', '다른 조직에 출고된 게이트웨이입니다');
      const existing = db.gateways.find((g) => g.gatewayId === label.gatewayId);
      if (existing?.siteId && existing.siteId !== site.siteId) return err(409, 'GATEWAY_ALREADY_BOUND', '이미 다른 세대에 연결된 게이트웨이입니다');
      if (label.claimWindowClosed) return err(423, 'CLAIM_WINDOW_CLOSED', 'claim 창이 닫혔습니다');
      if (existing?.siteId === site.siteId) return HttpResponse.json(existing);
      const g = db.addGateway(site.siteId, label.gatewayId.slice(3, 11), { online: false, lastSeen: null });
      db.push(site.siteId, 'gateway', g);
      if (db.auto) setTimeout(() => db.setGatewayOnline(g.gatewayId, true), 1500);
      return HttpResponse.json(g);
    }),
  ),

  http.get(
    '/app/v1/gateways/:gatewayId',
    authed(({ params }) => {
      const g = db.gateways.find((x) => x.gatewayId === params.gatewayId);
      return g ? HttpResponse.json(g) : err(404, 'NOT_FOUND');
    }),
  ),

  http.post(
    '/app/v1/gateways/:gatewayId/pairing',
    authed(async ({ request, params }) => {
      const b = await body<{ code?: string; name?: string }>(request);
      log(request, b);
      const g = db.gateways.find((x) => x.gatewayId === params.gatewayId);
      if (!g) return err(404, 'NOT_FOUND');
      if (!b.code || b.code.length < 8 || b.code.length > 64) return err(400, 'VALIDATION_FAILED');
      const p = db.enqueue(g.gatewayId, b.code);
      if (g.siteId) db.push(g.siteId, 'pairing', strip(p));
      return HttpResponse.json({ pairingSessionId: p.pairingSessionId, queuePosition: p.queuePosition }, { status: 202 });
    }),
  ),

  http.get(
    '/app/v1/pairing/:id',
    authed(({ params }) => {
      const p = db.pairings.find((x) => x.pairingSessionId === params.id);
      return p ? HttpResponse.json(strip(p)) : err(404, 'NOT_FOUND');
    }),
  ),

  http.patch(
    '/app/v1/devices/:deviceId',
    authed(async ({ request, params }) => {
      const b = await body<{ name?: string; room?: string | null }>(request);
      log(request, b);
      const d = db.devices.find((x) => x.deviceId === params.deviceId);
      if (!d) return err(404, 'NOT_FOUND');
      if (b.name !== undefined) d.name = b.name;
      if (b.room !== undefined) d.room = b.room;
      d.lastUpdated = new Date().toISOString();
      return HttpResponse.json(d);
    }),
  ),

  http.post(
    '/app/v1/devices/:deviceId/control',
    authed(({ params }) => {
      const d = db.devices.find((x) => x.deviceId === params.deviceId);
      if (!d) return err(404, 'NOT_FOUND');
      return HttpResponse.json({ status: 'confirmed', device: d, latencyMs: 420 });
    }),
  ),

  http.get('/app/v1/sites/:siteId/events', ({ params }) => {
    if (!db.me()) return err(401, 'UNAUTHORIZED');
    if (db.sseDown) return HttpResponse.error();
    const siteId = String(params.siteId);
    const site = db.sites.find((s) => s.siteId === siteId);
    if (!site) return err(404, 'NOT_FOUND');
    if (site.handedOver && db.me()!.me.user.role === 'installer') return err(403, 'HANDED_OVER');
    const enc = new TextEncoder();
    let off = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(': connected\n\n'));
        off = db.subscribe(
          siteId,
          (chunk) => {
            try {
              controller.enqueue(enc.encode(chunk));
            } catch {
              off();
            }
          },
          () => {
            clearInterval(keepalive);
            try {
              controller.error(new Error('dropped'));
            } catch {
              /* 이미 닫힘 */
            }
          },
        );
        if (db.auto) keepalive = setInterval(() => controller.enqueue(enc.encode(': keepalive\n\n')), 15000);
      },
      cancel() {
        clearInterval(keepalive);
        off();
      },
    });
    return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  }),
];
