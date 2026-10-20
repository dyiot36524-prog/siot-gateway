// 상태 캐시(계획 Step 1-3, C2): 인메모리 + Postgres write-through. 조회 API 는 캐시만 본다.
//
// replay 규칙(§2 b):
// - 이벤트 키 (gatewayId, bootId, seq, sub). 실제 evt 는 sub=0, events 테이블 유니크 키. 중복은 무시.
// - seq 는 bootId 마다 1부터. 연결마다 snapshot 이 evt 보다 먼저 온다.
// - 같은 bootId 에서 seq ≤ 마지막 snapshot.seq 인 evt 는 캐시에 반영하지 않는다(snapshot 이 더 새롭다).
//   단 events·웹훅 outbox 에는 미기록분이면 replayed:true 로 넣는다.
// - snapshot.bootId 가 이전과 다르면(재시작으로 링버퍼 소실) 이전 캐시와 snapshot 의 차이를
//   device.state_changed {source:"resync"} 로 합성한다. 키 (gatewayId, snapshot.bootId, snapshot.seq, sub=1..k),
//   sub 는 deviceId 정렬 순번. 같은 snapshot 재전송은 같은 키라 중복 제거된다.
// - keyVersion → site_keys.epoch 로 events.site_epoch 귀속. 옛 keyVersion 의 replay 는 옛 epoch 에 귀속.
// - 캐시 갱신 원천은 evt·snapshot 뿐. 제어 res 본문(낙관적 device)은 쓰지 않는다(N1).
// - 게이트웨이 offline 이면 조회 결과의 기기 online 은 false.
// - 백엔드 재기동 직후 모든 GW 는 offline 으로 시작한다(relay 가 접속을 확인하면 setGatewayOnline(true)).
import type { EvtFrame, EvtPairingFrame, PublicDevice, SnapshotFrame } from '@siot/protocol';

export interface ApplyResult {
  /** 캐시가 실제로 바뀐 기기 */
  changed: PublicDevice[];
  /** 새로 기록된 이벤트 수(중복 제외) */
  recorded: number;
  /** seq ≤ snapshot.seq 라 캐시 반영을 건너뛴 경우 true */
  stale: boolean;
}

export type DeviceListener = (device: PublicDevice, source: 'event' | 'resync' | 'gateway') => void;

export type GatewayStatusValue = 'unbound' | 'bound' | 'site_reset_pending' | 'factory_reset_pending';

/** 캐시가 들고 있는 게이트웨이 상태(조회 API 용) */
export interface GatewayView {
  gatewayId: string;
  shortId: string;
  orgId: string;
  siteId: string | null;
  status: GatewayStatusValue;
  online: boolean;
  lastSeenAt: Date | null;
  agentVersion: string | null;
  matterServerVersion: string | null;
  lastErrorCode: string | null;
  deviceCount: number;
  claimWindowUntil: Date | null;
  bootId: string | null;
  keyVersion: number;
}

export interface DeviceRef {
  deviceId: string;
  gatewayId: string;
  localId: string;
  siteId: string | null;
}

/** SSE·페어링 큐용 캐시 이벤트 */
export type CacheEvent =
  | { type: 'device'; siteId: string; device: PublicDevice; source: 'event' | 'resync' | 'gateway' }
  | { type: 'device_removed'; siteId: string | null; gatewayId: string; deviceId: string }
  | { type: 'gateway'; siteId: string | null; gateway: GatewayView }
  | { type: 'pairing'; siteId: string | null; gatewayId: string; frame: EvtPairingFrame; deviceIds: string[] };

export interface StateCache {
  getDevice(deviceId: string): PublicDevice | undefined;
  /** (gatewayId, localId) → 캐시 기기. 제어 로직의 before 스냅샷용 */
  getDeviceByLocal(gatewayId: string, localId: string): PublicDevice | undefined;
  getSiteDevices(siteId: string): PublicDevice[];
  applySnapshot(gatewayId: string, frame: SnapshotFrame): Promise<ApplyResult>;
  applyEvt(gatewayId: string, frame: EvtFrame): Promise<ApplyResult>;
  setGatewayOnline(gatewayId: string, online: boolean, at?: Date): Promise<void>;
  isGatewayOnline(gatewayId: string): boolean;
  /** 캐시 변화 구독(제어 확정 대기자·SSE). 반환값은 구독 해제 */
  subscribe(listener: DeviceListener): () => void;

  // ---- Step 1 추가 ----
  /** deviceId → (gatewayId, localId). 제거된 기기는 undefined */
  resolveDevice(deviceId: string): DeviceRef | undefined;
  getGateway(gatewayId: string): GatewayView | undefined;
  getSiteGateways(siteId: string): GatewayView[];
  /** claim·세대 초기화 등 DB 에서 바뀐 gateways 행(siteId/status/orgId)을 다시 읽는다 */
  reloadGateway(gatewayId: string): Promise<void>;
  /** 이름·위치 변경(클라우드 소유 필드. GW 이름은 최초 등록 때만 쓴다) */
  updateDeviceMeta(deviceId: string, patch: { name?: string; room?: string | null }): Promise<PublicDevice | undefined>;
  subscribeEvents(listener: (ev: CacheEvent) => void): () => void;
}
