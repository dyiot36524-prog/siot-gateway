// app-v1 클라이언트 서명(계약: apps/api/openapi/app-v1.yaml). 소유: Step 3a 실행자 — 구현은 Step 3a.
// 같은 origin, 쿠키 세션(credentials: 'same-origin'). 오류는 ApiError({status, code, message}).
import type { ControlResult, PublicDevice } from '@siot/protocol';

export type Role = 'installer' | 'resident' | 'operator';
export type DeviceAction = 'ON' | 'OFF' | 'TOGGLE';

export interface Me {
  user: { userId: string; email: string; name: string; role: Role; orgId: string | null };
}
export interface Site {
  siteId: string;
  name: string;
  address: string | null;
  orgId: string;
  ownerUserId: string | null;
  handedOver: boolean;
  epoch: number;
  gatewayCount: number;
  createdAt: string;
}
export interface GatewayDiagnostics {
  online: boolean;
  lastSeen: string | null;
  agentVersion: string | null;
  matterServerVersion: string | null;
  deviceCount: number;
  lastErrorCode: string | null;
}
export interface Gateway extends GatewayDiagnostics {
  gatewayId: string;
  shortId: string;
  siteId: string | null;
  status: 'unbound' | 'bound' | 'site_reset_pending' | 'factory_reset_pending';
  claimWindowUntil?: string | null;
}
export type ClaimRequest = ({ gatewayId: string; shortId?: never } | { shortId: string; gatewayId?: never }) & {
  claimSecret: string;
  siteId: string;
};
export type ClaimErrorCode =
  | 'INVALID_CLAIM_SECRET'
  | 'GATEWAY_ALREADY_BOUND'
  | 'GATEWAY_NOT_PROVISIONED'
  | 'GATEWAY_ORG_MISMATCH'
  | 'CLAIM_WINDOW_CLOSED';
export interface PairingSession {
  pairingSessionId: string;
  gatewayId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: 'queued' | 'thread_dataset' | 'commissioning' | 'interviewing' | 'done' | 'failed' | null;
  errorCode: string | null;
  error: string | null;
  deviceIds: string[];
  queuePosition: number;
  createdAt: string;
  updatedAt: string;
}
export type Device = PublicDevice;
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
export type SiteEvent =
  | { event: 'device'; data: Device }
  | { event: 'device_removed'; data: { deviceId: string } }
  | { event: 'gateway'; data: Gateway | GatewayDiagnostics }
  | { event: 'pairing'; data: PairingSession };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AppApiClient {
  login(email: string, password: string): Promise<Me>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  listSites(opts?: { cursor?: string; limit?: number }): Promise<Page<Site>>;
  createSite(input: { name: string; address?: string | null }): Promise<Site>;
  getSite(siteId: string): Promise<Site>;
  claimGateway(input: ClaimRequest): Promise<Gateway>;
  listSiteGateways(siteId: string): Promise<{ data: Array<Gateway | GatewayDiagnostics> }>;
  getGateway(gatewayId: string): Promise<Gateway | GatewayDiagnostics>;
  enqueuePairing(gatewayId: string, input: { code: string; name?: string }): Promise<{ pairingSessionId: string; queuePosition: number }>;
  getPairing(pairingSessionId: string): Promise<PairingSession>;
  listSiteDevices(siteId: string): Promise<{ data: Device[] }>;
  updateDevice(deviceId: string, patch: { name?: string; room?: string | null }): Promise<Device>;
  controlDevice(deviceId: string, action: DeviceAction): Promise<ControlResult>;
  /** SSE 구독. 반환값을 호출하면 닫힌다 */
  streamSiteEvents(siteId: string, onEvent: (e: SiteEvent) => void): () => void;
}

/** TODO(Step 3a): fetch 기반 구현 */
export function createAppApiClient(_baseUrl = ''): AppApiClient {
  throw new Error('createAppApiClient: not implemented (Step 3a)');
}
