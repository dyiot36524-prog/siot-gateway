import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { claimErrorText, pairingErrorText, pairingStageText } from './messages';

describe('페어링 errorCode 문구 (계획 E2 표)', () => {
  // matter-gateway-poc/agent/src/pairing.js classifyCommissionError 의 전 코드
  it.each([
    ['CODE_INVALID', '코드 오류'],
    ['DEVICE_NOT_FOUND', '기기 안 잡힘'],
    ['THREAD_NOT_READY', 'Thread 미설정'],
    ['ATTESTATION_REJECTED', '인증 거부'],
    ['BLE_TRANSIENT', 'BLE 연결 불안정'],
    ['UNKNOWN', '기타 오류'],
  ])('%s → %s', (code, title) => {
    const g = pairingErrorText(code);
    expect(g.title).toBe(title);
    expect(g.hint.length).toBeGreaterThan(10);
  });
  it('모르는 코드·null 은 기타', () => {
    expect(pairingErrorText('SOMETHING_NEW').title).toBe('기타 오류');
    expect(pairingErrorText(null).title).toBe('기타 오류');
  });
  it('단계 문구', () => {
    expect(pairingStageText({ status: 'queued', stage: 'queued', queuePosition: 2 })).toBe('대기 중 · 앞에 2개');
    expect(pairingStageText({ status: 'running', stage: 'commissioning', queuePosition: 0 })).toBe('기기 연결 중 (BLE·인증)');
    expect(pairingStageText({ status: 'running', stage: 'interviewing', queuePosition: 0 })).toBe('기기 정보 읽는 중');
    expect(pairingStageText({ status: 'running', stage: 'thread_dataset', queuePosition: 0 })).toBe('Thread 네트워크 설정 중');
    expect(pairingStageText({ status: 'done', stage: 'done', queuePosition: 0 })).toBe('완료');
    expect(pairingStageText({ status: 'failed', stage: 'failed', queuePosition: 0 })).toBe('실패');
  });
});

describe('claim 오류 문구 (계획 B2)', () => {
  it.each([
    [400, 'INVALID_CLAIM_SECRET', '라벨 코드가 맞지 않습니다'],
    [409, 'GATEWAY_ALREADY_BOUND', '이미 다른 세대에 연결된 게이트웨이'],
    [409, 'GATEWAY_NOT_PROVISIONED', '출고 등록되지 않은 게이트웨이'],
    [403, 'GATEWAY_ORG_MISMATCH', '다른 업체에 출고된 게이트웨이'],
    [423, 'CLAIM_WINDOW_CLOSED', '연결 가능 시간 지남'],
    [404, 'NOT_FOUND', '게이트웨이를 찾을 수 없음'],
  ])('%i %s', (status, code, title) => {
    expect(claimErrorText(new ApiError(status, code, 'x')).title).toBe(title);
  });
  it('네트워크 오류', () => {
    expect(claimErrorText(new TypeError('fetch failed')).title).toBe('네트워크 오류');
  });
});
