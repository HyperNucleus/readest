'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { accessPolicy, isPublicAuthPage, safeAuthRedirect } from '@/config/accessPolicy';

export default function AuthGuard({
  children,
  onRedirect,
}: {
  children: ReactNode;
  onRedirect: (path: string) => void;
}) {
  const pathname = usePathname();
  const { status } = useAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isPublic = isPublicAuthPage(pathname ?? '');
  useEffect(() => {
    if (!accessPolicy.requireLogin || !mounted || isPublic || status !== 'unauthenticated') return;
    const redirect = safeAuthRedirect(
      window.location.pathname + window.location.search + window.location.hash,
    );
    onRedirect(`/auth?redirect=${encodeURIComponent(redirect)}`);
  }, [mounted, pathname, isPublic, status, onRedirect]);

  if (!accessPolicy.requireLogin || isPublic) return children;
  if (!mounted || status !== 'authenticated') {
    return (
      <div className='bg-base-100 fixed inset-0 flex items-center justify-center' role='status'>
        <span className='loading loading-spinner loading-lg' />
      </div>
    );
  }
  return children;
}
