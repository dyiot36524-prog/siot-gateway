// app-v1 클라이언트(계약: apps/api/openapi/app-v1.yaml). 소유: Step 3a 실행자.
// 같은 origin, 쿠키 세션(credentials: 'same-origin'). 오류는 ApiError({status, code, message}), 네트워크 실패는 NetworkError.
import type { ControlResult, PublicDevice } from '@siot/protocol';

export type Role = 'installer' | 'resident' | 'operator';
export type DeviceAction = 'ON' | 'OFF' | 'TOGGLE';

export interface Me {
  user: { userId: string; email: string; name: string; role: Role; orgId: string | null };
}
export interface Site {
  siteId: string;
  name: string;
  address: string | null;
  orgId: string;
  ownerUserId: string | null;
  handedOver: boolean;
  epoch: number;
  gatewayCount: number;
  createdAt: string;
}
export interface GatewayDiagnostics {
  online: boolean;
  lastSeen: string | null;
  agentVersion: string | null;
  matterServerVersion: string | null;
  deviceCount: number;
  lastErrorCode: string | null;
}
export interface Gateway extends GatewayDiagnostics {
  gatewayId: string;
  shortId: string;
  siteId: string | null;
  status: 'unbound' | 'bound' | 'site_reset_pending' | 'factory_reset_pending';
  claimWindowUntil?: string | null;
}
export type ClaimRequest = ({ gatewayId: string; shortId?: never } | { shortId: string; gatewayId?: never }) & {
  claimSecret: string;
  siteId: string;
};
export type ClaimErrorCode =
  | 'INVALID_CLAIM_SECRET'
  | 'GATEWAY_ALREADY_BOUND'
  | 'GATEWAY_NOT_PROVISIONED'
  | 'GATEWAY_ORG_MISMATCH'
  | 'CLAIM_WINDOW_CLOSED';
export interface PairingSession {
  pairingSessionId: string;
  gatewayId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: 'queued' | 'thread_dataset' | 'commissioning' | 'interviewing' | 'done' | 'failed' | null;
  errorCode: string | null;
  error: string | null;
  deviceIds: string[];
  queuePosition: number;
  createdAt: string;
  updatedAt: string;
}
export type Device = PublicDevice;
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
export type SiteEvent =
  | { event: 'device'; data: Device }
  | { event: 'device_removed'; data: { deviceId: string } }
  | { event: 'gateway'; data: Gateway | GatewayDiagnostics }
  | { event: 'pairing'; data: PairingSession };

/** SSE 연결 상태. reconnecting 은 끊겨서 다시 붙는 중, denied 는 401/403/404 로 멈춤 */
export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'denied';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 서버에 닿지 못함(오프라인·DNS·타임아웃). 로그아웃 사유가 아니다 */
export class NetworkError extends Error {}

export function isGateway(g: Gateway | GatewayDiagnostics): g is Gateway {
  return typeof (g as Gateway).gatewayId === 'string';
}

export interface AppApiClient {
  login(email: string, password: string): Promise<Me>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  listSites(opts?: { cursor?: string; limit?: number }): Promise<Page<Site>>;
  createSite(input: { name: string; address?: string | null }): Promise<Site>;
  getSite(siteId: string): Promise<Site>;
  claimGateway(input: ClaimRequest): Promise<Gateway>;
  listSiteGateways(siteId: string): Promise<{ data: Array<Gateway | GatewayDiagnostics> }>;
  getGateway(gatewayId: string): Promise<Gateway | GatewayDiagnostics>;
  enqueuePairing(gatewayId: string, input: { code: string; name?: string }): Promise<{ pairingSessionId: string; queuePosition: number }>;
  getPairing(pairingSessionId: string): Promise<PairingSession>;
  listSiteDevices(siteId: string): Promise<{ data: Device[] }>;
  updateDevice(deviceId: string, patch: { name?: string; room?: string | null }): Promise<Device>;
  controlDevice(deviceId: string, action: DeviceAction): Promise<ControlResult>;
  /** SSE 구독. 반환값을 호출하면 닫힌다. 끊기면 지수 백오프로 다시 붙고 onStatus 로 알린다 */
  streamSiteEvents(siteId: string, onEvent: (e: SiteEvent) => void, onStatus?: (s: StreamStatus) => void): () => void;
}

export interface ClientOptions {
  /** 세션 없음·만료(401). 로그인 실패 401 은 제외 */
  onUnauthorized?: () => void;
  /** SSE 무응답 감시(ms). 서버 keepalive 가 15초라 기본 40초 */
  streamIdleMs?: number;
  /** 재접속 백오프(ms) */
  backoffMs?: readonly number[];
}

const SSE_EVENTS = new Set(['device', 'device_removed', 'gateway', 'pairing']);

