// GET /api/system — 게이트웨이 시스템 상태. 로컬·무인증, 진단/로컬 UI용.
import { getSystemStatus } from "@/lib/system-status";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getSystemStatus();
    return Response.json({ ok: true, ...status });
  } catch (err) {
    // 예기치 못한 오류는 500으로 응답.
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
