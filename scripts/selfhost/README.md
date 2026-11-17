# 个人自部署与编译

从仓库根目录运行 `pnpm selfhost`。中文向导逐项询问配置，保存或执行前展示汇总。
本模块面向已确认的组合：Ubuntu x86_64 + Docker Compose + 宿主机 Nginx；
macOS Apple Silicon DMG、Windows x64 NSIS、Ubuntu 上构建 Android ARM64 APK。

## 首次准备

使用 Node.js 26，或 Node.js 24.15 及以上；pnpm 版本由根 `package.json` 固定。
安装 Git 和系统 OpenSSH。服务器用户需要 Docker 权限，构建机需要对应的 Tauri 工具链。

```bash
git switch selfhost/personal-builds
git submodule update --init packages/foliate-js packages/simplecc-wasm packages/js-mdict apps/readest-app/src-tauri/plugins/tauri-plugin-turso
pnpm install --frozen-lockfile
pnpm selfhost
```

向导的部署/构建操作会初始化需要的子模块；不会自行切换分支、合并 Git、更改 Nginx
或安装操作系统工具链。更新源码时，先在这条分支执行自己的 Git 同步流程，再启动向导。
服务器用当前检出的源码构建 `readest-selfhost:local`，不拉取官方客户端镜像。

安全依赖已升级：Next.js 从 16.4.2 升至 16.4.6，修复
[GHSA-mfr8-8qww-v76h](https://github.com/advisories/GHSA-mfr8-8qww-v76h)。
实验性 Vite 服务端使用的 `react-server-dom-webpack` 从 19.2.8 升至 19.2.9，修复
[GHSA-xqc2-xf4c-x3h3](https://github.com/advisories/GHSA-xqc2-xf4c-x3h3)；
`react` 与 `react-dom` 同步升至 19.2.9，满足该包的 peer 依赖约束。
`pnpm-workspace.yaml` 同时固定 RSC 间接依赖，避免 vinext 保留旧漏洞版本。
这些修改位于应用 `package.json`、工作区配置和根锁文件；JSON 不支持注释，故在此解释用途。
构建保留 Next.js 安全检查，不依赖重试许可绕过漏洞提示。

## 先配置服务器

1. 在仓库根目录创建 `.selfhost/data` 和 `.selfhost/backups`，新部署默认使用这两个目录。
   运行数据、备份、配置、密钥、证书和构建产物都保存在项目内；工具链、下载缓存及
   Docker 自身存储仍使用系统位置。数据和备份必须分开，不能互相包含。
2. 运行“配置服务端”，填写 HTTPS 域名、独立名称/应用 ID/协议、目录、三个本机端口、
   TLS 证书路径、存储与翻译配额、可选字体地址和 OPDS 内网主机白名单。
3. 首次可在服务器生成 Tauri 更新签名密钥（服务器也是 Android 构建机），或读取已有
   `.pub` 文件。密钥生成后单独备份；后续配置默认沿用，不自动轮换。
4. 按下文在项目内申请证书，将 `.selfhost/nginx.conf` 链接到 Nginx 配置目录，
   设置公开更新目录的访问权限，先执行 `nginx -t` 再重载。
5. 选择“部署/更新服务端”。首次镜像构建可能较慢，完成后通过 HTTPS 域名访问。
6. 选择“创建账号/重置密码”创建自己的邮箱密码账号。公开注册、匿名账号、SMTP 均关闭。
7. 导出客户端公开配置，将其传到 Mac 和 Windows 并在各自向导中导入。

独立回跳协议可以使用 `readest-h`：系统按完整协议名区分应用，不会与官方 `readest`
冲突；官方已占用的 `readest`、`readest-onedrive` 仍不允许使用。名称、应用 ID 和协议
在输入时立即校验，错误不会留到整轮配置完成后才提示。
如果之前配置失败但已经生成签名密钥，重试时选择“读取已有 Tauri .pub 公钥文件”，
填写 `.selfhost/keys/update.key.pub`，保留原来的私钥和密码；不要重新生成或删除密钥。
只有显示“配置已保存”后，才会有可用于安装到 Nginx 的 `.selfhost/nginx.conf`。

项目内目录布局（全部被 Git 和 Docker 构建上下文排除）：

```text
.selfhost/
  data/             # PostgreSQL、MinIO 和公开 updates/ 安装包
  backups/          # 服务备份，包含服务端凭据
  keys/             # 更新签名私钥和 Android keystore，另行备份
  certbot/          # 证书、续期配置、工作目录和日志
  releases/         # 各平台构建产物
  build-source/     # 可重新生成的构建源码副本
  target/           # Rust 编译缓存
  server.json       # 服务端配置和密钥
  client.json       # 客户端公开连接配置
  local.json        # 本机构建及 SSH 配置
  compose.json      # 生成的 Docker Compose 配置
  nginx.conf        # 生成的 Nginx 站点配置
```

Ubuntu 首次部署，在仓库根目录执行；把示例域名换成你自己的域名，并先完成 DNS 解析：

```bash
install -d -m 700 .selfhost .selfhost/data .selfhost/backups
sudo apt install -y certbot python3-certbot-nginx acl
sudo certbot certonly --nginx -d books.example.com \
  --config-dir "$PWD/.selfhost/certbot/config" \
  --work-dir "$PWD/.selfhost/certbot/work" \
  --logs-dir "$PWD/.selfhost/certbot/logs"
pnpm selfhost
```

选择“配置服务端”。默认数据、备份和证书路径都是项目内的绝对路径，无需手写。
仓库内的数据目录只允许 `.selfhost/data/` 子树，备份只允许 `.selfhost/backups/`
子树，防止误用会被构建流程清理的目录。不要把这些目录符号链接到源码、密钥或彼此内部。
已有的仓库外目录仍支持，重配时沿用现有值；**修改目录不会搬迁已有数据**。
已有服务需先备份、停止服务，再通过“恢复到空数据目录”迁移，不能直接改路径后启动空库。

生成配置后，在 Ubuntu 默认 Nginx 布局中建立链接（若已存在同名站点，先检查其内容）：

```bash
sudo ln -s "$PWD/.selfhost/nginx.conf" /etc/nginx/sites-enabled/readest-selfhost
```

Nginx 的 master 以 root 读取站点配置和证书；worker 只需要穿过祖先目录并读取
公开 `updates/`。以下按 Ubuntu 默认 worker 用户 `www-data` 授予目录穿过权限，
不递归开放 `.selfhost`，也不给 worker 读取私钥、配置和备份的权限。
如果 Nginx `user` 指令使用其他用户，替换 `www-data` 后执行：

```bash
install -d -m 755 .selfhost/data/updates
readest_path="$PWD/.selfhost/data"
while [ "$readest_path" != / ]; do
  sudo setfacl -m u:www-data:--x "$readest_path"
  readest_path="$(dirname "$readest_path")"
done
sudo -u www-data test -x "$PWD/.selfhost/data/updates"
sudo nginx -t
sudo systemctl reload nginx
```

之后使用“部署/更新服务端”。不要对整个 `.selfhost` 执行递归 `chmod 755/777`。
迁移项目路径后需要重新生成 Compose/Nginx 配置、更新站点链接并重新设置祖先目录权限。

Certbot 使用自定义目录时，系统默认续期任务不会自动找到它。需把下面命令加入你的
定时任务（使用项目绝对路径；也可在仓库根目录手动运行）：

```bash
sudo certbot renew \
  --config-dir "$PWD/.selfhost/certbot/config" \
  --work-dir "$PWD/.selfhost/certbot/work" \
  --logs-dir "$PWD/.selfhost/certbot/logs" \
  --deploy-hook 'nginx -t && systemctl reload nginx'
```

服务备份只覆盖数据和服务配置，`keys/` 与 `certbot/` 需另行保存。
项目内备份与原数据在同一磁盘，仍应定期复制备份到另一台机器。

域名必须使用 HTTPS 默认 443 端口且不带路径。Nginx 将 `/` 转发到网页服务，
`/auth/v1/`、`/rest/v1/` 转发到 Kong，`/readest-files/` 转发到 MinIO，
`/updates/` 读取公开发布目录。Docker 的网页/Kong/S3 端口只监听 `127.0.0.1`，
MinIO 控制台不对外开放。证书申请、DNS 和 Nginx 安装由你管理。

沿用的内部固定配置：数据库 `postgres`、端口 5432、JWT 会话有效期 3600 秒、
S3 bucket `readest-files`、region `us-east-1`、MinIO 管理用户 `readest-admin`。
数据库密码、JWT 签名密钥及 MinIO 密码分别随机生成；公开 anon JWT 和管理员 JWT
用该部署的 JWT 密钥签名。管理员 JWT 不会导出到客户端。

字体、翻译、词典、TTS 等外部服务仍需可用的资源或自己的服务/API key。
`SELF_HOSTED` 解锁功能不会提供官方付费服务的凭据。Readest 的 CJK 字体 CDN 可能
拒绝自定义域名的跨域请求，可在向导中填自己的镜像地址；字体文件需另行准备。

## 编译各客户端

在三台机器分别导入同一份公开配置，选择“配置本机编译与签名”。
Tauri 更新签名私钥必须与公开配置中的公钥配对：三台构建机使用同一把更新签名私钥，
通过安全方式单独分发，**不放进 Git，也不放进公开配置导出文件**。
构建时交互输入加密口令，脚本不保存口令。私钥路径限于 `.selfhost/` 内或仓库外。

| 平台 | 预先安装 | 产物/签名 |
| --- | --- | --- |
| macOS Apple Silicon | Xcode Command Line Tools、Rust，`aarch64-apple-darwin` target | DMG + `.app.tar.gz` 更新包；本地临时签名，不做 Apple 公证 |
| Windows x64 | Visual Studio C++ Build Tools、Rust MSVC toolchain、WebView2 | NSIS `.exe`，暂不接入 Windows 代码签名证书 |
| Ubuntu Android | JDK 17、Android SDK platform 36、NDK 28.2.13676358、Rust Android target，Tauri Android 所需系统依赖 | ARM64 APK，自己的长期 keystore + 更新包签名 |

Android keystore 可以在向导中首次生成。密码和 alias 必须长期保留；丢失 keystore
就无法给现有 APK 做覆盖升级。服务器空间应同时容纳 SDK/NDK、Rust/Gradle 缓存、
Docker 镜像、书库与备份；“环境检查”显示可用空间，不会自动清理任何数据。

选择“编译当前平台客户端”，输入三平台统一的 `major.minor.patch` 稳定版版本号。
后续发布必须递增；minor、patch 限制在 0–999，Android versionCode 使用
`major * 1000000 + minor * 1000 + patch`。三平台需使用相同源码与公开配置。

构建使用 `.selfhost/build-source/` 中的源码副本、`.selfhost/target/` 中的 Rust 缓存；
身份替换仅作用于副本。不会覆盖工作区的 Tauri/Android 配置或已有 `.env.local`。
macOS/Windows 自用安装包可能触发系统的未公证/未知发布者提示。

首次已确认不接入 Windows Explorer 缩略图扩展及 Google Drive/OneDrive OAuth。
个人版隐藏对应入口，也不注册官方云盘回跳协议，避免与官方版冲突。
内置系统字体、其他阅读资源和自建服务器同步不受此决策影响。
登录后在集成设置中开启同步；上游界面仍有“Readest Cloud”字样，在个人构建中实际连接
的是你导入的服务器域名。

## 上传与应用内更新

构建产物在 `.selfhost/releases/<版本>/<平台>/`。不要编辑里面的 `release.json`。

1. 在 Mac/Windows 选择“通过 SSH 上传并发布更新”，确认 SSH 主机、用户、端口、
   私钥路径（或使用 ssh-agent）、服务器仓库绝对路径。
2. 服务器必须已拉取本分支并完成服务器配置；SSH 用户需有仓库和更新目录写权限。
   保留 OpenSSH 的主机指纹检查，不绕过 `known_hosts` 校验。
3. Android 在服务器编译后，可在同一菜单选择直接汇总本机产物，无需 SSH 连回自己。
4. 服务器验证应用 ID、域名、公钥、文件哈希和更新包签名。相同版本的 macOS、Windows、
   Android 三个平台都到齐后，才发布该版本，并最后原子替换 `latest.json`。

客户端只读取 `<域名>/updates/latest.json`；旧的 nightly 偏好也不回退官方源。
版本目录发布后不可变；相同内容重复上传是幂等的，不同内容必须换版本号。
发布说明生成到 `release-notes.json`。恢复/迁移前后保留同一域名、应用 ID、更新公钥
和 Android 签名证书，已安装客户端即可继续同步和升级。

SSH 接收端也可手动调用（此命令会执行发布，不再二次询问）：

```bash
node scripts/selfhost/cli.mjs --receive /absolute/path/to/release-directory
```

## 备份与迁移

“备份服务端”记录服务镜像信息、保存网页 Docker 镜像，停止栈后备份数据库、对象文件、
更新目录和服务端配置，再启动备份前运行的服务。备份期间服务不可用；备份目录包含
服务端密钥，应单独妥善保存。更新签名私钥和 Android keystore **不在服务备份中**，
需要额外备份。

这是**同 CPU 架构、相同 PostgreSQL 版本的物理备份**，不用于跨数据库大版本升级。
备份会尽可能将上游镜像固定到 digest；恢复前核对 `images.json` 和 `compose.json`。
网页镜像打包在 `client-image.tar`，无需在恢复时重新编译。

新服务器拉取分支、安装依赖后，运行“恢复到空数据目录”。只接受可信备份；不清空已有
数据目录。默认恢复到 `.selfhost/data`，并重新确认备份目录（默认 `.selfhost/backups`），
不沿用旧服务器项目路径。恢复会替换 `.selfhost` 中的服务配置，然后用“启动已恢复服务”启动备份版本。
先验证登录、书籍上传/下载、阅读进度同步和更新，再切 DNS；避免新旧两台同时接收写入。

域名若也更换，必须在旧域名仍可用时发布指向新地址的客户端，或手动重新安装。
修改公开配额后需重新导出/编译客户端以更新其显示值；服务器配额立即由服务端配置控制。

## 配置文件与改动说明

所有私密/本机状态在 `.selfhost/`，同时被 `.gitignore` 和 `.dockerignore` 排除。
POSIX 配置文件权限为 0600；Windows 请用用户目录和文件 ACL 保护私钥。

| 文件/代码 | 修改作用 |
| --- | --- |
| 根 `package.json` 的 `selfhost` / `test:selfhost` | 提供交互入口与模块测试命令；JSON 不支持行内注释，故在此说明 |
| 根 `package.json` 的 `@inquirer/prompts`、`pnpm-lock.yaml` | 固定中文交互组件与传递依赖；保留原有其他依赖版本 |
| `config.mjs` | 配置格式/域名/公开 JWT 校验、白名单导出和原子私密保存 |
| `process.mjs` | 跨平台参数数组执行、单操作锁、子模块准备、SSH 参数引用 |
| `server.mjs` | 随机凭据、Compose/Nginx 生成、部署、账号管理、备份/恢复 |
| `build.mjs` | 隔离源码副本、独立身份、构建环境、Tauri 覆盖配置、产物收集 |
| `release.mjs` | 签名/哈希验证、SSH 上传、三平台汇总与原子发布 |
| `cli.mjs` | 每个值的交互询问、摘要与执行确认 |
| `runtimeConfig.ts`、`personal.ts`、`environment.ts`、`constants.ts`、`access.ts` | 个人部署标志、自建 Node API/更新源/共享链接地址、客户端公开配额 |
| 登录面板、`PHContext.tsx`、集成/控制设置、云盘 provider | 隐藏未配置服务、关闭官方遥测及有身份冲突的额外集成 |
| `UpdaterWindow.tsx` | Android 稳定版更新包验签，并以下载完成事件推进安装 |
| `Dockerfile` | 声明个人部署构建参数，使预渲染与浏览器策略一致 |

生成的 `server.json`、`client.json`、`local.json`、`compose.json` 和
`tauri.personal.conf.json` 是数据文件，JSON 不能放注释；其字段在向导和本说明中解释。
实际源代码中的每组修改均附注释。不要手动修改生成的密钥或已发布清单来“修复”升级。

测试：`pnpm test:selfhost`。应用测试在 Node 26 上可用
`NODE_OPTIONS=--no-experimental-webstorage pnpm test --run` 避免内置实验性 localStorage
干扰现有测试环境。操作异常中断可能留下 `.selfhost/operation.lock`；确认没有构建、
部署或发布进程运行后再移除锁，向导不会自行强行解锁。
