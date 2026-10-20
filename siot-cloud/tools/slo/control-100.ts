// C3 ①② (계획 §3 C3): 공개 API 로 실기기 플러그(matter:5:1)를 제어해 확정률·지연을 잰다.
//   SIOT_API=https://siot-cloud.fly.dev SIOT_API_KEY=sk_... DEVICE_ID=dev_... npm run control-100 -w tools/slo
// ① ON/OFF 교대 100회 → confirmed 이고 ≤3초가 99회 이상
// ② 같은 명령 ON 연속 10회 → 10/10 confirmed ≤3초
// 기기당 제어 5 req/s 제한을 넘지 않게 요청 사이 GAP_MS(기본 400ms) 쉰다.
const API = (process.env.SIOT_API ?? 'https://siot-cloud.fly.dev').replace(/\/$/, '');
const KEY = process.env.SIOT_API_KEY ?? '';
const DEVICE = process.env.DEVICE_ID ?? process.argv[2] ?? '';
const N = Number(process.env.N ?? 100);
const GAP_MS = Number(process.env.GAP_MS ?? 400);
const BUDGET_MS = 3000;

interface Result {
  status: string;
  latencyMs: number;
  reason?: string;
}

async function control(action: 'ON' | 'OFF'): Promise<Result & { wallMs: number }> {
  const t0 = performance.now();
  const r = await fetch(`${API}/v1/devices/${DEVICE}/control`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const wallMs = Math.round(performance.now() - t0);
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, Number(r.headers.get('retry-after') ?? 1) * 1000));
    return control(action);
  }
  const j = (await r.json()) as Result;
  if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(j)}`);
  return { ...j, wallMs };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
};

async function run(label: string, actions: ('ON' | 'OFF')[], need: number): Promise<boolean> {
  const rs: (Result & { wallMs: number })[] = [];
  for (const [i, a] of actions.entries()) {
    const r = await control(a);
    rs.push(r);
    process.stdout.write(`${label} ${String(i + 1).padStart(3)} ${a.padEnd(3)} ${r.status.padEnd(9)} ${String(r.latencyMs).padStart(5)}ms (왕복 ${r.wallMs}ms)${r.reason ? ` ${r.reason}` : ''}\n`);
    await new Promise((res) => setTimeout(res, GAP_MS));
  }
  const good = rs.filter((r) => r.status === 'confirmed' && r.latencyMs <= BUDGET_MS).length;
  const lat = rs.map((r) => r.latencyMs);
  const byStatus = rs.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  console.log(`${label}: confirmed≤3s ${good}/${rs.length} (필요 ${need}) p50 ${pct(lat, 50)}ms p95 ${pct(lat, 95)}ms p99 ${pct(lat, 99)}ms ${JSON.stringify(byStatus)}`);
  return good >= need;
}

async function main(): Promise<number> {
  if (!KEY || !/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(DEVICE)) throw new Error('SIOT_API_KEY 와 DEVICE_ID(dev_ULID) 가 필요합니다');
  const one = await run('①', Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 'ON' : 'OFF')), Math.ceil(N * 0.99));
  const two = await run('②', Array.from({ length: 10 }, () => 'ON' as const), 10);
  console.log(one && two ? 'C3 ①② 통과' : 'C3 ①② 실패');
  return one && two ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
