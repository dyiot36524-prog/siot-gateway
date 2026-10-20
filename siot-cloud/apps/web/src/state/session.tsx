// 세션: 401 에서만 로그인 화면으로 보낸다. 네트워크 오류는 배지만 띄우고 마지막 사용자 정보를 쓴다(계획 C3 ④, E5).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, createAppApiClient, type AppApiClient, type ClientOptions, type Me } from '../api/client';
import { navigate } from '../lib/router';
import { store } from '../lib/store';

const ME_KEY = 'siot.me';
const RETURN_KEY = 'siot.returnTo';

interface SessionValue {
  api: AppApiClient;
  me: Me | null;
  ready: boolean;
  /** 브라우저가 오프라인이거나 마지막 요청이 네트워크 오류 */
  offline: boolean;
  setOffline(v: boolean): void;
  signIn(me: Me): void;
  signOut(): Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}

export function rememberReturnTo() {
  const here = location.pathname + location.search + location.hash;
  if (!here.startsWith('/login')) store.setSession(RETURN_KEY, here);
}

export function takeReturnTo(): string | null {
  const v = store.getSession(RETURN_KEY);
  store.setSession(RETURN_KEY, null);
  return v;
}

export function SessionProvider({ children, clientOptions }: { children: ReactNode; clientOptions?: Omit<ClientOptions, 'onUnauthorized'> }) {
  const [me, setMe] = useState<Me | null>(() => store.getJson<Me>(ME_KEY));
  const [ready, setReady] = useState(false);
  const [netDown, setNetDown] = useState(false);
  const [browserOffline, setBrowserOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);

  const onUnauthorized = useRef(() => {});
  onUnauthorized.current = () => {
    store.setJson(ME_KEY, null);
    setMe(null);
    if (!location.pathname.startsWith('/login')) {
      rememberReturnTo();
      navigate('/login', { replace: true });
    }
  };

  // 옵션은 마운트 시 한 번만 읽는다
  const [api] = useState(() => createAppApiClient('', { ...clientOptions, onUnauthorized: () => onUnauthorized.current() }));

  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((m) => {
        if (!alive) return;
        store.setJson(ME_KEY, m);
        setMe(m);
        setNetDown(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) {
          store.setJson(ME_KEY, null);
          setMe(null);
        } else if (!(e instanceof ApiError)) {
          setNetDown(true); // 캐시된 me 로 계속
        }
      })
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    const on = () => {
      setBrowserOffline(false);
      setNetDown(false);
    };
    const off = () => setBrowserOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const signIn = useCallback((m: Me) => {
    store.setJson(ME_KEY, m);
    setMe(m);
    setNetDown(false);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* 이미 만료됐거나 오프라인이어도 로컬 세션은 지운다 */
    }
    store.setJson(ME_KEY, null);
    store.clearPrefix('siot.pairing.');
    setMe(null);
    navigate('/login', { replace: true });
  }, [api]);

  const value = useMemo<SessionValue>(
    () => ({ api, me, ready, offline: browserOffline || netDown, setOffline: setNetDown, signIn, signOut }),
    [api, me, ready, browserOffline, netDown, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
