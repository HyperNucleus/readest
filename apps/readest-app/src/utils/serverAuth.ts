import type { NextRequest } from 'next/server';
import { supabase } from '@/utils/supabase';
import { AUTH_HEADER, SESSION_COOKIE, isAllowedUser } from '@/config/accessPolicy';

export const getRequestToken = (request: NextRequest) => {
  const header = request.headers.get(AUTH_HEADER) || request.headers.get('authorization');
  const bearer = header?.match(/^Bearer (\S+)$/i)?.[1];
  return bearer || request.cookies.get(SESSION_COOKIE)?.value;
};

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
export const isUnsafeCookieRequest = (request: NextRequest) => {
  if (/^(GET|HEAD|OPTIONS)$/.test(request.method)) return false;
  if (request.headers.get(AUTH_HEADER)?.match(/^Bearer /i)) return false;
  if (request.headers.get('authorization')?.match(/^Bearer /i)) return false;
  return request.headers.get('origin') !== request.nextUrl.origin;
};
