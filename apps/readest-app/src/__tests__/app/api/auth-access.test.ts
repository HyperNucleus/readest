// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/auth/access/route';

vi.mock('@/utils/supabase', () => ({
  supabase: {
    auth: {
      getUser: async (token: string) => ({
        data: { user: token === 'valid' ? { id: 'reader', role: 'authenticated' } : null },
      }),
    },
  },
}));

test('authenticates proxy downloads and verifies the original method of cookie-authenticated uploads', async () => {
  const request = (headers: HeadersInit) =>
    new NextRequest('https://reader.example/api/auth/access', { headers });
  expect((await GET(request({}))).status).toBe(401);
  const cookie = { cookie: 'readest-session=valid' };
  expect((await GET(request(cookie))).status).toBe(204);
  const upload = { ...cookie, 'x-readest-original-method': 'PUT' };
  expect((await GET(request({ ...upload, authorization: 'Bearer broken token' }))).status).toBe(
    403,
  );
  expect((await GET(request({ ...upload, origin: 'https://reader.example' }))).status).toBe(204);
  expect((await GET(request({ ...upload, authorization: 'Bearer valid' }))).status).toBe(204);
});
