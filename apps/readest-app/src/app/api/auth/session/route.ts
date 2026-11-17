import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, AUTH_HEADER } from '@/config/accessPolicy';
import { getRequestOrigin, verifyAccessToken } from '@/utils/serverAuth';

export async function POST(request: NextRequest) {
  // Never accept an ambient cookie as proof when establishing a new session.
  const token = (request.headers.get(AUTH_HEADER) || request.headers.get('authorization'))?.match(
    /^Bearer (\S+)$/i,
  )?.[1];
  const user = await verifyAccessToken(token);
  const response = NextResponse.json(
    { authenticated: !!user },
    {
      status: user ? 200 : 401,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
  response.cookies.set(SESSION_COOKIE, user ? token! : '', {
    httpOnly: true,
    secure: new URL(getRequestOrigin(request)).protocol === 'https:',
    sameSite: 'strict',
    path: '/',
    // JWT validity is checked on every request, independently of cookie lifetime.
    maxAge: user ? 3600 : 0,
  });
  return response;
}

export function DELETE(request: NextRequest) {
  if (request.headers.get('origin') !== getRequestOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const response = NextResponse.json(
    { authenticated: false },
    { headers: { 'Cache-Control': 'no-store' } },
  );
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: new URL(getRequestOrigin(request)).protocol === 'https:',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  return response;
}
