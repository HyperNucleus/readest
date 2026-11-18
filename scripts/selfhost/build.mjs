// 在隔离的源码副本中编译个人客户端；不临时改写用户的工作区或签名配置。
import { cp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, APP, STATE, clientProfile, loadJson, saveJson } from './config.mjs';
import { run } from './process.mjs';
import { protectedBuild } from './build-resources.mjs';

export function buildTargets(platform = process.platform, arch = process.arch) {
  switch (platform) {
    case 'linux': return ['android-arm64'];
    case 'win32': return ['windows-x86_64', 'android-arm64'];
    case 'darwin': return arch === 'arm64' ? ['darwin-aarch64'] : [];
    default: return [];
  }
}

export function hostExecutable(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

export const ANDROID_NDK_VERSION = '28.2.13676358';

export function androidHomes(local) {
  const javaHome = local.javaHome || process.env.JAVA_HOME;
  const androidHome = local.androidHome || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
    (process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android/Sdk') : undefined);
  const ndkHome = local.ndkHome || process.env.NDK_HOME || (androidHome ? path.join(androidHome, 'ndk', ANDROID_NDK_VERSION) : undefined);
  return { javaHome, androidHome, ndkHome };
}

export async function checkAndroidBuild(local) {
  const { javaHome, androidHome, ndkHome } = androidHomes(local);
  const files = [
    [javaHome && path.join(javaHome, 'bin', hostExecutable('java')), 'JDK 17（JAVA_HOME）'],
    [androidHome && path.join(androidHome, 'platforms/android-36/android.jar'), 'Android SDK platform 36'],
    [ndkHome && path.join(ndkHome, 'source.properties'), 'Android NDK'],
    [local.androidKey, 'Android 长期签名 keystore'],
  ];
  for (const [file, label] of files) {
    if (!file || !(await stat(file).catch(() => null))?.isFile()) {
      throw new Error(`找不到 ${label}${file ? `（${file}）` : ''}，请检查「配置本机编译与签名」`);
    }
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(local.androidAlias ?? '')) throw new Error('请配置有效的 Android 签名 alias');
}

// 版本统一用于三平台清单；限制为稳定版，Android versionCode 可确定性计算且递增。
export function releaseVersion(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error('版本必须是 major.minor.patch，例如 0.12.21');
  const parts = value.split('.').map(Number);
  if (parts.some((v, i) => v > (i === 0 ? 2000 : 999))) throw new Error('版本分量过大');
  return { version: parts.join('.'), code: parts[0] * 1000000 + parts[1] * 1000 + parts[2] };
}

// 客户端只注入公开配置；无论宿主环境是否配置了官方服务，都明确覆盖目标地址。
export function clientEnvironment(profile) {
  const p = clientProfile(profile);
  return {
    // 原工作区已执行 frozen install；副本复用依赖，禁止 pnpm 因目录不同而重装链接目标。
    pnpm_config_verify_deps_before_run: 'false',
    NEXT_PUBLIC_APP_PLATFORM: 'tauri', NEXT_PUBLIC_PERSONAL: 'true', NEXT_PUBLIC_SELF_HOSTED: 'true',
    NEXT_PUBLIC_API_BASE_URL: p.serverUrl, NEXT_PUBLIC_NODE_BASE_URL: p.serverUrl,
    NEXT_PUBLIC_SUPABASE_URL: p.serverUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: p.supabaseAnonKey,
    NEXT_PUBLIC_OBJECT_STORAGE_TYPE: 's3', NEXT_PUBLIC_APP_SCHEME: p.scheme,
    // 原生页面没有 Web runtime-config，公开配额需要在编译时注入。
    NEXT_PUBLIC_STORAGE_FIXED_QUOTA: String(p.storageQuota), NEXT_PUBLIC_TRANSLATION_FIXED_QUOTA: String(p.translationQuota),
    NEXT_PUBLIC_UPDATER_BASE_URL: `${p.serverUrl}/updates`, NEXT_PUBLIC_UPDATER_PUBKEY: p.updaterPublicKey,
    SENTRY_DSN: '', SENTRY_AUTH_TOKEN: '', NEXT_PUBLIC_POSTHOG_KEY: '',
    SUPABASE_URL: p.serverUrl, SUPABASE_ANON_KEY: p.supabaseAnonKey, API_BASE_URL: p.serverUrl,
  };
}

// 所有客户端使用同一更新公钥和独立协议；移除官方更新备用地址及官方 App Links 注册。
export function tauriOverride(p, version) {
  return {
    productName: p.appName, mainBinaryName: 'personal-reader', identifier: p.appId, version,
    build: { beforeBuildCommand: 'pnpm build' },
    // 不安装使用官方 CLSID 的 Explorer 扩展；独立客户端避免改写官方安装的注册项。
    bundle: { createUpdaterArtifacts: true, resources: [], macOS: { signingIdentity: '-' }, windows: { nsis: { installerHooks: null } } },
    plugins: {
      updater: { pubkey: p.updaterPublicKey, endpoints: [`${p.serverUrl}/updates/latest.json`] },
      'deep-link': { desktop: { schemes: [p.scheme] }, mobile: [{ scheme: [p.scheme], appLink: false }] },
    },
  };
}

// 遍历源码/产物时跳过缓存与依赖，防止跟随 node_modules 链接修改真实工作区。
export async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', 'target', '.git', '.gradle', 'build'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(filename));
    else result.push(filename);
  }
  return result;
}

