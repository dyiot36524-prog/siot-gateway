// OTBR REST(기본 8081)에서 활성 Thread 데이터셋을 읽어 Matter 컨트롤러에 자동 등록한다.
// 사람이 `cli dataset <hex>` 를 칠 필요가 없게 하는 것이 목적(AC-3).
import { logger } from '../log.js';
const log = logger('otbr');

export async function fetchActiveDataset(restUrl) {
  const r = await fetch(`${restUrl}/node/dataset/active`, { headers: { Accept: 'text/plain' } });
  if (r.status === 204) return null;                       // 데이터셋 없음(네트워크 미형성)
  if (!r.ok) throw new Error(`OTBR REST ${r.status}`);
  const text = (await r.text()).trim().replace(/^"|"$/g, '');
  return /^[0-9a-fA-F]+$/.test(text) ? text : null;
}

export async function fetchState(restUrl) {
  try { const r = await fetch(`${restUrl}/node/state`); return r.ok ? (await r.text()).trim().replace(/^"|"$/g, '') : null; } catch { return null; }
}

/** 데이터셋이 등록될 때까지 주기적으로 시도. 등록되면 true */
export function startDatasetSync({ restUrl, matter, pairing, intervalMs = 15000 }) {
  let timer = null, done = false;
  const tick = async () => {
    try {
      if (matter.serverInfo?.thread_credentials_set) { done = true; return; }
      const hex = await fetchActiveDataset(restUrl);
      if (!hex) { log.debug('OTBR 활성 데이터셋 없음 (네트워크 미형성?)'); return; }
      await pairing.setThreadDataset(hex);
      log.info(`Thread dataset registered from OTBR (${hex.length / 2} bytes)`);
      done = true;
    } catch (e) { log.debug(`dataset sync: ${e.message}`); }
    finally { if (!done) timer = setTimeout(tick, intervalMs); }
  };
  tick();
  return () => clearTimeout(timer);
}
