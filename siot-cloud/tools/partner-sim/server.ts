// 파트너 웹훅 수신 시뮬레이터(계획 Step 1-8, A2·A3).
//   PORT=8787 SECRET=whsec_... FAIL_FIRST=2 npm start -w tools/partner-sim
// - POST /hook : Siot-Signature 검증(허용 오차 300초), eventId 중복 표시, 처음 FAIL_FIRST 회는 500
// - GET  /     : 큰 글씨 시각 표시(도어 열림/닫힘, 수신 시각 ms) — 60fps 영상 측정(A3 ②)용
// - GET  /events.json?since=<n> : 수신 기록(demo.ts 가 지연 판정에 사용)
// - GET  /stream : 화면용 SSE
// 수신마다 stdout 에 JSON 한 줄: {recvAt, eventId, type, sigOk, dup, attempt, latencyMs:{fromCreated, fromGatewayAt}}
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.SECRET ?? process.env.WEBHOOK_SECRET ?? '';
const FAIL_FIRST = Number(process.env.FAIL_FIRST ?? 0);
const TOLERANCE_SEC = 300;

export interface Received {
  n: number;
  recvAt: string;
  recvAtMs: number;
  eventId: string;
  type: string;
  sigOk: boolean;
  dup: boolean;
  status: number;
  latencyMs: { fromCreated: number | null; fromGatewayAt: number | null };
  body: Record<string, unknown>;
}

export function verify(secret: string, raw: string, header: string | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m || !secret) return false;
  if (Math.abs(nowSec - Number(m[1])) > TOLERANCE_SEC) return false;
  const exp = createHmac('sha256', secret).update(`${m[1]}.${raw}`, 'utf8').digest();
  return timingSafeEqual(exp, Buffer.from(m[2]!, 'hex'));
}

const log: Received[] = [];
const seen = new Set<string>();
const viewers = new Set<ServerResponse>();
let posts = 0;

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>partner-sim</title><style>
:root{color-scheme:light dark}body{margin:0;font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh}
#state{font-size:22vw;font-weight:800;line-height:1}#state.open{color:#ff5252}#state.closed{color:#69f0ae}
#meta{font:600 4vw ui-monospace,monospace;margin-top:2vh}#log{font:14px ui-monospace,monospace;opacity:.7;margin-top:3vh;max-width:95vw;white-space:pre-wrap}
</style></head><body><div id="state">대기</div><div id="meta">-</div><div id="log"></div>
<script>
const s=document.getElementById('state'),m=document.getElementById('meta'),l=document.getElementById('log');
const es=new EventSource('/stream');
es.onmessage=(e)=>{const r=JSON.parse(e.data);const d=r.body&&r.body.data&&r.body.data.device;
 if(d&&d.data&&d.data.measurement==='door'){const open=d.data.active===true;s.textContent=open?'열림':'닫힘';s.className=open?'open':'closed';}
 else{s.textContent=r.type;s.className='';}
 const t=new Date(performance.timeOrigin+performance.now());
 m.textContent=t.toISOString().slice(11,23)+'  #'+r.n+(r.latencyMs.fromGatewayAt!=null?'  Δ'+r.latencyMs.fromGatewayAt+'ms':'')+(r.sigOk?'':'  서명실패');
 l.textContent=(r.recvAt+' '+r.type+' '+r.eventId+(r.dup?' (중복)':'')+'\\n'+l.textContent).slice(0,2000);};
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  if (req.method === 'GET' && url.pathname === '/events.json') {
    const since = Number(url.searchParams.get('since') ?? 0);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(log.filter((r) => r.n > since)));
  }
  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    viewers.add(res);
    req.on('close', () => viewers.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/hook') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const recvAtMs = Date.now();
      posts++;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* 서명 실패로 기록 */
      }
      const eventId = String(body.eventId ?? req.headers['siot-event-id'] ?? '');
      const sigOk = verify(SECRET, raw, req.headers['siot-signature'] as string | undefined);
      const status = posts <= FAIL_FIRST ? 500 : sigOk ? 200 : 401;
      const dup = status === 200 && seen.has(eventId);
      if (status === 200) seen.add(eventId);
      const data = (body.data ?? {}) as { at?: string };
      const created = typeof body.createdAt === 'string' ? Date.parse(body.createdAt) : NaN;
      const gwAt = typeof data.at === 'string' ? Date.parse(data.at) : NaN;
      const r: Received = {
        n: log.length + 1,
        recvAt: new Date(recvAtMs).toISOString(),
        recvAtMs,
        eventId,
        type: String(body.type ?? ''),
        sigOk,
        dup,
        status,
        latencyMs: { fromCreated: Number.isNaN(created) ? null : recvAtMs - created, fromGatewayAt: Number.isNaN(gwAt) ? null : recvAtMs - gwAt },
        body,
      };
      log.push(r);
      if (log.length > 5000) log.shift();
      const { body: _b, ...line } = r;
      console.log(JSON.stringify(line));
      for (const v of viewers) v.write(`data: ${JSON.stringify(r)}\n\n`);
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 200 ? 'ok' : 'fail');
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.error(`partner-sim: http://localhost:${PORT}/ (POST /hook, FAIL_FIRST=${FAIL_FIRST}, secret ${SECRET ? '설정됨' : '없음 — 서명 검증 실패로 401'})`);
});
