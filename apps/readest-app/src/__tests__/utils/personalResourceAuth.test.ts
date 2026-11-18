import { expect, test, vi } from 'vitest';
import { personalResourceHeaders } from '@/utils/personalResourceAuth';

vi.mock('@/services/personal', () => ({ isPersonalDeployment: () => true }));
vi.mock('@/services/environment', () => ({ getBaseUrl: () => 'https://reader.example' }));
vi.mock('@/utils/access', () => ({ getAccessToken: async () => 'session-token' }));

test('only sends the session to matching resources on the configured server', async () => {
  await expect(
    personalResourceHeaders('https://reader.example/updates/latest.json', '/updates/'),
  ).resolves.toEqual({ Authorization: 'Bearer session-token' });
  await expect(
    personalResourceHeaders(
      'https://reader.example/readest-files/book?X-Amz-Signature=abc',
      '/readest-files/',
    ),
  ).resolves.toEqual({ Authorization: 'Bearer session-token' });
  for (const url of [
    'https://reader.example.attacker.example/updates/latest.json',
    'http://reader.example/updates/latest.json',
    'https://reader.example/updates/../api/auth/session',
    'https://reader.example/readest-files/book',
    'https://name:password@reader.example/updates/latest.json',
    '/updates/latest.json',
  ]) {
    await expect(personalResourceHeaders(url, '/updates/')).resolves.toBeUndefined();
  }
});
