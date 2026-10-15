// 플랫폼/로컬 HTTP API 서버 — siot-app 의 라우트 계약을 그대로 제공한다.
//  플랫폼용(인증):  /siot-app/api/v1/{gateway, devices, devices/:id, devices/:id/control, events(SSE), system,
//                   pairing(POST), pairing/:sessionId(GET), devices/:id(DELETE), devices/:id/commissioning-window(POST)}
//  플랫폼용(무인증): POST /siot-app/api/v1/claim
//  로컬 UI용(무인증, LAN): /api/{gateway, register(POST), system, devices, devices/:id/control, stream(SSE), pairing(POST/GET :id)}, GET /
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPlatformAuth } from './auth.js';
import { generateCode, isCodeValid, CODE_TTL_MS } from './registration.js';
import { toSiotDevices, parseSiotId, resolveAction, SUPPORTED_ACTIONS } from './siotMapper.js';
import { logger } from '../log.js';

const log = logger('api');
const STARTED_AT = new Date().toISOString();
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');

export class PlatformServer {
  /**
   * @param {object} d
   * @param {import('./store.js').GatewayStore} d.store
   * @param {import('./identity.js').Identity} d.identity
   * @param {import('../model/registry.js').DeviceRegistry} d.registry
   * @param {(cmd:object)=>Promise<any>} d.execute
   * @param {import('../pairing.js').PairingManager} d.pairing
   * @param {object} d.matter   backend (serverInfo 등)
   * @param {object} [d.opts]   { port, version, engineKind }
   */
  constructor(d) {
    Object.assign(this, d);
    this.port = d.opts?.port ?? 3000;
    this.version = d.opts?.version ?? '0.2.0';
    this.engineKind = d.opts?.engineKind ?? 'matter';
    this.sse = new Set();            // {res, kind:'platform'|'local'}
    this.sessions = new Map();       // pairing sessionId -> session
    this.lastUpdated = new Map();    // siotId -> ISO
    this.server = http.createServer((req, res) => this.#handle(req, res).catch((e) => { log.error('handler', e.stack ?? e.message); this.#json(res, 500, { ok: false, error: '알 수 없는 오류', detail: String(e.message) }); }));
    registryHook(this);
  }

  listen() { return new Promise((r) => this.server.listen(this.port, '0.0.0.0', () => { log.info(`listening on :${this.port}`); r(); })); }
  close() { for (const c of this.sse) try { c.res.end(); } catch {} return new Promise((r) => this.server.close(() => r())); }

  // ---------- 디바이스 뷰 ----------
  listSiotDevices() {
    const out = [];
    for (const d of this.registry.list()) for (const s of toSiotDevices(d)) { s.lastUpdated = this.lastUpdated.get(s.id) ?? s.lastUpdated; out.push(s); }
    return out;
  }
  findSiotDevice(id) { return this.listSiotDevices().find((d) => d.id === id) ?? null; }

  broadcastDevice(siotDevice) {
    this.lastUpdated.set(siotDevice.id, siotDevice.lastUpdated);
    const platformChunk = `data: ${JSON.stringify({ type: 'device', device: siotDevice })}\n\n`;
    const localChunk = `data: ${JSON.stringify(siotDevice)}\n\n`;
    for (const c of this.sse) this.#write(c, c.kind === 'platform' ? platformChunk : localChunk);
  }
  broadcastEvent(name, payload) {
    const chunk = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.sse) this.#write(c, chunk);
  }
  #write(c, chunk) { try { c.res.write(chunk); } catch { this.sse.delete(c); } }

  async systemStatus() {
    const s = await this.store.load();
    return {
      gatewayId: await this.identity.gatewayId(), version: this.version, registered: Boolean(s.gatewayToken),
      engineOnline: Boolean(this.matter?.serverInfo), deviceCount: this.listSiotDevices().length, startedAt: STARTED_AT,
      engine: { kind: this.engineKind, backend: this.matter?.serverInfo?.backend ?? 'server', threadCredentialsSet: Boolean(this.matter?.serverInfo?.thread_credentials_set), bluetooth: Boolean(this.matter?.serverInfo?.bluetooth_enabled) },
    };
  }

  // ---------- 페어링 세션 ----------
  startPairing(code) {
    if (this.pairing.active) return { error: '다른 페어링이 진행 중입니다.', status: 409 };
    const sessionId = randomUUID();
    const session = { sessionId, code: String(code).trim(), stage: 'queued', startedAt: new Date().toISOString(), events: [], deviceId: null, devices: [], error: null };
    this.sessions.set(sessionId, session);
    const onProgress = (p) => {
      if (p.sessionId !== sessionId) return;
      session.stage = p.stage; session.events.push({ stage: p.stage, at: p.at, hint: p.hint, error: p.error });
      if (p.stage === 'done') { session.deviceId = p.deviceId; session.devices = toSiotDevices(p.device); for (const d of session.devices) this.broadcastDevice(d); }
      if (p.stage === 'failed') session.error = p.error;
      this.broadcastEvent('pairing', { sessionId, stage: p.stage, error: p.error ?? null, deviceId: p.deviceId ?? null });
    };
    this.pairing.on('progress', onProgress);
    this.pairing.start({ sessionId, code: session.code }).catch(() => {}).finally(() => this.pairing.off('progress', onProgress));
    return { session };
  }
  publicSession(s) { return { sessionId: s.sessionId, stage: s.stage, startedAt: s.startedAt, deviceId: s.deviceId, devices: s.devices, error: s.error, events: s.events }; }

