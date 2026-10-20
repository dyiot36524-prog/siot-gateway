// state/health/health.json — 호스트 OTA 확인 조건이 토큰·인터넷 없이 읽는 파일(계획 §2 d). 10초마다 원자적(rename) 쓰기.
// 형태: {bootId, version, engineOnline, deviceCount, relay:{connected}, writtenAt}. relay 는 진단용(판정에 쓰지 않음).
import { writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('health');
export const HEALTH_INTERVAL_MS = 10_000;

export async function writeHealth(dir, h) {
  const body = { bootId: h.bootId, version: h.version, engineOnline: Boolean(h.engineOnline), deviceCount: Number(h.deviceCount) || 0, relay: { connected: Boolean(h.relay?.connected) }, writtenAt: new Date().toISOString() };
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.health.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(body) + '\n', 'utf8');
  await rename(tmp, path.join(dir, 'health.json'));
  return body;
}

/** collect() 결과를 주기적으로 기록한다. 중지 함수를 돌려준다 */
export function startHealthWriter(dir, collect, intervalMs = HEALTH_INTERVAL_MS) {
  let warned = false;
  const tick = () => writeHealth(dir, collect()).then(() => { warned = false; }).catch((e) => { if (!warned) log.warn(`health.json 쓰기 실패: ${e.message}`); warned = true; });
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
