// POST /api/register — 시옷플랫폼 연결용 1회용 등록 코드 생성. (단계 7)
// 흐름: 게이트웨이가 코드 생성 → 사용자가 시옷플랫폼에 입력
//       → 플랫폼이 /siot-app/api/v1/claim 으로 코드 검증·토큰 발급.
import { getOrCreateGatewayId } from "@/lib/gateway-identity";
import { generateCode } from "@/lib/registration";
import { saveStore } from "@/lib/gateway-store";

export const dynamic = "force-dynamic";

export async function POST() {
  const gatewayId = await getOrCreateGatewayId();

  const code = generateCode();
  // 코드 유효 시간: 10분.
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await saveStore({ registrationCode: code, codeExpiresAt: expiresAt });

  return Response.json({
    ok: true,
    gatewayId,
    registrationCode: code,
    expiresAt,
    note: "이 코드를 시옷플랫폼에 입력해 연결하세요. 10분 내 유효.",
  });
}
