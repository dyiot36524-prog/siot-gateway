// GET /siot-app/api/v1/events — (시옷플랫폼용) 기기 상태 변경 실시간 스트림(SSE). 인증 필요.
// EventSource는 헤더를 못 보내므로 ?token= 쿼리 인증도 허용한다.
// 각 이벤트: data: { "type":"device", "device": <SiotDevice> }
import { verifyPlatformAuth, unauthorized } from "@/lib/platform-auth";
import { subscribeStateChanges } from "@/lib/ha-socket";
import { isUserFacing, mapEntity } from "@/lib/device-mapper";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await verifyPlatformAuth(request);
  if (!auth.ok) return unauthorized(auth.error!);

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
          send(`data: ${JSON.stringify({ type: "device", device })}\n\n`);
        },
        (err) => {
          send(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        },
      );

      ping = setInterval(() => send(": ping\n\n"), 25000);
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
