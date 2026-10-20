// relay-v2 클라이언트 — 게이트웨이 → siot-cloud WebSocket 터널. 프레임·순서·replay 규칙은 docs/relay-protocol.md.
//  접속: 헤더 X-Siot-Gateway-Id (+ 바인딩 후 Authorization: Bearer <gatewayToken>). 쿼리 토큰 없음.
//  순서: challenge → hello(Ed25519 서명) → welcome → [cfg → cfg_ack] → snapshot → 미확인 evt(replayed:true) → 실시간 evt
//  req 는 로컬 API(출고 127.0.0.1:3001, dev 127.0.0.1:3000)로 프록시하며 자기 토큰을 Authorization 에 넣는다.
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { logger } from '../log.js';

const log = logger('relay');
const DROP_REQ = new Set(['host', 'connection', 'content-length', 'keep-alive', 'upgrade', 'transfer-encoding', 'accept-encoding', 'authorization']);
const DROP_RES = new Set(['content-encoding', 'transfer-encoding', 'content-length', 'connection', 'keep-alive']);

export const PROTO = 2;
export const RING_SIZE = 1000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_HEARTBEAT_SEC = 10;
export const DEFAULT_DEAD_SEC = 25;
export const DEFAULT_REQ_TIMEOUT_MS = 30_000;
export const BACKOFF = Object.freeze({ baseMs: 1000, maxMs: 20_000, jitter: 0.2 });
export const EVT_KINDS = Object.freeze(['device', 'device_removed', 'gateway', 'pairing', 'thread', 'error', 'log']);
const now = () => performance.now();   // monotonic (RTC 없음, 벽시계 점프 무시)

/** 재접속 대기: min(20초, 1초·2^attempt) ±20%. 최댓값 24초 */
export function backoffDelay(attempt, opts = BACKOFF, random = Math.random) {
  const { baseMs, maxMs, jitter } = { ...BACKOFF, ...opts };
  const d = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.round(d * (1 + (random() * 2 - 1) * jitter));
}

/** (bootId, seq) 링버퍼. seq 는 에이전트 시작마다 1부터. 넘치면 가장 오래된 것을 버린다(메모리 전용) */
export class EventRing {
  constructor(bootId, capacity = RING_SIZE) { this.bootId = bootId; this.capacity = capacity; this.seq = 0; this.items = []; this.dropped = 0; }
  get lastSeq() { return this.seq; }
  get size() { return this.items.length; }
  push({ kind, data, keyVersion = 0, at = new Date().toISOString() }) {
    const e = frames.evt({ bootId: this.bootId, seq: ++this.seq, keyVersion, kind, at, data });
    this.items.push(e);
    if (this.items.length > this.capacity) { this.items.shift(); this.dropped++; }
    return e;
  }
  /** ack {bootId, upTo}: 같은 bootId 의 seq ≤ upTo 를 비운다. 지운 개수 */
  ack(bootId, upTo) {
    if (bootId !== this.bootId || !Number.isFinite(upTo)) return 0;
    const before = this.items.length;
    this.items = this.items.filter((e) => e.seq > upTo);
    return before - this.items.length;
  }
  unacked() { return this.items.slice(); }
}

/** GW → 서버 프레임 생성기. 필드 집합은 계획 §2 b 표 + P0 스키마(additionalProperties:false)와 정확히 같아야 한다 */
export const frames = {
  hello: (h) => ({ t: 'hello', proto: PROTO, gatewayId: h.gatewayId, bootId: h.bootId, agentVersion: h.agentVersion, matterServerVersion: h.matterServerVersion ?? null, startedAt: h.startedAt, clock: h.clock, cfgVersion: h.cfgVersion, keyVersion: h.keyVersion, pubKey: h.pubKey, sig: h.sig }),
  bound: () => ({ t: 'bound' }),
  cfgAck: (a) => ({ t: 'cfg_ack', cfgVersion: a.cfgVersion, keyVersion: a.keyVersion, rulesVersion: a.rulesVersion }),
  snapshot: (s) => ({ t: 'snapshot', bootId: s.bootId, seq: s.seq, keyVersion: s.keyVersion, gateway: s.gateway, devices: s.devices }),
  evt: (e) => ({ t: 'evt', bootId: e.bootId, seq: e.seq, keyVersion: e.keyVersion, kind: e.kind, at: e.at, data: e.data, ...(e.replayed ? { replayed: true } : {}) }),
  res: (r) => ({ t: 'res', id: r.id, status: r.status, headers: r.headers, body: r.body }),
  ping: () => ({ t: 'ping' }),
  pong: () => ({ t: 'pong' }),
};

