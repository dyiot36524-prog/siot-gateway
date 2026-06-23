// POST /api/pairing  — 기기 페어링 요청.
// GET  /api/pairing  — 지원 프로토콜 목록 조회 (프론트 옵션 UI용).
import { SUPPORTED_PROTOCOLS } from "@/lib/pairing-map";
import { pairDevice } from "@/lib/pairing-service";
import { HaClientError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/pairing — 지원하는 프로토콜 목록 반환. */
export function GET() {
  return Response.json({ ok: true, supported: SUPPORTED_PROTOCOLS });
}

/** POST /api/pairing — body { protocol: string } 으로 페어링 시도. */
export async function POST(request: Request) {
  // body 파싱 및 protocol 필드 검증.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "요청 body를 JSON으로 파싱할 수 없습니다.", supported: SUPPORTED_PROTOCOLS },
      { status: 400 },
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).protocol !== "string"
  ) {
    return Response.json(
      { ok: false, error: "protocol 필드가 없거나 문자열이 아닙니다.", supported: SUPPORTED_PROTOCOLS },
      { status: 400 },
    );
  }

  const protocol = (body as Record<string, unknown>).protocol as string;

  try {
    const result = await pairDevice(protocol);

    switch (result.status) {
      case "invalid":
        return Response.json(
          { ok: false, error: `지원하지 않는 protocol`, supported: SUPPORTED_PROTOCOLS },
          { status: 400 },
        );
      case "unsupported":
        return Response.json({ ok: true, status: "unsupported", message: result.message });
      case "paired":
        return Response.json({ ok: true, status: "paired", device: result.device });
    }
  } catch (err) {
    if (err instanceof HaClientError) {
      return Response.json(
        { ok: false, error: err.message },
        { status: 502 },
      );
    }
    return Response.json(
      { ok: false, error: "알 수 없는 오류", detail: String(err) },
      { status: 500 },
    );
  }
}
