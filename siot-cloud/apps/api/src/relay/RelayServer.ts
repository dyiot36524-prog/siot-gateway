// relay-v2 서버(계획 §2 b, Step 2 백엔드). GatewayBus 구현.
//  접속: X-Siot-Gateway-Id 필수(+ 바인딩 후 Authorization: Bearer). 쿼리 토큰 4401, 틀린 토큰 4401, 미등록 키·서명 실패 4403.
//  순서: challenge → hello(등록 공개키로 서명 검증) → welcome → [cfg → (snapshot·evt 보류, 1,000건/10초) → cfg_ack] → snapshot → evt
//  bind 유실 재발급: status bound 인데 토큰 없이 서명 hello → 새 토큰·옛 해시 즉시 폐기·감사 로그·bind 재전송, 24h 3회 초과 경보.
//  하트비트 10s/25s(monotonic), offline 판정 = WS 종료 또는 25초 무응답.
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger } from 'fastify';
import { RELAY_CLOSE, RELAY_TIMING } from '@siot/protocol';
import type { BindFrame, CfgAckFrame, EvtFrame, GatewayToServerFrame, HelloFrame, ReqFrame, ResFrame, ServerToGatewayFrame, SnapshotFrame } from '@siot/protocol';
import { newGatewayToken, tokenMatches, verifyHelloSig } from './crypto.js';
import type { CfgBody, GatewayRecord, GatewayRepo, RelayAlerts, RelayCache, RelayMetrics, RelayOutbox, RelayOutboxEvent, RelayTiming } from './deps.js';
import { assertServerFrame, parseGatewayFrame } from './frames.js';
import {
  GatewayOfflineError,
  GatewayTimeoutError,
  type GatewayBus,
  type GatewayRequest,
  type GatewayResponse,
  type OfflineInfo,
  type OnlineInfo,
  type Unsubscribe,
} from './GatewayBus.js';

/** close code (§2 b 의 4401/4403 + 서버 내부 사유) */
export const CLOSE = {
  badRequest: 4400,
  tokenRejected: RELAY_CLOSE.queryTokenRejected, // 4401
  unregisteredKey: RELAY_CLOSE.unregisteredKey, // 4403
  timeout: 4408,
  replaced: 4409,
  pendingOverflow: 4413,
  shutdown: 1001,
} as const;

export const DEFAULT_TIMING: RelayTiming = {
  heartbeatSec: RELAY_TIMING.heartbeatSec,
  deadSec: RELAY_TIMING.deadSec,
  helloTimeoutMs: 10_000,
  cfgAckTimeoutMs: RELAY_TIMING.cfgAckTimeoutSec * 1000,
  pendingMax: RELAY_TIMING.pendingBufferMax,
  ackEvery: 50,
  ackIntervalMs: 2000,
  tickMs: 1000,
  bindTimeoutMs: 10_000,
  offlineGraceMs: 90_000,
  reissueAlertThreshold: 3,
};

const GATEWAY_ID_RE = /^gw_[0-9a-f-]{36}$/;
const WS_OPEN = 1;
const now = () => performance.now();
/** welcome 은 정수 초(스키마 minimum 1). 내부 타이머는 설정값 그대로(테스트의 소수 초 포함) */
const wholeSec = (s: number) => Math.max(1, Math.round(s));

/** ws.WebSocket 중 쓰는 부분(@types/ws 없이) */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', fn: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: 'close', fn: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

export interface UpgradeInfo {
  gatewayIdHeader: string | undefined;
  authorization: string | undefined;
  /** 쿼리 문자열 키(토큰 거부용) */
  queryKeys: string[];
  ip?: string;
}