export class RelayAgent extends EventEmitter {
  /**
   * @param {object} o
   * @param {string|null} o.relayUrl
   * @param {import('./identity.js').Identity} o.identity
   * @param {import('./store.js').GatewayStore} o.store
   * @param {import('../site/siteConfig.js').SiteConfig} o.siteConfig
   * @param {string} o.bootId          에이전트 시작마다 새 uuid
   * @param {string} o.startedAt       ISO
   * @param {string} o.version         agentVersion
   * @param {number} o.proxyPort       출고 3001, dev 3000
   * @param {()=>Promise<{gateway:object, devices:object[]}>|{gateway:object, devices:object[]}} o.getSnapshot
   * @param {()=>string|null} [o.matterServerVersion]
   * @param {object} [o.timing]        테스트용 { tickMs, cfgWaitMs, backoff, random }
   */
  constructor(o) {
    super();
    Object.assign(this, { relayUrl: o.relayUrl, identity: o.identity, store: o.store, siteConfig: o.siteConfig, bootId: o.bootId, startedAt: o.startedAt, version: o.version, proxyPort: o.proxyPort, getSnapshot: o.getSnapshot, matterServerVersion: o.matterServerVersion ?? (() => null) });
    const t = o.timing ?? {};
    this.tickMs = t.tickMs ?? 1000; this.cfgWaitMs = t.cfgWaitMs ?? 10_000; this.backoff = t.backoff ?? BACKOFF; this.random = t.random ?? Math.random;
    this.ring = new EventRing(this.bootId, o.ringSize ?? RING_SIZE);
    this.conn = null; this.attempt = 0; this.stopped = false; this.skipToken = false; this.reconnectTimer = null;
  }

  /** welcome 을 받은 열린 연결이 있으면 true (health.json relay.connected) */
  get connected() { return Boolean(this.conn?.welcomed && this.conn.ws.readyState === WebSocket.OPEN); }

  async start() {
    if (!this.relayUrl) { log.info('릴레이 비활성(SIOT_RELAY_URL=off) — 로컬 전용'); return; }
    this.gatewayId = await this.identity.gatewayId();
    this.key = await this.identity.deviceKey();
    this.#connect();
  }

  stop() { this.stopped = true; clearTimeout(this.reconnectTimer); this.conn?.ws.close(1001, 'shutdown'); }

