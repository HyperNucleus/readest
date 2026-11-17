import { NextRequest, NextResponse } from 'next/server';
import { accessPolicy } from '@/config/accessPolicy';
import { getRequestToken, verifyAccessToken } from '@/utils/serverAuth';

// Used by the self-hosted reverse proxy before forwarding direct PostgREST
// calls, which do not pass through Next.js business API routes.
export async function GET(request: NextRequest) {
  const allowed =
    !accessPolicy.requireLogin || !!(await verifyAccessToken(getRequestToken(request)));
  return new NextResponse(null, {
    status: allowed ? 204 : 401,
    headers: { 'Cache-Control': 'no-store' },
  });
}
