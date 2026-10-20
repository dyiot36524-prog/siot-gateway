import type { ReactNode } from 'react';
import { Link } from '../lib/router';
import { useSession } from '../state/session';

export function Badge({ tone, children }: { tone: 'ok' | 'bad' | 'warn' | 'muted'; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function OnlineBadge({ online }: { online: boolean }) {
  return online ? <Badge tone="ok">온라인</Badge> : <Badge tone="bad">오프라인</Badge>;
}

/** 화면 공통 틀: 상단 바(뒤로·제목·로그아웃) + 연결 배지 */
export function Screen({
  title,
  back,
  children,
  banner,
}: {
  title: string;
  back?: string;
  children: ReactNode;
  /** 세대 화면의 실시간 연결 끊김 등 추가 배지 */
  banner?: ReactNode;
}) {
  const { me, offline, signOut } = useSession();
  return (
    <div className="screen">
      <header className="topbar">
        {back ? (
          <Link to={back} className="topbar__back" aria-label="뒤로">
            ‹
          </Link>
        ) : (
          <span className="topbar__logo" aria-hidden>
            ㅅ
          </span>
        )}
        <h1 className="topbar__title">{title}</h1>
        {me && (
          <button
            type="button"
            className="topbar__action"
            onClick={() => {
              if (confirm('로그아웃할까요?')) void signOut();
            }}
          >
            로그아웃
          </button>
        )}
      </header>
      {offline && (
        <div className="netbar" role="status">
          오프라인 · 인터넷 연결을 기다리는 중
        </div>
      )}
      {banner}
      <main className="content">{children}</main>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
