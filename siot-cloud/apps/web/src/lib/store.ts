// localStorage/sessionStorage 래퍼. 사파리 비공개 모드 등에서 throw 할 수 있어 전부 감싼다.

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const store = {
  getJson<T>(key: string): T | null {
    return safe(() => {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : null;
    }, null);
  },
  setJson(key: string, value: unknown) {
    safe(() => (value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value))), undefined);
  },
  clearPrefix(prefix: string) {
    safe(() => {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix)) localStorage.removeItem(k);
      }
    }, undefined);
  },
  getSession(key: string): string | null {
    return safe(() => sessionStorage.getItem(key), null);
  },
  setSession(key: string, value: string | null) {
    safe(() => (value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value)), undefined);
  },
};
