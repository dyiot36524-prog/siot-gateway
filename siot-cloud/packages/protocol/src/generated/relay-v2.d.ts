/* 자동 생성 파일 — 직접 고치지 말 것. 원본: packages/protocol/schema/relay-v2.json, 생성: npm run gen */

import type { SiotDevice } from './siot-device.js';

/**
 * 시옷 클라우드 ↔ 게이트웨이 WebSocket 릴레이 proto 2 (계획 §2 b, B1). 모든 프레임은 {t:"<type>", ...} JSON 텍스트 메시지. 방향은 각 정의의 x-direction(server_to_gateway | gateway_to_server | both). 생산자는 스키마를 엄격히 지키고(additionalProperties:false), 수신자는 모르는 필드를 무시한다. 접속: wss://siot-cloud.fly.dev/gateway, 헤더 X-Siot-Gateway-Id + (바인딩 후) Authorization: Bearer <gatewayToken>. 쿼리 토큰 4401, 미등록 키 4403.
 */
export type RelayV2Frame = ServerToGatewayFrame | GatewayToServerFrame;
export type ServerToGatewayFrame =
  ChallengeFrame | WelcomeFrame | BindFrame | CfgFrame | AckFrame | ReqFrame | PingFrame | PongFrame;
/**
 * ISO 8601 (new Date().toISOString())
 */
export type IsoTime = string;
/**
 * 서버가 발급하는 단조 증가 설정 버전. 미설정이면 0.
 */
export type CfgVersion = number;
/**
 * 'site_' + ULID
 */
export type SiteId = string;
export type GatewayId = string;
/**
 * 에이전트 프로세스 시작마다 새로 만드는 uuid v4. seq 는 bootId 마다 1부터.
 */
export type BootId = string;
export type Base64 = string;
export type GatewayToServerFrame =
  HelloFrame | BoundFrame | CfgAckFrame | SnapshotFrame | EvtFrame | ResFrame | PingFrame | PongFrame;
/**
 * 세대 키 버전. 미바인딩·미설정이면 0.
 */
export type KeyVersion = number;
/**
 * GW→서버 전용 이벤트. 키 (gatewayId, bootId, seq, sub=0).
 */
export type EvtFrame =
  | EvtDeviceFrame
  | EvtDeviceRemovedFrame
  | EvtGatewayFrame
  | EvtPairingFrame
  | EvtThreadFrame
  | EvtErrorFrame
  | EvtLogFrame;
export type EvtSeq = number;
export type PairingStage = 'queued' | 'thread_dataset' | 'commissioning' | 'interviewing' | 'done' | 'failed';

/**
 * 접속 직후 서버가 보낸다. GW 는 hello.sig 로 nonce 에 서명한다.
 */
export interface ChallengeFrame {
  t: 'challenge';
  nonce: string;
}
/**
 * hello 검증 후. cfgVersion 이 GW 보고값보다 크면 서버가 곧바로 cfg 를 보낸다.
 */
export interface WelcomeFrame {
  t: 'welcome';
  serverTime: IsoTime;
  heartbeatSec: number;
  deadSec: number;
  cfgVersion: CfgVersion;
}
/**
 * claim 직후(또는 bind 유실 재발급 시) 미바인딩 연결로 전달. GW 는 토큰 저장 → bound 응답 → 토큰으로 재접속.
 */
export interface BindFrame {
  t: 'bind';
  gatewayToken: string;
  siteId: SiteId;
}
/**
 * 버전이 붙은 멱등 설정. GW 는 keys 목록에 있는 버전만 허용하고 시각으로 키 만료를 판단하지 않는다. 적용 후 cfg_ack.
 */
export interface CfgFrame {
  t: 'cfg';
  cfgVersion: number;
  siteId: SiteId;
  /**
   * @minItems 1
   */
  keys: [SiteKey, ...SiteKey[]];
  peers: Peer[];
  rules: Rules;
  thread?: ThreadCfg;
}
export interface SiteKey {
  v: number;
  /**
   * 세대 키 32바이트 base64url(패딩 없음)
   */
  key: string;
}
export interface Peer {
  gatewayId: GatewayId;
  /**
   * LAN 주소(IPv4/IPv6, 포트 3443/tcp 고정)
   */
  lan: string[];
  /**
   * Thread ML-EID IPv6 주소. 아직 모르면 null
   */
  mleid: string | null;
}
export interface Rules {
  version: number;
  rules: {}[];
}
/**
 * M2 부터. M1 cfg 에는 없다.
 */
