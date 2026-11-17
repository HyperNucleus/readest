// 前后端共用的代码开关。修改后需要重新构建并部署网页/API 和原生客户端。
export const accessPolicy = {
  requireLogin: true,
  // 留空允许本实例中所有正式账号；完全自用可填入自己的 Supabase user ID。
  allowedUserIds: [] as string[],
};

export const SESSION_COOKIE = 'readest-session';
export const AUTH_HEADER = 'x-readest-authorization';

export const isAllowedUser = (user: { id: string; is_anonymous?: boolean; role?: string }) =>
  user.role === 'authenticated' &&
  !user.is_anonymous &&
  (!accessPolicy.allowedUserIds.length || accessPolicy.allowedUserIds.includes(user.id));

export const isPublicAuthPage = (path: string) =>
  ['/auth', '/auth/callback', '/auth/error', '/auth/recovery', '/auth/update'].includes(
    path.replace(/\/$/, '') || '/',
  );

export const safeAuthRedirect = (value: string | null | undefined) => {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) {
    return '/library';
  }
  try {
    const url = new URL(value, 'https://readest.invalid');
    if (url.origin !== 'https://readest.invalid' || isPublicAuthPage(url.pathname))
      return '/library';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/library';
  }
};