  // ---------- 라우팅 ----------
  async #handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;
    log.debug(`${m} ${p}`);

    // --- 무인증: claim ---
    if (p === '/siot-app/api/v1/claim' && m === 'POST') return this.#claim(req, res);

    // --- 플랫폼 API (인증) ---
    if (p.startsWith('/siot-app/api/v1/')) {
      const auth = await verifyPlatformAuth(req, url, this.store);
      if (!auth.ok) return this.#json(res, 401, { ok: false, error: auth.error });
      const sub = p.slice('/siot-app/api/v1/'.length);
      return this.#api(sub, m, req, res, url, 'platform');
    }
    // --- 로컬 API (무인증, LAN) ---
    if (p.startsWith('/api/')) {
      const sub = p.slice('/api/'.length);
      if (sub === 'register' && m === 'POST') return this.#register(res);
      if (sub === 'gateway' && m === 'GET') { const s = await this.store.load(); return this.#json(res, 200, { ok: true, gatewayId: await this.identity.gatewayId(), registered: Boolean(s.gatewayToken), hasCode: Boolean(s.registrationCode), registrationCode: s.registrationCode ?? null, codeExpiresAt: s.codeExpiresAt ?? null }); }
      return this.#api(sub, m, req, res, url, 'local');
    }
    if (p === '/' || p === '/connect' || p === '/index.html') return this.#static(res, 'index.html', 'text/html; charset=utf-8');
    if (p === '/app.js') return this.#static(res, 'app.js', 'text/javascript; charset=utf-8');
    if (p === '/healthz') return this.#json(res, 200, { ok: true });
    return this.#json(res, 404, { ok: false, error: 'not found' });
  }

