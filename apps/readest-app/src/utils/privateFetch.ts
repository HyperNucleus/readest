import { accessPolicy, AUTH_HEADER } from '@/config/accessPolicy';
import { getAPIBaseUrl, getNodeAPIBaseUrl } from '@/services/environment';

// Only attach our credentials to this application's API, never to an OPDS
// catalog, a storage presigned URL, or another arbitrary remote resource.
export const withPrivateAuth =
  (fetcher: typeof fetch, getToken: () => string | null): typeof fetch =>
  (input, init) => {
    if (!accessPolicy.requireLogin) return fetcher(input, init);
    const token = getToken();
    if (!token) return fetcher(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const isApi = [getAPIBaseUrl(), getNodeAPIBaseUrl()].some((base) => {
      const api = new URL(base, window.location.href);
      return (
        url.origin === api.origin &&
        (url.pathname === api.pathname || url.pathname.startsWith(`${api.pathname}/`))
      );
    });
    if (url.pathname === '/api/auth/session') return fetcher(input, init);
    if (!isApi) return fetcher(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const authorization = headers.get('authorization');
    const isCatalogProxy = url.pathname.endsWith('/api/opds/proxy');
    if (!isCatalogProxy && (!authorization || authorization === `Bearer ${token}`)) {
      // Fetch strips the standard Authorization header on cross-origin redirects,
      // so authenticated download routes can still redirect to signed storage URLs.
      headers.set('Authorization', `Bearer ${token}`);
      return fetcher(input, { ...init, headers });
    }
    headers.set(AUTH_HEADER, `Bearer ${token}`);
    // Custom headers are not automatically stripped on redirects. Proxy requests
    // that already carry catalog credentials must never forward our second token.
    return fetcher(input, { ...init, headers, redirect: 'error' });
  };
