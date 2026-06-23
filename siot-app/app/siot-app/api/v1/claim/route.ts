// POST /siot-app/api/v1/claim — 1회용 등록 코드로 게이트웨이를 클레임한다.
// 무인증 엔드포인트 — 등록 코드 자체가 1회용 비밀키 역할을 한다.
// 성공 시 gatewayToken 발급 및 스토어 저장, 코드는 즉시 폐기한다.
import { randomBytes } from "node:crypto";
import { loadStore, saveStore } from "@/lib/gateway-store";
import { isCodeValid } from "@/lib/registration";
import { getOrCreateGatewayId } from "@/lib/gateway-identity";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "JSON 본문이 필요합니다." },
      { status: 400 },
    );
  }

  const registrationCode = (body as Record<string, unknown>)?.registrationCode;
  if (typeof registrationCode !== "string") {
    return Response.json(
      { ok: false, error: "registrationCode(문자열)가 필요합니다." },
      { status: 400 },
    );
  }

  const store = await loadStore();
  const nowIso = new Date().toISOString();

  // 코드 유효성 검사 + 코드 일치 확인.
  const valid =
    isCodeValid(store.registrationCode ?? null, store.codeExpiresAt ?? null, nowIso) &&
    store.registrationCode === registrationCode;

  if (!valid) {
    return Response.json(
      { ok: false, error: "유효하지 않거나 만료된 등록 코드입니다." },
      { status: 400 },
    );
  }

  // 32바이트 무작위 게이트웨이 토큰 발급.
  const token = randomBytes(32).toString("hex");

  await saveStore({
    gatewayToken: token,
    registeredAt: nowIso,
    // 사용된 코드는 즉시 폐기.
    registrationCode: null,
    codeExpiresAt: null,
  });

  const gatewayId = await getOrCreateGatewayId();

  return Response.json({ ok: true, gatewayId, gatewayToken: token });
}
