// 제어 확정(계획 Step 1-4, N1).
// - deadline = API 수신 시각 + 3,000ms.
// - 캐시 갱신 원천은 evt·snapshot 뿐. 로컬 res 본문(낙관적 device)은 보지 않고 상태 코드만 쓴다.
// - 대기자를 req 송신 **전**에 등록하고, 그 다음 캐시 값을 before 로 뜬다(송신 직전). 이미 목표값/ TOGGLE 기대값은 before 로만 계산.
// - 목표: ON=true, OFF=false, TOGGLE=!before.switch(before 를 모르면 첫 switch evt 를 확정으로 본다).
// 결과 매핑:
//   감지된 미연결 → offline(즉시) | res 200 + before 가 이미 목표 → confirmed(즉시)
//   res 200 + deadline 안 목표 evt → confirmed | res 200 + deadline 초과 → timeout
//   res 404 → not_found | res 400/502·기기 offline → failed + reason | res 없음 → timeout
// 응답은 항상 HTTP 200 {status, device, latencyMs, reason?}.
import type { ControlResult, ControlStatus, PublicDevice } from '@siot/protocol';
import { GatewayOfflineError, GatewayTimeoutError, type GatewayBus } from '../relay/GatewayBus.js';
import type { StateCache } from '../cache/StateCache.js';
import { TokenBucket } from '../auth/rateLimit.js';

export const CONTROL_DEADLINE_MS = 3000;
export const CONTROL_RATE_PER_DEVICE = 5;
export type ControlAction = 'ON' | 'OFF' | 'TOGGLE';
export const CONTROL_ACTIONS: readonly ControlAction[] = ['ON', 'OFF', 'TOGGLE'];

export interface ControlDeps {
  cache: Pick<StateCache, 'getDevice' | 'resolveDevice' | 'subscribe'>;
  bus: Pick<GatewayBus, 'request' | 'isOnline'>;
  deadlineMs?: number;
  /** 단조 시계(ms) */
  clock?: () => number;
  onResult?: (status: ControlStatus, latencyMs: number) => void;
  /** 기기당 제어 req/s(기본 5) */
  perDeviceRate?: number;
}

export class ControlCoordinator {
  private readonly deadlineMs: number;
  private readonly clock: () => number;
  private readonly perDevice: TokenBucket;

  constructor(private readonly deps: ControlDeps) {
    this.deadlineMs = deps.deadlineMs ?? CONTROL_DEADLINE_MS;
    this.clock = deps.clock ?? (() => performance.now());
    const rate = deps.perDeviceRate ?? CONTROL_RATE_PER_DEVICE;
    this.perDevice = new TokenBucket(rate, rate);
  }

  /** 기기당 제어 5 req/s. 초과면 Retry-After 초 */
  rateLimit(deviceId: string): number | null {
    const r = this.perDevice.take(deviceId);
    return r.ok ? null : r.retryAfterSec;
  }

  /** @param receivedAt API 수신 시각(clock 기준) */
  async control(deviceId: string, action: ControlAction, receivedAt = this.clock()): Promise<ControlResult> {
    const { cache, bus } = this.deps;
    const deadline = receivedAt + this.deadlineMs;
    const done = (status: ControlStatus, reason?: string): ControlResult => {
      const latencyMs = Math.max(0, Math.round(this.clock() - receivedAt));
      this.deps.onResult?.(status, latencyMs);
      const device = status === 'not_found' ? null : (cache.getDevice(deviceId) ?? null);
      return reason ? { status, device, latencyMs, reason } : { status, device, latencyMs };
    };

    const ref = cache.resolveDevice(deviceId);
    if (!ref || !cache.getDevice(deviceId)) return done('not_found');
    if (!bus.isOnline(ref.gatewayId)) return done('offline');

    // 1) 대기자 등록(req 송신 전)
    let target: boolean | undefined;
    let anySwitch = false;
    let matched = false;
    let wake: (() => void) | null = null;
    const unsubscribe = cache.subscribe((d: PublicDevice) => {
      if (d.deviceId !== deviceId || !d.online) return;
      const sw = d.data.switch;
      if (typeof sw !== 'boolean') return;
      if (anySwitch || sw === target) {
        matched = true;
        wake?.();
      }
    });

    try {
      // 2) before = 송신 직전 캐시 값
      const before = cache.getDevice(deviceId)!;
      const beforeSwitch = typeof before.data.switch === 'boolean' ? before.data.switch : undefined;
      if (!before.online) return done('failed', 'DEVICE_OFFLINE');
      let wire: ControlAction = action;
      if (action === 'ON') target = true;
      else if (action === 'OFF') target = false;
      else if (beforeSwitch === undefined) anySwitch = true;
      else {
        target = !beforeSwitch;
        wire = target ? 'ON' : 'OFF'; // before 에 결속된 기대값을 명시적으로 보낸다
      }
      const alreadyTarget = target !== undefined && beforeSwitch === target;

      const evtPromise = new Promise<'evt'>((resolve) => {
        wake = () => resolve('evt');
        if (matched) resolve('evt');
      });
      const remaining = () => Math.max(0, deadline - this.clock());
      let deadlineTimer: NodeJS.Timeout | undefined;
      const deadlinePromise = new Promise<'deadline'>((resolve) => {
        deadlineTimer = setTimeout(() => resolve('deadline'), remaining());
      });

      // 3) req 송신
      const reqPromise = bus
        .request(
          ref.gatewayId,
          {
            method: 'POST',
            path: `/siot-app/api/v1/devices/${encodeURIComponent(ref.localId)}/control`,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ action: wire }), 'utf8').toString('base64'),
            timeoutMs: Math.max(1, Math.floor(remaining())),
          },
          Math.max(1, Math.floor(remaining())),
        )
        .then(
          (res) => ({ kind: 'res' as const, status: res.status }),
          (err: unknown) => ({ kind: 'err' as const, err }),
        );

      try {
        const first = await Promise.race([evtPromise, reqPromise, deadlinePromise]);
        if (first === 'evt') return done('confirmed');
        if (first === 'deadline') return done('timeout', 'GATEWAY_TIMEOUT');
        if (first.kind === 'err') {
          if (matched) return done('confirmed');
          if (first.err instanceof GatewayOfflineError) return done('offline');
          if (first.err instanceof GatewayTimeoutError) return done('timeout', 'GATEWAY_TIMEOUT');
          return done('failed', 'RELAY_ERROR');
        }
        const status = first.status;
        if (status >= 200 && status < 300) {
          if (matched || alreadyTarget) return done('confirmed');
          const second = await Promise.race([evtPromise, deadlinePromise]);
          return second === 'evt' ? done('confirmed') : done('timeout', 'NO_STATE_EVENT');
        }
        if (matched) return done('confirmed');
        if (status === 404) return done('not_found');
        if (status === 400) return done('failed', 'LOCAL_BAD_REQUEST');
        if (status === 502) return done('failed', 'DEVICE_UNREACHABLE');
        if (status === 504) return done('timeout', 'GATEWAY_TIMEOUT');
        return done('failed', `LOCAL_HTTP_${status}`);
      } finally {
        clearTimeout(deadlineTimer);
      }
    } finally {
      unsubscribe();
    }
  }
}
