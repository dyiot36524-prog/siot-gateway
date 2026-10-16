export const config = {
  // 플랫폼 API / 로컬 페이지
  port: Number(process.env.PORT ?? 3000),
  version: process.env.SIOT_GATEWAY_VERSION ?? '0.2.0',
  siotDataDir: process.env.SIOT_DATA_DIR ?? process.env.DATA_DIR ?? './data',
  relayUrl: process.env.SIOT_RELAY_URL || null,
  // Matter
  matterWsUrl: process.env.MATTER_WS_URL ?? 'ws://127.0.0.1:5580/ws',
  otbrRestUrl: process.env.OTBR_REST_URL === '' ? null : (process.env.OTBR_REST_URL ?? 'http://127.0.0.1:8081'),
  // 에이전트
  rulesFile: process.env.RULES_FILE ?? './rules.json',
  dataDir: process.env.DATA_DIR ?? './data',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
