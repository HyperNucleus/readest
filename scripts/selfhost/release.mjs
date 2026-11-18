// 更新发布只接受配置匹配且签名有效的三平台产物；先上传全部文件，再原子切换清单。
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, STATE, clientProfile, loadJson, saveJson } from './config.mjs';
import { releaseVersion } from './build.mjs';
import { run, shellQuote } from './process.mjs';

export const PLATFORMS = ['darwin-aarch64', 'windows-x86_64', 'android-arm64'];

// Tauri/minisign 的 Ed25519 签名封包含算法与 key ID；ED 先作 BLAKE2b-512 预哈希。
export function verifyArtifact(data, signature, publicKey) {
  try {
    const key = Buffer.from(Buffer.from(publicKey, 'base64').toString().trim().split('\n')[1], 'base64');
    const sig = Buffer.from(Buffer.from(signature, 'base64').toString().trim().split('\n')[1], 'base64');
    if (key.length !== 42 || sig.length !== 74 || !key.subarray(2, 10).equals(sig.subarray(2, 10))) return false;
    const algorithm = sig.subarray(0, 2).toString();
    if (!['Ed', 'ED'].includes(algorithm)) return false;
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]);
    const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
    return verify(null, message, createPublicKey({ key: spki, type: 'spki', format: 'der' }), sig.subarray(10));
  } catch { return false; }
}

// 文件名限定为当前平台的产物，禁止路径穿越、符号链接和额外文件进入公开更新目录。
export async function inspectRelease(directory, profile) {
  const p = clientProfile(profile);
  const r = await loadJson(path.join(directory, 'release.json'));
  releaseVersion(r.version);
  if (r.schema !== 1 || !PLATFORMS.includes(r.platform) || r.appId !== p.appId ||
    r.serverUrl !== p.serverUrl || r.publicKey !== p.updaterPublicKey) throw new Error('发布配置与目标服务器/应用/更新公钥不匹配');
  const suffix = r.platform === 'darwin-aarch64' ? '.app.tar.gz' : r.platform === 'windows-x86_64' ? '.exe' : '.apk';
  if (r.artifact !== `${r.platform}${suffix}` || !Array.isArray(r.artifacts)) throw new Error('发布产物名称无效');
  const expected = [r.artifact, ...(r.platform === 'darwin-aarch64' ? ['darwin-aarch64.dmg'] : [])];
  if (r.artifacts.length !== expected.length || new Set(r.artifacts.map((a) => a.name)).size !== expected.length) throw new Error('发布文件不完整或重复');
  const root = await realpath(directory);
  for (const artifact of r.artifacts) {
    if (!expected.includes(artifact.name)) throw new Error('发布文件不在白名单内');
    const file = path.join(directory, artifact.name);
    if (path.dirname(await realpath(file)) !== root || !(await stat(file)).isFile()) throw new Error('发布文件必须位于上传目录中');
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('发布文件哈希不匹配');
    if (artifact.name === r.artifact && !verifyArtifact(bytes, r.signature, p.updaterPublicKey)) throw new Error('更新签名校验失败');
  }
  return r;
}

