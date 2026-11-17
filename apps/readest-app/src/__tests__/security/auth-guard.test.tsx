import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AuthGuard from '@/components/AuthGuard';
import { accessPolicy } from '@/config/accessPolicy';
const state = vi.hoisted(() => ({ pathname: '/library', status: 'loading' }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ status: state.status }) }));
afterEach(() => {
  cleanup();
  state.status = 'loading';
  state.pathname = '/library';
  accessPolicy.requireLogin = true;
});
it('does not mount private children while checking the session', () => {
  const mounted = vi.fn();
  function Private() {
    mounted();
    return <div>Private book</div>;
  }
  render(
    <AuthGuard onRedirect={vi.fn()}>
      <Private />
    </AuthGuard>,
  );
  expect(mounted).not.toHaveBeenCalled();
});
it('allows verified readers', () => {
  state.status = 'authenticated';
  render(
    <AuthGuard onRedirect={vi.fn()}>
      <div>Private book</div>
    </AuthGuard>,
  );
  expect(screen.getByText('Private book')).toBeTruthy();
});
it('keeps login accessible without a session', () => {
  state.pathname = '/auth';
  state.status = 'unauthenticated';
  render(
    <AuthGuard onRedirect={vi.fn()}>
      <div>Login form</div>
    </AuthGuard>,
  );
  expect(screen.getByText('Login form')).toBeTruthy();
});
it('restores guest use when disabled', () => {
  accessPolicy.requireLogin = false;
  state.status = 'unauthenticated';
  render(
    <AuthGuard onRedirect={vi.fn()}>
      <div>Guest reader</div>
    </AuthGuard>,
  );
  expect(screen.getByText('Guest reader')).toBeTruthy();
});

it('unmounts private content and navigates without unloading logout requests', () => {
  const redirect = vi.fn();
  state.status = 'authenticated';
  const { rerender } = render(
    <AuthGuard onRedirect={redirect}>
      <div>Private book</div>
    </AuthGuard>,
  );
  state.status = 'unauthenticated';
  rerender(
    <AuthGuard onRedirect={redirect}>
      <div>Private book</div>
    </AuthGuard>,
  );
  expect(screen.queryByText('Private book')).toBeNull();
  expect(redirect).toHaveBeenCalledWith(expect.stringContaining('/auth?redirect='));
});
