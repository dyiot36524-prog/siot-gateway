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
import type { EvtFrame, PublicDevice, SnapshotFrame } from '@siot/protocol';

export interface ApplyResult {
  /** 캐시가 실제로 바뀐 기기 */
  changed: PublicDevice[];
  /** 새로 기록된 이벤트 수(중복 제외) */
  recorded: number;
  /** seq ≤ snapshot.seq 라 캐시 반영을 건너뛴 경우 true */
  stale: boolean;
}

export type DeviceListener = (device: PublicDevice, source: 'event' | 'resync' | 'gateway') => void;

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
}