export function createAppApiClient(baseUrl = '', opts: ClientOptions = {}): AppApiClient {
  const origin = baseUrl || (typeof location !== 'undefined' ? location.origin : '');
  const idleMs = opts.streamIdleMs ?? 40_000;
  const backoff = opts.backoffMs ?? [1000, 2000, 4000, 8000, 15000];

  async function toApiError(res: Response): Promise<ApiError> {
    let code = 'HTTP_' + res.status;
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* 본문 없음 */
    }
    return new ApiError(res.status, code, message);
  }

  async function call<T>(method: string, path: string, body?: unknown, { authFlow = false } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(origin + path, {
        method,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new NetworkError(e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) {
      const err = await toApiError(res);
      if (res.status === 401 && !authFlow) opts.onUnauthorized?.();
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const enc = encodeURIComponent;

  return {
    login: (email, password) => call<Me>('POST', '/app/v1/auth/login', { email, password }, { authFlow: true }),
    logout: () => call<void>('POST', '/app/v1/auth/logout', undefined, { authFlow: true }),
    me: () => call<Me>('GET', '/app/v1/me'),
    listSites: (o = {}) => {
      const q = new URLSearchParams();
      if (o.cursor) q.set('cursor', o.cursor);
      if (o.limit) q.set('limit', String(o.limit));
      const qs = q.toString();
      return call<Page<Site>>('GET', '/app/v1/sites' + (qs ? '?' + qs : ''));
    },
    createSite: (input) => call<Site>('POST', '/app/v1/sites', input),
    getSite: (id) => call<Site>('GET', `/app/v1/sites/${enc(id)}`),
    claimGateway: (input) => call<Gateway>('POST', '/app/v1/gateways/claim', input),
    listSiteGateways: (id) => call('GET', `/app/v1/sites/${enc(id)}/gateways`),
    getGateway: (id) => call('GET', `/app/v1/gateways/${enc(id)}`),
    enqueuePairing: (gwId, input) => call('POST', `/app/v1/gateways/${enc(gwId)}/pairing`, input),
    getPairing: (id) => call('GET', `/app/v1/pairing/${enc(id)}`),
    listSiteDevices: (id) => call('GET', `/app/v1/sites/${enc(id)}/devices`),
    updateDevice: (id, patch) => call('PATCH', `/app/v1/devices/${enc(id)}`, patch),
    controlDevice: (id, action) => call('POST', `/app/v1/devices/${enc(id)}/control`, { action }),

    streamSiteEvents(siteId, onEvent, onStatus) {
      // AbortSignal 대신 연결 객체를 버리는 방식으로 끊는다(jsdom·구형 WebView 의 signal 비호환 회피)
      interface Conn {
        dead: boolean;
        reader: ReadableStreamDefaultReader<string> | null;
      }
      let stopped = false;
      let attempt = 0;
      let conn: Conn | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const setStatus = (s: StreamStatus) => onStatus?.(s);
      const kill = (c: Conn | null) => {
        if (!c || c.dead) return;
        c.dead = true;
        c.reader?.cancel().catch(() => undefined);
      };
      const scheduleRetry = () => {
        if (stopped) return;
        setStatus('reconnecting');
        const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 15000;
        attempt++;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void connect(), wait);
      };
      const armIdle = (c: Conn) => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (conn !== c) return;
          kill(c);
          scheduleRetry();
        }, idleMs);
      };
      const onOnline = () => {
        if (stopped) return;
        attempt = 0;
        clearTimeout(retryTimer);
        kill(conn);
        void connect();
      };

      const dispatch = (event: string, data: string) => {
        if (!SSE_EVENTS.has(event)) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // 깨진 프레임 무시
        }
        onEvent({ event, data: parsed } as SiteEvent);
      };

      async function connect() {
        if (stopped) return;
        const c: Conn = { dead: false, reader: null };
        conn = c;
        setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
        armIdle(c);
        let res: Response;
        try {
          res = await fetch(`${origin}/app/v1/sites/${enc(siteId)}/events`, {
            credentials: 'same-origin',
            headers: { accept: 'text/event-stream' },
          });
        } catch {
          if (conn === c && !c.dead) {
            c.dead = true;
            scheduleRetry();
          }
          return;
        }
        if (c.dead) {
          res.body?.cancel().catch(() => undefined);
          return;
        }
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          clearTimeout(idleTimer);
          stopped = true;
          c.dead = true;
          setStatus('denied');
          if (res.status === 401) opts.onUnauthorized?.();
          return;
        }
        if (!res.ok || !res.body) {
          c.dead = true;
          scheduleRetry();
          return;
        }
        attempt = 0;
        setStatus('open');
        armIdle(c);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        c.reader = reader;
        let buf = '';
        let event = 'message';
        let data: string[] = [];
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || c.dead) break;
            armIdle(c);
            buf += value;
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).replace(/\r$/, '');
              buf = buf.slice(nl + 1);
              if (line === '') {
                if (data.length) dispatch(event, data.join('\n'));
                event = 'message';
                data = [];
              } else if (!line.startsWith(':')) {
                // ':' 로 시작하면 keepalive 주석
                const i = line.indexOf(':');
                const field = i < 0 ? line : line.slice(0, i);
                const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
                if (field === 'event') event = val;
                else if (field === 'data') data.push(val);
              }
            }
          }
        } catch {
          /* 네트워크 끊김 */
        }
        if (conn === c && !c.dead) {
          c.dead = true;
          clearTimeout(idleTimer);
          scheduleRetry();
        }
      }

      if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
      void connect();
      return () => {
        stopped = true;
        clearTimeout(retryTimer);
        clearTimeout(idleTimer);
        if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
        kill(conn);
        conn = null;
      };
    },
  };
}
