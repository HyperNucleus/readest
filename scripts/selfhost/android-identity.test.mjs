import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyIdentity, buildTargets, patchWindowsAndroidTurso } from './build.mjs';

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
  await writeFile(path.join(stage, 'Cargo.toml'), '[patch.crates-io]\ntauri = { path = "packages/tauri" }\n');
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
    '[patch.crates-io]\nturso_ext = { path = "patches/turso_ext-0.6.1" }\ntauri = { path = "packages/tauri" }\n');
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

test('Android init uses the build config and cleans only the staged generated project', async () => {
  const { initializeAndroidProject } = await import('./build.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'readest-android-init-'));
  try {
    const stage = path.join(root, 'stage');
    const original = path.join(root, 'original');
    const relative = 'src-tauri/gen/android/app';
    await mkdir(path.join(stage, relative), { recursive: true });
    await mkdir(path.join(original, relative, 'build'), { recursive: true });
    await writeFile(path.join(stage, relative, 'stale'), 'stale generated project');
    await writeFile(path.join(original, relative, 'MainActivity.kt'), 'handwritten');
    await writeFile(path.join(original, relative, 'build/old.apk'), 'old build');
    const config = path.join(stage, 'src-tauri/tauri.personal.conf.json');
    await writeFile(config, JSON.stringify({ identifier: 'top.hypernucleus.readest' }));
    const commands = [];
    await initializeAndroidProject(stage, config, async (args) => {
      commands.push(args);
      await assert.rejects(stat(path.join(stage, relative)), { code: 'ENOENT' });
      assert.equal(JSON.parse(await readFile(args[3], 'utf8')).identifier, 'top.hypernucleus.readest');
      await mkdir(path.join(stage, relative), { recursive: true });
      await writeFile(path.join(stage, relative, 'generated-template'), 'template');
    }, original);
    assert.deepEqual(commands, [['android', 'init', '--config', config]]);
    assert.equal(await readFile(path.join(stage, relative, 'MainActivity.kt'), 'utf8'), 'handwritten');
    assert.equal(await readFile(path.join(original, relative, 'build/old.apk'), 'utf8'), 'old build');
    await assert.rejects(stat(path.join(stage, relative, 'build')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
