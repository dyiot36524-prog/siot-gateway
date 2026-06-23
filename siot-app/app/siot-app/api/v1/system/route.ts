// GET /siot-app/api/v1/system — 게이트웨이 시스템 상태. 시옷플랫폼용, 인증 필요.
// 함대 관리: 플랫폼이 이 엔드포인트를 폴링(pull)하는 모델을 기본으로 한다.
// 게이트웨이가 능동적으로 보내는 heartbeat(push)는 플랫폼 확정 후 추가.
import { verifyPlatformAuth, unauthorized } from "@/lib/platform-auth";
import { getSystemStatus } from "@/lib/system-status";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // 플랫폼 토큰 검증.
  const auth = await verifyPlatformAuth(request);
  if (!auth.ok) return unauthorized(auth.error!);

  try {
    const status = await getSystemStatus();
    return Response.json({ ok: true, ...status });
  } catch (err) {
    // 예기치 못한 오류는 500으로 응답.
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
