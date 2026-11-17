// 自部署配置只在本机保存；公开配置按白名单导出，避免把服务端/签名密钥带进客户端。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径始终相对模块定位，允许从任意工作目录启动向导。
// 规范化并移除末尾分隔符，后续目录隔离检查在 macOS/Linux/Windows 上使用同一种形式。
export const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const STATE = path.join(ROOT, '.selfhost');
export const APP = path.join(ROOT, 'apps/readest-app');

// 集中校验服务数据与备份位置，避免配置向导和恢复流程使用不同的目录规则。
export function serverDirectories(dataDirectory, backupDirectory) {
  const dataDir = path.resolve(dataDirectory);
  const backupDir = path.resolve(backupDirectory);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  // 仓库内仅开放专用 data/backups 子树，不能把私钥、源码副本或 Rust 缓存当成数据。
  for (const [directory, allowed, label] of [[dataDir, 'data', '数据'], [backupDir, 'backups', '备份']]) {
    if (contains(directory, ROOT) || (contains(ROOT, directory) && !contains(path.join(STATE, allowed), directory))) {
      throw new Error(`${label}目录请放在 .selfhost/${allowed}/ 内或仓库外，不能包含源码仓库`);
    }
  }
  // 双向拒绝嵌套，保证备份不会递归包含自己，也不会混入数据库的运行文件。
  if (contains(dataDir, backupDir) || contains(backupDir, dataDir)) throw new Error('数据目录与备份目录必须分开，不能互相包含');
  return { dataDir, backupDir };
}

// 仅接受不含路径/凭据的 HTTPS 域名，确保代理路由及生成配置不会被输入改变。
export function httpsOrigin(value) {
  if (typeof value !== 'string' || /\s/.test(value)) throw new Error('请输入 HTTPS 域名');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
    url.pathname !== '/' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(url.hostname)) {
    throw new Error('请输入不带路径、账号、参数的 HTTPS 域名');
  }
  return url.origin;
}

// 只允许公开 anon JWT；检查角色不是验签，连接测试负责确认服务器接受该 key。
export function anonKey(value) {
  try {
    const parts = value.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (parts.length === 3 && payload.role === 'anon') return value;
  } catch { /* 统一报错不回显可能误填的管理员密钥。 */ }
  throw new Error('需要 role=anon 的公开 JWT，不能填写 service_role 管理员密钥');
}

// 独立应用 ID/协议避免覆盖官方安装；版本号拒绝未知格式，便于后续迁移配置。
export function clientProfile(value) {
  if (value?.version !== 1) throw new Error('不支持的客户端配置版本');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(value.appId) ||
    value.appId === 'com.bilingify.readest') throw new Error('请使用独立的反向域名应用 ID');
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(value.scheme) || value.scheme.startsWith('readest')) {
    throw new Error('请使用独立的登录回跳协议（不要以 readest 开头）');
  }
  if (typeof value.appName !== 'string' || !value.appName.trim() || value.appName.trim().toLowerCase() === 'readest' ||
    /[\x00-\x1f<>:"/\\|?*]/.test(value.appName) || /[. ]$/.test(value.appName)) {
    throw new Error('应用名称不能为空或包含文件名保留字符');
  }
  const key = Buffer.from(value.updaterPublicKey ?? '', 'base64').toString().trim().split('\n');
  if (key.length !== 2 || !key[0].startsWith('untrusted comment:') ||
    Buffer.from(key[1], 'base64').length !== 42) throw new Error('需要 Tauri 更新公钥文件的内容');
  // 配额也是公开配置，原生客户端需使用与服务端一致的显示值。
  for (const field of ['storageQuota', 'translationQuota']) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) throw new Error(`${field} 必须为正整数`);
  }
  return {
    version: 1, serverUrl: httpsOrigin(value.serverUrl), supabaseAnonKey: anonKey(value.supabaseAnonKey),
    appName: value.appName, appId: value.appId, scheme: value.scheme,
    updaterPublicKey: value.updaterPublicKey.trim(),
    storageQuota: value.storageQuota, translationQuota: value.translationQuota,
  };
}

// 临时文件 + rename 避免中断时破坏旧配置；POSIX 下仅当前用户可读写。
export async function saveJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

// 只有不存在时使用默认值；损坏的配置必须报错，不能悄悄生成新密钥。
export async function loadJson(filename, fallback) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
