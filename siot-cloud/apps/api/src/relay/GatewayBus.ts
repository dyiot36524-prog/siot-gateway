// 릴레이 경계(계획 §2 a): 공개 API·앱 API·캐시는 이 인터페이스만 본다. 구현은 Step 2(src/relay/**).
// A2 전환(앱 분리) 시에도 이 인터페이스 뒤만 바뀐다.
import type { BindFrame, CfgFrame, EvtFrame, HelloFrame, ReqFrame, ResFrame, SnapshotFrame } from '@siot/protocol';

/** 서버가 보낼 req (id 는 버스가 붙인다) */
export type GatewayRequest = Omit<ReqFrame, 't' | 'id'>;
export type GatewayResponse = Omit<ResFrame, 't'>;

export class GatewayOfflineError extends Error {
  readonly code = 'GATEWAY_OFFLINE';
  constructor(readonly gatewayId: string) {
    super(`gateway ${gatewayId} is offline`);
  }
}
export class GatewayTimeoutError extends Error {
  readonly code = 'GATEWAY_TIMEOUT';
  constructor(readonly gatewayId: string, readonly timeoutMs: number) {
    super(`gateway ${gatewayId} did not respond in ${timeoutMs}ms`);
  }
}

export interface OnlineInfo {
  gatewayId: string;
  hello: HelloFrame;
  connectedAt: Date;
}
export interface OfflineInfo {
  gatewayId: string;
  /** 'closed' = WS 종료, 'heartbeat' = 25초 무응답, 'replaced' = 같은 GW 새 연결 */
  reason: 'closed' | 'heartbeat' | 'replaced';
  at: Date;
}

export type Unsubscribe = () => void;

export interface GatewayBus {
  /**
   * 로컬 API 호출을 req 프레임으로 보내고 res 를 기다린다.
   * 감지된 미연결이면 즉시 GatewayOfflineError, timeoutMs 안에 res 가 없으면 GatewayTimeoutError.
   * res 본문은 캐시에 쓰지 않는다(N1: 캐시 갱신 원천은 evt·snapshot 뿐).
   */
  request(gatewayId: string, req: GatewayRequest, timeoutMs: number): Promise<GatewayResponse>;
  /** 하트비트로 감지된 연결 상태(반열림 최대 25초는 true 로 보일 수 있음) */
  isOnline(gatewayId: string): boolean;
  /** 접속 중이면 cfg 를 보내고 true. 아니면 false(다음 접속 시 welcome.cfgVersion 비교로 재전송) */
  sendCfg(gatewayId: string, cfg: Omit<CfgFrame, 't'>): Promise<boolean>;
  /** 미바인딩 연결로 bind 를 보낸다. bound 수신 시 resolve, 접속 없음·타임아웃이면 false */
  sendBind(gatewayId: string, bind: Omit<BindFrame, 't'>): Promise<boolean>;

  /** 연결마다 1회, 항상 그 연결의 evt 보다 먼저(cfg_ack 대기 보류 해제 후) */
  onSnapshot(handler: (gatewayId: string, frame: SnapshotFrame) => void | Promise<void>): Unsubscribe;
  /** 중복 제거 전 원본 evt. 중복 제거·replay 규칙은 StateCache 가 적용 */
  onEvt(handler: (gatewayId: string, frame: EvtFrame) => void | Promise<void>): Unsubscribe;
  onOnline(handler: (info: OnlineInfo) => void | Promise<void>): Unsubscribe;
  onOffline(handler: (info: OfflineInfo) => void | Promise<void>): Unsubscribe;
}
