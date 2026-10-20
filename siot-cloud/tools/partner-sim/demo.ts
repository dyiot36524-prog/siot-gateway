// A3 시연(계획 §3 A3): API 키 1개로 두 세대 기기 나열 → 세대마다 플러그 ON→OFF confirmed → 도어 10회 열고 닫기(20 이벤트) 지연 판정.
//   SIOT_API=https://siot-cloud.fly.dev SIOT_API_KEY=sk_... PARTNER_SIM=http://localhost:8787 \
//   CLOCK_OFFSET_MS=0 DOOR_EVENTS=20 npm run demo:partner -w tools/partner-sim
// partner-sim 은 웹훅 수신 URL(https 터널 등)로 등록돼 있어야 한다. 도어 판정 ①: (partner-sim 수신 − GW Matter 보고 시각 data.at − 시계 오프셋) ≤ 2.5초 20/20.
// CLOCK_OFFSET_MS = GW 시계 − 서버 시계(hello.clock 기준, 운영 로그의 relay welcome 줄에서 읽는다).
const API = (process.env.SIOT_API ?? 'https://siot-cloud.fly.dev').replace(/\/$/, '');
const KEY = process.env.SIOT_API_KEY ?? '';
const SIM = (process.env.PARTNER_SIM ?? 'http://localhost:8787').replace(/\/$/, '');
const OFFSET = Number(process.env.CLOCK_OFFSET_MS ?? 0);
const DOOR_EVENTS = Number(process.env.DOOR_EVENTS ?? 20);
const DOOR_BUDGET_MS = 2500;
const DOOR_WAIT_MS = Number(process.env.DOOR_WAIT_MS ?? 300_000);

interface Device {
  deviceId: string;
  siteId: string;
  name: string;
  deviceType: string;
  online: boolean;
  data: Record<string, unknown>;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await r.json()) as T;
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const p: { data: T[]; nextCursor: string | null } = await api('GET', `${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...p.data);
    cursor = p.nextCursor;
  } while (cursor);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  if (!KEY) throw new Error('SIOT_API_KEY 가 필요합니다');
  let ok = true;
  const sites = await all<{ siteId: string; name: string }>('/v1/sites');
  console.log(`세대 ${sites.length}개`);
  const doors: Device[] = [];
  for (const s of sites) {
    const devs = await all<Device>(`/v1/sites/${s.siteId}/devices`);
    console.log(`\n[${s.name}] ${s.siteId}`);
    for (const d of devs) console.log(`  ${d.deviceId} ${d.deviceType.padEnd(13)} ${d.online ? 'online ' : 'offline'} ${d.name} ${JSON.stringify(d.data)}`);
    doors.push(...devs.filter((d) => d.deviceType === 'BINARY_SENSOR' && d.data.measurement === 'door'));
    const plug = devs.find((d) => d.deviceType === 'PLUG');
    if (!plug) {
      console.log('  플러그 없음 — 제어 건너뜀');
      ok = false;
      continue;
    }
    for (const action of ['ON', 'OFF'] as const) {
      const r = await api<{ status: string; latencyMs: number; reason?: string }>('POST', `/v1/devices/${plug.deviceId}/control`, { action });
      console.log(`  ${plug.name} ${action} → ${r.status} ${r.latencyMs}ms${r.reason ? ` (${r.reason})` : ''}`);
      if (r.status !== 'confirmed') ok = false;
      await sleep(300);
    }
  }
  if (sites.length < 2) {
    console.log('\n세대가 2개 미만입니다(A3 은 S1·S2 두 세대)');
    ok = false;
  }

  if (!doors.length) {
    console.log('\n도어 센서가 없어 도어 판정을 건너뜁니다');
    return ok ? 0 : 1;
  }
  const doorIds = new Set(doors.map((d) => d.deviceId));
  const base = ((await (await fetch(`${SIM}/events.json`)).json()) as { n: number }[]).at(-1)?.n ?? 0;
  console.log(`\n도어(${doors.map((d) => d.name).join(', ')})를 ${DOOR_EVENTS / 2}회 열고 닫으세요. ${DOOR_WAIT_MS / 1000}초 동안 기다립니다…`);
  const got: { eventId: string; ms: number }[] = [];
  const end = Date.now() + DOOR_WAIT_MS;
  while (got.length < DOOR_EVENTS && Date.now() < end) {
    await sleep(500);
    const recs = (await (await fetch(`${SIM}/events.json?since=${base}`)).json()) as {
      eventId: string;
      type: string;
      dup: boolean;
      status: number;
      recvAtMs: number;
      body: { data?: { at?: string; source?: string; device?: { deviceId: string } } };
    }[];
    for (const r of recs) {
      if (r.type !== 'device.state_changed' || r.status !== 200 || r.dup) continue;
      if (!r.body.data?.device || !doorIds.has(r.body.data.device.deviceId) || r.body.data.source !== 'event') continue;
      if (got.some((g) => g.eventId === r.eventId)) continue;
      const ms = r.recvAtMs - (Date.parse(r.body.data.at ?? '') - OFFSET);
      got.push({ eventId: r.eventId, ms });
      console.log(`  #${got.length} ${ms}ms ${ms <= DOOR_BUDGET_MS ? 'OK' : '초과'}`);
    }
  }
  const pass = got.filter((g) => g.ms <= DOOR_BUDGET_MS).length;
  const sorted = got.map((g) => g.ms).sort((a, b) => a - b);
  console.log(`\n도어 ${pass}/${DOOR_EVENTS} ≤ ${DOOR_BUDGET_MS}ms (p50 ${sorted[Math.floor(sorted.length / 2)] ?? '-'}ms, max ${sorted.at(-1) ?? '-'}ms)`);
  if (got.length < DOOR_EVENTS || pass < DOOR_EVENTS) ok = false;
  console.log(ok ? '\nA3 통과' : '\nA3 실패');
  return ok ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
