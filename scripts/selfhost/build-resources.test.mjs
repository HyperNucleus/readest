import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureAndroidResources } from './build.mjs';
import { resourceSnapshot } from './build-resources.mjs';

test('Android resource settings replace conflicting defaults and preserve app properties', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'readest-gradle-'));
  try {
    const directory = path.join(root, 'src-tauri/gen/android');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'gradle.properties');
    await writeFile(file, 'org.gradle.jvmargs=-Xmx2048m\norg.gradle.workers.max = 8\norg.gradle.daemon:true\nandroid.useAndroidX=true\n');
    await configureAndroidResources(root);
    await configureAndroidResources(root);
    const source = await readFile(file, 'utf8');
    assert.match(source, /^android.useAndroidX=true$/m);
    assert.match(source, /^org.gradle.workers.max=1$/m);
    assert.match(source, /^org.gradle.daemon=false$/m);
    assert.match(source, /^kotlin.compiler.execution.strategy=in-process$/m);
    assert.equal(source.match(/org.gradle.jvmargs=/g).length, 1);
    assert.doesNotMatch(source, /2048m|workers.max = 8|daemon:true/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resource samples retain cgroup OOM evidence without recording command lines or environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'readest-cgroup-'));
  try {
    await writeFile(path.join(root, 'memory.events'), 'oom 1\noom_kill 1\n');
    await writeFile(path.join(root, 'memory.peak'), '4718592000\n');
    await writeFile(path.join(root, 'cgroup.procs'), `${process.pid}\n`);
    const sample = await resourceSnapshot(root);
    assert.equal(sample.cgroup['memory.events'], 'oom 1\noom_kill 1\n');
    assert.equal(sample.cgroup['memory.peak'], '4718592000\n');
    assert.equal(sample.cgroup['memory.current'], null);
    assert.deepEqual(Object.keys(sample.processes[0]).sort(), ['name', 'pid', 'status']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
