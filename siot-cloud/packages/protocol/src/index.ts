// @siot/protocol — 클라우드·게이트웨이·PWA 공용 계약.
// 스키마(JSON)가 원본이고 타입은 `npm run gen` 으로 생성한다(src/generated, 커밋 대상).
// 검증기는 소비자가 만든다: Ajv2020 + ajv-formats + addKeyword('x-direction') 후 schemas 를 모두 addSchema.
import relayV2 from '../schema/relay-v2.json' with { type: 'json' };
import peerV1 from '../schema/peer-v1.json' with { type: 'json' };
import siotDevice from '../schema/siot-device.json' with { type: 'json' };
import publicV1Control from '../schema/public-v1-control.json' with { type: 'json' };

export type * from './generated/siot-device.js';
export type * from './generated/relay-v2.js';
export type * from './generated/peer-v1.js';
export type * from './generated/public-v1-control.js';

import type { EvtFrame, RelayV2Frame } from './generated/relay-v2.js';
import type { ControlStatus } from './generated/public-v1-control.js';

export const schemas = { relayV2, peerV1, siotDevice, publicV1Control } as const;
/** 서로 $ref 하므로 Ajv 에는 이 순서 그대로 전부 addSchema 한다. */
export const allSchemas = [siotDevice, relayV2, peerV1, publicV1Control] as const;

export const SCHEMA_IDS = {
  relayV2: relayV2.$id,
  relayV2ServerToGateway: `${relayV2.$id}#/$defs/ServerToGateway`,
  relayV2GatewayToServer: `${relayV2.$id}#/$defs/GatewayToServer`,
  peerV1: peerV1.$id,
  siotDevice: siotDevice.$id,
  publicV1Control: publicV1Control.$id,
} as const;

export type FrameType = RelayV2Frame['t'];
export type EvtKind = EvtFrame['kind'];
export type FrameDirection = 'server_to_gateway' | 'gateway_to_server' | 'both';

export const RELAY_PROTO = 2 as const;
export const EVT_KINDS = ['device', 'device_removed', 'gateway', 'pairing', 'thread', 'error', 'log'] as const satisfies readonly EvtKind[];
export const CONTROL_STATUSES = ['confirmed', 'timeout', 'offline', 'failed', 'not_found'] as const satisfies readonly ControlStatus[];

/** §2 b 표의 방향. 스키마 각 정의의 x-direction 과 같다(테스트가 확인). */
export const FRAME_DIRECTIONS = {
  challenge: 'server_to_gateway',
  welcome: 'server_to_gateway',
  bind: 'server_to_gateway',
  cfg: 'server_to_gateway',
  ack: 'server_to_gateway',
  req: 'server_to_gateway',
  ping: 'both',
  pong: 'both',
  hello: 'gateway_to_server',
  bound: 'gateway_to_server',
  cfg_ack: 'gateway_to_server',
  snapshot: 'gateway_to_server',
  evt: 'gateway_to_server',
  res: 'gateway_to_server',
} as const satisfies Record<FrameType, FrameDirection>;

/** 릴레이 WS close code (§2 b 접속) */
export const RELAY_CLOSE = {
  queryTokenRejected: 4401,
  unregisteredKey: 4403,
} as const;

/** 하트비트·접속 순서 상수 (§2 b) */
export const RELAY_TIMING = {
  heartbeatSec: 10,
  deadSec: 25,
  cfgAckTimeoutSec: 10,
  pendingBufferMax: 1000,
  ringBufferSize: 1000,
} as const;
