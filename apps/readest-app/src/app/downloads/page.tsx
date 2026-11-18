'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { isPersonalDeployment } from '@/services/personal';

const installers = [
  { platform: 'android-arm64', filename: 'android-arm64.apk', label: 'Android ARM64 (APK)' },
  { platform: 'windows-x86_64', filename: 'windows-x86_64.exe', label: 'Windows x64 (EXE)' },
  {
    platform: 'darwin-aarch64',
    filename: 'darwin-aarch64.dmg',
    label: 'macOS Apple Silicon (DMG)',
  },
];

export default function DownloadsPage() {
  const _ = useTranslation();
  const [version, setVersion] = useState<string | null>();

  useEffect(() => {
    if (!isPersonalDeployment()) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/updates/latest.json', { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { version } = await response.json();
        setVersion(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : null);
      } catch {
        if (!controller.signal.aborted) setVersion(null);
      }
    })();
    return () => controller.abort();
  }, []);

  if (!isPersonalDeployment()) return null;

  return (
    <main className='mx-auto flex max-w-lg flex-col gap-5 px-6 py-12'>
      <h1 className='text-2xl font-semibold'>{_('Downloads')}</h1>
      {version ? (
        <>
          <p>{version}</p>
          {installers.map(({ platform, filename, label }) => (
            <a
              key={platform}
              className='btn btn-contrast eink-bordered'
              href={`/updates/${version}/${platform}/${filename}`}
              download={filename}
            >
              {label}
            </a>
          ))}
        </>
      ) : (
        <p role='status'>{version === undefined ? _('Loading...') : _('No downloads available')}</p>
      )}
    </main>
  );
}
