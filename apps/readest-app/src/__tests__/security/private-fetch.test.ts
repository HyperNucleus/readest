import { afterEach, expect, it, vi } from 'vitest';
import { withPrivateAuth } from '@/utils/privateFetch';
import { accessPolicy, AUTH_HEADER } from '@/config/accessPolicy';
vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: () => 'https://reader.example/api',
  getNodeAPIBaseUrl: () => 'https://reader.example/api',
}));
afterEach(() => {
  accessPolicy.requireLogin = true;
});

it('adds a separate credential without replacing catalog Authorization', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response());
  await withPrivateAuth(fetcher, () => 'valid')('https://reader.example/api/opds/proxy', {
    headers: { Authorization: 'Basic catalog' },
  });
  const init = fetcher.mock.calls[0]![1] as RequestInit;
  expect(new Headers(init.headers).get(AUTH_HEADER)).toBe('Bearer valid');
  expect(new Headers(init.headers).get('Authorization')).toBe('Basic catalog');
  expect(init.redirect).toBe('error');
});

it.each([
  'https://evil.example/api/metadata',
  'https://reader.example/api-fake',
  'https://storage.example/book',
  'https://reader.example/api/auth/session',
])('does not attach credentials to %s', async (url) => {
  const fetcher = vi.fn().mockResolvedValue(new Response());
  await withPrivateAuth(fetcher, () => 'secret')(url);
  expect(fetcher.mock.calls[0]![1]).toBeUndefined();
});

it('does not change requests when disabled', async () => {
  accessPolicy.requireLogin = false;
  const fetcher = vi.fn().mockResolvedValue(new Response());
  await withPrivateAuth(fetcher, () => 'secret')('https://reader.example/api/metadata');
  expect(fetcher.mock.calls[0]![1]).toBeUndefined();
});

it('uses standard Authorization for downloads so fetch can strip it on cross-origin redirects', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response());
  await withPrivateAuth(fetcher, () => 'valid')('https://reader.example/api/share/token/download');
  const init = fetcher.mock.calls[0]![1] as RequestInit;
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer valid');
  expect(new Headers(init.headers).has(AUTH_HEADER)).toBe(false);
  expect(init.redirect).toBeUndefined();
});

it('never puts the app token in the header forwarded to an OPDS catalog', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response());
  await withPrivateAuth(
    fetcher,
    () => 'secret',
  )('https://reader.example/api/opds/proxy?url=https://catalog.example');
  const init = fetcher.mock.calls[0]![1] as RequestInit;
  expect(new Headers(init.headers).has('Authorization')).toBe(false);
  expect(new Headers(init.headers).get(AUTH_HEADER)).toBe('Bearer secret');
});
