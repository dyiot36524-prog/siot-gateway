// HA WebSocket 구독 — state_changed 이벤트를 받아 콜백으로 전달. (단계 6)
// 서버 전용. 브라우저로는 SSE(app/api/stream)로 다시 내보낸다.
import "server-only";
import { HaClientError, type HaState } from "./types";

export interface StateChangeEvent {
  entity_id: string;
  new_state: HaState | null;
  old_state: HaState | null;
}

/**
 * HA WebSocket에 연결해 state_changed 이벤트를 구독한다.
 * 반환된 함수를 호출하면 구독을 해제(연결 종료)한다.
 */
export function subscribeStateChanges(
  onEvent: (event: StateChangeEvent) => void,
  onError: (err: Error) => void,
): () => void {
  const baseUrl = process.env.HA_BASE_URL?.replace(/\/+$/, "");
  const token = process.env.HA_TOKEN;
  if (!baseUrl || !token || token === "여기에_토큰_붙여넣기") {
    onError(new HaClientError("HA 설정이 없습니다 (.env.local 확인)."));
    return () => {};
  }

  const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/websocket";
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    onError(
      new HaClientError(
        `HA WebSocket 연결 실패: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return () => {};
  }

  ws.addEventListener("message", (ev) => {
    let msg: {
      type?: string;
      event?: { event_type?: string; data?: StateChangeEvent };
    };
    try {
      msg = JSON.parse(String((ev as MessageEvent).data));
    } catch {
      return;
    }
    if (msg.type === "auth_required") {
      ws.send(JSON.stringify({ type: "auth", access_token: token }));
    } else if (msg.type === "auth_ok") {
      ws.send(
        JSON.stringify({
          id: 1,
          type: "subscribe_events",
          event_type: "state_changed",
        }),
      );
    } else if (msg.type === "auth_invalid") {
      onError(new HaClientError("HA WebSocket 인증 실패 (토큰 확인)."));
    } else if (
      msg.type === "event" &&
      msg.event?.event_type === "state_changed" &&
      msg.event.data
    ) {
      onEvent(msg.event.data);
    }
  });

  ws.addEventListener("error", () => {
    onError(new HaClientError("HA WebSocket 오류."));
  });

  return () => {
    try {
      ws.close();
    } catch {
      // 이미 닫힘 — 무시.
    }
  };
}