// 同一版本的三平台产物先汇总在私有 staging，缺一个平台就保持旧清单不动。
export async function receiveRelease(directory, profile, server, stateDir = STATE) {
  const r = await inspectRelease(directory, profile);
  const stage = path.join(stateDir, 'pending', r.version);
  const destination = path.join(stage, r.platform);
  await mkdir(destination, { recursive: true });
  for (const a of r.artifacts) await cp(path.join(directory, a.name), path.join(destination, a.name));
  await saveJson(path.join(destination, 'release.json'), r);
  const collected = [];
  for (const platform of PLATFORMS) {
    try { collected.push(await inspectRelease(path.join(stage, platform), profile)); }
    catch (error) { if (error.code === 'ENOENT') { console.log(`已接收 ${r.platform}，等待 ${platform}`); return; } throw error; }
  }
  const updates = path.join(server.dataDir, 'updates');
  const previous = await loadJson(path.join(updates, 'latest.json'), { version: '0.0.0' });
  if (releaseVersion(r.version).code < releaseVersion(previous.version).code) throw new Error('不能回退到旧版本');
  await mkdir(updates, { recursive: true, mode: 0o755 });
  const finalDirectory = path.join(updates, r.version);
  const temp = path.join(updates, `.publishing-${randomUUID()}`);
  // 支持文件已发布、清单尚未切换时的重试；同版本内容不同则拒绝覆盖。
  let alreadyCopied = false;
  try {
    await stat(finalDirectory);
    alreadyCopied = true;
    for (const entry of collected) {
      const published = await inspectRelease(path.join(finalDirectory, entry.platform), profile);
      if (JSON.stringify(published.artifacts) !== JSON.stringify(entry.artifacts)) throw new Error('同版本已有不同产物，请递增版本');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous.version === r.version) { console.log(`版本 ${r.version} 已发布，内容一致，无需重复发布`); return; }
  if (!alreadyCopied) await cp(stage, temp, { recursive: true });
  // 安装包开放只读权限；父目录权限需允许 Nginx 访问，文档中提供检查方法。
  const { chmod } = await import('node:fs/promises');
  const prepared = alreadyCopied ? finalDirectory : temp;
  await chmod(prepared, 0o755);
  for (const entry of collected) {
    await chmod(path.join(prepared, entry.platform), 0o755);
    for (const artifact of entry.artifacts) await chmod(path.join(prepared, entry.platform, artifact.name), 0o644);
  }
  if (!alreadyCopied) await rename(temp, finalDirectory);
  const platforms = Object.fromEntries(collected.map((entry) => [entry.platform, {
    url: `${profile.serverUrl}/updates/${r.version}/${entry.platform}/${entry.artifact}`, signature: entry.signature,
  }]));
  const notes = ['Personal self-hosted build'];
  const changelogFile = path.join(updates, 'release-notes.json');
  const changelog = await loadJson(changelogFile, { releases: {} });
  changelog.releases[r.version] = { date: new Date().toISOString(), notes };
  await saveJson(changelogFile, changelog);
  await chmod(changelogFile, 0o644);
  // 最后发布 latest.json：客户端不会先看到清单却下载到尚未上传的包。
  const manifestFile = path.join(updates, 'latest.json');
  await saveJson(manifestFile, { version: r.version, pub_date: new Date().toISOString(), notes: notes.join('\n'), platforms });
  await chmod(manifestFile, 0o644);
  console.log(`已发布 ${r.version}：${profile.serverUrl}/updates/latest.json`);
}

// 使用系统 OpenSSH，保留主机指纹确认和 ssh-agent；不保存 SSH 密码。
export async function uploadRelease(directory, profile, ssh) {
  const r = await inspectRelease(directory, profile);
  if (!/^[a-zA-Z0-9_.-]+$/.test(ssh.host) || !/^[a-zA-Z0-9_-]+$/.test(ssh.user) ||
    !/^\/[a-zA-Z0-9_./-]+$/.test(ssh.repository) || ssh.repository.split('/').includes('..')) throw new Error('SSH 主机/用户/仓库路径格式无效');
  const destination = `${ssh.user}@${ssh.host}`;
  const incoming = `${ssh.repository}/.selfhost/incoming/${randomUUID()}`;
  const identity = ssh.key?.startsWith('~') ? ssh.key : ssh.key && path.resolve(ROOT, ssh.key);
  const common = ['-o', 'StrictHostKeyChecking=ask', ...(identity ? ['-i', identity] : [])];
  await run('ssh', [...common, '-p', String(ssh.port), destination, `mkdir -p -m 700 ${shellQuote(incoming)}`]);
  // OpenSSH can parse the colon in a Windows drive path as a remote host separator.
  // Transfer the verified local filenames from their own directory.
  await run('scp', [...common, '-P', String(ssh.port), ...r.artifacts.map((a) => a.name), 'release.json',
    `${destination}:${incoming}/`], { cwd: directory });
  // 远端只执行已随 Git 部署的发布模块，上传的 JSON 不会作为代码运行。
  await run('ssh', [...common, '-p', String(ssh.port), destination,
    `cd ${shellQuote(ssh.repository)} && node scripts/selfhost/cli.mjs --receive ${shellQuote(incoming)}`]);
}
