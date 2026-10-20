/* 자동 생성 파일 — 직접 고치지 말 것. 원본: packages/protocol/schema/peer-v1.json, 생성: npm run gen */

/**
 * 같은 세대 게이트웨이 간 PeerLink 프레임(계획 §2 c, C1). 전송: TCP 3443 + TLS-PSK(identity "<siteId>:<keyVersion>", PSK = HKDF-SHA256(siteKey, "siot-peer-v1")). LAN·Thread ML-EID 두 경로를 동시에 유지하고 이벤트는 살아 있는 모든 경로로 보낸다. 수신자는 (from, bootId, seq) 로 중복 제거. keepalive: LAN 2s/6s, Thread 10s/30s(monotonic). 링크로 오가는 것은 상태 이벤트뿐이다(E-b).
 */
export type PeerV1Frame = PeerHelloFrame | PeerPingFrame | PeerPongFrame | PeerEvtFrame | PeerAckFrame;
export type PeerGatewayId = string;
export type PeerBootId = string;

export interface PeerHelloFrame {
  t: 'hello';
  /**
   * HMAC(siteKey, "site-tag") 앞 8 hex (mDNS TXT site= 와 같다)
   */
  siteTag: string;
  gatewayId: PeerGatewayId;
  bootId: PeerBootId;
  keyVersion: number;
}
export interface PeerPingFrame {
  t: 'ping';
}
export interface PeerPongFrame {
  t: 'pong';
}
export interface PeerEvtFrame {
  t: 'evt';
  from: PeerGatewayId;
  bootId: PeerBootId;
  seq: number;
  kind: 'device' | 'device_removed' | 'gateway';
  data: {};
}
/**
 * bootId 는 확인하는 상대(evt 송신자)의 bootId, upTo 이하 seq 를 받았다는 뜻
 */
export interface PeerAckFrame {
  t: 'ack';
  bootId: PeerBootId;
  upTo: number;
}