interface PendingReq {
  conn: Conn;
  resolve: (r: GatewayResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Conn {
  id: number;
  ws: RelaySocket;
  gatewayId: string;
  /** 유효 토큰을 제시했는가 */
  authed: boolean;
  state: 'opening' | 'challenge' | 'ready' | 'closed';
  nonce: string;
  gw: GatewayRecord | null;
  hello?: HelloFrame;
  connectedAt: Date;
  lastRx: number;
  lastTx: number;
  /** 프레임 직렬 처리 체인 */
  chain: Promise<void>;
  helloTimer?: NodeJS.Timeout;
  /** cfg 를 보낸 연결: cfg_ack 전 snapshot·evt 보류 */
  holding: boolean;
  held: Array<SnapshotFrame | EvtFrame>;
  cfgTimer?: NodeJS.Timeout;
  ackBoot?: string;
  processedUpTo: number;
  ackedUpTo: number;
  unacked: number;
  ackTimer?: NodeJS.Timeout;
  closeReason?: OfflineInfo['reason'];
  /** 같은 GW 의 살아 있는 연결을 대체했는가(online 웹훅 생략) */
  replacedLive: boolean;
  bindWaiters: Array<(ok: boolean) => void>;
}

export interface RelayServerOptions {
  repo: GatewayRepo;
  cache: RelayCache;
  outbox?: RelayOutbox;
  metrics?: RelayMetrics & { relayRequests?: { inc(n?: number): void } };
  alerts?: RelayAlerts;
  deployedAt?: Date;
  timing?: Partial<RelayTiming>;
  log?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
}

type Handler<A extends unknown[]> = (...a: A) => void | Promise<void>;

export class RelayServer implements GatewayBus {
  readonly timing: RelayTiming;
  private readonly repo: GatewayRepo;
  private readonly cache: RelayCache;
  private outbox?: RelayOutbox;
  private metrics?: RelayServerOptions['metrics'];
  private readonly alerts?: RelayAlerts;
  private readonly deployedAt: Date;
  private readonly log: NonNullable<RelayServerOptions['log']>;

  private readonly conns = new Set<Conn>();
  /** gatewayId → hello 검증을 마친 현재 연결 */
  private readonly registry = new Map<string, Conn>();
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, PendingReq>();
  private readonly ticker: NodeJS.Timeout;
  private nextConnId = 1;
  private shuttingDown = false;

  private readonly hSnapshot = new Set<Handler<[string, SnapshotFrame]>>();
  private readonly hEvt = new Set<Handler<[string, EvtFrame]>>();
  private readonly hOnline = new Set<Handler<[OnlineInfo]>>();
  private readonly hOffline = new Set<Handler<[OfflineInfo]>>();

  constructor(o: RelayServerOptions) {
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.repo = o.repo;
    this.cache = o.cache;
    this.outbox = o.outbox;
    this.metrics = o.metrics;
    this.alerts = o.alerts;
    this.deployedAt = o.deployedAt ?? new Date();
    const noop = () => {};
    this.log = o.log ?? { info: noop, warn: noop, error: noop, debug: noop };
    this.ticker = setInterval(() => this.tick(), this.timing.tickMs);
    this.ticker.unref();
  }

  setOutbox(outbox: RelayOutbox | undefined): void {
    this.outbox = outbox;
  }
  setMetrics(metrics: RelayServerOptions['metrics']): void {
    this.metrics = metrics;
  }

  /** 테스트·진단용: 현재 연결 수 */
  get connectionCount(): number {
    return this.conns.size;
  }

  // ------------------------------------------------------------------ 접속

  /** @fastify/websocket 핸들러에서 호출한다 */
  accept(ws: RelaySocket, up: UpgradeInfo): void {
    const conn: Conn = {
      id: this.nextConnId++,
      ws,
      gatewayId: up.gatewayIdHeader ?? '',
      authed: false,
      state: 'opening',
      nonce: randomBytes(32).toString('base64url'),
      gw: null,
      connectedAt: new Date(),
      lastRx: now(),
      lastTx: now(),
      chain: Promise.resolve(),
      holding: false,
      held: [],
      processedUpTo: 0,
      ackedUpTo: 0,
      unacked: 0,
      replacedLive: false,
      bindWaiters: [],
    };
    this.conns.add(conn);
    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on('close', (code) => this.onClose(conn, code));
    ws.on('error', (e) => this.log.warn({ gatewayId: conn.gatewayId, err: e.message }, 'relay ws error'));

    // 쿼리 토큰은 받지 않는다(헤더 검사보다 먼저: 토큰을 URL 에 실은 클라이언트를 확실히 끊는다)
    if (up.queryKeys.some((k) => /token/i.test(k))) return this.reject(conn, CLOSE.tokenRejected, 'query token not accepted');
    if (!up.gatewayIdHeader || !GATEWAY_ID_RE.test(up.gatewayIdHeader)) return this.reject(conn, CLOSE.badRequest, 'X-Siot-Gateway-Id required');
    let token: string | null = null;
    if (up.authorization !== undefined) {
      const m = /^Bearer\s+(\S+)$/i.exec(up.authorization);
      if (!m?.[1]) return this.reject(conn, CLOSE.tokenRejected, 'malformed authorization');
      token = m[1];
    }
    this.enqueue(conn, async () => {
      const gw = await this.repo.get(conn.gatewayId);
      if (conn.state === 'closed') return;
      if (!gw || !gw.pubkey) return this.reject(conn, CLOSE.unregisteredKey, 'unregistered gateway key');
      if (token !== null) {
        if (!tokenMatches(token, gw.tokenHash)) return this.reject(conn, CLOSE.tokenRejected, 'invalid gateway token');
        conn.authed = true;
      }
      conn.gw = gw;
      conn.state = 'challenge';
      conn.helloTimer = setTimeout(() => this.reject(conn, CLOSE.timeout, 'hello timeout'), this.timing.helloTimeoutMs);
      this.send(conn, { t: 'challenge', nonce: conn.nonce });
    });
  }

  private reject(conn: Conn, code: number, reason: string): void {
    this.log.info({ gatewayId: conn.gatewayId || undefined, code, reason }, 'relay connection rejected');
    this.closeConn(conn, code, reason);
  }

  private closeConn(conn: Conn, code: number, reason: string): void {
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
  }

  private enqueue(conn: Conn, fn: () => Promise<void> | void): void {
    conn.chain = conn.chain.then(fn).catch((e: unknown) => {
      this.log.error({ gatewayId: conn.gatewayId, err: e instanceof Error ? e.message : String(e) }, 'relay frame handling failed');
    });
  }

  private onMessage(conn: Conn, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    conn.lastRx = now();
    if (isBinary) return;
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
    const r = parseGatewayFrame(text);
    if (!r.ok) {
      this.log.warn({ gatewayId: conn.gatewayId, error: r.error }, 'relay frame rejected by schema');
      return;
    }
    const f = r.frame;
    // 순서와 무관한 프레임은 즉시
    if (f.t === 'ping') return void (conn.state === 'ready' && this.send(conn, { t: 'pong' }));
    if (f.t === 'pong') return;
    if (f.t === 'res') return this.onRes(conn, f);
    // bound 직후 GW 가 곧바로 연결을 닫으므로 대기자는 DB 기록 전에 즉시 깨운다(close 의 false 보다 먼저)
    if (f.t === 'bound' && conn.state === 'ready') for (const w of conn.bindWaiters.splice(0)) w(true);
    this.enqueue(conn, () => this.onFrame(conn, f));
  }

  private async onFrame(conn: Conn, f: GatewayToServerFrame): Promise<void> {
    if (conn.state === 'closed') return;
    if (conn.state === 'challenge') {
      if (f.t === 'hello') await this.onHello(conn, f);
      return; // hello 전 다른 프레임은 무시
    }
    if (conn.state !== 'ready') return;
    switch (f.t) {
      case 'cfg_ack':
        return this.onCfgAck(conn, f);
      case 'bound':
        await this.repo.recordBound(conn.gatewayId);
        this.log.info({ gatewayId: conn.gatewayId }, 'relay bound');
        return;
      case 'snapshot':
      case 'evt':
        if (conn.holding) {
          conn.held.push(f);
          if (conn.held.length > this.timing.pendingMax) {
            this.log.warn({ gatewayId: conn.gatewayId, held: conn.held.length }, 'relay pending buffer overflow before cfg_ack');
            this.closeConn(conn, CLOSE.pendingOverflow, 'pending overflow');
          }
          return;
        }
        return this.processData(conn, f);
      default:
        return;
    }
  }

  private async onHello(conn: Conn, hello: HelloFrame): Promise<void> {
    const gw = conn.gw!;
    if (hello.gatewayId !== conn.gatewayId) return this.reject(conn, CLOSE.unregisteredKey, 'gatewayId mismatch');
    // 사전 등록된 키만: hello.pubKey 가 등록 키와 같아야 하고, 서명은 등록 키로 검증한다
    if (hello.pubKey !== gw.pubkey || !verifyHelloSig(gw.pubkey, conn.nonce, hello.sig)) {
      return this.reject(conn, CLOSE.unregisteredKey, 'signature or key mismatch');
    }
    clearTimeout(conn.helloTimer);
    conn.hello = hello;
    conn.state = 'ready';

    const prev = this.registry.get(conn.gatewayId);
    if (prev && prev !== conn) {
      prev.closeReason = 'replaced';
      conn.replacedLive = true;
      this.closeConn(prev, CLOSE.replaced, 'replaced by new connection');
    }
    this.registry.set(conn.gatewayId, conn);
    if (this.seen.has(conn.gatewayId)) this.metrics?.relayReconnects.inc();
    this.seen.add(conn.gatewayId);
    this.metrics?.gatewaysOnline.set(this.registry.size);

    const at = new Date();
    await this.repo.markOnline(conn.gatewayId, hello, at);
    await this.cache.setGatewayOnline(conn.gatewayId, true, at);
    if (!conn.replacedLive) await this.enqueueOutbox(gw, { type: 'gateway.online', gatewayId: gw.gatewayId, siteId: gw.siteId, at: at.toISOString() });
    this.emit(this.hOnline, { gatewayId: conn.gatewayId, hello, connectedAt: conn.connectedAt });
    if (conn.state !== 'ready') return; // 처리 중 끊김

    // cfg 단계: 초기화 대기 상태를 다른 처리보다 먼저 본다
    const needReissue = !conn.authed && (gw.status === 'bound' || gw.status === 'site_reset_pending') && gw.siteId !== null;
    if (gw.status === 'factory_reset_pending') {
      // M1 뼈대: 공장초기화 명령(req) 송신은 M2(B6). 그 전까지는 cfg·bind 를 보내지 않는다
      this.log.warn({ gatewayId: gw.gatewayId }, 'factory_reset_pending: reset command not implemented in M1');
    }
    this.send(conn, { t: 'welcome', serverTime: at.toISOString(), heartbeatSec: wholeSec(this.timing.heartbeatSec), deadSec: wholeSec(this.timing.deadSec), cfgVersion: gw.cfgVersion });

    if (needReissue) {
      await this.reissue(conn, gw);
      return;
    }
    if (gw.status !== 'factory_reset_pending' && gw.siteId && gw.cfgVersion > hello.cfgVersion) {
      const cfg = await this.repo.buildCfg(conn.gatewayId);
      if (cfg && conn.state === 'ready') this.sendStartupCfg(conn, cfg);
    }
  }

  /** 접속 시 cfg: 보낸 연결만 cfg_ack 전 snapshot·evt 를 보류하고, 10초 안에 ack 가 없으면 끊는다 */
  private sendStartupCfg(conn: Conn, cfg: CfgBody): void {
    conn.holding = true;
    conn.cfgTimer = setTimeout(() => {
      if (!conn.holding) return;
      this.log.warn({ gatewayId: conn.gatewayId }, 'relay cfg_ack timeout');
      this.closeConn(conn, CLOSE.timeout, 'cfg_ack timeout');
    }, this.timing.cfgAckTimeoutMs);
    this.send(conn, { t: 'cfg', ...cfg });
  }

  private async onCfgAck(conn: Conn, ack: CfgAckFrame): Promise<void> {
    await this.repo.recordCfgAck(conn.gatewayId, ack);
    if (!conn.holding) return;
    conn.holding = false;
    clearTimeout(conn.cfgTimer);
    for (const f of conn.held.splice(0)) {
      if (conn.state === 'closed') return;
      await this.processData(conn, f);
    }
  }

  private async reissue(conn: Conn, gw: GatewayRecord): Promise<void> {
    const { token, hash } = newGatewayToken();
    const at = new Date();
    const { recentCount } = await this.repo.reissueToken(gw.gatewayId, hash, at);
    gw.tokenHash = hash;
    this.log.warn({ gatewayId: gw.gatewayId, recentCount }, 'relay gateway token reissued (bind lost)');
    if (recentCount > this.timing.reissueAlertThreshold) {
      try {
        await this.alerts?.notify(`gateway.token_reissue:${gw.gatewayId}`, `게이트웨이 ${gw.gatewayId} 토큰 재발급이 24시간 안에 ${recentCount}회`, {
          gatewayId: gw.gatewayId,
          orgId: gw.orgId,
          recentCount,
        });
      } catch (e) {
        this.log.error({ err: (e as Error).message }, 'alert notify failed');
      }
    }
    if (conn.state === 'ready' && gw.siteId) this.send(conn, { t: 'bind', gatewayToken: token, siteId: gw.siteId });
  }

  // ------------------------------------------------------------------ snapshot·evt·ack

  private async processData(conn: Conn, f: SnapshotFrame | EvtFrame): Promise<void> {
    if (f.t === 'snapshot') {
      if (conn.ackBoot !== f.bootId) {
        conn.ackBoot = f.bootId;
        conn.processedUpTo = 0;
        conn.ackedUpTo = 0;
        conn.unacked = 0;
      }
      await this.cache.applySnapshot(conn.gatewayId, f);
      this.emit(this.hSnapshot, conn.gatewayId, f);
      return;
    }
    try {
      await this.cache.applyEvt(conn.gatewayId, f);
    } catch (e) {
      this.log.error({ gatewayId: conn.gatewayId, seq: f.seq, err: (e as Error).message }, 'cache.applyEvt failed');
    }
    this.emit(this.hEvt, conn.gatewayId, f);
    if (conn.ackBoot === undefined) conn.ackBoot = f.bootId;
    if (f.bootId !== conn.ackBoot) return;
    if (f.seq > conn.processedUpTo) conn.processedUpTo = f.seq;
    conn.unacked++;
    if (conn.unacked >= this.timing.ackEvery) this.flushAck(conn);
    else if (!conn.ackTimer) conn.ackTimer = setTimeout(() => this.flushAck(conn), this.timing.ackIntervalMs);
  }

  private flushAck(conn: Conn): void {
    clearTimeout(conn.ackTimer);
    conn.ackTimer = undefined;
    conn.unacked = 0;
    if (!conn.ackBoot || conn.processedUpTo <= conn.ackedUpTo || conn.state !== 'ready') return;
    conn.ackedUpTo = conn.processedUpTo;
    this.send(conn, { t: 'ack', bootId: conn.ackBoot, upTo: conn.processedUpTo });
  }

  // ------------------------------------------------------------------ 하트비트·종료

  private tick(): void {
    const t = now();
    const deadMs = this.timing.deadSec * 1000;
    const hbMs = this.timing.heartbeatSec * 1000;
    for (const conn of this.conns) {
      if (conn.state === 'closed') continue;
      if (t - conn.lastRx > deadMs) {
        this.log.warn({ gatewayId: conn.gatewayId, silentMs: Math.round(t - conn.lastRx) }, 'relay heartbeat timeout');
        conn.closeReason = 'heartbeat';
        if (conn.state === 'ready') this.metrics?.heartbeatTimeouts.inc();
        conn.ws.terminate();
        continue;
      }
      if (conn.state === 'ready' && t - conn.lastTx >= hbMs) this.send(conn, { t: 'ping' });
    }
  }

  private onClose(conn: Conn, code: number): void {
    if (conn.state === 'closed') return;
    const wasReady = conn.state === 'ready';
    conn.state = 'closed';
    this.conns.delete(conn);
    clearTimeout(conn.helloTimer);
    clearTimeout(conn.cfgTimer);
    clearTimeout(conn.ackTimer);
    for (const w of conn.bindWaiters.splice(0)) w(false);
    for (const [id, p] of this.pending) {
      if (p.conn !== conn) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new GatewayOfflineError(conn.gatewayId));
    }
    if (!wasReady) return;
    const isCurrent = this.registry.get(conn.gatewayId) === conn;
    if (isCurrent) this.registry.delete(conn.gatewayId);
    this.metrics?.gatewaysOnline.set(this.registry.size);
    const reason: OfflineInfo['reason'] = conn.closeReason ?? 'closed';
    const at = new Date();
    this.log.info({ gatewayId: conn.gatewayId, code, reason }, 'relay gateway disconnected');
    if (this.shuttingDown) return; // 배포 종료: 새 인스턴스가 유예 후 판단
    if (!isCurrent || reason === 'replaced') {
      this.emit(this.hOffline, { gatewayId: conn.gatewayId, reason: 'replaced', at });
      return;
    }
    this.enqueue(conn, async () => {
      if (this.registry.has(conn.gatewayId)) return; // 그새 재접속
      await this.repo.markOffline(conn.gatewayId, at);
      await this.cache.setGatewayOnline(conn.gatewayId, false, at);
      const gw = conn.gw!;
      if (at.getTime() >= this.deployedAt.getTime() + this.timing.offlineGraceMs) {
        await this.enqueueOutbox(gw, { type: 'gateway.offline', gatewayId: gw.gatewayId, siteId: gw.siteId, at: at.toISOString(), data: { reason } });
      }
      this.emit(this.hOffline, { gatewayId: conn.gatewayId, reason, at });
    });
  }

  private async enqueueOutbox(gw: GatewayRecord, ev: RelayOutboxEvent): Promise<void> {
    if (!this.outbox) return;
    try {
      await this.outbox.enqueue(gw.orgId, ev);
    } catch (e) {
      this.log.error({ gatewayId: gw.gatewayId, type: ev.type, err: (e as Error).message }, 'outbox enqueue failed');
    }
  }

  /** 모든 연결을 닫는다(app onClose). offline 웹훅은 내지 않는다 */
  async close(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.ticker);
    for (const c of this.conns) this.closeConn(c, CLOSE.shutdown, 'server shutdown');
    await Promise.all([...this.conns].map((c) => c.chain));
  }

