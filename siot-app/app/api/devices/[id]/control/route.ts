// POST /api/devices/[id]/control — (내부 UI용) 기기 제어. 인증 없음(동일 출처).
// body: { "action": "ON" | "OFF" | "TOGGLE" | ... }
import { controlDevice, ControlError } from "@/lib/devices-service";
import { SUPPORTED_ACTIONS } from "@/lib/control-map";
import { HaClientError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let action: unknown;
  try {
    action = (await request.json())?.action;
  } catch {
    return Response.json(
      { ok: false, error: 'JSON 본문이 필요합니다. 예: {"action":"ON"}' },
      { status: 400 },
    );
  }
  if (typeof action !== "string") {
    return Response.json(
      { ok: false, error: "action(문자열)이 필요합니다.", supported: SUPPORTED_ACTIONS },
      { status: 400 },
    );
  }

  try {
    const { device, service } = await controlDevice(id, action);
    return Response.json({ ok: true, action, service, device });
  } catch (err) {
    if (err instanceof ControlError) {
      return Response.json(
        { ok: false, error: err.message, supported: SUPPORTED_ACTIONS },
        { status: 400 },
      );
    }
    if (err instanceof HaClientError) {
      const status = err.status === 401 ? 401 : err.status === 404 ? 404 : 502;
      return Response.json({ ok: false, error: err.message }, { status });
    }
    return Response.json(
      { ok: false, error: "알 수 없는 오류", detail: String(err) },
      { status: 500 },
    );
  }
}
