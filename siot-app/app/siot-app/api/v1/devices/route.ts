// GET /siot-app/api/v1/devices — (시옷플랫폼용) 기기 목록. 인증 필요.
import { verifyPlatformAuth, unauthorized, getGatewayId } from "@/lib/platform-auth";
import { getDevices } from "@/lib/devices-service";
import { HaClientError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await verifyPlatformAuth(request);
  if (!auth.ok) return unauthorized(auth.error!);

  try {
    const devices = await getDevices();
    return Response.json({
      ok: true,
      gatewayId: await getGatewayId(),
      count: devices.length,
      devices,
    });
  } catch (err) {
    if (err instanceof HaClientError) {
      return Response.json({ ok: false, error: err.message }, { status: 502 });
    }
    return Response.json(
      { ok: false, error: "알 수 없는 오류", detail: String(err) },
      { status: 500 },
    );
  }
}
