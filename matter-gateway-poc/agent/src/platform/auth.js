// 플랫폼 → 게이트웨이 인증 — siot-app lib/platform-auth.ts 와 같은 규칙(timing-safe).
// 출고 모드는 Authorization: Bearer 만 받는다(쿼리 토큰은 401, 보안 예외 1). dev 모드만 ?token= 허용.
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** @param {{allowQuery?: boolean}} [opts]  allowQuery 기본 false */
export async function verifyPlatformAuth(req, url, store, opts = {}) {
  const s = await store.load();
  const expected = s.gatewayToken ?? process.env.SIOT_PLATFORM_TOKEN;
  if (!expected) return { ok: false, error: '미등록 게이트웨이입니다. 먼저 등록하세요.' };
  let token = null;
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) token = header.slice(7).trim();
  if (!token && url.searchParams.has('token')) {
    if (!opts.allowQuery) return { ok: false, error: '쿼리 토큰(?token=)은 지원하지 않습니다. Authorization: Bearer 를 쓰세요.' };
    token = url.searchParams.get('token');
  }
  if (!token) return { ok: false, error: opts.allowQuery ? '인증 토큰이 없습니다 (Authorization: Bearer 또는 ?token=).' : '인증 토큰이 없습니다 (Authorization: Bearer).' };
  if (!safeEqual(token, expected)) return { ok: false, error: '유효하지 않은 토큰입니다.' };
  return { ok: true };
}
