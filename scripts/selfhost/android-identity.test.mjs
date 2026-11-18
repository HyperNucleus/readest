import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyIdentity, buildTargets, patchWindowsAndroidTurso } from './build.mjs';
import { APP, ROOT } from './config.mjs';
import { run } from './process.mjs';

test('Windows offers both NSIS and Android APK while Linux and macOS keep their targets', () => {
  assert.deepEqual(buildTargets('win32', 'x64'), ['windows-x86_64', 'android-arm64']);
  assert.deepEqual(buildTargets('linux', 'x64'), ['android-arm64']);
  assert.deepEqual(buildTargets('darwin', 'arm64'), ['darwin-aarch64']);
  assert.deepEqual(buildTargets('darwin', 'x64'), []);
});

test('Windows Android builds patch the Turso linker check only in the staged workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'readest-turso-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'build source');
  const source = path.join(root, 'cargo registry');
  const buildScript = 'fn main() { if cfg!(target_os = "windows") { println!("cargo:rustc-link-lib=advapi32"); } }\n';
  await mkdir(stage);
  await mkdir(source);
  const manifest = (await readFile(path.join(ROOT, 'Cargo.toml'), 'utf8')).replace(/\r?\n/g, '\r\n');
  await writeFile(path.join(stage, 'Cargo.toml'), manifest);
  await writeFile(path.join(source, 'build.rs'), buildScript);
  await patchWindowsAndroidTurso(stage, async (command, args, options) => {
    assert.equal(command, 'cargo');
    assert.ok(args.includes('aarch64-linux-android'));
    assert.equal(options.cwd, stage);
    return JSON.stringify({ packages: [{ name: 'turso_ext', version: '0.6.1',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      manifest_path: path.join(source, 'Cargo.toml') }] });
  });
  assert.equal(await readFile(path.join(source, 'build.rs'), 'utf8'), buildScript);
  assert.equal(await readFile(path.join(stage, 'patches/turso_ext-0.6.1/build.rs'), 'utf8'),
    buildScript.replace('cfg!(target_os = "windows")', 'std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")'));
  assert.equal(await readFile(path.join(stage, 'Cargo.toml'), 'utf8'),
    manifest.replace('\r\n[patch.crates-io]\r\n',
      '\r\n[patch.crates-io]\r\nturso_ext = { path = "patches/turso_ext-0.6.1" }\r\n'));
});

test('personal Android identity relocates the handwritten activity into the generated package', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'readest-android-'));
  try {
    const oldPackage = path.join(root, 'src-tauri/gen/android/app/src/main/java/com/bilingify/readest');
    const newPackage = path.join(root, 'src-tauri/gen/android/app/src/main/java/top/hypernucleus/readest');
    await mkdir(oldPackage, { recursive: true });
    await mkdir(newPackage, { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'src-tauri/plugins'), { recursive: true });
    await writeFile(path.join(oldPackage, 'MainActivity.kt'), 'package com.bilingify.readest\n// handwritten reader activity\n');
    await writeFile(path.join(newPackage, 'MainActivity.kt'), 'package top.hypernucleus.readest\n// generated template\n');
    await applyIdentity(root, { appId: 'top.hypernucleus.readest', appName: 'Reader', scheme: 'reader-personal', serverUrl: 'https://reader.example' });
    const activity = await readFile(path.join(newPackage, 'MainActivity.kt'), 'utf8');
    assert.match(activity, /handwritten reader activity/);
    assert.match(activity, /package top\.hypernucleus\.readest/);
    await assert.rejects(stat(oldPackage), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Android init generates launcher resources and preserves the tracked adaptive icon', async () => {
  const { initializeAndroidProject } = await import('./build.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'readest-android-init-'));
  try {
    const stage = path.join(root, 'stage/apps/readest-app');
    const original = path.join(root, 'original');
    const relative = 'src-tauri/gen/android/app';
    const res = path.join(relative, 'src/main/res');
    const launcher = path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml');
    const iconDir = path.join(root, 'stage/data/icons');
    await mkdir(iconDir, { recursive: true });
    await copyFile(path.join(ROOT, 'data/icons/readest-book.png'), path.join(iconDir, 'readest-book.png'));
    await mkdir(path.join(stage, relative), { recursive: true });
    await mkdir(path.join(original, relative, 'build'), { recursive: true });
    await mkdir(path.dirname(path.join(original, launcher)), { recursive: true });
    await copyFile(path.join(APP, launcher), path.join(original, launcher));
    await writeFile(path.join(stage, relative, 'stale'), 'stale generated project');
    await writeFile(path.join(original, relative, 'MainActivity.kt'), 'handwritten');
    await writeFile(path.join(original, relative, 'build/old.apk'), 'old build');
    const config = path.join(stage, 'src-tauri/tauri.personal.conf.json');
    await writeFile(config, JSON.stringify({ identifier: 'top.hypernucleus.readest' }));
    const commands = [];
    await initializeAndroidProject(stage, config, async (args) => {
      commands.push(args);
      if (args[0] === 'icon') {
        await run(process.execPath, [path.join(APP, 'node_modules/@tauri-apps/cli/tauri.js'), ...args,
          '--output', path.join(stage, 'src-tauri/icons')], { cwd: stage, capture: true });
        return;
      }
      await assert.rejects(stat(path.join(stage, relative)), { code: 'ENOENT' });
      assert.equal(JSON.parse(await readFile(args[3], 'utf8')).identifier, 'top.hypernucleus.readest');
      await mkdir(path.join(stage, res), { recursive: true });
      await writeFile(path.join(stage, relative, 'generated-template'), 'template');
    }, original);
    assert.deepEqual(commands, [['android', 'init', '--config', config], ['icon', '../../data/icons/readest-book.png']]);
    assert.match(await readFile(path.join(stage, res, 'values/ic_launcher_background.xml'), 'utf8'), /<color name="ic_launcher_background">/);
    assert.ok((await stat(path.join(stage, res, 'mipmap-mdpi/ic_launcher_foreground.png'))).size > 0);
    assert.equal(await readFile(path.join(stage, launcher), 'utf8'), await readFile(path.join(APP, launcher), 'utf8'));
    assert.equal(await readFile(path.join(stage, relative, 'MainActivity.kt'), 'utf8'), 'handwritten');
    assert.equal(await readFile(path.join(original, relative, 'build/old.apk'), 'utf8'), 'old build');
    await assert.rejects(stat(path.join(stage, relative, 'build')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
