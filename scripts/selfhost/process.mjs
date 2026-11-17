// 统一以参数数组启动子进程，不把用户输入交给本地 shell；私密环境变量不打印。
import { spawn } from 'node:child_process';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, STATE } from './config.mjs';

export function run(command, args = [], options = {}) {
  // Windows 的 pnpm.cmd 不能直接 exec；从 pnpm script 环境复用其 JS 入口。
  if (command === 'pnpm' && process.env.npm_execpath) {
    const entry = process.env.npm_execpath;
    // npm 安装的 pnpm 是 JS；@pnpm/exe 则是本机二进制，不能交给 node 当作 JS 解析。
    if (/\.[cm]?js$/.test(entry)) { args = [entry, ...args]; command = process.execPath; }
    else command = entry;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    let output = '';
    // 捕获输出用于解析，不把可能带凭据的配置输出回显到终端。
    child.stdout?.on('data', (data) => { output += data; });
    child.stderr?.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) :
      reject(new Error(`${path.basename(command)} 执行失败（退出码 ${code}）`)));
  });
}

// 防止同一仓库的部署、备份、编译相互覆盖配置；异常退出会保留锁供人工核查。
export async function locked(action) {
  await mkdir(STATE, { recursive: true, mode: 0o700 });
  const filename = path.join(STATE, 'operation.lock');
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`有操作锁：${filename}。确认没有运行中的任务后再删除。`);
    throw error;
  }
  try { await handle.writeFile(String(process.pid)); return await action(); }
  finally { await handle.close(); await rm(filename); }
}

// SSH 的远端命令需要 POSIX quoting；本地仍使用参数数组传输。
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// Web 同样引用词典和 Turso 的 TS 源码；原生构建还需要 Tauri fork/qcms/WebView 插件。
export const prepareSources = (native = false) => run('git', ['submodule', 'update', '--init', '--recursive',
  'packages/foliate-js', 'packages/simplecc-wasm', 'packages/js-mdict', 'apps/readest-app/src-tauri/plugins/tauri-plugin-turso',
  ...(native ? ['packages/tauri', 'packages/qcms', 'apps/readest-app/src-tauri/plugins/tauri-plugin-webview-upgrade'] : []),
]);
