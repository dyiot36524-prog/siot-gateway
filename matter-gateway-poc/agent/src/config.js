const DEFAULT_RELAY_URL = 'wss://siot-cloud.fly.dev/gateway';
const mode = process.env.SIOT_MODE === 'dev' ? 'dev' : 'production';   // 출고 기본 production. dev 만 기존 단일 서버 동작
const relayEnv = process.env.SIOT_RELAY_URL;

export const config = {
  mode,
  // 플랫폼 API / 로컬 페이지
  port: Number(process.env.PORT ?? 3000),                       // LAN (출고: healthz·축소 gateway·상태 페이지만)
  localAdminPort: Number(process.env.LOCAL_ADMIN_PORT ?? 3001), // 출고 모드 전체 API, 127.0.0.1 전용
  // CI 가 이미지에 굽는 SIOT_AGENT_VERSION 이 우선(OTA 확인 조건 version = 대상 버전)
  version: process.env.SIOT_AGENT_VERSION || process.env.SIOT_GATEWAY_VERSION || '0.2.0',
  siotDataDir: process.env.SIOT_DATA_DIR ?? process.env.DATA_DIR ?? './data',
  // 릴레이: 비우면 기본 URL, "off" 면 비활성(로컬 전용)
  relayUrl: relayEnv === 'off' ? null : (relayEnv || DEFAULT_RELAY_URL),
  healthDir: process.env.HEALTH_DIR ?? './state/health',
  // Matter
  matterWsUrl: process.env.MATTER_WS_URL ?? 'ws://127.0.0.1:5580/ws',
  otbrRestUrl: process.env.OTBR_REST_URL === '' ? null : (process.env.OTBR_REST_URL ?? 'http://127.0.0.1:8081'),
  // 에이전트
  rulesFile: process.env.RULES_FILE ?? './rules.json',
  rulesSeedFile: process.env.RULES_SEED_FILE ?? './rules.example.json',   // rulesFile 이 없을 때 최초 1회 복사
  clockSyncFile: process.env.SIOT_CLOCK_SYNC_FILE || null,   // 있으면 이 파일이 생긴 뒤(NTP 동기)에만 schedule 규칙 발동
  dataDir: process.env.DATA_DIR ?? './data',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
