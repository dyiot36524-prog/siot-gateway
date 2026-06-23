// GET /api/devices — (내부 UI용) 시옷 표준 기기 목록. 인증 없음(동일 출처).
// 쿼리 ?all=1 이면 HA 시스템 entity까지 전부 포함(디버그용).
import { getDevices } from "@/lib/devices-service";
import { HaClientError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const includeAll = new URL(request.url).searchParams.get("all") === "1";
  try {
    const devices = await getDevices(includeAll);
    return Response.json({ ok: true, count: devices.length, devices });
  } catch (err) {
    if (err instanceof HaClientError) {
      const status = err.status === 401 ? 401 : 502;
      return Response.json({ ok: false, error: err.message }, { status });
    }
    return Response.json(
      { ok: false, error: "알 수 없는 오류", detail: String(err) },
      { status: 500 },
    );
  }
}
