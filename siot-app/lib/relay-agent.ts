// 릴레이 터널 에이전트 — server-only.
// 게이트웨이가 시옷 릴레이로 "나가는" WebSocket을 상시 유지하고, 릴레이가 보내온
// 요청을 localhost(시옷앱)에 프록시한 뒤 응답을 돌려준다. → 집 밖 원격 접속.
//
// SIOT_RELAY_URL 이 없으면 비활성(로컬만). 인증은 gatewayToken(없으면 dev 토큰).
import "server-only";
// 앱/플랫폼이 보는 것과 동일한 gatewayId를 쓴다(getGatewayId = env 오버라이드 반영).
import { getGatewayId } from "./platform-auth";
import { loadStore } from "./gateway-store";

let started = false;

// 게이트웨이로 프록시할 때 빼는 요청 헤더(홉바이홉/인코딩).
const DROP_REQ = new Set([
  "host",
  "connection",
  "content-length",
  "keep-alive",
  "upgrade",
  "transfer-encoding",
  "accept-encoding",
]);
// 앱으로 돌려줄 때 빼는 응답 헤더(이미 디코드됨/직접 관리).
const DROP_RES = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
  "keep-alive",
]);

export async function startRelayAgent(): Promise<void> {
  if (started) return;
  const relayUrl = process.env.SIOT_RELAY_URL;
  if (!relayUrl) return; // 릴레이 미설정 → 비활성(로컬 전용)
  started = true;
  try {
    const gatewayId = await getGatewayId();
    const store = await loadStore();
    const token = store.gatewayToken ?? process.env.SIOT_PLATFORM_TOKEN;
    if (!token) {
      console.warn("[relay] gatewayToken 없음 — 릴레이 비활성(등록/claim 후 가능)");
      return;
    }
    const port = Number(process.env.PORT ?? 3000);
    connect(relayUrl, gatewayId, token, port, 0);
  } catch (err) {
    console.warn(
      "[relay] 에이전트 시작 실패:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function connect(
  relayUrl: string,
  gatewayId: string,
  token: string,
  port: number,
  attempt: number,
): void {
  const url = `${relayUrl}?gatewayId=${encodeURIComponent(
    gatewayId,
  )}&token=${encodeURIComponent(token)}`;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    reconnect(relayUrl, gatewayId, token, port, attempt + 1);
    return;
  }

  ws.addEventListener("open", () => {
    console.log(`[relay] 릴레이 연결됨: ${relayUrl} (gatewayId=${gatewayId})`);
  });

  ws.addEventListener("message", async (ev) => {
    let msg: {
      t?: string;
      id?: string;
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    try {
      msg = JSON.parse(String((ev as MessageEvent).data));
    } catch {
      return;
    }
    if (msg.t !== "req" || !msg.id) return;
    const resFrame = await proxyToLocal(msg, port);
    try {
      ws.send(JSON.stringify(resFrame));
    } catch {
      // 무시
    }
  });

  ws.addEventListener("close", () => {
    reconnect(relayUrl, gatewayId, token, port, attempt + 1);
  });
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      // 무시
    }
  });
}

function reconnect(
  relayUrl: string,
  gatewayId: string,
  token: string,
  port: number,
  attempt: number,
): void {
  // 지수 백오프(최대 30초).
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  setTimeout(() => connect(relayUrl, gatewayId, token, port, attempt), delay);
}

async function proxyToLocal(
  msg: {
    id?: string;
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  },
  port: number,
): Promise<unknown> {
  try {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.headers ?? {})) {
      if (!DROP_REQ.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
    }
    const method = msg.method ?? "GET";
    const init: RequestInit = { method, headers };
    if (msg.body && method !== "GET" && method !== "HEAD") {
      init.body = Buffer.from(msg.body, "base64");
    }
    const r = await fetch(`http://127.0.0.1:${port}${msg.path ?? "/"}`, init);
    const buf = Buffer.from(await r.arrayBuffer());
    const resHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (!DROP_RES.has(k.toLowerCase())) resHeaders[k] = v;
    });
    return {
      t: "res",
      id: msg.id,
      status: r.status,
      headers: resHeaders,
      body: buf.toString("base64"),
    };
  } catch {
    return {
      t: "res",
      id: msg.id,
      status: 502,
      headers: { "content-type": "application/json" },
      body: Buffer.from(
        JSON.stringify({ ok: false, error: "gateway proxy error" }),
      ).toString("base64"),
    };
  }
}
