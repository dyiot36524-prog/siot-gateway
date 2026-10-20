// 출고 모드 상태 페이지: /healthz 와 축소된 /api/gateway 만 읽는다(다른 API 는 LAN 에서 404).
const $ = (id) => document.getElementById(id);
async function load() {
  try { const h = await fetch('/healthz').then((r) => r.json()); $('health').innerHTML = h.ok ? '<span class="ok">정상</span>' : '<span class="bad">이상</span>'; }
  catch { $('health').innerHTML = '<span class="bad">응답 없음</span>'; }
  try {
    const g = await fetch('/api/gateway').then((r) => r.json());
    $('ver').textContent = g.version ? 'v' + g.version : '';
    $('short').textContent = g.shortId ?? '-';
    $('gid').textContent = g.gatewayId ?? '-';
    $('bound').innerHTML = g.bound ? '<span class="ok">연결됨</span>' : '<span class="bad">미연결</span>';
  } catch { /* 다음 주기에 재시도 */ }
}
load(); setInterval(load, 15000);
