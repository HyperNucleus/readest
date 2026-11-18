import type { NextRequest } from 'next/server';
import { supabase } from '@/utils/supabase';
import { AUTH_HEADER, SESSION_COOKIE, isAllowedUser } from '@/config/accessPolicy';

// Route handlers can see the container's internal host even when middleware
// sees the public URL. Use deployment configuration, not client-supplied
// forwarded headers, as the trusted origin for cookies and CSRF checks.
export const getRequestOrigin = (request: NextRequest) =>
  new URL(process.env['API_BASE_URL'] || process.env['SITE_URL'] || request.url).origin;

const getBearerToken = (request: NextRequest) => {
  const header = request.headers.get(AUTH_HEADER) || request.headers.get('authorization');
  return header?.match(/^Bearer (\S+)$/i)?.[1];
};

export const getRequestToken = (request: NextRequest) =>
  getBearerToken(request) || request.cookies.get(SESSION_COOKIE)?.value;

export const verifyAccessToken = async (token?: string) => {
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    return !error && data.user && isAllowedUser(data.user) ? data.user : null;
  } catch {
    return null;
  }
};

// Cookie-authenticated writes must originate from this app. Native clients use
// an explicit token header instead; third-party OPDS credentials are unrelated.
export const isUnsafeCookieRequest = (request: NextRequest, method = request.method) => {
  if (/^(GET|HEAD|OPTIONS)$/.test(method)) return false;
  if (getBearerToken(request)) return false;
  return request.headers.get('origin') !== getRequestOrigin(request);
};