export interface ThreadCfg {
  mode: 'adopt' | 'form' | 'join' | 'wait';
  datasetRef?: string;
}
/**
 * evt 누적 확인. 같은 bootId 의 seq ≤ upTo 는 링버퍼에서 지워도 된다.
 */
export interface AckFrame {
  t: 'ack';
  bootId: BootId;
  upTo: number;
}
/**
 * 명령(제어·페어링·thread join·로그·OTA·공장초기화). GW 가 loopback 로컬 API 로 프록시하고 res 로 응답. 기존 req/res(relay.js) 와 호환.
 */
export interface ReqFrame {
  t: 'req';
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  path: string;
  headers?: StringMap;
  body?: Base64;
  /**
   * 로컬 프록시 타임아웃. 없으면 GW 기본값
   */
  timeoutMs?: number;
}
export interface StringMap {
  [k: string]: string | undefined;
}
/**
 * 하트비트. 양방향 10초 주기, 25초 동안 프레임이 없으면 끊는다(monotonic 시계).
 */
export interface PingFrame {
  t: 'ping';
}
/**
 * ping 응답.
 */
export interface PongFrame {
  t: 'pong';
}
/**
 * 접속 인증. sig = Ed25519(UTF-8(challenge.nonce)) 의 base64url. pubKey = Ed25519 raw 공개키 32바이트 base64url. 서버는 사전 등록된 공개키만 받는다(미등록 4403).
 */
export interface HelloFrame {
  t: 'hello';
  proto: 2;
  gatewayId: GatewayId;
  bootId: BootId;
  agentVersion: string;
  matterServerVersion: string | null;
  startedAt: IsoTime;
  /**
   * GW 벽시계 ISO 8601(시계 오프셋 보정용)
   */
  clock: string;
  cfgVersion: CfgVersion;
  keyVersion: KeyVersion;
  /**
   * Ed25519 raw 공개키 32바이트 base64url
   */
  pubKey: string;
  /**
   * Ed25519(UTF-8(challenge.nonce)) 서명 64바이트 base64url
   */
  sig: string;
}
/**
 * bind 처리(토큰 저장) 완료.
 */
export interface BoundFrame {
  t: 'bound';
}
/**
 * cfg 적용 완료. cfg 를 보낸 연결은 이 ack 전 snapshot·evt 를 보류한다.
 */
export interface CfgAckFrame {
  t: 'cfg_ack';
  cfgVersion: CfgVersion;
  keyVersion: KeyVersion;
  rulesVersion: number;
}
/**
 * 연결마다 전체 재동기화. 항상 evt(replayed 포함)보다 먼저. seq = 그 시점 마지막 evt seq(없으면 0). keyVersion 은 site_epoch 귀속용.
 */
export interface SnapshotFrame {
  t: 'snapshot';
  bootId: BootId;
  seq: number;
  keyVersion: KeyVersion;
  gateway: GatewayStatus;
  devices: SiotDevice[];
}
/**
 * snapshot.gateway. 필수 4개 외 진단 필드는 자유(matterServerVersion, startedAt, lastErrorCode, engine 등).
 */
export interface GatewayStatus {
  gatewayId: GatewayId;
  agentVersion: string;
  matterServerVersion?: string | null;
  engineOnline: boolean;
  deviceCount: number;
  startedAt?: IsoTime;
  lastErrorCode?: string | null;
  [k: string]: unknown | undefined;
}
/**
 * 기기 상태 변화. 바뀐 SiotDevice 전체 값.
 */