// 仅修改副本中的身份字面值，覆盖原生 widget/分享/登录链接中散落的官方协议。
export async function applyIdentity(stageApp, p) {
  // Tauri checks the filesystem package path, not just Kotlin's package text.
  // Overlay our handwritten activity onto the freshly generated personal
  // package, keeping its generated sources and removing duplicate old classes.
  const androidSources = path.join(stageApp, 'src-tauri/gen/android/app/src');
  for (const sourceSet of await readdir(androidSources, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!sourceSet.isDirectory()) continue;
    for (const language of ['java', 'kotlin']) {
      const base = path.join(androidSources, sourceSet.name, language);
      const oldPackage = path.join(base, 'com/bilingify/readest');
      const newPackage = path.join(base, ...p.appId.split('.'));
      if (oldPackage === newPackage) continue;
      try { await stat(oldPackage); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      await mkdir(newPackage, { recursive: true });
      await cp(oldPackage, newPackage, { recursive: true });
      await rm(oldPackage, { recursive: true });
    }
  }
  const candidates = [
    ...await filesUnder(path.join(stageApp, 'src')),
    ...await filesUnder(path.join(stageApp, 'src-tauri/gen/android')),
    ...await filesUnder(path.join(stageApp, 'src-tauri/plugins')),
  ];
  for (const filename of candidates) {
    if (!/\.(ts|tsx|kt|kts|xml|pro)$/.test(filename) || filename.includes('__tests__')) continue;
    const original = await readFile(filename, 'utf8');
    let text = original.replaceAll('readest://', `${p.scheme}://`)
      .replaceAll("'readest:'", `'${p.scheme}:'`)
      .replaceAll('https://web.readest.com', p.serverUrl)
      .replaceAll("'web.readest.com'", `'${new URL(p.serverUrl).hostname}'`);
    if (filename.includes(`${path.sep}gen${path.sep}android${path.sep}`)) {
      text = text.replaceAll('com.bilingify.readest', p.appId)
        .replaceAll('android:scheme="readest"', `android:scheme="${p.scheme}"`);
      // 手写的官方云盘 intent-filter 不受 Tauri deep-link 配置覆盖，需一并移除。
      if (filename.endsWith('AndroidManifest.xml')) text = text.replace(/<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter>/g, (block) =>
        /android:scheme="(?:readest-onedrive|com\.googleusercontent\.)/.test(block) ? '<!-- Selfhost build: official cloud OAuth handlers are not registered. -->' : block);
      // Android init 的字符串资源可能保留上游显示名，显式更新并做 XML 转义。
      if (filename.endsWith('.xml')) text = text.replace(/(<string name="(?:app_name|main_activity_title)">)[\s\S]*?(<\/string>)/g,
        (_match, start, end) => `${start}${p.appName.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}${end}`);
    }
    if (text !== original) {
      // 在每个实际生成的代码文件也注明此处替换用于隔离官方版身份。
      if (!filename.endsWith('.xml')) text = `// Selfhost build: app identity and deep links target the personal installation.\n${text}`;
      else text = text.replace(/(<\?xml[^>]*>)/, '$1\n<!-- Selfhost build: personal application identity and deep links. -->');
      await writeFile(filename, text);
    }
  }
}

// 把副本准备与原生编译分开，使同一目录可先验证前端构建与身份替换。
export async function prepareBuildSource() {
  const stage = path.join(STATE, 'build-source');
  const stageApp = path.join(stage, 'apps/readest-app');
  await rm(stage, { recursive: true, force: true });
  const excluded = new Set(['.git', '.selfhost', 'node_modules', 'target', '.next', 'out', '.gradle', 'build', '.claude', '.agents']);
  const filter = (source) => {
    const name = path.basename(source);
    // 也排除上游 Docker 的本机 .env 与常见私钥扩展，副本只需要公开构建配置。
    return !excluded.has(name) && source !== path.join(ROOT, 'docker/.env') &&
      !/^\.env.*\.local$/.test(name) && !/\.(jks|keystore|pem|key)$/.test(name) && name !== 'keystore.properties';
  };
  // 分别复制顶层条目，避免 fs.cp 拒绝把根目录递归复制到自身的子目录。
  await mkdir(stage, { recursive: true });
  for (const entry of await readdir(ROOT)) {
    const source = path.join(ROOT, entry);
    if (filter(source)) await cp(source, path.join(stage, entry), { recursive: true, filter });
  }
  // 使用链接而非复制 pnpm 的符号链接树，确保依赖指向原有安装且不重复占用空间。
  const { symlink } = await import('node:fs/promises');
  for (const relative of ['node_modules', 'apps/readest-app/node_modules', 'packages/foliate-js/node_modules']) {
    await symlink(path.join(ROOT, relative), path.join(stage, relative), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return { stage, stageApp };
}

// 初始化和构建必须使用同一份个人配置。仅清理隔离副本中的生成目录，
// 再保留仓库的手写原生功能；绝不删除用户工作区或签名密钥。
export async function initializeAndroidProject(stageApp, config, tauri, sourceApp = APP) {
  const android = path.join(stageApp, 'src-tauri/gen/android');
  await rm(android, { recursive: true, force: true });
  await tauri(['android', 'init', '--config', config]);
  await cp(path.join(sourceApp, 'src-tauri/gen/android/app'), path.join(android, 'app'), {
    recursive: true,
    filter: (source) => !['build', '.gradle', 'generated'].includes(path.basename(source)),
  });
}

export async function patchWindowsAndroidTurso(stage, cargo = run) {
  const metadata = JSON.parse(await cargo('cargo', ['metadata', '--format-version', '1',
    '--locked', '--filter-platform', 'aarch64-linux-android'], { cwd: stage, capture: true }));
  const extension = metadata.packages.find(({ name, version, source }) =>
    name === 'turso_ext' && version === '0.6.1' && source === 'registry+https://github.com/rust-lang/crates.io-index');
  if (!extension) return;

  // Backport Turso 7fc2acb: build scripts run on the host, but the library must match the target.
  const sourceDir = path.dirname(extension.manifest_path);
  const buildScript = await readFile(path.join(sourceDir, 'build.rs'), 'utf8');
  const hostCheck = 'cfg!(target_os = "windows")';
  if (!buildScript.includes(hostCheck)) return;

  const relative = 'patches/turso_ext-0.6.1';
  const workspace = path.join(stage, 'Cargo.toml');
  const manifest = await readFile(workspace, 'utf8');
  const patchTable = /^([ \t]*\[patch\.crates-io\][ \t]*(?:#[^\r\n]*)?)(\r?\n|$)/m;
  if (!patchTable.test(manifest)) throw new Error('找不到 Cargo 工作区的 [patch.crates-io] 配置');
  await cp(sourceDir, path.join(stage, relative), { recursive: true });
  await writeFile(path.join(stage, relative, 'build.rs'), buildScript.replace(hostCheck,
    'std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")'));
  await writeFile(workspace, manifest.replace(patchTable, (_match, header, lineEnding) => {
    const newline = lineEnding || '\n';
    return `${header}${newline}turso_ext = { path = "${relative}" }${newline}`;
  }));
}

export async function configureAndroidResources(stageApp) {
  const filename = path.join(stageApp, 'src-tauri/gen/android/gradle.properties');
  const settings = {
    'org.gradle.jvmargs': '-Xmx768m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8',
    'org.gradle.workers.max': '1',
    'org.gradle.parallel': 'false',
    'org.gradle.daemon': 'false',
    'kotlin.compiler.execution.strategy': 'in-process',
  };
  const original = await readFile(filename, 'utf8');
  const lines = original.split(/\r?\n/).filter((line) => {
    const key = line.trim().split(/[\s=:]/, 1)[0];
    return !Object.hasOwn(settings, key);
  });
  await writeFile(filename, lines.join('\n') + '\n' +
    Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}

// 编译副本复用已安装依赖，Rust 缓存放在 .selfhost 内；不复制本地环境文件或私钥。
export async function buildClient(profile, local, version, passwords, target = buildTargets()[0]) {
  const normalized = releaseVersion(version).version;
  if (!buildTargets().includes(target)) throw new Error('当前系统不支持所选构建目标');
  if (process.platform === 'linux') return protectedBuild({ profile, local, version: normalized, passwords });
  return buildClientUnrestricted(profile, local, normalized, passwords, target);
}

export async function buildClientUnrestricted(profile, local, version, passwords, target = buildTargets()[0]) {
  const p = clientProfile(profile);
  const release = releaseVersion(version);
  if (!buildTargets().includes(target)) throw new Error('当前系统不支持所选构建目标');
  const { javaHome, androidHome, ndkHome } = androidHomes(local);
  const privateKey = await readFile(local.signingKey, 'utf8');
  const { stage, stageApp } = await prepareBuildSource();
  const pkg = await loadJson(path.join(stageApp, 'package.json'));
  pkg.version = release.version;
  await saveJson(path.join(stageApp, 'package.json'), pkg);
  const env = { ...clientEnvironment(p), TAURI_SIGNING_PRIVATE_KEY: privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: passwords.update, CARGO_TARGET_DIR: path.join(STATE, 'target'),
    CARGO_BUILD_JOBS: String(local.jobs), JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome, NDK_HOME: ndkHome,
    READEST_KEY_PASSWORD: passwords.android ?? '',
  };
  const tauri = (args) => run('pnpm', ['exec', 'tauri', ...args], { cwd: stageApp, env });
  const override = tauriOverride(p, release.version);
  if (target === 'android-arm64') {
    if (process.platform === 'win32') await patchWindowsAndroidTurso(stage);
    // Gradle requires both SDK environment variables to point to the same installation.
    env.ANDROID_SDK_ROOT = androidHome;
    // 上游为包体积使用单个 codegen unit；个人构建优先降低 LLVM 的峰值内存。
    // 仅覆盖本次 Android 构建，不改工作区的 release profile 或桌面端参数。
    env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16';
    env.CARGO_PROFILE_RELEASE_OPT_LEVEL = '2';
    env.CARGO_PROFILE_RELEASE_LTO = 'off';
    if (process.platform === 'linux') {
      env.CARGO_BUILD_JOBS = '1';
      // Report why Cargo invalidates cached artifacts during Gradle's second invocation.
      env.CARGO_LOG = 'cargo::core::compiler::fingerprint=info';
    }
    override.bundle.createUpdaterArtifacts = false;
    override.bundle.android = { versionCode: release.code };
  }
  const config = path.join(stageApp, 'src-tauri/tauri.personal.conf.json');
  await saveJson(config, override);
  if (target === 'android-arm64') await initializeAndroidProject(stageApp, config, tauri);
  if (target === 'android-arm64' && process.platform === 'linux') await configureAndroidResources(stageApp);
  await applyIdentity(stageApp, p);
  // build.rs 原本无条件编译 Windows 缩略图 DLL；个人版不安装它，也无需执行这个嵌套构建。
  const rustBuild = path.join(stageApp, 'src-tauri/build.rs');
  const rustSource = await readFile(rustBuild, 'utf8');
  await writeFile(rustBuild, rustSource.replace('if target_os == "windows" {',
    '// Selfhost build: skip the official Explorer extension for personal installations.\n    if target_os == "windows" && env::var("NEXT_PUBLIC_PERSONAL").as_deref() != Ok("true") {'));
  // 主平台配置会自动合并 Windows resources，因此直接清空副本中的平台扩展配置。
  if (target === 'windows-x86_64') await saveJson(path.join(stageApp, 'src-tauri/tauri.windows.conf.json'), { bundle: { resources: [] } });
  if (target === 'android-arm64') {
    // 签名密码由环境读取，不写入 keystore.properties；原签名块改读该环境变量。
    const gradle = path.join(stageApp, 'src-tauri/gen/android/app/build.gradle.kts');
    let source = await readFile(gradle, 'utf8');
    source = source.replaceAll('keystoreProperties["password"] as String', 'System.getenv("READEST_KEY_PASSWORD")')
      .replace('keystoreProperties["storeFile"] as String', 'System.getenv("READEST_ANDROID_KEYSTORE")');
    env.READEST_ANDROID_KEYSTORE = path.resolve(local.androidKey);
    await writeFile(gradle, `// Selfhost build: signing passwords come only from the process environment.\n${source}`);
    await writeFile(path.join(stageApp, 'src-tauri/gen/android/keystore.properties'),
      `# Selfhost build: key path and password are supplied via the environment.\nkeyAlias=${local.androidAlias}\n`, { mode: 0o600 });
  }
  // macOS 更新包需要显式启用 app；仅打包 dmg 不会生成 .app.tar.gz 和签名。
  const args = target === 'darwin-aarch64' ? ['build', '--target', 'aarch64-apple-darwin', '--bundles', 'app,dmg'] :
    target === 'windows-x86_64' ? ['build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis'] :
      ['android', 'build', '--target', 'aarch64', '--apk'];
  await tauri([...args, '--config', config]);
  // 只收集本次目标目录的产物，打包成带哈希和签名的发布目录，供 SSH 发布端核对。
  const bundleDir = target === 'android-arm64' ? path.join(stageApp, 'src-tauri/gen/android/app/build/outputs/apk') :
    path.join(STATE, 'target', target === 'darwin-aarch64' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc', 'release/bundle');
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const result = [];
    for (const e of entries) if (!e.isSymbolicLink()) {
      const f = path.join(directory, e.name);
      if (e.isDirectory()) result.push(...await walk(f)); else result.push(f);
    }
    return result;
  };
  const built = await walk(bundleDir);
  const suffix = target === 'darwin-aarch64' ? '.app.tar.gz' : target === 'windows-x86_64' ? '.exe' : '.apk';
  const matching = built.filter((f) => f.endsWith(suffix) && (target !== 'android-arm64' || f.includes('release')));
  if (matching.length !== 1) throw new Error(`预期一个 ${suffix} 更新产物，实际 ${matching.length} 个；请检查构建输出`);
  const artifact = matching[0];
  // Android 的 APK 系统签名与 Tauri 更新签名各司其职；两种签名都保留。
  if (target === 'android-arm64') await tauri(['signer', 'sign', artifact]);
  const output = path.join(STATE, 'releases', release.version, target);
  await mkdir(output, { recursive: true });
  const name = `${target}${suffix}`;
  await cp(artifact, path.join(output, name));
  const signature = (await readFile(`${artifact}.sig`, 'utf8')).trim();
  const artifacts = [{ name, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') }];
  if (target === 'darwin-aarch64') {
    const dmgs = built.filter((f) => f.endsWith('.dmg'));
    if (dmgs.length !== 1) throw new Error('找不到唯一的 DMG 安装包');
    await cp(dmgs[0], path.join(output, 'darwin-aarch64.dmg'));
    artifacts.push({ name: 'darwin-aarch64.dmg', sha256: createHash('sha256').update(await readFile(dmgs[0])).digest('hex') });
  }
  await saveJson(path.join(output, 'release.json'), {
    schema: 1, version: release.version, platform: target, appId: p.appId, serverUrl: p.serverUrl,
    publicKey: p.updaterPublicKey, artifact: name, signature, artifacts,
  });
  console.log(`构建完成：${output}`);
  return output;
}
