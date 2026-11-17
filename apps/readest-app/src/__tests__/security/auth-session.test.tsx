import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { accessPolicy } from '@/config/accessPolicy';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  refreshSession: vi.fn(),
}));
vi.mock('@/utils/supabase', () => ({
  supabase: {
    auth: {
      ...mocks,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  },
}));
vi.mock('posthog-js', () => ({ default: { identify: vi.fn() } }));
vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: () => '/api',
  getNodeAPIBaseUrl: () => '/api',
}));
const user = { id: 'owner', role: 'authenticated', is_anonymous: false };
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
  accessPolicy.requireLogin = true;
  accessPolicy.allowedUserIds = [];
  request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', request);
  mocks.getSession.mockResolvedValue({
    data: {
      session: { access_token: 'valid', user, expires_at: Math.floor(Date.now() / 1000) + 3600 },
    },
    error: null,
  });
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  accessPolicy.allowedUserIds = [];
});

it('never trusts forged localStorage user and token values', async () => {
  localStorage.setItem('user', JSON.stringify(user));
  localStorage.setItem('token', 'forged');
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error('invalid token') });
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  expect(result.current.status).toBe('loading');
  expect(result.current.user).toBeNull();
  await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
  expect(localStorage.getItem('user')).toBeNull();
});

it('does not admit a verified user until the server cookie is established', async () => {
  let finish!: (response: Response) => void;
  request.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(result.current.status).toBe('loading');
  await act(async () => finish(new Response(null, { status: 200 })));
  await waitFor(() => expect(result.current.status).toBe('authenticated'));
});

it('fails closed when backend authentication fails', async () => {
  request.mockResolvedValue(new Response(null, { status: 401 }));
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
  expect(result.current.token).toBeNull();
});

it('does not restore a stale verification result after logout', async () => {
  let finish!: (value: { data: { user: typeof user }; error: null }) => void;
  mocks.getUser.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  await waitFor(() => expect(mocks.getUser).toHaveBeenCalled());
  await act(async () => {
    await result.current.logout();
  });
  await act(async () => finish({ data: { user }, error: null }));
  expect(result.current.status).toBe('unauthenticated');
  expect(result.current.user).toBeNull();
  expect(request.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
});

it('rejects a user outside the owner whitelist', async () => {
  accessPolicy.allowedUserIds = ['other'];
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
});

it('closes the reader when its session has expired', async () => {
  mocks.getSession.mockResolvedValue({
    data: {
      session: { access_token: 'expired', user, expires_at: Math.floor(Date.now() / 1000) - 1 },
    },
    error: null,
  });
  const { result } = renderHook(useAuth, { wrapper: AuthProvider });
  await waitFor(() => expect(request).toHaveBeenCalled());
  await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
});
