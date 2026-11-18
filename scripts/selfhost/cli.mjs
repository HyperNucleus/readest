#!/usr/bin/env node
// 中文交互入口：逐项询问配置、保存前汇总，部署/编译/发布/恢复前再次确认具体操作。
import { readFile, mkdir, access, statfs, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT, APP, STATE, httpsOrigin, clientProfile, loadJson, saveJson, serverDirectories, applicationName, applicationId, applicationScheme } from './config.mjs';
import { run, locked, prepareSources } from './process.mjs';
import { newSecrets, generateServer, deploy, account, backup, restore, SERVER_FILE, COMPOSE_FILE, composeRun } from './server.mjs';
import { ANDROID_NDK_VERSION, androidHomes, buildClient, buildTargets, checkAndroidBuild, hostExecutable, releaseVersion } from './build.mjs';
import { inspectRelease, receiveRelease, uploadRelease } from './release.mjs';

const CLIENT_FILE = path.join(STATE, 'client.json');
const LOCAL_FILE = path.join(STATE, 'local.json');
const targetNames = {
  'darwin-aarch64': 'macOS Apple Silicon（DMG）',
  'windows-x86_64': 'Windows x64（NSIS）',
  'android-arm64': 'Android ARM64（APK）',
};

// SSH 接收端不加载交互库、不读取口令，验证当前服务器配置后只执行产物发布。
if (process.argv[2] === '--receive') {
  try {
    if (process.argv.length !== 4) throw new Error('用法：--receive <上传目录>');
    await locked(async () => receiveRelease(path.resolve(process.argv[3]), clientProfile(await loadJson(CLIENT_FILE)), await loadJson(SERVER_FILE)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (process.argv[2] === '--help') {
  // 无依赖帮助可用于首次拉取后的入口检查。
  console.log('pnpm selfhost：配置、检查、部署、编译、ADB 安装、SSH 发布、账号管理、备份与恢复。私密配置保存在 .selfhost/，不提交 Git。');
} else {
  await interactive().catch((error) => {
    // Ctrl+C 是正常取消；不打印可能包含口令/配置内容的调用栈。
    if (error.name !== 'ExitPromptError') { console.error(error.message); process.exitCode = 1; }
  });
}

async function interactive() {
  const { input, password, select, confirm } = await import('@inquirer/prompts');
  // 将校验函数的异常转换为输入框提示；保留逐项编辑，不会使用无效默认值继续执行。
  const ask = (message, defaultValue = '', check = (v) => { if (!v) throw new Error('不能为空'); return v; }) =>
    input({ message, default: String(defaultValue), validate: (v) => { try { check(v); return true; } catch (e) { return e.message; } } });
  const integer = async (message, value, min, max) => Number(await ask(message, value, (v) => {
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new Error(`请输入 ${min}–${max} 的整数`);
  }));
  const optional = (message, value = '') => ask(message, value, () => {});
  const exists = async (filename) => { try { await access(filename); return true; } catch { return false; } };
  const summary = async (message, value) => { console.log(JSON.stringify(value, null, 2)); return confirm({ message, default: false }); };
  // Linux 路径会出现在 Docker 挂载和 Nginx 配置中，限制为无空格的绝对路径。
  const linuxPath = (v) => { if (!/^\/[a-zA-Z0-9_./-]+$/.test(v) || v.split('/').includes('..') || v === '/') throw new Error('请输入不含空格或 .. 的绝对目录/文件路径'); return v; };
  const local = () => loadJson(LOCAL_FILE, {});
  const profile = async () => clientProfile(await loadJson(CLIENT_FILE));
  const targets = buildTargets();
  const supportsAndroid = targets.includes('android-arm64');
  const chooseTarget = async (message) => {
    if (!targets.length) throw new Error('当前系统没有可用的构建目标');
    if (targets.length === 1) return targets[0];
    return select({ message, choices: targets.map((value) => ({ name: targetNames[value], value })) });
  };
  const sdkExecutable = async (name, directory) => {
    const executable = hostExecutable(name);
    const candidate = directory && path.join(directory, executable);
    return candidate && await exists(candidate) ? candidate : executable;
  };
  const adbCommand = (config) => {
    const { androidHome } = androidHomes(config);
    return sdkExecutable('adb', androidHome && path.join(androidHome, 'platform-tools'));
  };

  async function chooseReleaseDirectory(config, target) {
    const recent = [...new Set([config.lastRelease, ...Object.values(config.lastReleases ?? {})].filter(Boolean))];
    const choices = [];
    for (const directory of recent) {
      const release = await loadJson(path.join(directory, 'release.json'), null);
      if (release && (!target || release.platform === target)) {
        choices.push({ value: directory, name: `${targetNames[release.platform] ?? release.platform} · ${release.version} · ${directory}` });
      }
    }
    if (choices.length) {
      const directory = await select({ message: '选择本机发布产物', choices: [...choices, { name: '输入其他发布目录', value: '' }] });
      if (directory) return path.resolve(directory);
    }
    return path.resolve(await ask('本机发布目录', config.lastReleases?.[target] || (!target ? config.lastRelease : '') || ''));
  }
  // 仓库内的私钥必须放在已排除 Git/Docker 的 .selfhost 中，防止自选路径意外入库。
  const privatePath = (value) => {
    const absolute = path.resolve(value);
    const relative = path.relative(ROOT, absolute);
    const inside = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    if (inside && absolute !== STATE && !absolute.startsWith(`${STATE}${path.sep}`)) throw new Error('私钥请放在 .selfhost/ 内或仓库外');
    return absolute;
  };

  // 更新签名密钥只在构建机保存；服务器及公开配置只需要 .pub 文件。
  async function publicKey(previous = '') {
    const choice = await select({ message: '更新签名公钥', choices: [
      ...(previous ? [{ name: '沿用现有公钥（保持已安装客户端可更新）', value: 'keep' }] : []),
      { name: '读取已有 Tauri .pub 公钥文件', value: 'read' },
      { name: '生成新更新签名密钥（首次部署时使用）', value: 'generate' },
    ] });
    if (choice === 'keep') return previous;
    if (choice === 'read') return (await readFile(path.resolve(await ask('公钥文件路径')), 'utf8')).trim();
    const key = privatePath(await ask('私钥保存路径（.selfhost 内或仓库外）', path.join(STATE, 'keys/update.key'), privatePath));
    if (await exists(key) || await exists(`${key}.pub`)) throw new Error('密钥文件已存在，不覆盖');
    await mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
    if (!await confirm({ message: `生成密钥到 ${key}？接下来由 Tauri 询问加密口令，请另行备份私钥。`, default: false })) throw new Error('已取消');
    await run('pnpm', ['exec', 'tauri', 'signer', 'generate', '-w', key], { cwd: APP });
    // 即使用户选择已有公共目录，也将新私钥限制为当前用户可读写。
    await chmod(key, 0o600);
    const current = await local();
    await saveJson(LOCAL_FILE, { ...current, signingKey: key });
    return (await readFile(`${key}.pub`, 'utf8')).trim();
  }

  // 身份逐项即时校验，再进入密钥生成；避免整轮填写结束后才拒绝名称、ID 或协议。
  async function identity(previous = {}) {
    return {
      appName: await ask('独立应用显示名称', previous.appName || 'Personal Reader', applicationName),
      appId: await ask('独立应用 ID（反向域名，长期保持）', previous.appId || 'org.personal.reader', applicationId),
      scheme: await ask('独立登录/打开应用协议（例如 readest-h；不能使用官方完整协议名）', previous.scheme || 'personal-reader', applicationScheme),
      updaterPublicKey: await publicKey(previous.updaterPublicKey),
    };
  }

  async function configureServer() {
    if (process.platform !== 'linux') throw new Error('请在 Ubuntu 服务器上配置服务端；当前电脑可配置/编译客户端');
    const old = await loadJson(SERVER_FILE, {});
    const previous = await loadJson(CLIENT_FILE, {});
    const serverUrl = httpsOrigin(await ask('公网 HTTPS 域名（不带路径）', old.serverUrl || '', httpsOrigin));
    const id = await identity(previous);
    // 新部署集中在项目的私有目录；已有部署保留原路径，不把修改配置当成数据迁移。
    const { dataDir, backupDir } = serverDirectories(
      await ask('服务数据目录（默认在项目 .selfhost/data 内）', old.dataDir || path.join(STATE, 'data'), linuxPath),
      await ask('备份目录（与数据目录分开）', old.backupDir || path.join(STATE, 'backups'), linuxPath),
    );
    const ports = {};
    for (const [service, defaultPort] of [['client', 3000], ['kong', 8000], ['s3', 9000]]) ports[service] = await integer(`${service} 本机端口`, old.ports?.[service] || defaultPort, 1024, 65535);
    if (new Set(Object.values(ports)).size !== 3) throw new Error('三个服务端口不能重复');
    const domain = new URL(serverUrl).hostname;
    const s = {
      version: 1, serverUrl, ...id, dataDir, backupDir, ports,
      // Certbot 的配置、证书、工作文件与日志均可放在项目内，已有证书路径继续沿用。
      certificate: await ask('Nginx TLS fullchain 文件', old.certificate || path.join(STATE, 'certbot/config/live', domain, 'fullchain.pem'), linuxPath),
      certificateKey: await ask('Nginx TLS private key 文件', old.certificateKey || path.join(STATE, 'certbot/config/live', domain, 'privkey.pem'), linuxPath),
      storageQuota: (await integer('单账号书籍存储配额（MiB）', (old.storageQuota || 1073741824) / 1048576, 1, 1048576)) * 1048576,
      translationQuota: await integer('翻译配额（沿用项目的字符计数规则；需可用翻译服务）', old.translationQuota || 50000, 1, 100000000),
      fontBaseUrl: await optional('可选：自托管 CJK 字体目录 URL；留空用上游资源（其 CORS 可能不支持自定义域名）', old.fontBaseUrl),
      trustedHosts: await optional('可选：允许 OPDS 代理访问的内网主机，逗号分隔；留空禁止', old.trustedHosts),
      secrets: old.secrets || newSecrets(),
    };
    if (s.fontBaseUrl && (!s.fontBaseUrl.startsWith('https://') || /\s/.test(s.fontBaseUrl))) throw new Error('字体地址需为 HTTPS URL');
    if (!/^[a-zA-Z0-9.,:\[\]-]*$/.test(s.trustedHosts)) throw new Error('内网主机列表格式无效');
    const p = clientProfile({ version: 1, ...id, serverUrl, supabaseAnonKey: s.secrets.anonKey,
      storageQuota: s.storageQuota, translationQuota: s.translationQuota });
    if (!await summary('保存上述服务端规则并生成 Nginx/Compose 配置？身份或域名变更需要重新编译客户端。', {
      ...s, secrets: old.secrets ? '保留已有密钥，不轮换' : '自动生成数据库密码、JWT 密钥、MinIO 密码和公开/管理员 JWT',
      accountPolicy: '邮箱密码；关闭公开注册、匿名账号和 SMTP；管理员脚本创建/重置',
      storage: 'PostgreSQL + MinIO/readest-files；端口仅监听 127.0.0.1',
    })) return;
    await generateServer(s);
    await saveJson(SERVER_FILE, s);
    await saveJson(CLIENT_FILE, p);
    console.log(`配置已保存；请应用 ${path.join(STATE, 'nginx.conf')} 并验证 nginx -t。`);
  }

  async function configureClient() {
    const previous = await loadJson(CLIENT_FILE, {});
    const mode = await select({ message: '客户端连接配置来源', choices: [
      { name: '导入服务器导出的公开配置（推荐）', value: 'import' },
      { name: '逐项输入/修改', value: 'manual' },
    ] });
    const p = mode === 'import' ? clientProfile(await loadJson(path.resolve(await ask('配置 JSON 文件路径')))) : clientProfile({
      version: 1, serverUrl: await ask('服务器 HTTPS 域名', previous.serverUrl || '', httpsOrigin),
      supabaseAnonKey: await ask('服务器公开 anon JWT', previous.supabaseAnonKey || ''), ...await identity(previous),
      // 手动填写时也确认配额；导入配置会直接使用服务器的已确认值。
      storageQuota: (await integer('与服务器一致的存储配额（MiB）', (previous.storageQuota || 1073741824) / 1048576, 1, 1048576)) * 1048576,
      translationQuota: await integer('与服务器一致的翻译配额', previous.translationQuota || 50000, 1, 100000000),
    });
    // 公钥/anon key 可公开但摘要不重复打印长字符串，提高配置审阅可读性。
    if (await summary('保存客户端连接配置？', { ...p, supabaseAnonKey: '[公开 anon key]', updaterPublicKey: '[更新验证公钥]' })) await saveJson(CLIENT_FILE, p);
  }

  async function configureBuild() {
    const target = await chooseTarget('配置哪个构建目标？');
    const old = await local();
    const value = {
      ...old, signingKey: privatePath(await ask('Tauri 更新签名私钥路径（与客户端公钥配对）', old.signingKey || path.join(STATE, 'keys/update.key'), privatePath)),
      jobs: await integer('Rust 并行任务数（服务器建议 2）', old.jobs || 2, 1, 64),
    };
    if (target === 'android-arm64') {
      const defaults = androidHomes(old);
      value.javaHome = path.resolve(await ask('JDK 17 JAVA_HOME', defaults.javaHome));
      value.androidHome = path.resolve(await ask('Android SDK 目录（需要 platform 36）', defaults.androidHome));
      const ndk = old.ndkHome || process.env.NDK_HOME || path.join(value.androidHome, 'ndk', ANDROID_NDK_VERSION);
      value.ndkHome = path.resolve(await ask(`Android NDK 目录（上游使用 ${ANDROID_NDK_VERSION}）`, ndk));
      value.androidKey = privatePath(await ask('Android 长期签名 keystore 路径', old.androidKey || path.join(STATE, 'keys/android.jks'), privatePath));
      value.androidAlias = await ask('Android key alias', old.androidAlias || 'personal-reader', (v) => { if (!/^[a-zA-Z0-9_.-]+$/.test(v)) throw new Error('alias 仅支持字母、数字、点、下划线、短横线'); });
      if (!await exists(value.androidKey) && await confirm({ message: '此 keystore 不存在。仅在首次发布时生成新密钥；已有安装请使用原密钥。现在生成？', default: false })) {
        const secret = await password({ message: '新 keystore 密码（至少 8 位）', validate: (v) => v.length >= 8 || '至少 8 位' });
        await mkdir(path.dirname(value.androidKey), { recursive: true, mode: 0o700 });
        await run(path.join(value.javaHome, 'bin', hostExecutable('keytool')), ['-genkeypair', '-keystore', value.androidKey, '-alias', value.androidAlias,
          '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Personal Reader',
          '-storepass:env', 'READEST_KEY_PASSWORD', '-keypass:env', 'READEST_KEY_PASSWORD'], { env: { READEST_KEY_PASSWORD: secret } });
        await chmod(value.androidKey, 0o600);
      }
    }
    if (await summary('保存本机构建配置（不保存密码）？', value)) await saveJson(LOCAL_FILE, value);
  }

  async function checkEnvironment() {
    console.log(`系统：${process.platform}/${process.arch}；Node ${process.version}；可用内存 ${(os.freemem() / 2 ** 30).toFixed(1)} GiB`);
    const fs = await statfs(ROOT);
    console.log(`仓库所在磁盘剩余 ${(fs.bavail * fs.bsize / 2 ** 30).toFixed(1)} GiB；首次原生构建工具链/缓存可能需要数十 GiB。`);
    const commands = [['pnpm', ['--version']], ['git', ['--version']], ['cargo', ['--version']], ['rustc', ['--version']], ['ssh', ['-V']]];
    if (process.platform === 'linux') commands.push(['docker', ['compose', 'version']]);
    if (supportsAndroid) {
      const config = await local();
      const { javaHome } = androidHomes(config);
      commands.push([await sdkExecutable('java', javaHome && path.join(javaHome, 'bin')), ['-version']],
        [await adbCommand(config), ['version']]);
      try { await checkAndroidBuild(config); console.log('✓ Android SDK、NDK、JDK 和签名文件已找到'); }
      catch (error) { console.log(`✗ Android ARM64：${error.message}`); }
    }
    if (process.platform === 'darwin') commands.push(['xcodebuild', ['-version']]);
    for (const [cmd, args] of commands) {
      try { const result = await run(cmd, args, { capture: true }); console.log(`✓ ${cmd} ${result.split('\n')[0]}`); }
      catch { console.log(`✗ ${cmd} 不可用，请安装工具链后再编译/部署`); }
    }
    const p = await loadJson(CLIENT_FILE, null);
    if (p) {
      try {
        const response = await fetch(`${p.serverUrl}/auth/v1/settings`, { headers: { apikey: p.supabaseAnonKey }, signal: AbortSignal.timeout(10000) });
        console.log(`认证 API：HTTP ${response.status}`);
      } catch { console.log('认证 API 暂不可达，请检查域名、证书和 Nginx'); }
    }
  }

  // 一次操作结束后回到菜单，错误不吞掉；配置写入只发生在明确确认之后。
  while (true) {
    const action = await select({ message: 'Readest 自部署与个人编译', choices: [
      ['配置服务端', 'server'], ['配置/导入客户端连接', 'client'], ['导出客户端公开配置', 'export'],
      ['配置本机编译与签名', 'build-config'], ['环境与连接检查', 'check'], ['部署/更新服务端', 'deploy'],
      ['启动已恢复服务（不重建/升级）', 'start'], ['编译客户端', 'build'],
      ...(supportsAndroid ? [['推送并安装 APK 到 Android 设备（ADB）', 'adb']] : []),
      ['通过 SSH 上传并发布更新', 'publish'],
      ['创建账号/重置密码', 'account'], ['备份服务端', 'backup'], ['恢复到空数据目录', 'restore'], ['退出', 'exit'],
    ].map(([name, value]) => ({ name, value })) });
    if (action === 'exit') break;
    try {
      if (action === 'check') { await checkEnvironment(); continue; }
      await locked(async () => {
        if (action === 'server') return configureServer();
        if (action === 'client') return configureClient();
        if (action === 'build-config') return configureBuild();
        if (action === 'export') {
          const filename = path.resolve(await ask('导出文件路径', path.join(STATE, 'client-export.json')));
          if (await exists(filename) && !await confirm({ message: `覆盖 ${filename}？`, default: false })) return;
          await saveJson(filename, await profile()); console.log(`已导出公开配置：${filename}`); return;
        }
        if (action === 'build') {
          const target = await chooseTarget('选择客户端构建目标');
          const p = await profile(); const l = await local();
          if (!l.signingKey || !l.jobs) throw new Error('请先配置本机编译与签名');
          if (target === 'android-arm64') await checkAndroidBuild(l);
          const pkg = await loadJson(path.join(APP, 'package.json'));
          const version = releaseVersion(await ask('本次三平台统一版本（后续更新必须递增）', l.version || pkg.version, releaseVersion)).version;
          if (!await summary('准备依赖并开始构建？', { system: `${process.platform}/${process.arch}`, target: targetNames[target], app: p.appName, appId: p.appId, server: p.serverUrl, version, jobs: process.platform === 'linux' ? 1 : l.jobs })) return;
          const passwords = { update: await password({ message: '更新签名私钥密码（未加密则留空）' }) };
          if (target === 'android-arm64') passwords.android = await password({ message: 'Android keystore 密码' });
          await prepareSources(true);
          await run('pnpm', ['install', '--frozen-lockfile']);
          await run('pnpm', ['--filter', '@readest/readest-app', 'setup-vendors']);
          const output = await buildClient(p, l, version, passwords, target);
          await saveJson(LOCAL_FILE, { ...l, version, lastRelease: output, lastReleases: { ...l.lastReleases, [target]: output } }); return;
        }
        if (action === 'adb') {
          const l = await local();
          const directory = await chooseReleaseDirectory(l, 'android-arm64');
          const release = await inspectRelease(directory, await profile());
          if (release.platform !== 'android-arm64') throw new Error('请选择 Android ARM64 的发布目录');
          const adb = await adbCommand(l);
          const listing = await run(adb, ['devices', '-l'], { capture: true });
          const choices = listing.split(/\r?\n/).flatMap((line) => {
            const device = line.match(/^(\S+)\s+device(?:\s+.*)?$/);
            return device ? [{ name: line.trim(), value: device[1] }] : [];
          });
          if (!choices.length) throw new Error('未找到已授权的 Android 设备。请连接设备、开启 USB 调试并确认授权。');
          const device = choices.length === 1 ? choices[0].value : await select({ message: '选择要安装的设备', choices });
          const apk = path.join(directory, release.artifact);
          if (!await summary('在所选 Android 设备上安装或覆盖升级？', { device, apk, version: release.version })) return;
          await run(adb, ['-s', device, 'install', '-r', apk]);
          return;
        }
        if (action === 'publish') {
          const p = await profile(); const l = await local(); const old = l.ssh || {};
          const directory = await chooseReleaseDirectory(l);
          // Android 在服务器本机编译时无需绕回 SSH；仍经过完全相同的签名/完整性检查。
          if (await exists(SERVER_FILE) && await confirm({ message: '产物已在这台部署服务器上，直接汇总并在三平台齐全后发布？', default: true })) {
            await receiveRelease(directory, p, await loadJson(SERVER_FILE)); return;
          }
          const ssh = { host: await ask('SSH 主机名或 ~/.ssh/config 别名', old.host || ''), user: await ask('SSH 用户', old.user || 'ubuntu'),
            port: await integer('SSH 端口', old.port || 22, 1, 65535), key: await optional('SSH 私钥路径（留空使用 ssh-agent/SSH config）', old.key),
            repository: await ask('服务器仓库绝对路径（无空格）', old.repository || '', linuxPath) };
          if (!await summary('上传产物，并在三平台同版本产物齐全时发布？', { directory, ...ssh, server: p.serverUrl })) return;
          await saveJson(LOCAL_FILE, { ...l, ssh }); await uploadRelease(directory, p, ssh); return;
        }
        if (action === 'restore') {
          if (process.platform !== 'linux') throw new Error('请在 Linux 服务器恢复');
          const directory = path.resolve(await ask('可信备份目录', '', linuxPath));
          // 恢复位置也遵循项目内 data/backups 分离规则，并为新服务器重新选择备份目录。
          const { dataDir: target, backupDir } = serverDirectories(
            await ask('空数据目录', path.join(STATE, 'data'), linuxPath),
            await ask('恢复后的备份目录', path.join(STATE, 'backups'), linuxPath),
          );
          if (await exists(COMPOSE_FILE)) {
            const running = await composeRun(['ps', '--services', '--status', 'running'], { capture: true });
            if (running) throw new Error('请先停止当前自部署栈，再恢复到新目录');
          }
          if (await summary('恢复此备份并替换本机服务端配置？备份含服务端密钥，只应使用可信备份。', { directory, target, backupDir })) await restore(directory, target, backupDir);
          return;
        }
        const s = await loadJson(SERVER_FILE);
        // 恢复后使用备份内的镜像配置启动，不调用 generateServer 覆盖固定的镜像 digest。
        if (action === 'start') {
          if (await summary('按已恢复的 Compose 配置启动，不重建镜像？', { server: s.serverUrl, dataDir: s.dataDir })) await composeRun(['up', '-d', '--no-build', '--wait', '--wait-timeout', '180']);
          return;
        }
        if (action === 'deploy') {
          if (!await summary('从当前检出的源码构建并启动/更新？', { server: s.serverUrl, dataDir: s.dataDir, ports: s.ports })) return;
          if (await exists(COMPOSE_FILE)) {
            const running = await composeRun(['ps', '--services', '--status', 'running'], { capture: true });
            if (running && await confirm({ message: '先暂停服务并备份现有数据（推荐）？', default: true })) await backup(s);
          }
          await deploy(s); return;
        }
        if (action === 'backup') {
          if (await summary('暂停服务完成备份，再恢复之前运行的服务？', { dataDir: s.dataDir, backupDir: s.backupDir })) await backup(s);
          return;
        }
        if (action === 'account') {
          const reset = await select({ message: '账号管理', choices: [{ name: '创建账号', value: false }, { name: '重置密码', value: true }] });
          const email = await ask('账号邮箱', '', (v) => { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('邮箱格式无效'); });
          const secret = await password({ message: '新密码（至少 12 位）', validate: (v) => v.length >= 12 || '至少 12 位' });
          if (await summary(reset ? '重置这个账号的密码？' : '创建这个账号？', { email, server: s.serverUrl })) { await account(s, email, secret, reset); console.log('账号操作完成'); }
        }
      });
    } catch (error) {
      if (error.name === 'ExitPromptError') throw error;
      console.error(`操作未完成：${error.message}`);
    }
  }
}
