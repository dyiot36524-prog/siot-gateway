// app-v1 계약을 흉내 내는 메모리 백엔드. 테스트(msw/node)와 `--mode mock` 미리보기(msw/browser)가 함께 쓴다.
import type { Device, Gateway, Me, PairingSession, Site } from '../api/client';

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let counter = 0;
export function ulid(): string {
  let n = ++counter;
  let s = '';
  while (n > 0) {
    s = CROCK[n % 32] + s;
    n = Math.floor(n / 32);
  }
  return ('01JZ' + s.padStart(22, '0')).slice(0, 26);
}

export function gwUuid(short: string): string {
  // gw_<uuid>: shortId 는 uuid 앞 8 hex
  return `gw_${short}-0000-4000-8000-${short.padEnd(12, '0').slice(0, 12)}`;
}

export interface MockUser {
  email: string;
  password: string;
  me: Me;
}
export interface MockLabel {
  gatewayId: string;
  claimSecret: string;
  orgId: string;
  provisioned: boolean;
  claimWindowClosed?: boolean;
}
export interface MockPairing extends PairingSession {
  code: string;
}

type Sink = (chunk: string) => void;

export const ORG = 'org_01JZ0000000000000000000001';
export const OTHER_ORG = 'org_01JZ0000000000000000000002';

export class MockDb {
  users: MockUser[] = [];
  /** 쿠키 세션을 단순화: 로그인한 사용자 email, null 이면 401 */
  session: string | null = null;
  sites: Site[] = [];
  labels: MockLabel[] = [];
  gateways: Gateway[] = [];
  devices: Device[] = [];
  pairings: MockPairing[] = [];
  /** 요청 로그(테스트 단언용) */
  requests: Array<{ method: string; path: string; body?: unknown }> = [];
  /** SSE 접속을 네트워크 오류로 거절 */
  sseDown = false;
  /** true 면 페어링·GW 접속을 타이머로 진행(미리보기용) */
  auto = false;
  private streams = new Map<string, Set<Sink>>();
  private closers = new Map<string, Set<() => void>>();
  private failedOnce = new Set<string>();

  me(): MockUser | undefined {
    return this.users.find((u) => u.email === this.session);
  }

  addUser(email: string, password: string, role: Me['user']['role'] = 'installer', orgId: string | null = ORG): MockUser {
    const u: MockUser = { email, password, me: { user: { userId: `usr_${ulid()}`, email, name: email.split('@')[0]!, role, orgId } } };
    this.users.push(u);
    return u;
  }

