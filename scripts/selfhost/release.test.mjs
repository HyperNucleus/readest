// 用真实 Ed25519 签名检验发布校验，确保篡改文件或混用密钥无法发布。
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { verifyArtifact, receiveRelease, PLATFORMS } from './release.mjs';
import { releaseVersion } from './build.mjs';
import { shellQuote, run } from './process.mjs';
import { APP, saveJson, loadJson } from './config.mjs';
import { access, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 构造与 minisign 兼容的包头与预哈希签名，不依赖外部签名工具。
test('release verification rejects tampering and wrong keys', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const data = Buffer.from('personal application artifact');
  const publicPacket = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]);
  const encoded = (packet) => Buffer.from(`untrusted comment: test\n${packet.toString('base64')}\n`).toString('base64');
  for (const algorithm of ['Ed', 'ED']) {
    const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
    const signature = encoded(Buffer.concat([Buffer.from(algorithm), id, sign(null, message, privateKey)]));
    assert.equal(verifyArtifact(data, signature, encoded(publicPacket)), true);
    assert.equal(verifyArtifact(Buffer.from('tampered'), signature, encoded(publicPacket)), false);
    assert.equal(verifyArtifact(data, signature, encoded(Buffer.alloc(42))), false);
  }
});

// Android versionCode 与稳定版排序保持一致，拒绝无法映射的版本。
test('version mapping is increasing and rejects unsafe version paths', () => {
  assert.ok(releaseVersion('1.0.0').code > releaseVersion('0.999.999').code);
  for (const value of ['../1', '1.2.3-beta', '1.1000.0', '1.2']) assert.throws(() => releaseVersion(value));
});

// SSH 远端命令中的引号不会让路径被当作 shell 命令执行。
test('remote shell quoting encloses embedded quotes', () => {
  assert.equal(shellQuote("a'b;$HOME"), "'a'\\''b;$HOME'");
});

// 用真正的 Tauri CLI 生成并签名临时文件，校验生产签名格式而不是仅靠自制 fixture。
test('verifies a real Tauri signer artifact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'readest-signature-'));
  const cli = path.join(APP, 'node_modules/@tauri-apps/cli/tauri.js');
  try {
    const key = path.join(directory, 'test.key');
    const artifact = path.join(directory, 'test.bin');
    await writeFile(artifact, 'test artifact');
    await run('node', [cli, 'signer', 'generate', '--ci', '-w', key], { capture: true });
    await run('node', [cli, 'signer', 'sign', artifact], { capture: true, env: {
      TAURI_SIGNING_PRIVATE_KEY: await readFile(key, 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    } });
    assert.equal(verifyArtifact(await readFile(artifact), await readFile(`${artifact}.sig`, 'utf8'), await readFile(`${key}.pub`, 'utf8')), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 三平台发布流程在临时目录真实读写：缺平台不发布、到齐发布、重复上传幂等。
test('publishes only after all three platforms arrive and supports retries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'readest-publish-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const id = randomBytes(8);
    const encode = (packet) => Buffer.from(`untrusted comment: fixture\n${packet.toString('base64')}\n`).toString('base64');
    const pub = encode(Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]));
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from('{"role":"anon"}').toString('base64url'), 'fake-signature'].join('.');
    const profile = { version: 1, serverUrl: 'https://books.example.org', supabaseAnonKey: jwt,
      appName: 'Personal Reader', appId: 'org.example.reader', scheme: 'personal-reader', updaterPublicKey: pub,
      storageQuota: 1073741824, translationQuota: 50000 };
    const server = { dataDir: path.join(directory, 'data') };
    const latest = path.join(server.dataDir, 'updates/latest.json');
    for (const platform of PLATFORMS) {
      const input = path.join(directory, platform);
      await mkdir(input);
      const name = `${platform}${platform.startsWith('darwin') ? '.app.tar.gz' : platform.startsWith('windows') ? '.exe' : '.apk'}`;
      const bytes = Buffer.from(`artifact ${platform}`);
      await writeFile(path.join(input, name), bytes);
      const artifacts = [{ name, sha256: createHash('sha256').update(bytes).digest('hex') }];
      if (platform.startsWith('darwin')) {
        await writeFile(path.join(input, 'darwin-aarch64.dmg'), bytes);
        artifacts.push({ name: 'darwin-aarch64.dmg', sha256: artifacts[0].sha256 });
      }
      const signature = encode(Buffer.concat([Buffer.from('Ed'), id, sign(null, bytes, privateKey)]));
      await saveJson(path.join(input, 'release.json'), { schema: 1, version: '1.0.0', platform, appId: profile.appId,
        serverUrl: profile.serverUrl, publicKey: pub, artifact: name, signature, artifacts });
      await receiveRelease(input, profile, server, path.join(directory, 'state'));
      if (platform !== PLATFORMS.at(-1)) await assert.rejects(access(latest));
    }
    assert.deepEqual(Object.keys((await loadJson(latest)).platforms), PLATFORMS);
    await receiveRelease(path.join(directory, PLATFORMS[0]), profile, server, path.join(directory, 'state'));
    assert.equal((await loadJson(latest)).version, '1.0.0');
    // 同一版本不能用篡改的字节覆盖已发布目录。
    await writeFile(path.join(directory, PLATFORMS[2], `${PLATFORMS[2]}.apk`), 'tampered');
    await assert.rejects(receiveRelease(path.join(directory, PLATFORMS[2]), profile, server, path.join(directory, 'state')), /哈希/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
