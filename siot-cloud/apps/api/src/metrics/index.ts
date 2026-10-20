// 소유: Step 1 실행자. GET /metrics (Fly [metrics]).
import type { FastifyInstance } from 'fastify';

export const METRIC_NAMES = [
  'siot_control_latency_seconds',
  'siot_webhook_latency_seconds',
  'siot_gateways_online',
  'siot_relay_reconnects_total',
  'siot_relay_heartbeat_timeouts_total',
] as const;

/** TODO(Step 1): prom-client 레지스트리와 위 지표, /metrics 라우트. */
export async function registerMetrics(_app: FastifyInstance, _deps: Record<string, never> = {}): Promise<void> {
  throw new Error('registerMetrics: not implemented (Step 1)');
}
