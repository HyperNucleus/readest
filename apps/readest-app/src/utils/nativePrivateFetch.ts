import { fetch as tauriFetch, type ClientOptions } from '@tauri-apps/plugin-http';
import { withPrivateAuth } from './privateFetch';

// The native HTTP plugin does not use window.fetch or the browser cookie jar.
export const fetch = (input: RequestInfo | URL, init?: RequestInit & ClientOptions) =>
  withPrivateAuth(tauriFetch, () =>
    typeof window === 'undefined' ? null : window.localStorage.getItem('token'),
  )(input, init);
