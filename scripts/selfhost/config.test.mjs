// 覆盖密钥误导出、危险域名和配置原子保存，防止多机配置污染或泄露。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clientProfile, saveJson, httpsOrigin } from './config.mjs';

// 测试 JWT 只用于角色校验，不使用任何实际部署凭据。
const token = (role) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role })).toString('base64url'),
  Buffer.alloc(32, 1).toString('base64url'),
].join('.');

// 最小有效公开配置供各项边界测试复用。
const profile = () => ({
  version: 1,
  serverUrl: 'https://books.example.org',
  supabaseAnonKey: token('anon'),
  appName: 'Personal Reader',
  appId: 'org.example.reader',
  scheme: 'personal-reader',
  // 配额随公开配置同步，客户端显示值应与服务端相同。
  storageQuota: 1073741824, translationQuota: 50000,
  updaterPublicKey: Buffer.from('untrusted comment: test\nRW' + 'A'.repeat(54)).toString('base64'),
});

// 混入服务端字段时仍只能导出白名单字段。
test('client export never carries server credentials or signing secrets', () => {
  const exported = clientProfile({
    ...profile(), postgresPassword: 'do-not-export', serviceRoleKey: token('service_role'),
    signing: { privateKey: 'do-not-export' },
  });
  assert.deepEqual(exported, profile());
  assert.ok(!JSON.stringify(exported).includes('do-not-export'));
});

// 管理员权限的 key 不能进入客户端配置。
test('an administrator JWT cannot be embedded in a client', () => {
  assert.throws(() => clientProfile({ ...profile(), supabaseAnonKey: token('service_role') }), /anon/);
  assert.throws(() => clientProfile({ ...profile(), supabaseAnonKey: 'invalid' }), /anon/);
});

// 域名输入同时作为 URL 和反向代理配置使用，必须拒绝注入及非域名地址。
test('rejects origins that would leak credentials, change routing or inject generated config', () => {
  for (const url of [
    'http://books.example.org', 'https://user:pass@books.example.org',
    'https://books.example.org/subpath', 'https://books.example.org?key=secret',
    'https://books.example.org/#fragment', 'https://127.0.0.1',
    'https://books.example.org\n', 'https://books.example.org;bad', 'https://books.example.org:8443',
  ]) assert.throws(() => httpsOrigin(url), undefined, url);
  assert.equal(httpsOrigin('https://BOOKS.example.org/'), 'https://books.example.org');
});

// 自编译身份不能误用官方身份，也不能默默读取未来格式。
test('rejects official app identity and unsupported profile versions', () => {
  assert.throws(() => clientProfile({ ...profile(), appId: 'com.bilingify.readest' }));
  assert.throws(() => clientProfile({ ...profile(), scheme: 'readest' }));
  // macOS 的 .app 安装路径取决于显示名称，同名也会与官方安装冲突。
  assert.throws(() => clientProfile({ ...profile(), appName: 'Readest' }));
  assert.throws(() => clientProfile({ ...profile(), version: 2 }));
});

// 验证实际磁盘权限和覆盖行为，而不只检查实现文本。
test('saved configuration replaces cleanly and is private on POSIX', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'readest-selfhost-'));
  try {
    const filename = path.join(directory, 'nested', 'profile.json');
    await saveJson(filename, { old: true });
    await saveJson(filename, profile());
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), profile());
    if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
