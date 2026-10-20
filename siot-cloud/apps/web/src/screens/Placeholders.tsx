// 거주자·운영자 화면 자리(M2). 역할이 다르면 /forbidden.
import { Screen } from '../components/ui';
import { Link } from '../lib/router';
import { useSession } from '../state/session';

export function ResidentHome() {
  return (
    <Screen title="우리 집">
      <div className="notice">거주자 화면(기기 보기·켜고 끄기·자동화)은 준비 중입니다.</div>
    </Screen>
  );
}

export function OperatorHome() {
  return (
    <Screen title="운영">
      <div className="notice">운영자 대시보드(진단·OTA·경보)는 준비 중입니다.</div>
    </Screen>
  );
}

export function Forbidden() {
  const { me } = useSession();
  return (
    <Screen title="권한 없음">
      <p>이 화면은 {me ? '현재 계정 역할로' : '로그인 없이'} 열 수 없습니다.</p>
      <Link to="/" className="btn btn--primary btn--block">
        처음 화면으로
      </Link>
    </Screen>
  );
}

export function NotFound() {
  return (
    <Screen title="없는 화면">
      <Link to="/" className="btn btn--primary btn--block">
        처음 화면으로
      </Link>
    </Screen>
  );
}
