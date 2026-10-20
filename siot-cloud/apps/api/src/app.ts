// 소유: Step 1 실행자. 다른 실행자는 자기 모듈의 register*(app, deps) 만 채우고 이 파일은 고치지 않는다.
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { registerHealthz } from './healthz.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';

export interface BuildAppOptions {
  config?: Config;
  db?: Db;
  /** /healthz DB ping. 없으면 항상 실패(503) */
  pingDb?: () => Promise<void>;
  logger?: FastifyServerOptions['logger'];
}

/** JSON 로그(requestId, gatewayId, siteId)와 비밀 마스킹 */
export const LOG_REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-siot-gateway-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.gatewayToken',
  '*.claimSecret',
  '*.secret',
];

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: opts.config?.LOG_LEVEL ?? 'info', redact: LOG_REDACT },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  registerHealthz(app, { pingDb: opts.pingDb ?? (async () => Promise.reject(new Error('no database configured'))) });

  // ---- 플러그인 등록 지점(순서 고정). 각 모듈 구현 후 여기서 연결한다 ----
  // 1. const cache = await createStateCache({ db })                       — src/cache   (Step 1)
  // 2. const bus = await registerRelay(app, { config, db, cache })        — src/relay   (Step 2)
  // 3. const { apiKeys, sessions } = await registerAuth(app, { config, db }) — src/auth (Step 1)
  // 4. await registerMetrics(app)                                         — src/metrics (Step 1)
  // 5. await registerWebhooks(app, { config, db })                        — src/webhooks(Step 1)
  // 6. await registerPublicApi(app, { db, cache, bus, apiKeys })          — src/public  (Step 1)
  // 7. await registerAppApi(app, { config, db, cache, bus, sessions })    — src/appapi  (Step 1, claim 은 Step 2)
  // 8. PWA 정적 파일(apps/web/dist) 서빙                                    — (Step 1/3a)

  return app;
}
