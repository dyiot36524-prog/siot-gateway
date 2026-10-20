// 소유: Step 2 백엔드 실행자. app.ts 는 registerRelay(app, deps) 만 호출한다.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {} from '@fastify/websocket';
import { createDbGatewayRepo } from './repo.js';
import { RelayServer, type RelaySocket } from './RelayServer.js';
import type { RelayDeps } from './deps.js';

export type { GatewayBus } from './GatewayBus.js';
export { GatewayOfflineError, GatewayTimeoutError } from './GatewayBus.js';
export type * from './deps.js';
export { RelayServer, CLOSE as RELAY_CLOSE_CODES, DEFAULT_TIMING as RELAY_DEFAULT_TIMING } from './RelayServer.js';

/** registerRelay 결과: GatewayBus + 수명·늦은 주입 */
export type RelayHandle = RelayServer;

/**
 * GET /gateway (WebSocket) 를 등록하고 GatewayBus 구현을 돌려준다(@fastify/websocket 은 app.ts 가 먼저 등록).
 * challenge/hello 검증(사전 등록 공개키만, 미등록 4403, 쿼리·틀린 토큰 4401), 연결 레지스트리, 하트비트 10s/25s,
 * 접속 순서(cfg 보낸 연결은 cfg_ack 전 snapshot·evt 보류, 최대 1,000건/10초), bind 유실 재발급(옛 해시 즉시 폐기 + 감사 로그),
 * snapshot·evt → cache, 누적 ack, offline 판정 → cache·outbox.
 */
export async function registerRelay(app: FastifyInstance, deps: RelayDeps): Promise<RelayHandle> {
  let repo = deps.repo;
  if (!repo) {
    if (!deps.db || !deps.config) throw new Error('registerRelay: db and config.DATA_ENC_KEY (or repo) required');
    repo = createDbGatewayRepo(deps.db, deps.config.DATA_ENC_KEY);
  }
  const relay = new RelayServer({
    repo,
    cache: deps.cache,
    outbox: deps.outbox,
    metrics: deps.metrics,
    alerts: deps.alerts,
    deployedAt: deps.deployedAt,
    timing: deps.timing,
    log: app.log.child({ module: 'relay' }),
  });

  app.get('/gateway', { websocket: true }, (socket: RelaySocket, req: FastifyRequest) => {
    const h = req.headers;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    const q = req.url.indexOf('?');
    const queryKeys = q < 0 ? [] : [...new URLSearchParams(req.url.slice(q + 1)).keys()];
    relay.accept(socket, {
      gatewayIdHeader: one(h['x-siot-gateway-id']),
      authorization: one(h.authorization),
      queryKeys,
      ip: req.ip,
    });
  });
  app.addHook('onClose', async () => relay.close());
  return relay;
}
