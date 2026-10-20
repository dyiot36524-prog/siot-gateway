import { describe, expect, it } from 'vitest';
import { formatLabelCode, maskCode, normalizeLabelCode, normalizeShortId, parseGatewayDeepLink, parseGatewayQr, parseMatterCode } from './codes';

const GW = 'gw_3f9a2c71-0000-4000-8000-3f9a2c710000';

describe('게이트웨이 라벨', () => {
  it('라벨 QR https://<app>/g/<gatewayId>#<claimSecret> 를 읽는다', () => {
    expect(parseGatewayQr(`https://siot-cloud.fly.dev/g/${GW}#9c2e41ab77d05e18`)).toEqual({ gatewayId: GW, claimSecret: '9c2e41ab77d05e18' });
    expect(parseGatewayQr(`https://siot-cloud.fly.dev/g/${GW}#9C2E-41AB-77D0-5E18`)).toEqual({ gatewayId: GW, claimSecret: '9c2e41ab77d05e18' });
  });
  it('형식이 다르면 null', () => {
    expect(parseGatewayQr('MT:Y.K9042C00KA0648G00')).toBeNull();
    expect(parseGatewayQr(`https://x/g/${GW}`)).toBeNull();
    expect(parseGatewayQr(`https://x/g/gw_nope#9c2e41ab77d05e18`)).toBeNull();
    expect(parseGatewayQr(`https://x/other/${GW}#9c2e41ab77d05e18`)).toBeNull();
  });
  it('딥링크 hash', () => {
    expect(parseGatewayDeepLink(GW, '#9c2e41ab77d05e18')?.claimSecret).toBe('9c2e41ab77d05e18');
    expect(parseGatewayDeepLink(GW, '')).toBeNull();
  });
  it('수동 입력 siot-<shortId> + 16자 4-4-4-4', () => {
    expect(normalizeShortId('siot-3F9A2C71')).toBe('3f9a2c71');
    expect(normalizeShortId('3f9a2c71')).toBe('3f9a2c71');
    expect(normalizeShortId('siot-3f9a2c7')).toBeNull();
    expect(normalizeLabelCode('9C2E-41AB-77D0-5E18')).toBe('9c2e41ab77d05e18');
    expect(normalizeLabelCode('9C2E 41AB 77D0 5E1')).toBeNull();
    expect(formatLabelCode('9c2e41ab77d05e18zz')).toBe('9C2E-41AB-77D0-5E18');
    expect(formatLabelCode('9c2e4')).toBe('9C2E-4');
  });
});

describe('Matter 기기 코드', () => {
  it('QR MT: 페이로드', () => {
    expect(parseMatterCode('MT:Y.K9042C00KA0648G00')).toEqual({ code: 'MT:Y.K9042C00KA0648G00', kind: 'qr' });
    expect(parseMatterCode('mt:y.k9042c00ka0648g00')?.code).toBe('MT:Y.K9042C00KA0648G00');
    expect(parseMatterCode('MT:short')).toBeNull();
  });
  it('수동 11/21자리(공백·하이픈 무시)', () => {
    expect(parseMatterCode('3497-011-2332')).toEqual({ code: '34970112332', kind: 'manual11' });
    expect(parseMatterCode('749701123365521327694')).toEqual({ code: '749701123365521327694', kind: 'manual21' });
    expect(parseMatterCode('1234567890')).toBeNull();
    expect(parseMatterCode('3497011233a')).toBeNull();
  });
  it('표시용 마스킹', () => {
    expect(maskCode('34970112332')).toBe('…2332');
  });
});
