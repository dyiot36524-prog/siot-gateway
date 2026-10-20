// 서버 코드 → 기사용 한국어 문구. 계획 E2 표(페어링)와 B2(바인딩 오류)를 따른다.
import { ApiError, type PairingSession } from '../api/client';

export interface Guidance {
  title: string;
  hint: string;
}

/** 페어링 errorCode(matter-gateway-poc/agent/src/pairing.js classifyCommissionError) → 문구 */
export const PAIRING_ERRORS: Record<string, Guidance> = {
  CODE_INVALID: {
    title: '코드 오류',
    hint: '기기 QR 또는 숫자 코드가 맞지 않습니다. 기기·상자의 코드를 다시 스캔하세요.',
  },
  DEVICE_NOT_FOUND: {
    title: '기기 안 잡힘',
    hint: '기기를 게이트웨이 3m 안에 두고 페어링 모드(전원 다시 꽂기·버튼 길게)인지 확인한 뒤 다시 시도하세요.',
  },
  THREAD_NOT_READY: {
    title: 'Thread 미설정',
    hint: '게이트웨이의 Thread 네트워크가 아직 준비되지 않았습니다. 게이트웨이가 온라인인지 확인하고 1분 뒤 다시 시도하세요.',
  },
  ATTESTATION_REJECTED: {
    title: '인증 거부',
    hint: '인증되지 않은 기기입니다. 지원 기기 목록에 있는 정품인지 확인하세요.',
  },
  BLE_TRANSIENT: {
    title: 'BLE 연결 불안정',
    hint: '블루투스 연결이 끊겼습니다. 기기를 게이트웨이 가까이 두고 다시 시도하세요.',
  },
  UNKNOWN: {
    title: '기타 오류',
    hint: '알 수 없는 오류입니다. 다시 시도해도 같으면 기기를 초기화한 뒤 시도하세요.',
  },
};

export function pairingErrorText(code: string | null | undefined): Guidance {
  return PAIRING_ERRORS[code ?? 'UNKNOWN'] ?? PAIRING_ERRORS.UNKNOWN!;
}

export function pairingStageText(s: Pick<PairingSession, 'status' | 'stage' | 'queuePosition'>): string {
  if (s.status === 'done') return '완료';
  if (s.status === 'failed') return '실패';
  if (s.status === 'cancelled') return '취소됨';
  switch (s.stage) {
    case 'thread_dataset':
      return 'Thread 네트워크 설정 중';
    case 'commissioning':
      return '기기 연결 중 (BLE·인증)';
    case 'interviewing':
      return '기기 정보 읽는 중';
    default:
      return s.queuePosition > 0 ? `대기 중 · 앞에 ${s.queuePosition}개` : '곧 시작';
  }
}

/** POST /gateways/claim 오류 → 문구 */
export function claimErrorText(err: unknown): Guidance {
  if (!(err instanceof ApiError)) {
    return { title: '네트워크 오류', hint: '인터넷 연결을 확인하고 다시 시도하세요.' };
  }
  switch (err.code) {
    case 'INVALID_CLAIM_SECRET':
      return { title: '라벨 코드가 맞지 않습니다', hint: '게이트웨이 라벨의 16자 코드(4-4-4-4)를 다시 확인하세요.' };
    case 'VALIDATION_FAILED':
      return { title: '입력 형식 오류', hint: 'siot- 뒤 8자리와 라벨 코드 16자를 다시 확인하세요.' };
    case 'GATEWAY_ALREADY_BOUND':
      return {
        title: '이미 다른 세대에 연결된 게이트웨이',
        hint: '기존 세대에서 세대 초기화를 해야 연결할 수 있습니다. 다른 게이트웨이를 쓰거나 관리자에게 초기화를 요청하세요.',
      };
    case 'GATEWAY_NOT_PROVISIONED':
      return { title: '출고 등록되지 않은 게이트웨이', hint: '이 게이트웨이는 쓸 수 없습니다. 다른 게이트웨이로 교체하고 본사에 알려 주세요.' };
    case 'GATEWAY_ORG_MISMATCH':
      return { title: '다른 업체에 출고된 게이트웨이', hint: '우리 업체 재고가 아닙니다. 받은 게이트웨이가 맞는지 확인하세요.' };
    case 'CLAIM_WINDOW_CLOSED':
      return {
        title: '연결 가능 시간 지남',
        hint: '초기화 후 24시간이 지나 연결할 수 없습니다. 관리자에게 연결 창을 다시 열어 달라고 요청하세요.',
      };
    case 'NOT_FOUND':
      return { title: '게이트웨이를 찾을 수 없음', hint: 'siot- 뒤 8자리를 다시 확인하세요. 게이트웨이 전원이 켜져 있어야 합니다.' };
    case 'FORBIDDEN':
    case 'HANDED_OVER':
      return { title: '권한 없음', hint: '이 세대에 게이트웨이를 연결할 권한이 없습니다.' };
    default:
      return { title: '연결 실패', hint: err.message || '잠시 뒤 다시 시도하세요.' };
  }
}

/** 일반 API 오류 → 한 줄 문구 */
export function apiErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return '네트워크 오류입니다. 연결을 확인하고 다시 시도하세요.';
  switch (err.code) {
    case 'INVALID_CREDENTIALS':
    case 'UNAUTHORIZED':
      return '이메일 또는 비밀번호가 맞지 않습니다.';
    case 'RATE_LIMITED':
      return '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.';
    case 'HANDED_OVER':
      return '인계된 세대라 바꿀 수 없습니다.';
    case 'FORBIDDEN':
      return '권한이 없습니다.';
    case 'VALIDATION_FAILED':
      return '입력값을 확인하세요.';
    default:
      return err.message || '요청에 실패했습니다.';
  }
}
