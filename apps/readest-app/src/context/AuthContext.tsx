'use client';

import {
  createContext,
  useState,
  useContext,
  useCallback,
  useMemo,
  ReactNode,
  useEffect,
  useRef,
} from 'react';
import { isAuthRetryableFetchError, User } from '@supabase/supabase-js';
import { supabase } from '@/utils/supabase';
import posthog from 'posthog-js';
import { accessPolicy, isAllowedUser } from '@/config/accessPolicy';
import { withPrivateAuth } from '@/utils/privateFetch';

interface AuthContextType {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  token: string | null;
  user: User | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  refresh: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const readCachedSession = (): { token: string; user: User } | null => {
  if (accessPolicy.requireLogin || typeof window === 'undefined') return null;
  const token = localStorage.getItem('token');
  const user = localStorage.getItem('user');
  if (!token || !user) return null;
  try {
    return { token, user: JSON.parse(user) };
  } catch {
    return null;
  }
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [cachedSession] = useState(readCachedSession);
  const [token, setToken] = useState<string | null>(cachedSession?.token ?? null);
  const [user, setUser] = useState<User | null>(cachedSession?.user ?? null);
  const [status, setStatus] = useState<AuthContextType['status']>(
    cachedSession ? 'authenticated' : 'loading',
  );
  const generation = useRef(0);
  const currentToken = useRef<string | null>(token);
  const cookieQueue = useRef<Promise<unknown>>(Promise.resolve());
  const isWeb = process.env['NEXT_PUBLIC_APP_PLATFORM'] !== 'tauri';

  const syncCookie = useCallback((accessToken: string | null, attempt: number) => {
    const job = cookieQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (attempt !== generation.current) return false;
        const response = await fetch('/api/auth/session', {
          method: accessToken ? 'POST' : 'DELETE',
          ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
        });
        return response.ok;
      });
    cookieQueue.current = job;
    return job;
  }, []);

  const clear = useCallback(() => {
    currentToken.current = null;
    setToken(null);
    setUser(null);
    setStatus('unauthenticated');
    for (const key of ['token', 'refresh_token', 'user']) localStorage.removeItem(key);
  }, []);

  const acceptSession = useCallback(
    async (accessToken: string | null, cachedUser?: User) => {
      const attempt = ++generation.current;
      if (!accessToken) {
        clear();
        if (accessPolicy.requireLogin && isWeb) {
          await syncCookie(null, generation.current).catch(() => undefined);
        }
        return;
      }
      if (accessPolicy.requireLogin) {
        if (!currentToken.current) setStatus('loading');
      }
      try {
        const { data, error } = accessPolicy.requireLogin
          ? await supabase.auth.getUser(accessToken)
          : { data: { user: cachedUser ?? null }, error: null };
        if (attempt !== generation.current) return;
        if (error || !data.user || (accessPolicy.requireLogin && !isAllowedUser(data.user))) {
          if (accessPolicy.requireLogin && isWeb)
            void syncCookie(null, attempt).catch(() => undefined);
          clear();
          return;
        }
        if (accessPolicy.requireLogin && isWeb) {
          const ok = await syncCookie(accessToken, attempt);
          if (attempt !== generation.current) return;
          if (!ok) {
            clear();
            return;
          }
        }
        currentToken.current = accessToken;
        localStorage.setItem('token', accessToken);
        localStorage.setItem('user', JSON.stringify(data.user));
        setToken(accessToken);
        setUser(data.user);
        setStatus('authenticated');
        posthog.identify(data.user.id);
      } catch {
        if (attempt === generation.current) clear();
      }
    },
    [clear, isWeb, syncCookie],
  );

  useEffect(() => {
    const originalFetch = window.fetch;
    const privateFetch = withPrivateAuth(originalFetch.bind(window), () => currentToken.current);
    window.fetch = privateFetch;
    let active = true;
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    const restore = async () => {
      const attempt = generation.current;
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!active || attempt !== generation.current) return;
        await acceptSession(
          error ? null : (data.session?.access_token ?? null),
          data.session?.user,
        );
      } catch {
        if (accessPolicy.requireLogin && active && attempt === generation.current) clear();
      }
    };
    const restoreCachedSession = async (refreshToken: string, attempt: number) => {
      try {
        const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
        if (!active || attempt !== generation.current) return;
        if (error && isAuthRetryableFetchError(error)) return;
        if (data.session?.refresh_token) {
          localStorage.setItem('refresh_token', data.session.refresh_token);
        }
        await acceptSession(
          error ? null : (data.session?.access_token ?? null),
          data.session?.user,
        );
      } catch {
        // A network failure leaves the cached session available in public mode.
      }
    };
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.refresh_token) localStorage.setItem('refresh_token', session.refresh_token);
      // Do not await another auth method inside Supabase's auth-state lock.
      clearTimeout(eventTimer);
      const eventGeneration = ++generation.current;
      eventTimer = setTimeout(() => {
        if (!active || eventGeneration !== generation.current) return;
        // The SDK can report a null initial session after a failed startup
        // refresh. In public mode, try the app's copy of the refresh token.
        const refreshToken =
          !accessPolicy.requireLogin && event === 'INITIAL_SESSION' && !session
            ? localStorage.getItem('refresh_token')
            : null;
        if (refreshToken) {
          void restoreCachedSession(refreshToken, eventGeneration);
        } else {
          void acceptSession(session?.access_token ?? null, session?.user);
        }
      }, 0);
    });
    if (accessPolicy.requireLogin) {
      void restore();
      window.addEventListener('focus', restore);
    }
    return () => {
      active = false;
      generation.current++;
      clearTimeout(eventTimer);
      subscription.subscription.unsubscribe();
      window.removeEventListener('focus', restore);
      if (window.fetch === privateFetch) window.fetch = originalFetch;
    };
  }, [acceptSession, clear]);

  // Stop rendering private content at token expiry even if the device is
  // offline and Supabase cannot refresh the session.
  useEffect(() => {
    if (!accessPolicy.requireLogin || !token) return;
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active || currentToken.current !== token) return;
        const expires = data.session?.expires_at;
        if (!expires) {
          clear();
          return;
        }
        timer = setTimeout(
          () => {
            if (currentToken.current === token) {
              generation.current++;
              clear();
            }
          },
          Math.max(0, expires * 1000 - Date.now()),
        );
      })
      .catch(clear);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [token, clear]);

  const login = useCallback(
    (newToken: string, newUser: User) => {
      return acceptSession(newToken, newUser);
    },
    [acceptSession],
  );

  const logout = useCallback(async () => {
    generation.current++;
    clear();
    if (accessPolicy.requireLogin && isWeb) {
      await syncCookie(null, generation.current).catch(() => undefined);
    }
    await supabase.auth.signOut({ scope: 'local' });
  }, [clear, isWeb, syncCookie]);

  const refresh = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession();
      await acceptSession(error ? null : (data.session?.access_token ?? null), data.session?.user);
      return !!currentToken.current;
    } catch {
      clear();
      return false;
    }
  }, [acceptSession, clear]);

  const value = useMemo(
    () => ({ status, token, user, login, logout, refresh }),
    [status, token, user, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
