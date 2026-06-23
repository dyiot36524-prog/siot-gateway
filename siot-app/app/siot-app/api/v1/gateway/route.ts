// GET /siot-app/api/v1/gateway — 게이트웨이 정보·상태. (단계 7, 인증 필요)
import { verifyPlatformAuth, unauthorized, getGatewayId } from "@/lib/platform-auth";
import { ping } from "@/lib/ha-client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await verifyPlatformAuth(request);
  if (!auth.ok) return unauthorized(auth.error!);

  let engineOnline = false;
  try {
    engineOnline = await ping();
  } catch {
    engineOnline = false;
  }

  return Response.json({
    ok: true,
    gatewayId: await getGatewayId(),
    apiVersion: "v1",
    version: process.env.SIOT_GATEWAY_VERSION ?? "0.1.0",
    engine: { kind: "home-assistant", online: engineOnline },
  });
}
