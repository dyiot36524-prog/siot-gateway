import { useState, type FormEvent } from 'react';
import { apiErrorText } from '../lib/messages';
import { navigate } from '../lib/router';
import { takeReturnTo, useSession } from '../state/session';

export function LoginScreen() {
  const { api, signIn, offline } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.login(email.trim(), password);
      signIn(me);
      navigate(takeReturnTo() ?? '/', { replace: true });
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login__brand">
        <span className="login__mark" aria-hidden>
          ㅅ
        </span>
        <h1>시옷 설치·관리</h1>
        <p className="muted">기사 계정으로 로그인하세요.</p>
      </div>
      {offline && (
        <div className="netbar netbar--inline" role="status">
          오프라인 · 인터넷 연결을 기다리는 중
        </div>
      )}
      <form onSubmit={onSubmit} className="stack">
        <label className="field">
          <span>이메일</span>
          <input type="email" inputMode="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>비밀번호</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
      </form>
    </main>
  );
}
