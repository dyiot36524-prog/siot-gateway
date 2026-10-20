// 소유: Step 1 실행자. GET /metrics (Fly [metrics]). 앱마다 별도 레지스트리(테스트에서 buildApp 을 여러 번 불러도 충돌 없음).
// relay 는 RelayDeps.metrics 로 relayReconnects/heartbeatTimeouts/gatewaysOnline/relayRequests 를 받아 직접 갱신한다.
import type { FastifyInstance } from 'fastify';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const METRIC_NAMES = [
  'siot_control_latency_seconds',
  'siot_webhook_latency_seconds',
  'siot_gateways_online',
  'siot_relay_reconnects_total',
  'siot_relay_heartbeat_timeouts_total',
] as const;

export interface Metrics {
  registry: Registry;
  /** 제어 API 수신 → 결과 결정 */
  controlLatency: Histogram<'status'>;
  /** outbox 적재 → 파트너 2xx */
  webhookLatency: Histogram;
  gatewaysOnline: Gauge;
  relayReconnects: Counter;
  heartbeatTimeouts: Counter;
  /** 릴레이 req 송신 수(C2: 조회 중 0 이어야 함) */
  relayRequests: Counter;
}

export function createMetrics(opts: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (opts.defaultMetrics !== false) collectDefaultMetrics({ register: registry });
  return {
    registry,
    controlLatency: new Histogram({
      name: 'siot_control_latency_seconds',
      help: '제어 API 수신부터 결과 결정까지(초)',
      labelNames: ['status'],
      buckets: [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5],
      registers: [registry],
    }),
    webhookLatency: new Histogram({
      name: 'siot_webhook_latency_seconds',
      help: '웹훅 이벤트 적재부터 수신자 2xx 까지(초)',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15, 60, 600, 3600],
      registers: [registry],
    }),
    gatewaysOnline: new Gauge({ name: 'siot_gateways_online', help: '온라인 게이트웨이 수', registers: [registry] }),
    relayReconnects: new Counter({ name: 'siot_relay_reconnects_total', help: '게이트웨이 재접속 수', registers: [registry] }),
    heartbeatTimeouts: new Counter({ name: 'siot_relay_heartbeat_timeouts_total', help: '25초 무응답 끊김 수', registers: [registry] }),
    relayRequests: new Counter({ name: 'siot_relay_requests_total', help: '릴레이 req 송신 수', registers: [registry] }),
  };
}

export async function registerMetrics(app: FastifyInstance, deps: { metrics: Metrics }): Promise<void> {
  app.get('/metrics', { logLevel: 'warn' }, async (_req, reply) => {
    reply.header('content-type', deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });
}
