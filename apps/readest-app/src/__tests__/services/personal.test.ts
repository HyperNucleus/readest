// 验证 Web 运行时配置与原生构建变量都能启用个人部署，且 Node API 不回退官方。
import { afterEach, expect, test, vi } from 'vitest';
import { getNodeBaseUrl } from '@/services/environment';
import { getServerRuntimeConfig } from '@/services/runtimeConfig';

afterEach(() => {
  vi.unstubAllEnvs();
  // 避免常量模块的构建变量缓存影响其他用例。
  vi.resetModules();
  delete window.__READEST_RUNTIME_CONFIG;
});

// 两种更新通道必须同时使用个人源与公钥，不能通过 nightly 偏好退回官方。
test('personal build uses its own stable, nightly and release-note endpoints', async () => {
  vi.stubEnv('NEXT_PUBLIC_UPDATER_BASE_URL', 'https://books.example.org/updates');
  vi.stubEnv('NEXT_PUBLIC_UPDATER_PUBKEY', 'personal-public-key');
  vi.resetModules();
  const constants = await import('@/services/constants');
  expect(constants.READEST_UPDATER_FILE).toBe('https://books.example.org/updates/latest.json');
  expect(constants.READEST_NIGHTLY_UPDATER_FILE).toBe(constants.READEST_UPDATER_FILE);
  expect(constants.READEST_CHANGELOG_FILE).toBe(
    'https://books.example.org/updates/release-notes.json',
  );
  expect(constants.READEST_UPDATER_PUBKEY).toBe('personal-public-key');
});

test('personal web runtime routes Node API to its own server', () => {
  window.__READEST_RUNTIME_CONFIG = { apiBaseUrl: 'https://books.example.org', selfHosted: true };
  expect(getNodeBaseUrl()).toBe('https://books.example.org');
});

test('runtime config includes the personal deployment policy', () => {
  vi.stubEnv('READEST_PERSONAL', 'true');
  expect(getServerRuntimeConfig()).toMatchObject({ personal: true });
});

// 验证原生客户端在没有 Web 运行时脚本时也显示导入的配额。
test('native client reads its baked public quotas', async () => {
  vi.stubEnv('NEXT_PUBLIC_STORAGE_FIXED_QUOTA', '2147483648');
  vi.stubEnv('NEXT_PUBLIC_TRANSLATION_FIXED_QUOTA', '75000');
  vi.stubEnv('STORAGE_FIXED_QUOTA', undefined);
  vi.stubEnv('TRANSLATION_FIXED_QUOTA', undefined);
  const { getStoragePlanData, getTranslationQuota } = await import('@/utils/access');
  const token = `e30.${btoa(JSON.stringify({ plan: 'free' }))}.signature`;
  expect(getStoragePlanData(token).quota).toBe(2147483648);
  expect(getTranslationQuota('free')).toBe(75000);
});
