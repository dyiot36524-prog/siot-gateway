// GET /api/stream — HA state_changed를 SSE로 브라우저에 실시간 푸시. (단계 6)
// 브라우저는 EventSource로 이 엔드포인트를 구독한다.
// ※ 연결당 HA WebSocket 1개를 연다. 게이트웨이 UI는 소수 클라이언트라 충분.
//   대규모 다중 클라이언트가 필요해지면 HA WS를 단일 공유 연결로 두는 구조로 전환.
import { subscribeStateChanges } from "@/lib/ha-socket";
import { isUserFacing, mapEntity } from "@/lib/device-mapper";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // 이미 닫힘.
        }
      };
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      send(": connected\n\n");

      unsubscribe = subscribeStateChanges(
        (event) => {
          if (!event.new_state || !isUserFacing(event.entity_id)) return;
          const device = mapEntity(event.new_state);
          send(`data: ${JSON.stringify(device)}\n\n`);
        },
        (err) => {
          send(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        },
      );

      // keep-alive: 프록시/브라우저가 연결을 끊지 않도록 주기적 주석 핑.
      ping = setInterval(() => send(": ping\n\n"), 25000);

      // 클라이언트 연결 종료 시 정리.
      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      if (ping) clearInterval(ping);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
