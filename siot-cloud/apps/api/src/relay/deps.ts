// 릴레이가 바깥(Step 1: cache·webhooks outbox·metrics·alerts)에 기대는 좁은 인터페이스.
// StateCache·prom-client Counter/Gauge 는 구조적으로 그대로 맞는다. 테스트는 인메모리 fake 를 넘긴다.
import type { CfgAckFrame, CfgFrame, EvtFrame, HelloFrame, SnapshotFrame } from '@siot/protocol';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';

/** StateCache 중 릴레이가 쓰는 부분. replay 규칙(중복·seq ≤ snapshot.seq·resync·epoch)은 cache 책임 */
export interface RelayCache {
  applySnapshot(gatewayId: string, frame: SnapshotFrame): Promise<unknown>;
  applyEvt(gatewayId: string, frame: EvtFrame): Promise<unknown>;
  setGatewayOnline(gatewayId: string, online: boolean, at?: Date): Promise<void>;
}

/** gateway.online / gateway.offline 웹훅 원천. 배포 직후 유예(90초)는 relay 가 deployedAt 으로 먼저 거른다 */
export interface RelayOutboxEvent {
  type: 'gateway.online' | 'gateway.offline';
  gatewayId: string;
  siteId: string | null;
  /** ISO 8601 */
  at: string;
  data?: Record<string, unknown>;
}
export interface RelayOutbox {
  enqueue(orgId: string, event: RelayOutboxEvent): Promise<void> | void;
}

export interface RelayMetrics {
  relayReconnects: { inc(n?: number): void };
  heartbeatTimeouts: { inc(n?: number): void };
  gatewaysOnline: { set(n: number): void };
}

/** 운영 경보(같은 key 는 수신 쪽이 30분 중복 억제) */
export interface RelayAlerts {
  notify(key: string, message: string, data?: Record<string, unknown>): Promise<void> | void;
}

export type GatewayStatus = 'unbound' | 'bound' | 'site_reset_pending' | 'factory_reset_pending';

/** 릴레이가 보는 gateways 행 */
export interface GatewayRecord {
  gatewayId: string;
  orgId: string;
  siteId: string | null;
  status: GatewayStatus;
  /** Ed25519 raw 공개키 base64url(43자). 빈 값이면 미등록 */
  pubkey: string;
  /** gatewayToken SHA-256 hex */
  tokenHash: string | null;
  cfgVersion: number;
}

export type CfgBody = Omit<CfgFrame, 't'>;

/**
 * 릴레이의 DB 접근 전부. 기본 구현은 drizzle(src/relay/repo.ts), 테스트는 인메모리.
 */
export interface GatewayRepo {
  get(gatewayId: string): Promise<GatewayRecord | null>;
  /** 인증된 연결 시작: online=true, lastSeen, bootId, 버전, 보고 cfgVersion */
  markOnline(gatewayId: string, hello: HelloFrame, at: Date): Promise<void>;
  markOffline(gatewayId: string, at: Date): Promise<void>;
  /** cfg_ack 기록. site_reset_pending 이고 ack ≥ cfgVersion 이면 bound 로 */
  recordCfgAck(gatewayId: string, ack: CfgAckFrame): Promise<void>;
  /** bound 수신 기록(감사 로그) */
  recordBound(gatewayId: string): Promise<void>;
  /**
   * bind 유실 재발급: 옛 해시를 즉시 새 해시로 교체하고 감사 로그를 남긴다.
   * @returns 이번 것을 포함한 최근 24시간 재발급 횟수
   */
  reissueToken(gatewayId: string, newTokenHash: string, at: Date): Promise<{ recentCount: number }>;
  /** 현재 cfgVersion 의 cfg 본문. 세대가 없거나 키가 없으면 null */
  buildCfg(gatewayId: string): Promise<CfgBody | null>;
}

export interface RelayTiming {
  heartbeatSec: number;
  deadSec: number;
  /** challenge 후 hello 대기 */
  helloTimeoutMs: number;
  /** cfg 송신 후 cfg_ack 대기(초과 시 끊음) */
  cfgAckTimeoutMs: number;
  /** cfg_ack 전 보류 최대 건수(초과 시 끊음) */
  pendingMax: number;
  /** evt 누적 ack: 이 건수마다 즉시 */
  ackEvery: number;
  /** evt 누적 ack: 마지막 ack 후 이 시간 안에 */
  ackIntervalMs: number;
  /** 하트비트 검사 주기 */
  tickMs: number;
  /** sendBind 의 bound 대기 */
  bindTimeoutMs: number;
  /** 배포(프로세스 시작) 후 gateway.offline 을 내지 않는 창 */
  offlineGraceMs: number;
  /** 24h 안 재발급이 이 횟수를 넘으면 경보 */
  reissueAlertThreshold: number;
}

export interface RelayDeps {
  /** repo 를 안 넘기면 db 로 drizzle repo 를 만든다 */
  db?: Db;
  /** 세대 키 복호화(cfg.keys)에 DATA_ENC_KEY 가 필요 */
  config?: Pick<Config, 'DATA_ENC_KEY'>;
  repo?: GatewayRepo;
  cache: RelayCache;
  outbox?: RelayOutbox;
  metrics?: RelayMetrics;
  alerts?: RelayAlerts;
  /** 이 시각 + offlineGraceMs 안의 offline 은 outbox 에 넣지 않는다. 기본: registerRelay 호출 시각 */
  deployedAt?: Date;
  timing?: Partial<RelayTiming>;
}
