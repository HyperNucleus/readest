import { NextRequest, NextResponse } from 'next/server';
import { accessPolicy, isPublicAuthPage } from '@/config/accessPolicy';
import { getRequestToken, verifyAccessToken, isUnsafeCookieRequest } from '@/utils/serverAuth';

const allowedOrigins = [
  'https://web.readest.com',
  'https://tauri.localhost',
  'http://tauri.localhost',
  'http://localhost:3000',
  'http://localhost:3001',
  'tauri://localhost',
];

const corsOptions = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isApi = path === '/api' || path.startsWith('/api/');
  const isSession = path === '/api/auth/session';
  // Static assets carry no private user data. API paths are never exempted by
  // an extension (share covers and generated images are business endpoints).
  const isPublic =
    !isApi &&
    (isPublicAuthPage(path) ||
      path === '/runtime-config.js' ||
      /^\/swe-worker-[a-f0-9]+\.js$/.test(path) ||
      ['/_next/', '/assets/', '/fonts/', '/images/', '/locales/', '/vendor/', '/workers/'].some(
        (prefix) => path.startsWith(prefix),
      ) ||
      [
        '/favicon.ico',
        '/icon.png',
        '/icon-tiny.png',
        '/apple-touch-icon.png',
        '/manifest.json',
        '/sw.js',
      ].includes(path));
  let authResponse: NextResponse | undefined;
  if (accessPolicy.requireLogin && !isSession && !isPublic && request.method !== 'OPTIONS') {
    const user = await verifyAccessToken(getRequestToken(request));
    if (!user) {
      if (isApi) {
        authResponse = NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      } else {
        const login = new URL('/auth', request.url);
        login.searchParams.set('redirect', path + request.nextUrl.search);
        authResponse = NextResponse.redirect(login);
      }
    } else if (isUnsafeCookieRequest(request)) {
      authResponse = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  if (isApi) {
    const origin = request.headers.get('origin') ?? '';
    const isAllowedOrigin = allowedOrigins.includes(origin) || origin === request.nextUrl.origin;

    if (request.method === 'OPTIONS') {
      // Echo the requested headers rather than answering `*`: the Fetch spec
      // excludes `Authorization` from wildcard matching in the browser's
      // preflight cache, so a wildcard answer forces a fresh OPTIONS round
      // trip before every authenticated API call despite Max-Age.
      const requestedHeaders = request.headers.get('access-control-request-headers');
      const preflightHeaders = new Headers({
        ...corsOptions,
        'Access-Control-Allow-Headers': requestedHeaders || 'Authorization, Content-Type',
        Vary: 'Origin, Access-Control-Request-Headers',
        ...(isAllowedOrigin && { 'Access-Control-Allow-Origin': origin }),
      });

      return new NextResponse(null, {
        status: 200,
        headers: preflightHeaders,
      });
    }

    const response = authResponse || NextResponse.next();
    if (accessPolicy.requireLogin) response.headers.set('Cache-Control', 'private, no-store');

    if (isAllowedOrigin) {
      response.headers.set('Access-Control-Allow-Origin', origin);
    }

    Object.entries(corsOptions).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  }

  // Cross-origin isolation enables SharedArrayBuffer, which the Turso WASM
  // thread pool requires (initThreadPool hangs without it). Set on every
  // document response, not just /api/* — `crossOriginIsolated` is a property
  // of the top-level browsing context, determined by the document's headers.
  const response = authResponse || NextResponse.next();
  if (accessPolicy.requireLogin && !isPublic)
    response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // The /s share landing embeds the book cover via an <img> that redirects to a
  // cross-origin R2 presigned URL. Under COEP: require-corp the browser blocks
  // that image, because R2 can't attach a Cross-Origin-Resource-Policy header to
  // a presigned GET. `credentialless` keeps the page cross-origin isolated — so
  // EnvContext can still boot the Turso replica (SharedArrayBuffer) here when the
  // user has sync enabled — while dropping the CORP requirement for no-cors
  // subresources, letting the cover load with no client-side change. Every other
  // route keeps the stricter require-corp.
  const coep = path === '/s' || path.startsWith('/s/') ? 'credentialless' : 'require-corp';
  response.headers.set('Cross-Origin-Embedder-Policy', coep);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.json).*)'],
};