  addSite(name: string, extra: Partial<Site> = {}): Site {
    const s: Site = {
      siteId: `site_${ulid()}`,
      name,
      address: null,
      orgId: ORG,
      ownerUserId: null,
      handedOver: false,
      epoch: 1,
      gatewayCount: 0,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    this.sites.push(s);
    return s;
  }

  addLabel(short: string, secret: string, extra: Partial<MockLabel> = {}): MockLabel {
    const l: MockLabel = { gatewayId: gwUuid(short), claimSecret: secret.toLowerCase(), orgId: ORG, provisioned: true, ...extra };
    this.labels.push(l);
    return l;
  }

  /** 이미 바인딩된 GW 를 세대에 바로 붙인다(테스트 준비용) */
  addGateway(siteId: string | null, short: string, extra: Partial<Gateway> = {}): Gateway {
    const g: Gateway = {
      gatewayId: gwUuid(short),
      shortId: short,
      siteId,
      status: siteId ? 'bound' : 'unbound',
      online: true,
      lastSeen: new Date().toISOString(),
      agentVersion: '0.4.0',
      matterServerVersion: '0.2.3',
      deviceCount: 0,
      lastErrorCode: null,
      claimWindowUntil: null,
      ...extra,
    };
    this.gateways.push(g);
    const site = this.sites.find((s) => s.siteId === siteId);
    if (site) site.gatewayCount++;
    return g;
  }

  addDevice(gatewayId: string, name: string, extra: Partial<Device> = {}): Device {
    const g = this.gateways.find((x) => x.gatewayId === gatewayId)!;
    const d: Device = {
      deviceId: `dev_${ulid()}`,
      gatewayId,
      siteId: g.siteId!,
      name,
      room: null,
      deviceType: 'PLUG',
      online: true,
      data: { on: false },
      lastUpdated: new Date().toISOString(),
      vendor: 'IKEA of Sweden',
      model: 'TRETAKT',
      ...extra,
    };
    this.devices.push(d);
    g.deviceCount++;
    return d;
  }

  // --- SSE ---
  subscribe(siteId: string, sink: Sink, close: () => void): () => void {
    const set = this.streams.get(siteId) ?? new Set();
    set.add(sink);
    this.streams.set(siteId, set);
    const cs = this.closers.get(siteId) ?? new Set();
    cs.add(close);
    this.closers.set(siteId, cs);
    return () => {
      set.delete(sink);
      cs.delete(close);
    };
  }
  streamCount(siteId: string): number {
    return this.streams.get(siteId)?.size ?? 0;
  }
  push(siteId: string, event: string, data: unknown) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of this.streams.get(siteId) ?? []) s(chunk);
  }
  /** 서버 쪽에서 스트림을 끊는다(네트워크 끊김 흉내) */
  dropStreams(siteId: string) {
    for (const c of [...(this.closers.get(siteId) ?? [])]) c();
    this.streams.get(siteId)?.clear();
    this.closers.get(siteId)?.clear();
  }

  // --- 상태 변경 + 이벤트 ---
  setGatewayOnline(gatewayId: string, online: boolean) {
    const g = this.gateways.find((x) => x.gatewayId === gatewayId);
    if (!g) return;
    g.online = online;
    g.lastSeen = new Date().toISOString();
    for (const d of this.devices) if (d.gatewayId === gatewayId) d.online = online;
    if (g.siteId) this.push(g.siteId, 'gateway', g);
  }

  updatePairing(id: string, patch: Partial<PairingSession>) {
    const p = this.pairings.find((x) => x.pairingSessionId === id);
    if (!p) return;
    Object.assign(p, patch, { updatedAt: new Date(Date.now() + this.pairings.length).toISOString() });
    if (p.status === 'done' && patch.status === 'done' && p.deviceIds.length === 0) {
      const d = this.addDevice(p.gatewayId, `Matter 기기 ${this.devices.length + 1}`, {
        deviceType: p.code.endsWith('1') ? 'BINARY_SENSOR' : 'PLUG',
      });
      p.deviceIds = [d.deviceId];
      this.push(d.siteId, 'device', d);
    }
    this.requeue(p.gatewayId);
    const site = this.gateways.find((g) => g.gatewayId === p.gatewayId)?.siteId;
    if (site) this.push(site, 'pairing', strip(p));
  }

  private requeue(gatewayId: string) {
    const active = this.pairings.filter((x) => x.gatewayId === gatewayId && (x.status === 'queued' || x.status === 'running'));
    active.forEach((x, i) => (x.queuePosition = x.status === 'running' ? 0 : i));
  }

  enqueue(gatewayId: string, code: string): MockPairing {
    const now = new Date().toISOString();
    const active = this.pairings.filter((x) => x.gatewayId === gatewayId && (x.status === 'queued' || x.status === 'running')).length;
    const p: MockPairing = {
      pairingSessionId: `pair_${ulid()}`,
      gatewayId,
      status: 'queued',
      stage: 'queued',
      errorCode: null,
      error: null,
      deviceIds: [],
      queuePosition: active,
      createdAt: now,
      updatedAt: now,
      code,
    };
    this.pairings.push(p);
    if (this.auto) this.drive(gatewayId);
    return p;
  }

  // --- 미리보기용 자동 진행: GW 마다 직렬, GW 끼리 병렬 ---
  private driving = new Set<string>();
  private drive(gatewayId: string) {
    if (this.driving.has(gatewayId)) return;
    const next = this.pairings.find((x) => x.gatewayId === gatewayId && x.status === 'queued');
    if (!next) return;
    this.driving.add(gatewayId);
    const id = next.pairingSessionId;
    const step = (ms: number, patch: Partial<PairingSession>, then?: () => void) =>
      setTimeout(() => {
        this.updatePairing(id, patch);
        then?.();
      }, ms);
    // 끝자리 9 코드는 첫 시도에 "기기 안 잡힘"으로 실패(재시도 흐름 확인용)
    const fail = next.code.endsWith('9') && !this.failedOnce.has(next.code);
    if (fail) this.failedOnce.add(next.code);
    step(600, { status: 'running', stage: 'commissioning' }, () =>
      fail
        ? step(2500, { status: 'failed', stage: 'failed', errorCode: 'DEVICE_NOT_FOUND', error: 'BLE scan timeout' }, () => this.finish(gatewayId))
        : step(2600, { stage: 'interviewing' }, () => step(1400, { status: 'done', stage: 'done' }, () => this.finish(gatewayId))),
    );
  }
  private finish(gatewayId: string) {
    this.driving.delete(gatewayId);
    this.drive(gatewayId);
  }
}

export function strip(p: MockPairing): PairingSession {
  const { code: _code, ...rest } = p;
  return rest;
}

export let db = new MockDb();
export function resetDb(): MockDb {
  db = new MockDb();
  return db;
}
