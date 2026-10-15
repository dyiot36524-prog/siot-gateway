export const config = {
  gatewayId: process.env.GATEWAY_ID ?? 'gw-poc-001',
  matterWsUrl: process.env.MATTER_WS_URL ?? 'ws://127.0.0.1:5580/ws',
  mqttUrl: process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883',
  mqttUser: process.env.MQTT_USER,
  mqttPass: process.env.MQTT_PASS,
  rulesFile: process.env.RULES_FILE ?? './rules.json',
  dataDir: process.env.DATA_DIR ?? './data',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
