// 소유: Step 3a 실행자. 지금은 로그인 화면 자리만 있다.
import { useState, type FormEvent } from 'react';

export function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // TODO(Step 3a): api.login(email, password) → 세대 목록
  };

  return (
    <main style={{ maxWidth: 360, margin: '15vh auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 24 }}>시옷 로그인</h1>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
        <label>
          이메일
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} style={{ display: 'block', width: '100%' }} />
        </label>
        <label>
          비밀번호
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} style={{ display: 'block', width: '100%' }} />
        </label>
        <button type="submit">로그인</button>
      </form>
    </main>
  );
}
