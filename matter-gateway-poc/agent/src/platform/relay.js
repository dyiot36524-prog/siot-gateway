// 릴레이 터널 에이전트 — siot-app lib/relay-agent.ts 와 동일 프레임: {t:"req",id,method,path,headers,body(b64)} → {t:"res",id,status,headers,body(b64)}
import WebSocket from 'ws';
import { logger } from '../log.js';
const log = logger('relay');
const DROP_REQ = new Set(['host', 'connection', 'content-length', 'keep-alive', 'upgrade', 'transfer-encoding', 'accept-encoding']);
const DROP_RES = new Set(['content-encoding', 'transfer-encoding', 'content-length', 'connection', 'keep-alive']);

export class RelayAgent {
  constructor({ relayUrl, identity, store, port }) { Object.assign(this, { relayUrl, identity, store, port }); this.ws = null; this.attempt = 0; this.stopped = false; }
  async start() {
    if (!this.relayUrl) { log.info('SIOT_RELAY_URL 없음 — 릴레이 비활성(로컬 전용)'); return; }
    const s = await this.store.load();
    const token = s.gatewayToken ?? process.env.SIOT_PLATFORM_TOKEN;
    if (!token) { log.warn('gatewayToken 없음 — 릴레이 대기(claim 후 자동 시작)'); return; }
    this.token = token; this.gatewayId = await this.identity.gatewayId();
    this.#connect();
  }
  /** claim 직후 호출 */
  async restartWithToken(token) { this.token = token; this.gatewayId = await this.identity.gatewayId(); this.ws?.close(); if (!this.ws && this.relayUrl) this.#connect(); }
  stop() { this.stopped = true; this.ws?.close(); }

  #connect() {
    if (this.stopped || !this.relayUrl) return;
    const url = `${this.relayUrl}?gatewayId=${encodeURIComponent(this.gatewayId)}&token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url); this.ws = ws;
    ws.on('open', () => { this.attempt = 0; log.info(`connected ${this.relayUrl} (gatewayId=${this.gatewayId})`); });
    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t !== 'req' || !msg.id) return;
      const frame = await this.#proxy(msg);
      try { ws.send(JSON.stringify(frame)); } catch { /* ignore */ }
    });
    ws.on('close', () => { this.ws = null; this.#reconnect(); });
    ws.on('error', (e) => { log.warn(`ws error: ${e.message}`); try { ws.close(); } catch {} });
  }
  #reconnect() { if (this.stopped) return; const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)); setTimeout(() => this.#connect(), delay); }
  async #proxy(msg) {
    try {
      const headers = {};
      for (const [k, v] of Object.entries(msg.headers ?? {})) if (!DROP_REQ.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
      const method = msg.method ?? 'GET';
      const init = { method, headers };
      if (msg.body && method !== 'GET' && method !== 'HEAD') init.body = Buffer.from(msg.body, 'base64');
      const r = await fetch(`http://127.0.0.1:${this.port}${msg.path ?? '/'}`, init);
      const buf = Buffer.from(await r.arrayBuffer());
      const resHeaders = {}; r.headers.forEach((v, k) => { if (!DROP_RES.has(k.toLowerCase())) resHeaders[k] = v; });
      return { t: 'res', id: msg.id, status: r.status, headers: resHeaders, body: buf.toString('base64') };
    } catch {
      return { t: 'res', id: msg.id, status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ ok: false, error: 'gateway proxy error' })).toString('base64') };
    }
  }
}