export interface EvtDeviceFrame {
  t: 'evt';
  bootId: BootId;
  seq: EvtSeq;
  keyVersion: KeyVersion;
  kind: 'device';
  at: IsoTime;
  data: {
    /**
     * @minItems 1
     */
    devices: [SiotDevice, ...SiotDevice[]];
  };
  /**
   * 링버퍼 재전송분이면 true(재전송일 때만 포함). seq ≤ 직전 snapshot.seq 이면 백엔드는 캐시에 반영하지 않는다.
   */
  replayed?: boolean;
}
/**
 * 기기(노드) 제거.
 */
export interface EvtDeviceRemovedFrame {
  t: 'evt';
  bootId: BootId;
  seq: EvtSeq;
  keyVersion: KeyVersion;
  kind: 'device_removed';
  at: IsoTime;
  data: {
    /**
     * 노드 id(예: matter:5)
     */
    deviceId?: string;
    /**
     * 제거된 SiotDevice.id(localId) 목록
     *
     * @minItems 1
     */
    ids: [string, ...string[]];
  };
  /**
   * 링버퍼 재전송분이면 true(재전송일 때만 포함). seq ≤ 직전 snapshot.seq 이면 백엔드는 캐시에 반영하지 않는다.
   */
  replayed?: boolean;
}
/**
 * 게이트웨이 상태.
 */
export interface EvtGatewayFrame {
  t: 'evt';
  bootId: BootId;
  seq: EvtSeq;
  keyVersion: KeyVersion;
  kind: 'gateway';
  at: IsoTime;
  /**
   * 게이트웨이 상태 변화(engineOnline, OTA 결과 등). 자유 객체.
   */
  data: {};
  /**
   * 링버퍼 재전송분이면 true(재전송일 때만 포함). seq ≤ 직전 snapshot.seq 이면 백엔드는 캐시에 반영하지 않는다.
   */
  replayed?: boolean;
}
/**
 * 페어링 진행.
 */
export interface EvtPairingFrame {
  t: 'evt';
  bootId: BootId;
  seq: EvtSeq;
  keyVersion: KeyVersion;
  kind: 'pairing';
  at: IsoTime;
  data: {
    sessionId: string;
    stage: PairingStage;
    errorCode?: string | null;
    error?: string | null;
    deviceId?: string | null;
    devices?: SiotDevice[];
  };
  /**
   * 링버퍼 재전송분이면 true(재전송일 때만 포함). seq ≤ 직전 snapshot.seq 이면 백엔드는 캐시에 반영하지 않는다.
   */
  replayed?: boolean;
}
/**
 * Thread 상태.
 */
export interface EvtThreadFrame {
  t: 'evt';
  bootId: BootId;
  seq: EvtSeq;
  keyVersion: KeyVersion;
  kind: 'thread';
  at: IsoTime;
  /**
   * Thread 상태(M2). 자유 객체.
   */
  data: {};
  /**
   * 링버퍼 재전송분이면 true(재전송일 때만 포함). seq ≤ 직전 snapshot.seq 이면 백엔드는 캐시에 반영하지 않는다.
   */
  replayed?: boolean;
}
/**
 * 오류.
 */
export interface EvtErrorFrame {
  t: 'evt';
  bootId: BootId;
  seq: EvtSeq;
  keyVersion: KeyVersion;
  kind: 'error';
  at: IsoTime;
  /**
   * 오류 보고. 자유 객체(code, message 권장).
   */
  data: {};
  /**
   * 링버퍼 재전송분이면 true(재전송일 때만 포함). seq ≤ 직전 snapshot.seq 이면 백엔드는 캐시에 반영하지 않는다.
   */
  replayed?: boolean;
}
/**
 * 로그.
 */
export interface EvtLogFrame {
  t: 'evt';
  bootId: BootId;
  seq: EvtSeq;
  keyVersion: KeyVersion;
  kind: 'log';
  at: IsoTime;
  /**
   * 로그. 자유 객체(level, msg 권장).
   */
  data: {};
  /**
   * 링버퍼 재전송분이면 true(재전송일 때만 포함). seq ≤ 직전 snapshot.seq 이면 백엔드는 캐시에 반영하지 않는다.
   */
  replayed?: boolean;
}
/**
 * req 응답. 로컬 프록시 실패는 status 502.
 */
export interface ResFrame {
  t: 'res';
  id: string;
  status: number;
  headers?: StringMap;
  body?: Base64;
}
