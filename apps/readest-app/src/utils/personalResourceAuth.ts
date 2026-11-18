import { accessPolicy } from '@/config/accessPolicy';
import { getBaseUrl } from '@/services/environment';
import { isPersonalDeployment } from '@/services/personal';
import { getAccessToken } from '@/utils/access';

// These paths belong to the configured personal server. A signed URL from
// S3, an OPDS catalog, or an update mirror must not receive our login token.
export const isPersonalResourceUrl = (url: string, prefix: '/updates/' | '/readest-files/') => {
  if (!isPersonalDeployment()) return false;
  try {
    const target = new URL(url);
    return (
      target.origin === new URL(getBaseUrl()).origin &&
      !target.username &&
      !target.password &&
      target.pathname.startsWith(prefix)
    );
  } catch {
    return false;
  }
};

export const personalResourceHeaders = async (
  url: string,
  prefix: '/updates/' | '/readest-files/',
) => {
  if (!accessPolicy.requireLogin || !isPersonalResourceUrl(url, prefix)) return undefined;
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
};
