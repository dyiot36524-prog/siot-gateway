const $ = (id) => document.getElementById(id);
const j = (url, opt) => fetch(url, opt).then((r) => r.json());

async function loadSystem() {
  const s = await j('/api/system');
  $('gid').textContent = s.gatewayId ?? '-';
  $('ver').textContent = s.version ? 'v' + s.version : '';
  $('engine').textContent = s.engine ? `${s.engine.kind}/${s.engine.backend}${s.engineOnline ? '' : ' (오프라인)'}` : '-';
  $('thread').innerHTML = s.engine?.threadCredentialsSet ? '<span class="ok">등록됨</span>' : '<span class="bad">없음</span>';
  $('ble').innerHTML = s.engine?.bluetooth ? '<span class="ok">사용</span>' : '<span class="bad">꺼짐</span>';
  const g = await j('/api/gateway');
  $('reg').innerHTML = g.registered ? '<span class="ok">완료</span>' : '<span class="bad">미등록</span>';
  if (g.registrationCode) showCode(g.registrationCode, g.codeExpiresAt);
}
function showCode(code, exp) { $('codeBox').style.display = ''; $('code').textContent = code; $('codeExp').textContent = exp ? `만료 ${new Date(exp).toLocaleTimeString()}` : ''; }

$('btnRegister').onclick = async () => { const r = await j('/api/register', { method: 'POST' }); if (r.ok) showCode(r.registrationCode, r.expiresAt); };

$('btnPair').onclick = async () => {
  const code = $('pairCode').value.trim();
  if (!code) return;
  $('pairLog').textContent = ''; $('pairStatus').textContent = '요청 중...';
  const r = await j('/api/pairing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!r.ok) { $('pairStatus').innerHTML = `<span class="bad">${r.error}</span>`; return; }
  $('pairStatus').textContent = `세션 ${r.session.sessionId.slice(0, 8)} 시작`;
};

async function loadDevices() {
  const r = await j('/api/devices');
  $('count').textContent = `(${r.count})`;
  const ul = $('devices'); ul.innerHTML = '';
  for (const d of r.devices) ul.appendChild(renderDevice(d));
}
function renderDevice(d) {
  const li = document.createElement('li'); li.id = 'dev-' + CSS.escape(d.id);
  const data = Object.entries(d.data).map(([k, v]) => `${k}=${v}`).join(' · ');
  const ctl = ('switch' in d.data) ? `<button class="secondary" data-id="${d.id}" data-action="ON">켜기</button> <button class="secondary" data-id="${d.id}" data-action="OFF">끄기</button>` : '';
  li.innerHTML = `<div class="row"><strong>${d.name}</strong><span class="pill">${d.deviceType}</span><span class="muted">${d.online ? '' : '오프라인'}</span></div>
    <div class="muted">${d.id} · ${data}</div>
    <div class="row" style="margin-top:6px">${ctl}<button class="danger" data-id="${d.id}" data-action="REMOVE">제거</button></div>`;
  li.querySelectorAll('button').forEach((b) => b.onclick = async () => {
    const id = encodeURIComponent(b.dataset.id);
    if (b.dataset.action === 'REMOVE') { if (confirm('기기를 제거할까요?')) await fetch(`/api/devices/${id}`, { method: 'DELETE' }); await loadDevices(); return; }
    await j(`/api/devices/${id}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: b.dataset.action }) });
  });
  return li;
}

const es = new EventSource('/api/stream');
es.onmessage = (ev) => { const d = JSON.parse(ev.data); const old = document.getElementById('dev-' + CSS.escape(d.id)); const li = renderDevice(d); if (old) old.replaceWith(li); else $('devices').appendChild(li); };
es.addEventListener('pairing', (ev) => { const p = JSON.parse(ev.data); $('pairLog').textContent += `${new Date().toLocaleTimeString()} ${p.stage}${p.error ? ' ' + p.error : ''}\n`; $('pairStatus').textContent = p.stage === 'done' ? '페어링 완료' : p.stage === 'failed' ? '페어링 실패' : `진행 중: ${p.stage}`; if (p.stage === 'done') loadDevices(); });
es.addEventListener('device_removed', () => loadDevices());

loadSystem(); loadDevices(); setInterval(loadSystem, 30000);
