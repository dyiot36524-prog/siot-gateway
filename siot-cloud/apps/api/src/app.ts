// 소유: Step 1 실행자. 다른 실행자는 자기 모듈의 register*(app, deps) 만 채우고 이 파일은 고치지 않는다.
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { registerHealthz } from './healthz.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { HttpError, errorBody, sendError } from './http.js';
import { createMetrics, registerMetrics, type Metrics } from './metrics/index.js';
import { registerWebhooks, type WebhookModule } from './webhooks/index.js';
import { createStateCache } from './cache/index.js';
import type { StateCache } from './cache/StateCache.js';
import { registerRelay } from './relay/index.js';
import type { GatewayBus } from './relay/GatewayBus.js';
import { registerAuth } from './auth/index.js';
import type { ApiKeyService } from './auth/apiKey.js';
import type { SessionService } from './auth/session.js';
import { registerPublicApi } from './public/index.js';
import { ControlCoordinator } from './public/ControlCoordinator.js';
import { toPublicGateway } from './public/views.js';
import { registerAppApi } from './appapi/index.js';
import type { PairingQueue } from './appapi/pairing.js';
import { createStaticHandler, type StaticHandler } from './appapi/static.js';

export interface BuildAppOptions {
  config?: Config;
  db?: Db;
  /** /healthz DB ping. 없으면 항상 실패(503) */
  pingDb?: () => Promise<void>;
  logger?: FastifyServerOptions['logger'];
  /** 테스트: 릴레이 대신 쓸 GatewayBus(fake). 없으면 registerRelay */
  bus?: GatewayBus;
  now?: () => Date;
  /** 웹훅 HTTP 클라이언트(테스트) */
  fetchImpl?: typeof fetch;
  /** false 면 웹훅 워커·페어링 sweep 을 자동 시작하지 않는다(테스트에서 runOnce 직접) */
  startWorkers?: boolean;
  /** 배포(프로세스 시작) 시각. 이후 90초 gateway.offline 유예 */
  deployedAt?: Date;
  /** 속도 제한 덮어쓰기(측정용 테스트). 기본은 계획 §2 값 */
  rateLimits?: { keyPerSec?: number; keyBurst?: number; devicePerSec?: number };
  /** PWA dist 경로(기본 apps/web/dist) */
  webDist?: string | false;
}

/** 테스트·운영 도구가 들여다보는 조립 결과 */
export interface AppContext {
  metrics: Metrics;
  webhooks: WebhookModule;
  cache: StateCache;
  bus: GatewayBus;
  apiKeys: ApiKeyService;
  sessions: SessionService;
  control: ControlCoordinator;
  pairing: PairingQueue;
}

declare module 'fastify' {
  interface FastifyInstance {
    siot: AppContext | null;
  }
}

/** JSON 로그(requestId, gatewayId, siteId)와 비밀 마스킹 */
const SECRET_KEYS = ['password', 'passwordHash', 'gatewayToken', 'claimSecret', 'secret', 'secretEnc', 'codeEnc', 'keyEnc', 'key', 'token', 'apiKey'];
export const LOG_REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-siot-gateway-token"]',
  'req.headers["siot-signature"]',
  'res.headers["set-cookie"]',
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
];

const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: opts.config?.LOG_LEVEL ?? 'info', redact: LOG_REDACT },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });
  app.decorate('siot', null);
  app.decorateRequest('t0', 0);
  app.decorateRequest('principal', null);
  app.decorateRequest('sessionUser', null);

  app.addHook('onRequest', async (req) => {
    req.t0 = performance.now();
  });
  // 로그에 gatewayId·siteId 를 붙인다(경로 파라미터 기준)
  app.addHook('preHandler', async (req) => {
    const p = req.params as Record<string, string> | undefined;
    if (p && (p.gatewayId || p.siteId)) req.log = req.log.child({ ...(p.gatewayId ? { gatewayId: p.gatewayId } : {}), ...(p.siteId ? { siteId: p.siteId } : {}) });
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err);
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const code = err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'VALIDATION_FAILED';
      return reply.code(status).send(errorBody(code, err.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL', '서버 오류'));
  });
  let serveStatic: StaticHandler | null = null;
  app.setNotFoundHandler((req, reply) => (serveStatic ? serveStatic(req, reply) : reply.code(404).send(errorBody('NOT_FOUND', '경로를 찾을 수 없습니다'))));

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  registerHealthz(app, { pingDb: opts.pingDb ?? (async () => Promise.reject(new Error('no database configured'))) });

  // ---- 플러그인 등록 지점(순서 고정) ----
  // 1. metrics → 2. webhooks(outbox·worker·alerts) → 3. cache → 4. relay(cache·outbox·metrics·alerts)
  // 5. auth → 6. public → 7. appapi(claim 은 Step 2) → 8. PWA 정적 파일
  const metrics = createMetrics();
  await registerMetrics(app, { metrics });

  const { config, db } = opts;
  if (!config || !db) return app; // DB 없는 구성(계약 테스트의 healthz)

  const startWorkers = opts.startWorkers !== false;
  const webhooks = await registerWebhooks(app, { config, db, metrics, now: opts.now, fetchImpl: opts.fetchImpl, autoStart: startWorkers });
  const cache = await createStateCache({
    db,
    outbox: webhooks.outbox,
    log: app.log,
    now: opts.now,
    onOnlineCount: (n) => metrics.gatewaysOnline.set(n),
  });
  webhooks.outbox.describeGateway = (id) => {
    const g = cache.getGateway(id);
    return g?.siteId ? toPublicGateway(g) : null;
  };

  let bus = opts.bus;
  if (!bus) {
    const relayDeps = { db, config, cache, outbox: webhooks.outbox, metrics, alerts: webhooks.alerts, deployedAt: opts.deployedAt ?? new Date() };
    bus = await registerRelay(app, relayDeps);
  }

  const { apiKeys, sessions } = await registerAuth(app, { config, db, now: opts.now });
  const control = new ControlCoordinator({
    cache,
    bus,
    onResult: (status, ms) => metrics.controlLatency.observe({ status }, ms / 1000),
    perDeviceRate: opts.rateLimits?.devicePerSec,
  });
  const rl = opts.rateLimits;
  const keyRate = rl?.keyPerSec || rl?.keyBurst ? { perSec: rl.keyPerSec ?? 20, burst: rl.keyBurst ?? 40 } : undefined;
  await registerPublicApi(app, { db, cache, bus, apiKeys, control, outbox: webhooks.outbox, config, now: opts.now, keyRate });
  const { pairing } = await registerAppApi(app, { config, db, cache, bus, sessions, outbox: webhooks.outbox, metrics, control, pairingSweepMs: startWorkers ? undefined : 0 });

  if (opts.webDist !== false) {
    serveStatic = await createStaticHandler(opts.webDist ?? DEFAULT_WEB_DIST);
    if (!serveStatic) app.log.info('apps/web/dist 가 없어 PWA 정적 서빙을 건너뜁니다');
  }

  app.siot = { metrics, webhooks, cache, bus, apiKeys, sessions, control, pairing };
  return app;
}
