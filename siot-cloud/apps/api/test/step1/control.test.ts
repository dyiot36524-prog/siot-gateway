// N1 제어 확정 단위 테스트(계획 519-524행 5건 + 결과 매핑). DB 없음: 인메모리 fake 캐시·버스.
import { describe, expect, it } from 'vitest';
import type { PublicDevice } from '@siot/protocol';
import { ControlCoordinator } from '../../src/public/ControlCoordinator.js';
import { GatewayTimeoutError, type GatewayRequest, type GatewayResponse } from '../../src/relay/GatewayBus.js';
import type { DeviceListener, DeviceRef } from '../../src/cache/StateCache.js';
import { decodeBody, jsonBody } from './helpers.js';

const GW = 'gw_00000001-0000-4000-8000-000000000001';
const DEV = 'dev_01JZ8Q0V4Y4W6P1M2N3B5C7D9E';

class FakeCache {
  device: PublicDevice;
  listeners = new Set<DeviceListener>();
  constructor(on: boolean | undefined) {
    this.device = {
      deviceId: DEV,
      gatewayId: GW,
      siteId: 'site_01JZ8Q0V4Y4W6P1M2N3B5C7D9E',
      name: '플러그',
      room: null,
      deviceType: 'PLUG',
      online: true,
      data: on === undefined ? {} : { switch: on },
      lastUpdated: '2026-10-21T00:00:00.000Z',
    };
  }
  getDevice(id: string) {
    return id === DEV ? structuredClone(this.device) : undefined;
  }
  resolveDevice(id: string): DeviceRef | undefined {
    return id === DEV ? { deviceId: DEV, gatewayId: GW, localId: 'matter:5:1', siteId: this.device.siteId } : undefined;
  }
  subscribe(l: DeviceListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** evt 반영(캐시 갱신 원천) */
  evt(on: boolean) {
    this.device = { ...this.device, data: { ...this.device.data, switch: on } };
    for (const l of this.listeners) l(structuredClone(this.device), 'event');
  }
}

class FakeBus {
  online = true;
  reqs: GatewayRequest[] = [];
  handler: (req: GatewayRequest) => Promise<GatewayResponse> = async () => ({ id: '1', status: 200 });
  isOnline() {
    return this.online;
  }
  request(_g: string, req: GatewayRequest): Promise<GatewayResponse> {
    this.reqs.push(req);
    return this.handler(req);
  }
}

function setup(before: boolean | undefined, deadlineMs = 300) {
  const cache = new FakeCache(before);
  const bus = new FakeBus();
  const cc = new ControlCoordinator({ cache, bus, deadlineMs });
  return { cache, bus, cc };
}

describe('ControlCoordinator (N1)', () => {
  it('① 로컬 res 의 낙관적 device 본문은 캐시를 바꾸지 않는다', async () => {
    const { cache, bus, cc } = setup(false);
    bus.handler = async () => ({ id: '1', status: 200, body: jsonBody({ ok: true, device: { id: 'matter:5:1', data: { switch: true } } }) });
    const r = await cc.control(DEV, 'ON');
    expect(r.status).toBe('timeout');
    expect(r.reason).toBe('NO_STATE_EVENT');
    expect(cache.device.data.switch).toBe(false);
    expect(r.device?.data.switch).toBe(false);
  });

  it('② before=ON 에서 ON → res 200 즉시 confirmed', async () => {
    const { bus, cc } = setup(true, 3000);
    const r = await cc.control(DEV, 'ON');
    expect(r.status).toBe('confirmed');
    expect(r.latencyMs).toBeLessThan(200);
    expect(bus.reqs).toHaveLength(1); // req 는 보낸다
  });

  it('③ before=OFF 에서 ON, res 200 만 오고 evt 없음 → timeout', async () => {
    const { cc } = setup(false, 250);
    const t0 = performance.now();
    const r = await cc.control(DEV, 'ON');
    expect(r.status).toBe('timeout');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(240);
  });

  it('④ req 송신 후 res 전에 evt 도착 → confirmed (대기자는 송신 전 등록)', async () => {
    const { cache, bus, cc } = setup(false, 2000);
    let release!: () => void;
    bus.handler = (req) => {
      // GW 가 res 보다 evt 를 먼저 보낸 경우: request() 호출 안에서 곧바로 evt 반영
      expect(decodeBody(req.body)).toEqual({ action: 'ON' });
      cache.evt(true);
      return new Promise((resolve) => {
        release = () => resolve({ id: '1', status: 200 });
      });
    };
    const r = await cc.control(DEV, 'ON');
    expect(r.status).toBe('confirmed');
    expect(r.device?.data.switch).toBe(true);
    release();
  });

  it('⑤ TOGGLE 은 before 에 결속된다(송신 후 캐시가 바뀌어도 목표는 !before)', async () => {
    const { cache, bus, cc } = setup(true, 1000);
    bus.handler = async (req) => {
      expect(decodeBody(req.body)).toEqual({ action: 'OFF' }); // before=ON → 목표 OFF 를 명시적으로
      setTimeout(() => cache.evt(true), 20); // 목표가 아닌 값(재보고)은 확정이 아니다
      setTimeout(() => cache.evt(false), 80);
      return { id: '1', status: 200 };
    };
    const r = await cc.control(DEV, 'TOGGLE');
    expect(r.status).toBe('confirmed');
    expect(r.device?.data.switch).toBe(false);
    expect(r.latencyMs).toBeGreaterThanOrEqual(70);
  });

  it('TOGGLE: before 를 모르면 첫 switch evt 를 확정으로 본다', async () => {
    const { cache, bus, cc } = setup(undefined, 1000);
    bus.handler = async (req) => {
      expect(decodeBody(req.body)).toEqual({ action: 'TOGGLE' });
      setTimeout(() => cache.evt(true), 20);
      return { id: '1', status: 200 };
    };
    expect((await cc.control(DEV, 'TOGGLE')).status).toBe('confirmed');
  });

  it('res 200 후 deadline 안 목표 evt → confirmed', async () => {
    const { cache, bus, cc } = setup(false, 1000);
    bus.handler = async () => {
      setTimeout(() => cache.evt(true), 50);
      return { id: '1', status: 200 };
    };
    const r = await cc.control(DEV, 'ON');
    expect(r.status).toBe('confirmed');
  });

  it('결과 매핑: 감지된 미연결 offline(즉시), 404 not_found, 400/502 failed, 무응답 timeout', async () => {
    const a = setup(false);
    a.bus.online = false;
    const off = await a.cc.control(DEV, 'ON');
    expect(off.status).toBe('offline');
    expect(off.latencyMs).toBeLessThan(50);
    expect(a.bus.reqs).toHaveLength(0);

    const b = setup(false);
    b.bus.handler = async () => ({ id: '1', status: 404 });
    const nf = await b.cc.control(DEV, 'ON');
    expect(nf).toMatchObject({ status: 'not_found', device: null });

    const c = setup(false);
    c.bus.handler = async () => ({ id: '1', status: 502 });
    expect(await c.cc.control(DEV, 'ON')).toMatchObject({ status: 'failed', reason: 'DEVICE_UNREACHABLE' });
    c.bus.handler = async () => ({ id: '1', status: 400 });
    expect(await c.cc.control(DEV, 'OFF')).toMatchObject({ status: 'failed', reason: 'LOCAL_BAD_REQUEST' });

    const d = setup(false, 200);
    d.bus.handler = () => new Promise(() => {}); // res 가 오지 않음
    expect(await d.cc.control(DEV, 'ON')).toMatchObject({ status: 'timeout', reason: 'GATEWAY_TIMEOUT' });
    d.bus.handler = async () => Promise.reject(new GatewayTimeoutError(GW, 200));
    expect(await d.cc.control(DEV, 'ON')).toMatchObject({ status: 'timeout', reason: 'GATEWAY_TIMEOUT' });

    const e = setup(false);
    e.cache.device.online = false;
    expect(await e.cc.control(DEV, 'ON')).toMatchObject({ status: 'failed', reason: 'DEVICE_OFFLINE' });
    expect(await e.cc.control('dev_01JZ8Q0V4Y4W6P1M2N3B5C7D9F', 'ON')).toMatchObject({ status: 'not_found', device: null });
  });

  it('deadline 은 API 수신 시각 기준(receivedAt)', async () => {
    const { cc } = setup(false, 300);
    const receivedAt = performance.now() - 200;
    const t0 = performance.now();
    const r = await cc.control(DEV, 'ON', receivedAt);
    expect(r.status).toBe('timeout');
    expect(performance.now() - t0).toBeLessThan(200);
    expect(r.latencyMs).toBeGreaterThanOrEqual(290);
  });

  it('기기당 제어 5 req/s', () => {
    const { cc } = setup(false);
    const res = Array.from({ length: 6 }, () => cc.rateLimit(DEV));
    expect(res.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(res[5]).toBeGreaterThanOrEqual(1);
  });
});

