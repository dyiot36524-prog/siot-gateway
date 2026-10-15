// 플랫폼 → 게이트웨이 인증 — siot-app lib/platform-auth.ts 와 동일 (Bearer 또는 ?token=, timing-safe)
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function verifyPlatformAuth(req, url, store) {
  const s = await store.load();
  const expected = s.gatewayToken ?? process.env.SIOT_PLATFORM_TOKEN;
  if (!expected) return { ok: false, error: '미등록 게이트웨이입니다. 먼저 등록(/connect)하세요.' };
  let token = null;
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) token = header.slice(7).trim();
  if (!token) token = url.searchParams.get('token');
  if (!token) return { ok: false, error: '인증 토큰이 없습니다 (Authorization: Bearer 또는 ?token=).' };
  if (!safeEqual(token, expected)) return { ok: false, error: '유효하지 않은 토큰입니다.' };
  return { ok: true };
}
