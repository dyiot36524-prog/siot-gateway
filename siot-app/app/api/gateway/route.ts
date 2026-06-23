// GET /api/gateway — 게이트웨이 상태 조회 (로컬 UI용, 무인증).
// 같은 출처의 프론트엔드 UI에서 게이트웨이 등록 여부를 확인하는 데 사용한다.
import { getGatewayId } from "@/lib/platform-auth";
import { loadStore } from "@/lib/gateway-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const [store, gatewayId] = await Promise.all([loadStore(), getGatewayId()]);

  return Response.json({
    ok: true,
    gatewayId,
    // gatewayToken이 있으면 플랫폼에 등록 완료 상태.
    registered: !!store.gatewayToken,
    // registrationCode가 있으면 플랫폼 입력 대기 중.
    hasCode: !!store.registrationCode,
  });
}
