// MATTER_BACKEND=server  → matterjs-server WebSocket (기본, 선택지 B)
// MATTER_BACKEND=embedded → matter.js 라이브러리 직접 임베드 (선택지 C)
// MATTER_BACKEND=sim      → 가짜 백엔드(실기기 없음). SIM_DOOR_TOGGLE_MS 로 도어 이벤트 생성
import { config } from './config.js';
import { logger } from './log.js';

const log = logger('backend');

export async function createMatterBackend() {
  const kind = process.env.MATTER_BACKEND ?? 'server';
  if (kind === 'sim') {
    const { MatterSim } = await import('./matterSim.js');
    log.info('using simulated matter backend');
    return new MatterSim({ doorToggleMs: Number(process.env.SIM_DOOR_TOGGLE_MS ?? 0) });
  }
  if (kind === 'embedded') {
    const { MatterEmbedded } = await import('./embedded/matterEmbedded.js');
    log.info('using embedded matter.js controller');
    return new MatterEmbedded({
      dataDir: config.dataDir,
      ble: process.env.MATTER_BLE !== '0',
      hciId: process.env.MATTER_BLE_HCI !== undefined ? Number(process.env.MATTER_BLE_HCI) : undefined,
      netInterface: process.env.MATTER_INTERFACE,
      vendorId: process.env.MATTER_VENDOR_ID ? Number(process.env.MATTER_VENDOR_ID) : 0xfff1,
      fabricId: process.env.MATTER_FABRIC_ID ? Number(process.env.MATTER_FABRIC_ID) : 1,
      fabricLabel: process.env.MATTER_FABRIC_LABEL ?? 'Gateway PoC',
    });
  }
  const { MatterClient } = await import('./matterClient.js');
  log.info(`using matterjs-server at ${config.matterWsUrl}`);
  return new MatterClient(config.matterWsUrl);
}
