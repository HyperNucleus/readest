// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

vi.mock('@/utils/supabase', () => ({
  supabase: { auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } },
}));

describe('private deployment boundary', () => {
  it.each([
    '/api/opds/proxy?url=https://example.org',
    '/api/share/public/download',
    '/api/metadata/search',
    '/api/new-feature',
  ])('rejects anonymous API calls to %s', async (path) => {
    const response = await middleware(new NextRequest(`https://reader.example${path}`));
    expect(response.status).toBe(401);
  });
  it('redirects anonymous page requests to login', async () => {
    const response = await middleware(new NextRequest('https://reader.example/reader?ids=book'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth?redirect=');
  });
  it('allows login and preflight without a session', async () => {
    expect((await middleware(new NextRequest('https://reader.example/auth'))).status).toBe(200);
    expect(
      (
        await middleware(
          new NextRequest('https://reader.example/api/opds/proxy', { method: 'OPTIONS' }),
        )
      ).status,
    ).toBe(200);
  });
});

import { accessPolicy, AUTH_HEADER, safeAuthRedirect } from '@/config/accessPolicy';
import { supabase } from '@/utils/supabase';
import { afterEach } from 'vitest';
import { POST, DELETE } from '@/app/api/auth/session/route';

const validUser = { id: 'owner', role: 'authenticated', is_anonymous: false };
afterEach(() => {
  accessPolicy.requireLogin = true;
  accessPolicy.allowedUserIds = [];
  vi.mocked(supabase.auth.getUser).mockReset();
});

it('accepts a verified token separately from third-party proxy credentials', async () => {
  vi.mocked(supabase.auth.getUser).mockResolvedValue({
    data: { user: validUser },
    error: null,
  } as Awaited<ReturnType<typeof supabase.auth.getUser>>);
  const response = await middleware(
    new NextRequest('https://reader.example/api/opds/proxy', {
      headers: { [AUTH_HEADER]: 'Bearer valid', authorization: 'Basic catalog-password' },
    }),
  );
  expect(response.status).toBe(200);
  expect(supabase.auth.getUser).toHaveBeenCalledWith('valid');
  expect(response.headers.get('cache-control')).toContain('no-store');
});

it.each([
  { ...validUser, is_anonymous: true },
  { ...validUser, role: 'service_role' },
])('rejects anonymous accounts and service credentials', async (user) => {
  vi.mocked(supabase.auth.getUser).mockResolvedValue({ data: { user }, error: null } as Awaited<
    ReturnType<typeof supabase.auth.getUser>
  >);
  expect(
    (
      await middleware(
        new NextRequest('https://reader.example/api/share/test/og.png', {
          headers: { authorization: 'Bearer fake' },
        }),
      )
    ).status,
  ).toBe(401);
});

it('enforces the optional owner whitelist', async () => {
  accessPolicy.allowedUserIds = ['another-owner'];
  vi.mocked(supabase.auth.getUser).mockResolvedValue({
    data: { user: validUser },
    error: null,
  } as Awaited<ReturnType<typeof supabase.auth.getUser>>);
  expect(
    (
      await middleware(
        new NextRequest('https://reader.example/api/stats/restore', {
          headers: { authorization: 'Bearer valid' },
        }),
      )
    ).status,
  ).toBe(401);
});

it('rejects invalid and expired tokens even if a cookie is present', async () => {
  vi.mocked(supabase.auth.getUser).mockRejectedValue(new Error('expired'));
  expect(
    (
      await middleware(
        new NextRequest('https://reader.example/api/metadata/search', {
          headers: { cookie: 'readest-session=expired' },
        }),
      )
    ).status,
  ).toBe(401);
});

it('rejects cross-site writes with ambient cookies', async () => {
  vi.mocked(supabase.auth.getUser).mockResolvedValue({
    data: { user: validUser },
    error: null,
  } as Awaited<ReturnType<typeof supabase.auth.getUser>>);
  expect(
    (
      await middleware(
        new NextRequest('https://reader.example/api/share/create', {
          method: 'POST',
          headers: { cookie: 'readest-session=valid', origin: 'https://attacker.example' },
        }),
      )
    ).status,
  ).toBe(403);
});

it('does not exempt reader URLs just because they end in an extension', async () => {
  expect(
    (await middleware(new NextRequest('https://reader.example/reader/book.epub'))).status,
  ).toBe(307);
});

it('restores anonymous access when the shared switch is disabled', async () => {
  accessPolicy.requireLogin = false;
  expect((await middleware(new NextRequest('https://reader.example/library'))).status).toBe(200);
  expect((await middleware(new NextRequest('https://reader.example/api/new-feature'))).status).toBe(
    200,
  );
  expect(supabase.auth.getUser).not.toHaveBeenCalled();
});

it('sets an HttpOnly secure cookie only after verification', async () => {
  vi.mocked(supabase.auth.getUser).mockResolvedValue({
    data: { user: validUser },
    error: null,
  } as Awaited<ReturnType<typeof supabase.auth.getUser>>);
  const response = await POST(
    new NextRequest('https://reader.example/api/auth/session', {
      method: 'POST',
      headers: { authorization: 'Bearer valid' },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toMatch(
    /readest-session=valid.*Secure.*HttpOnly.*SameSite=strict/i,
  );
  const forged = await POST(
    new NextRequest('https://reader.example/api/auth/session', {
      method: 'POST',
      headers: { cookie: 'readest-session=valid' },
    }),
  );
  expect(forged.status).toBe(401);
});

it('clears the cookie on same-origin logout and rejects cross-site logout', () => {
  const request = (origin: string) =>
    new NextRequest('https://reader.example/api/auth/session', {
      method: 'DELETE',
      headers: { origin },
    });
  expect(DELETE(request('https://attacker.example')).status).toBe(403);
  expect(DELETE(request('https://reader.example')).headers.get('set-cookie')).toContain(
    'Max-Age=0',
  );
});

it.each([
  'https://attacker.example',
  '//attacker.example',
  '/\\attacker.example',
  '/auth',
])('rejects unsafe login redirects: %s', (path) => {
  expect(safeAuthRedirect(path)).toBe('/library');
});