  // ------------------------------------------------------------------ 송신

  private send(conn: Conn, frame: ServerToGatewayFrame): boolean {
    assertServerFrame(frame);
    if (conn.ws.readyState !== WS_OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(frame));
      conn.lastTx = now();
      return true;
    } catch {
      return false;
    }
  }

  private ready(gatewayId: string): Conn | undefined {
    const c = this.registry.get(gatewayId);
    return c && c.state === 'ready' && c.ws.readyState === WS_OPEN ? c : undefined;
  }

  // ------------------------------------------------------------------ GatewayBus

  isOnline(gatewayId: string): boolean {
    return this.ready(gatewayId) !== undefined;
  }

  request(gatewayId: string, req: GatewayRequest, timeoutMs: number): Promise<GatewayResponse> {
    const conn = this.ready(gatewayId);
    if (!conn) return Promise.reject(new GatewayOfflineError(gatewayId));
    const id = randomUUID();
    const frame: ReqFrame = { t: 'req', id, method: req.method, path: req.path };
    if (req.headers) frame.headers = req.headers;
    if (req.body !== undefined) frame.body = req.body;
    if (req.timeoutMs !== undefined) frame.timeoutMs = req.timeoutMs;
    return new Promise<GatewayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayTimeoutError(gatewayId, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { conn, resolve, reject, timer });
      this.metrics?.relayRequests?.inc();
      if (!this.send(conn, frame)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new GatewayOfflineError(gatewayId));
      }
    });
  }

  private onRes(conn: Conn, f: ResFrame): void {
    const p = this.pending.get(f.id);
    if (!p || p.conn !== conn) return;
    clearTimeout(p.timer);
    this.pending.delete(f.id);
    const { t: _t, ...res } = f;
    p.resolve(res);
  }

  async sendCfg(gatewayId: string, cfg: CfgBody): Promise<boolean> {
    const conn = this.ready(gatewayId);
    return conn ? this.send(conn, { t: 'cfg', ...cfg }) : false;
  }

  sendBind(gatewayId: string, bind: Omit<BindFrame, 't'>): Promise<boolean> {
    const conn = this.ready(gatewayId);
    if (!conn) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), this.timing.bindTimeoutMs);
      conn.bindWaiters.push(finish);
      if (!this.send(conn, { t: 'bind', ...bind })) finish(false);
    });
  }

  onSnapshot(handler: Handler<[string, SnapshotFrame]>): Unsubscribe {
    return this.sub(this.hSnapshot, handler);
  }
  onEvt(handler: Handler<[string, EvtFrame]>): Unsubscribe {
    return this.sub(this.hEvt, handler);
  }
  onOnline(handler: Handler<[OnlineInfo]>): Unsubscribe {
    return this.sub(this.hOnline, handler);
  }
  onOffline(handler: Handler<[OfflineInfo]>): Unsubscribe {
    return this.sub(this.hOffline, handler);
  }

  private sub<A extends unknown[]>(set: Set<Handler<A>>, h: Handler<A>): Unsubscribe {
    set.add(h);
    return () => void set.delete(h);
  }

  private emit<A extends unknown[]>(set: Set<Handler<A>>, ...args: A): void {
    for (const h of set) {
      try {
        const r = h(...args);
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e: unknown) => this.log.error({ err: String(e) }, 'relay hook failed'));
      } catch (e) {
        this.log.error({ err: String(e) }, 'relay hook failed');
      }
    }
  }
}
