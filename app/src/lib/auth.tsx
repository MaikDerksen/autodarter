import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { api, configureApi } from './api';
import { live } from './live';
import { getItem, setItem } from './storage';

export interface User {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}

interface AuthState {
  ready: boolean;
  user: User | null;
  serverUrl: string;
  login(username: string, password: string): Promise<void>;
  register(username: string, password: string, displayName?: string): Promise<void>;
  logout(): Promise<void>;
  setServerUrl(url: string): Promise<void>;
  refreshUser(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const TOKEN_KEY = 'autodarter.token';
const SERVER_KEY = 'autodarter.server';

/** On the web the app is served by the Autodarter server itself -> same origin. */
function defaultServer(): string {
  const env = process.env.EXPO_PUBLIC_API_URL;
  if (env) return env;
  if (Platform.OS === 'web' && typeof window !== 'undefined') return '';
  return '';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [serverUrl, setServer] = useState(defaultServer());

  const applySession = useCallback(async (t: string | null, u: User | null) => {
    setToken(t);
    setUser(u);
    configureApi({ token: t });
    await setItem(TOKEN_KEY, t);
  }, []);

  const logout = useCallback(async () => {
    await applySession(null, null);
  }, [applySession]);

  useEffect(() => {
    (async () => {
      const storedServer = await getItem(SERVER_KEY);
      const server = storedServer ?? defaultServer();
      setServer(server);
      configureApi({ baseUrl: server, onUnauthorized: () => void logout() });
      const t = await getItem(TOKEN_KEY);
      if (t) {
        configureApi({ token: t });
        try {
          const me = await api<User>('/api/auth/me');
          setToken(t);
          setUser(me);
        } catch {
          configureApi({ token: null });
          await setItem(TOKEN_KEY, null);
        }
      }
      setReady(true);
    })();
  }, [logout]);

  // keep the live connection in sync with the session (configure() reconnects when token or server changed)
  useEffect(() => {
    if (ready) live.configure(token);
  }, [ready, token, serverUrl]);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      user,
      serverUrl,
      async login(username, password) {
        const res = await api<{ token: string; user: User }>('/api/auth/login', { body: { username, password } });
        await applySession(res.token, res.user);
      },
      async register(username, password, displayName) {
        const res = await api<{ token: string; user: User }>('/api/auth/register', {
          body: { username, password, displayName: displayName || undefined },
        });
        await applySession(res.token, res.user);
      },
      logout,
      async setServerUrl(url: string) {
        const clean = url.trim().replace(/\/+$/, '');
        setServer(clean);
        configureApi({ baseUrl: clean });
        await setItem(SERVER_KEY, clean || null);
      },
      async refreshUser() {
        setUser(await api<User>('/api/auth/me'));
      },
    }),
    [ready, user, serverUrl, applySession, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