  async #api(sub, m, req, res, url, kind) {
    const gatewayId = await this.identity.gatewayId();
    if (sub === 'gateway' && m === 'GET') return this.#json(res, 200, { ok: true, gatewayId, apiVersion: 'v1', version: this.version, engine: { kind: this.engineKind, online: Boolean(this.matter?.serverInfo) } });
    if (sub === 'system' && m === 'GET') return this.#json(res, 200, { ok: true, ...(await this.systemStatus()) });
    if (sub === 'devices' && m === 'GET') { const devices = this.listSiotDevices(); return this.#json(res, 200, kind === 'platform' ? { ok: true, gatewayId, count: devices.length, devices } : { ok: true, count: devices.length, devices }); }
    if ((sub === 'events' || sub === 'stream') && m === 'GET') return this.#sse(req, res, kind);
    if (sub === 'pairing' && m === 'GET') return this.#json(res, 200, { ok: true, supported: ['MATTER'], active: this.pairing.active, sessions: [...this.sessions.values()].slice(-10).map((s) => this.publicSession(s)) });
    if (sub === 'pairing' && m === 'POST') {
      const body = await this.#body(req);
      if (!body) return this.#json(res, 400, { ok: false, error: 'JSON 본문이 필요합니다. 예: {"code":"MT:..."}' });
      const code = body.code ?? body.setupCode ?? body.qrCode ?? body.pairingCode;
      if (typeof code !== 'string' || !code.trim()) return this.#json(res, 400, { ok: false, error: 'code(문자열: Matter QR "MT:..." 또는 수동 페어링 코드)가 필요합니다.' });
      if (body.protocol && String(body.protocol).toUpperCase() !== 'MATTER') return this.#json(res, 400, { ok: false, error: '지원하지 않는 protocol', supported: ['MATTER'] });
      const r = this.startPairing(code);
      if (r.error) return this.#json(res, r.status, { ok: false, error: r.error });
      return this.#json(res, 202, { ok: true, status: 'started', session: this.publicSession(r.session) });
    }
    let mm;
    if ((mm = sub.match(/^pairing\/([^/]+)$/)) && m === 'GET') { const s = this.sessions.get(mm[1]); return s ? this.#json(res, 200, { ok: true, session: this.publicSession(s) }) : this.#json(res, 404, { ok: false, error: '세션 없음' }); }
    if ((mm = sub.match(/^devices\/([^/]+)$/)) && m === 'GET') { const d = this.findSiotDevice(decodeURIComponent(mm[1])); return d ? this.#json(res, 200, { ok: true, device: d }) : this.#json(res, 404, { ok: false, error: '기기를 찾을 수 없습니다.' }); }
    if ((mm = sub.match(/^devices\/([^/]+)$/)) && m === 'DELETE') {
      const id = decodeURIComponent(mm[1]); const parsed = parseSiotId(id);
      if (!parsed || !this.registry.get(parsed.deviceId)) return this.#json(res, 404, { ok: false, error: '기기를 찾을 수 없습니다.' });
      await this.pairing.remove(parsed.deviceId);
      this.broadcastEvent('device_removed', { id, deviceId: parsed.deviceId });
      return this.#json(res, 200, { ok: true, removed: id });
    }
    if ((mm = sub.match(/^devices\/([^/]+)\/commissioning-window$/)) && m === 'POST') {
      const parsed = parseSiotId(decodeURIComponent(mm[1]));
      if (!parsed || !this.registry.get(parsed.deviceId)) return this.#json(res, 404, { ok: false, error: '기기를 찾을 수 없습니다.' });
      const body = (await this.#body(req)) ?? {};
      const r = await this.pairing.openWindow(parsed.deviceId, Number(body.timeout ?? 300));
      return this.#json(res, 200, { ok: true, ...r });
    }
    if ((mm = sub.match(/^devices\/([^/]+)\/control$/)) && m === 'POST') {
      const id = decodeURIComponent(mm[1]);
      const body = await this.#body(req);
      if (!body) return this.#json(res, 400, { ok: false, error: 'JSON 본문이 필요합니다. 예: {"action":"ON"}' });
      if (typeof body.action !== 'string') return this.#json(res, 400, { ok: false, error: 'action(문자열)이 필요합니다.', supported: SUPPORTED_ACTIONS });
      const parsed = parseSiotId(id); const dev = parsed && this.registry.get(parsed.deviceId);
      if (!dev) return this.#json(res, 404, { ok: false, error: '기기를 찾을 수 없습니다.' });
      const cmd = resolveAction(body.action);
      if (!cmd) return this.#json(res, 400, { ok: false, error: `지원하지 않는 action: ${body.action}`, supported: SUPPORTED_ACTIONS });
      try {
        await this.execute({ deviceId: parsed.deviceId, endpoint: parsed.endpoint, capability: cmd.capability, action: cmd.action });
        // 낙관적 반영: Matter 구독 보고가 곧 도착하지만, 응답에는 기대 상태를 먼저 담는다
        const device = this.findSiotDevice(id);
        if (device && 'switch' in device.data && cmd.action !== 'toggle') device.data.switch = cmd.action === 'on';
        return this.#json(res, 200, { ok: true, action: body.action, service: cmd.service, device });
      } catch (e) { return this.#json(res, 502, { ok: false, error: e.message }); }
    }
    return this.#json(res, 404, { ok: false, error: 'not found' });
  }

  async #claim(req, res) {
    const body = await this.#body(req);
    if (!body) return this.#json(res, 400, { ok: false, error: 'JSON 본문이 필요합니다.' });
    if (typeof body.registrationCode !== 'string') return this.#json(res, 400, { ok: false, error: 'registrationCode(문자열)가 필요합니다.' });
    const s = await this.store.load(); const nowIso = new Date().toISOString();
    const valid = isCodeValid(s.registrationCode ?? null, s.codeExpiresAt ?? null, nowIso) && s.registrationCode === body.registrationCode;
    if (!valid) return this.#json(res, 400, { ok: false, error: '유효하지 않거나 만료된 등록 코드입니다.' });
    const token = randomBytes(32).toString('hex');
    await this.store.save({ gatewayToken: token, registeredAt: nowIso, registrationCode: null, codeExpiresAt: null });
    log.info('gateway claimed by platform');
    this.onClaimed?.(token);
    return this.#json(res, 200, { ok: true, gatewayId: await this.identity.gatewayId(), gatewayToken: token });
  }

  async #register(res) {
    const code = generateCode(); const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    await this.store.save({ registrationCode: code, codeExpiresAt: expiresAt });
    return this.#json(res, 200, { ok: true, gatewayId: await this.identity.gatewayId(), registrationCode: code, expiresAt, note: '이 코드를 시옷플랫폼에 입력해 연결하세요. 10분 내 유효.' });
  }

  #sse(req, res, kind) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    const c = { res, kind };
    this.sse.add(c);
    const ping = setInterval(() => this.#write(c, ': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); this.sse.delete(c); });
  }

  async #static(res, name, type) {
    try { const buf = await readFile(path.join(STATIC_DIR, name)); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(buf); }
    catch { this.#json(res, 404, { ok: false, error: 'not found' }); }
  }
  #json(res, status, obj) { const body = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); res.end(body); }
  #body(req) {
    return new Promise((resolve) => {
      let data = ''; req.setEncoding('utf8');
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }
}

/** 레지스트리 변화를 SiotDevice 이벤트로 흘린다 */
function registryHook(server) {
  const push = (d) => { for (const s of toSiotDevices(d)) server.broadcastDevice(s); };
  server.registry.on('device.added', push);
  server.registry.on('device.updated', push);
  server.registry.on('state', (c) => { const d = server.registry.get(c.deviceId); if (!d) return; for (const s of toSiotDevices(d)) if (parseSiotId(s.id).endpoint === c.endpoint) { s.lastUpdated = new Date(c.at).toISOString(); server.broadcastDevice(s); } });
  server.registry.on('device.removed', (id) => server.broadcastEvent('device_removed', { deviceId: id }));
}
