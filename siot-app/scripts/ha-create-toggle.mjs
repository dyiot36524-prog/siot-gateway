// 일회성 스크립트: HA에 테스트용 가상 토글(input_boolean)을 생성한다.
// 실물 플러그가 없을 때 단계 3(제어)을 실제로 켜고/끄며 검증하기 위함.
// 실행: node scripts/ha-create-toggle.mjs
import { readFileSync } from "node:fs";

// .env.local에서 HA 설정 읽기 (이 스크립트는 Next 밖에서 도므로 직접 파싱).
function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const { HA_BASE_URL, HA_TOKEN } = loadEnv();
if (!HA_BASE_URL || !HA_TOKEN) {
  console.error("HA_BASE_URL / HA_TOKEN 없음 (.env.local 확인)");
  process.exit(1);
}

const wsUrl = HA_BASE_URL.replace(/^http/, "ws").replace(/\/+$/, "") + "/api/websocket";
const NAME = "Siot Test Plug"; // entity_id = input_boolean.siot_test_plug 로 생성됨

const ws = new WebSocket(wsUrl);
const timeout = setTimeout(() => {
  console.error("시간 초과 — HA WebSocket 응답 없음");
  process.exit(1);
}, 15000);

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "auth_required") {
    ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
  } else if (msg.type === "auth_invalid") {
    console.error("인증 실패:", msg.message);
    clearTimeout(timeout);
    process.exit(1);
  } else if (msg.type === "auth_ok") {
    ws.send(
      JSON.stringify({
        id: 1,
        type: "input_boolean/create",
        name: NAME,
        icon: "mdi:power-socket",
      }),
    );
  } else if (msg.type === "result" && msg.id === 1) {
    clearTimeout(timeout);
    if (msg.success) {
      console.log("생성 성공:", JSON.stringify(msg.result));
    } else {
      // 이미 존재하면 그것도 사실상 성공으로 간주.
      console.log("생성 응답(실패/중복):", JSON.stringify(msg.error));
    }
    ws.close();
    process.exit(0);
  }
});

ws.addEventListener("error", (e) => {
  clearTimeout(timeout);
  console.error("WebSocket 오류:", e.message ?? e);
  process.exit(1);
});
