// 라벨·기기 코드 파서. 계획 B2(라벨 QR·수동 입력), app-v1 ClaimRequest·enqueuePairing 패턴과 같다.

const GATEWAY_ID_RE = /^gw_[0-9a-f-]{36}$/;
const SECRET_RE = /^[0-9a-f]{16}$/;

export interface GatewayLabel {
  gatewayId: string;
  claimSecret: string;
}

/** 라벨 QR `https://<app>/g/<gatewayId>#<claimSecret>` → {gatewayId, claimSecret}. 형식이 다르면 null */
export function parseGatewayQr(text: string): GatewayLabel | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const m = /^\/g\/([^/]+)\/?$/.exec(url.pathname);
  if (!m?.[1]) return null;
  const gatewayId = decodeURIComponent(m[1]).toLowerCase();
  const claimSecret = normalizeLabelCode(url.hash.replace(/^#/, ''));
  if (!GATEWAY_ID_RE.test(gatewayId) || !claimSecret) return null;
  return { gatewayId, claimSecret };
}

/** `/g/<gatewayId>` 딥링크(폰 카메라 앱으로 라벨을 찍어 열린 경우)의 hash 를 읽는다 */
export function parseGatewayDeepLink(gatewayId: string, hash: string): GatewayLabel | null {
  const id = gatewayId.toLowerCase();
  const claimSecret = normalizeLabelCode(hash.replace(/^#/, ''));
  if (!GATEWAY_ID_RE.test(id) || !claimSecret) return null;
  return { gatewayId: id, claimSecret };
}

/** `siot-1a2b3c4d`, `1A2B3C4D` → `1a2b3c4d`. 형식이 다르면 null */
export function normalizeShortId(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/^siot-/, '');
  return /^[0-9a-f]{8}$/.test(s) ? s : null;
}

/** 라벨 코드 16자(하이픈·공백 무시) → 소문자 16 hex. 형식이 다르면 null */
export function normalizeLabelCode(input: string): string | null {
  const s = input.replace(/[\s-]/g, '').toLowerCase();
  return SECRET_RE.test(s) ? s : null;
}

/** 입력 중 표시용 4-4-4-4 포맷 */
export function formatLabelCode(input: string): string {
  const s = input.replace(/[^0-9a-fA-F]/g, '').slice(0, 16).toUpperCase();
  return s.replace(/(.{4})(?=.)/g, '$1-');
}

export type MatterCodeKind = 'qr' | 'manual11' | 'manual21';

/** Matter 기기 코드: QR `MT:...` 또는 수동 11/21자리 숫자(공백·하이픈 무시). 서버에 보낼 정규형을 돌려준다 */
export function parseMatterCode(input: string): { code: string; kind: MatterCodeKind } | null {
  const t = input.trim();
  if (/^MT:/i.test(t)) {
    const body = t.slice(3).toUpperCase();
    // Matter QR 페이로드는 base38(0-9 A-Z - .)이고 최소 19자
    if (!/^[0-9A-Z.-]{19,61}$/.test(body)) return null;
    return { code: `MT:${body}`, kind: 'qr' };
  }
  const digits = t.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 11) return { code: digits, kind: 'manual11' };
  if (digits.length === 21) return { code: digits, kind: 'manual21' };
  return null;
}

/** 화면 표시용 짧은 코드(끝 4자리만) */
export function maskCode(code: string): string {
  return code.length <= 6 ? code : `…${code.slice(-4)}`;
}
