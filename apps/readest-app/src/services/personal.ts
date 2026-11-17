// 区分本 fork 的个人部署策略与通用 SELF_HOSTED 高级功能开关。
import { getRuntimeConfig } from './runtimeConfig';

export const isPersonalDeployment = () =>
  getRuntimeConfig()?.personal === true ||
  process.env['READEST_PERSONAL'] === 'true' ||
  process.env['NEXT_PUBLIC_PERSONAL'] === 'true';

// Web 的地址在运行时注入；Tauri 静态构建在编译时固定更新域名。
export const personalUpdateBaseUrl = () =>
  process.env['NEXT_PUBLIC_UPDATER_BASE_URL'] ||
  (isPersonalDeployment()
    ? `${getRuntimeConfig()?.apiBaseUrl || process.env['API_BASE_URL'] || ''}/updates`
    : undefined);
