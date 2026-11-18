import { NextRequest, NextResponse } from 'next/server';
import { accessPolicy } from '@/config/accessPolicy';
import { getRequestToken, isUnsafeCookieRequest, verifyAccessToken } from '@/utils/serverAuth';

// Also authenticates static downloads and storage transfers handled by Nginx.
export async function GET(request: NextRequest) {
  const allowed =
    !accessPolicy.requireLogin || !!(await verifyAccessToken(getRequestToken(request)));
  const method = request.headers.get('x-readest-original-method') || request.method;
  const forbidden = accessPolicy.requireLogin && isUnsafeCookieRequest(request, method);
  return new NextResponse(null, {
    status: !allowed ? 401 : forbidden ? 403 : 204,
    headers: { 'Cache-Control': 'no-store' },
  });
}