  /** 백오프 없이 즉시 다시 접속(dev 로컬 claim 직후 등) */
  reconnectNow() {
    if (!this.relayUrl || this.stopped) return;
    this.attempt = 0;
    if (this.conn) { this.conn.immediate = true; this.conn.ws.close(1000, 'reconnect'); }
    else { clearTimeout(this.reconnectTimer); this.#connect(); }
  }

  /** 이벤트를 링버퍼에 넣고, snapshot 이 끝난 연결이면 바로 보낸다 */
  publish(kind, data) {
    if (!EVT_KINDS.includes(kind)) throw new Error(`unknown evt kind: ${kind}`);
    const e = this.ring.push({ kind, data, keyVersion: this.siteConfig?.keyVersion ?? 0 });
    if (this.conn?.live) this.#send(this.conn, e);
    return e;
  }

  async #connect() {
    if (this.stopped) return;
    const s = await this.store.load();
    const token = this.skipToken ? null : (s.gatewayToken ?? null);
    const headers = { 'X-Siot-Gateway-Id': this.gatewayId };
    if (token) headers.Authorization = `Bearer ${token}`;
    const ws = new WebSocket(this.relayUrl, { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    const conn = { ws, authed: Boolean(token), welcomed: false, snapshotSent: false, live: false, immediate: false, lastRx: now(), lastTx: now(), hbMs: DEFAULT_HEARTBEAT_SEC * 1000, deadMs: DEFAULT_DEAD_SEC * 1000, tick: null, cfgTimer: null };
    this.conn = conn;
    ws.on('open', () => {
      conn.lastRx = conn.lastTx = now();
      log.info(`connected ${this.relayUrl} (gatewayId=${this.gatewayId}, ${token ? 'bound' : 'unbound'})`);
      conn.tick = setInterval(() => this.#tick(conn), this.tickMs);
    });
    ws.on('message', (raw) => { this.#onFrame(conn, raw).catch((e) => log.warn(`frame error: ${e.message}`)); });
    ws.on('error', (e) => log.warn(`ws error: ${e.message}`));
    ws.on('close', (code) => {
      clearInterval(conn.tick); clearTimeout(conn.cfgTimer);
      if (this.conn === conn) this.conn = null;
      if (conn.welcomed) this.emit('disconnected', { code });
      if (code === 4401 && conn.authed) { log.warn('토큰 거부(4401) — 다음 접속은 서명만으로(bind 재발급 대기)'); this.skipToken = true; }
      if (code === 4403) log.warn('미등록 장치 키(4403) — 공장 등록 필요');
      if (this.stopped) return;
      const delay = conn.immediate ? 0 : backoffDelay(this.attempt++, this.backoff, this.random);
      log.info(`disconnected (${code}); reconnect in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => this.#connect().catch((e) => log.warn(`connect failed: ${e.message}`)), delay);
    });
  }

  #tick(conn) {
    const t = now();
    if (t - conn.lastRx > conn.deadMs) { log.warn(`${Math.round((t - conn.lastRx) / 1000)}s 동안 프레임 없음 — 연결 종료`); conn.ws.terminate(); return; }
    if (t - conn.lastTx >= conn.hbMs) this.#send(conn, frames.ping());
  }

  #send(conn, frame) {
    if (conn.ws.readyState !== WebSocket.OPEN) return false;
    try { conn.ws.send(JSON.stringify(frame)); conn.lastTx = now(); return true; } catch { return false; }
  }

  async #onFrame(conn, raw) {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    conn.lastRx = now();
    switch (msg.t) {
      case 'challenge': {
        if (typeof msg.nonce !== 'string') return;
        return void this.#send(conn, frames.hello({
          gatewayId: this.gatewayId, bootId: this.bootId, agentVersion: this.version, matterServerVersion: this.matterServerVersion(),
          startedAt: this.startedAt, clock: new Date().toISOString(),
          cfgVersion: this.siteConfig?.cfgVersion ?? 0, keyVersion: this.siteConfig?.keyVersion ?? 0,
          pubKey: this.key.publicKey, sig: this.key.sign(msg.nonce),
        }));
      }
      case 'welcome': {
        conn.welcomed = true; this.attempt = 0;
        if (Number.isFinite(msg.heartbeatSec) && msg.heartbeatSec > 0) conn.hbMs = msg.heartbeatSec * 1000;
        if (Number.isFinite(msg.deadSec) && msg.deadSec > 0) conn.deadMs = msg.deadSec * 1000;
        this.emit('welcome', msg);
        // 서버 cfgVersion 이 더 높으면 곧 cfg 가 온다 → cfg_ack 뒤에 snapshot. 오지 않으면 cfgWaitMs 뒤 진행
        if (Number(msg.cfgVersion) > (this.siteConfig?.cfgVersion ?? 0)) conn.cfgTimer = setTimeout(() => this.#sync(conn), this.cfgWaitMs);
        else await this.#sync(conn);
        return;
      }
      case 'cfg': {
        const ack = await this.siteConfig.apply(msg);
        this.#send(conn, frames.cfgAck(ack));
        this.emit('cfg', msg);
        if (conn.welcomed && !conn.snapshotSent) { clearTimeout(conn.cfgTimer); await this.#sync(conn); }
        return;
      }
      case 'bind': {
        if (typeof msg.gatewayToken !== 'string' || !msg.gatewayToken) return;
        await this.store.save({ gatewayToken: msg.gatewayToken, siteId: msg.siteId ?? null, registeredAt: new Date().toISOString() });
        this.skipToken = false;
        this.#send(conn, frames.bound());
        log.info(`bound (siteId=${msg.siteId ?? '-'}) — 토큰으로 재접속`);
        this.emit('bound', { siteId: msg.siteId ?? null });
        conn.immediate = true; this.attempt = 0;
        conn.ws.close(1000, 'rebind');
        return;
      }
      case 'ack': this.ring.ack(msg.bootId, Number(msg.upTo)); return;
      case 'req': {
        if (msg.id == null) return;
        const r = await this.#proxy(msg);
        this.#send(conn, frames.res(r));
        return;
      }
      case 'ping': this.#send(conn, frames.pong()); return;
      default: return;   // pong 및 모르는 프레임은 lastRx 갱신만
    }
  }

  /** snapshot → 미확인 evt(replayed:true) → 이후 evt 실시간. 연결당 1회 */
  async #sync(conn) {
    if (conn.snapshotSent || conn.ws.readyState !== WebSocket.OPEN) return;
    conn.snapshotSent = true;
    const snap = await this.getSnapshot();
    // 여기부터 동기 구간: seq 캡처·snapshot·replay 사이에 새 evt 가 끼지 않는다
    this.#send(conn, frames.snapshot({ bootId: this.bootId, seq: this.ring.lastSeq, keyVersion: this.siteConfig?.keyVersion ?? 0, gateway: snap.gateway, devices: snap.devices }));
    for (const e of this.ring.unacked()) this.#send(conn, { ...e, replayed: true });
    conn.live = true;
    this.emit('synced');
  }

  async #proxy(msg) {
    const id = msg.id;
    const fail = (status, error) => ({ id, status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ ok: false, error })).toString('base64') });
    const p = typeof msg.path === 'string' ? msg.path : '/';
    if (!p.startsWith('/')) return fail(400, 'invalid path');
    try {
      const headers = {};
      for (const [k, v] of Object.entries(msg.headers ?? {})) if (!DROP_REQ.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
      const s = await this.store.load();
      const token = s.gatewayToken ?? process.env.SIOT_PLATFORM_TOKEN;
      if (token) headers.authorization = `Bearer ${token}`;   // 클라우드가 보낸 Authorization 은 버리고 자기 토큰 주입
      const method = msg.method ?? 'GET';
      const timeoutMs = Math.min(120_000, Math.max(100, Number(msg.timeoutMs) || DEFAULT_REQ_TIMEOUT_MS));
      const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
      if (msg.body && method !== 'GET' && method !== 'HEAD') init.body = Buffer.from(msg.body, 'base64');
      const r = await fetch(`http://127.0.0.1:${this.proxyPort}${p}`, init);
      const buf = Buffer.from(await r.arrayBuffer());
      const resHeaders = {}; r.headers.forEach((v, k) => { if (!DROP_RES.has(k.toLowerCase())) resHeaders[k] = v; });
      return { id, status: r.status, headers: resHeaders, body: buf.toString('base64') };
    } catch (e) {
      if (e?.name === 'TimeoutError') return fail(504, 'gateway timeout');
      return fail(502, 'gateway proxy error');
    }
  }
}
