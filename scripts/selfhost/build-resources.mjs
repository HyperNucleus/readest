import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, STATE } from './config.mjs';
import { run } from './process.mjs';

// A high watermark below rustc's working set can stall it in reclaim indefinitely.
// Keep the hard cap and group OOM policy, without soft-limit throttling.
export const BUILD_LIMITS = ['MemoryHigh=infinity', 'MemoryMax=4500M', 'MemorySwapMax=512M',
  'OOMPolicy=kill', 'CPUQuota=200%', 'IOWeight=10'];

export async function resourceSnapshot(group) {
  const read = async (file) => readFile(file, 'utf8').catch(() => null);
  const snapshot = { time: new Date().toISOString() };
  for (const name of ['meminfo', 'vmstat', 'pressure/memory', 'pressure/io']) {
    snapshot[name] = await read(`/proc/${name}`);
  }
  snapshot.cgroup = {};
  for (const name of ['memory.current', 'memory.peak', 'memory.swap.current', 'memory.events',
    'memory.pressure', 'io.stat', 'cpu.stat']) {
    snapshot.cgroup[name] = await read(path.join(group, name));
  }
  const pids = (await read(path.join(group, 'cgroup.procs')) || '').trim().split(/\s+/).filter(Boolean);
  snapshot.processes = await Promise.all(pids.map(async (pid) => ({
    pid, name: (await read(`/proc/${pid}/comm`))?.trim(),
    status: await read(`/proc/${pid}/status`),
  })));
  // No command lines or environment: signing passwords must never enter diagnostics.
  return snapshot;
}

export async function protectedBuild(payload) {
  await mkdir(path.join(STATE, 'build-logs'), { recursive: true, mode: 0o700 });
  const unit = `readest-build-${process.pid}-${Date.now()}.scope`;
  const log = path.join(STATE, 'build-logs', `${unit}.jsonl`);
  await writeFile(log, JSON.stringify({ unit, limits: BUILD_LIMITS }) + '\n', { mode: 0o600 });
  console.log(`构建资源限制：内存 4500 MiB / swap 512 MiB / CPU 2 核；资源日志：${log}`);
  // The parent (and its operation lock) stays outside the scope and survives group OOM.
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', `--unit=${unit}`,
    ...BUILD_LIMITS.flatMap((limit) => ['--property', limit]),
    process.execPath, path.join(ROOT, 'scripts/selfhost/build-worker.mjs')],
  { cwd: ROOT, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {}); // systemd may reject the scope before reading stdin.
  child.stdin.end(JSON.stringify(payload));
  let group;
  let finished = false;
  const sample = async () => {
    if (!group) {
      const relative = await run('systemctl', ['--user', 'show', unit, '--property=ControlGroup', '--value'], { capture: true });
      if (!relative.startsWith('/')) return;
      group = path.join('/sys/fs/cgroup', relative);
    }
    await appendFile(log, JSON.stringify(await resourceSnapshot(group)) + '\n');
  };
  let sampling = Promise.resolve();
  const tick = () => {
    sampling = sampling.then(sample).catch((error) => {
      console.error(`资源采样失败：${error.message}`);
    });
  };
  const timer = setInterval(tick, 5000);
  const forward = (signal) => { child.kill(signal); };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    finished = true;
    tick();
    await sampling;
    const unitResult = await run('systemctl', ['--user', 'show', unit, '--property=Result'], { capture: true }).catch(() => null);
    await appendFile(log, JSON.stringify({ time: new Date().toISOString(), exitCode: code, signal, unitResult }) + '\n');
    if (code !== 0) throw new Error(`受限构建失败（退出码 ${code}${signal ? `，信号 ${signal}` : ''}），请检查 ${log}。不会自动改为无限制重试。`);
    return path.join(STATE, 'releases', payload.version, 'android-arm64');
  } finally {
    clearInterval(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    if (!finished) child.kill('SIGTERM');
    await run('systemctl', ['--user', 'stop', unit], { capture: true }).catch(() => {});
    await run('systemctl', ['--user', 'reset-failed', unit], { capture: true }).catch(() => {});
  }
}
