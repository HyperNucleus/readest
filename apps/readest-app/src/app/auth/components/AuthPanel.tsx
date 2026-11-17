import { useRef } from 'react';
import Image from 'next/image';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FcGoogle } from 'react-icons/fc';
import { FaApple, FaGithub, FaDiscord } from 'react-icons/fa';
import { useTranslation } from '@/hooks/useTranslation';
import { ProviderLogin, type OAuthProvider } from './ProviderLogin';
import EmailPasswordAuth from './EmailPasswordAuth';
import ReadestCloudOptIn from './ReadestCloudOptIn';
// 个人账号由管理员脚本创建，不显示官方 OAuth 与 Readest Cloud 授权提示。
import { isPersonalDeployment } from '@/services/personal';

interface AuthPanelProps {
  supabaseClient: SupabaseClient;
  redirectTo?: string;
  magicLink?: boolean;
  onProviderSignIn: (provider: OAuthProvider) => Promise<void>;
}

export default function AuthPanel({
  supabaseClient,
  redirectTo,
  magicLink = false,
  onProviderSignIn,
}: AuthPanelProps) {
  const _ = useTranslation();
  // `signInWithOAuth` redirects the whole page on web, which can cut off the
  // opt-in's settings write. Hold sign-in until it has landed. Null until the
  // user actually touches the checkbox, so the common path adds no delay.
  const pendingCloudChoice = useRef<Promise<unknown> | null>(null);
  const handleProviderSignIn = async (provider: OAuthProvider) => {
    await pendingCloudChoice.current;
    return onProviderSignIn(provider);
  };

  return (
    <div className='flex w-full max-w-sm flex-col items-center gap-6'>
      <div className='flex flex-col items-center gap-3 text-center'>
        <Image src='/icon.png' alt='' width={56} height={56} className='eink-bordered rounded-xl' />
        <div>
          <h1 className='text-xl font-semibold tracking-tight'>{_('Sign in to Readest')}</h1>
          <p className='text-base-content/70 mt-1.5 text-sm leading-relaxed'>
            {_('Sync your library, reading progress, and highlights across your devices.')}
          </p>
        </div>
      </div>
      {/* 个人部署仅配置邮箱密码登录，不显示未配置的第三方登录按钮。 */}
      {!isPersonalDeployment() && (
        <>
          <div className='flex w-full flex-col gap-2.5'>
            <ProviderLogin
              provider='google'
              handleSignIn={handleProviderSignIn}
              Icon={FcGoogle}
              label={_('Sign in with {{provider}}', { provider: 'Google' })}
            />
            <ProviderLogin
              provider='apple'
              handleSignIn={handleProviderSignIn}
              Icon={FaApple}
              label={_('Sign in with {{provider}}', { provider: 'Apple' })}
            />
            <ProviderLogin
              provider='github'
              handleSignIn={handleProviderSignIn}
              Icon={FaGithub}
              label={_('Sign in with {{provider}}', { provider: 'GitHub' })}
            />
            <ProviderLogin
              provider='discord'
              handleSignIn={handleProviderSignIn}
              Icon={FaDiscord}
              label={_('Sign in with {{provider}}', { provider: 'Discord' })}
            />
          </div>
          <div className='flex w-full items-center gap-3' aria-hidden='true'>
            <hr className='border-base-300 flex-1 border-t' />
            <span className='text-base-content/50 text-xs'>{_('or continue with email')}</span>
            <hr className='border-base-300 flex-1 border-t' />
          </div>
        </>
      )}
      <EmailPasswordAuth
        supabaseClient={supabaseClient}
        redirectTo={redirectTo}
        magicLink={magicLink}
      />
      {/* 同步目标已由个人配置指定，不询问官方 Readest Cloud 的授权选择。 */}
      {!isPersonalDeployment() && (
        <ReadestCloudOptIn
          onPendingWrite={(write) => {
            pendingCloudChoice.current = write;
          }}
        />
      )}
    </div>
  );
}
