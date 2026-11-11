# 桌面分发构建

发行目标为 Mac Apple Silicon（arm64）和 Windows x64。Mac 使用 AppKit + WKWebView 外壳和独立 Node 子进程。Windows Edge 双网盘预览包自带 Node 和媒体组件，用 Edge 显示本机面板，复用 Edge 中的迅雷云盘或百度网盘登录。两者都在 `127.0.0.1` 监听。Windows 预览包内的《使用说明》介绍解压、启动和安装抓链书签。

## 可复现的 Mac 构建

构建机需要 macOS、Apple Command Line Tools（含 Swift/clang/make）和 Node.js 22+，用户电脑不用安装这些构建工具。脚本从 Node 官方下载固定版本 24.22.0、校验官方 SHA256 清单；从 FFmpeg 官方下载固定版本 9.0.2、校验源码固定 SHA256。

在项目根目录运行：

```sh
npm run build:mac
version="$(node -p 'require("./package.json").version')"
node scripts/smoke-package.mjs "dist/$version/Shark-mac-arm64.app"
```

只先编译媒体工具：

```sh
node scripts/build-ffmpeg-macos.mjs --arch arm64
```

Mac 打包和媒体构建入口只接受 arm64；不支持的架构及未知参数在下载或改写发布目录前拒绝。Windows 打包入口只接受 x64，不提供 Intel Mac、Windows ARM64 或 32 位发行包。默认最低系统声明为 macOS 13.5，实际可支持的最低版本应以独立设备验收为准。

下载、源码和编译缓存位于项目外层 `work/desktop-build`；可用 `CLIP_FETCHER_BUILD_DIR` 指定构建机上的其他绝对目录。重复构建复用已校验的下载与已编译媒体工具。修改 FFmpeg 配置后应删除对应 `ffmpeg/darwin-arm64` 和 `ffmpeg-build/darwin-arm64` 缓存再构建。请勿同时运行两个针对同一架构的构建。

产物默认位于 `dist/<版本>/`，包括 `Shark-mac-arm64.app`、ZIP 和 SHA256 文件。构建从源码编译启动器并生成图标。重复构建同一版本时，用 `CLIP_FETCHER_DIST_DIR` 指定新的绝对发布目录。打包使用明确的代码文件白名单，只纳入运行代码和合成示例。

## Windows x64 + Edge 双网盘构建与 CI

Windows 双网盘预览包命名为 `Shark-<版本>-windows-x64-Edge-迅雷-百度.zip`。默认输出到 `dist/`，同时生成同名解压目录和 `.sha256` 校验文件。重复构建使用新的 `CLIP_FETCHER_DIST_DIR`，避免覆盖已有版本。

### 从 Mac 交叉构建

准备 macOS Command Line Tools 和 Node.js 22+。将固定的 `node-v24.22.0-win-x64.zip`、`llvm-mingw-20261104-ucrt-macos-universal.tar.xz`、`zlib-1.4.tar.xz` 和 `ffmpeg-9.0.2.tar.xz` 放入 `work/windows-build/downloads/`。若 `work/subtitle-media-build/downloads/` 已有同版 FFmpeg 源码，交叉脚本可直接校验并使用它。归档使用脚本固定的 SHA-256。可设置绝对路径 `CLIP_FETCHER_BUILD_DIR` 更换 Windows 构建缓存。 [Node 官方发布](https://nodejs.org/en/blog/release/v24.22.0) · [LLVM-MinGW 发布](https://github.com/mstorsjo/llvm-mingw/releases/tag/20261104) · [zlib 源码](https://zlib.net/) · [FFmpeg 官方下载](https://ffmpeg.org/download.html)

```sh
bash scripts/build-ffmpeg-windows-cross.sh
node scripts/build-windows.mjs --arch x64
```

交叉构建从固定 FFmpeg 源码编译 Win64 媒体程序，静态链接 zlib，并核对三个 Windows 可执行文件的架构、哈希和导入表。Mac 上完成这一步可验证包结构，运行烟测在 Windows x64 上执行。

### 在 Windows 上构建并验收

本地构建需要 Node 22+、MSYS2 UCRT64、GCC、make、curl、tar、xz 和静态 zlib。先在 UCRT64 shell 中编译媒体组件。

```sh
bash scripts/build-ffmpeg-windows.sh
```

然后打开 PowerShell 完成打包和烟测。

```powershell
$env:CLIP_FETCHER_UCRT64_BIN = 'C:\msys64\ucrt64\bin'
./scripts/build-windows.ps1
$version = node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version"
node scripts/smoke-package.mjs "dist/Shark-$version-windows-x64-Edge-迅雷-百度"
```

若要验收从 Mac 生成的 ZIP，完整解压后将解压目录传给 `scripts/smoke-package.mjs`。随包附有 Node 和 FFmpeg，双击带鲨鱼鳍图标的 `Shark.exe` 即可打开 Edge 面板。也可使用 `启动片段取材.cmd`。烟测使用本地示例，Edge 上迅雷和百度的真实抓链与出片需要在 Windows 上验收。

在 Git 仓库中可手动运行 `.github/workflows/windows-portable.yml`。该工作流运行桌面回归、使用 MSYS2 UCRT64 编译媒体组件、打包并执行本地示例烟测。产物保存在工作流 artifact 中。

当前完整媒体回归仍有测试移植缺口：多项合成素材使用 libx264 编码，诊断测试还生成 POSIX shebang 可执行文件，不能直接当作 Windows 测试材料。发行用 LGPL 媒体工具不含 libx264；不要把测试专用的全功能媒体工具复制进发行包。Windows 流程暂不运行 `npm test`，保留 `npm run test:desktop` 和独立包烟测；完整回归需先解决这些 fixture 和执行方式，再在 Windows 单独验收。

## 首次使用检查

Windows Edge 双网盘预览先用内置示例核对保存位置和出片，再在 Edge 登录网盘并安装一次抓链书签。

使用 WebDAV 的版本可打开面板里的「首次使用与环境检查」，填写本机 WebDAV 地址和保存位置，再点「检查本机环境」。检查会确认随包视频处理组件、尝试在保存位置创建并清理一个空文件，并查询本机 WebDAV 是否响应。可用空间是检查时的值。

WebDAV 能响应不代表已经登录、授权到正确云盘或能读取具体影片。云盘取材仍需先在 CloudDrive2 添加自己的账号，再回到工具连接、选片和检查源文件；本地文件可直接使用。环境检查不代替真实取片和剪辑软件导入验收。

Windows 当前默认路径为用户目录下的 `Videos/片段取材`，尚未解析或实测系统 Videos Known Folder、OneDrive 和企业策略的目录重定向。应通过现有「选择文件夹」指定实际保存位置，再执行环境检查；不要声称重定向目录问题已经解决。

## 进程、数据和密码

Mac 启动器只接受子进程输出的 `CLIP_FETCHER_URL=http://127.0.0.1:端口`，不会将任意输出当成浏览地址。文件与目录选择由 AppKit 原生窗口处理，父子进程通过私有标准输入输出通信；WKWebView 无原生 JavaScript 桥接，不加载第三方页面；主动点击的正常 HTTPS 链接交给系统浏览器。WebView 使用临时网站数据存储。

本机 Node 服务在退出时取消任务。Mac 外壳异常退出后，后端会检测父 PID 并自行退出。桌面入口利用独占 loopback socket 实现每个数据目录单实例；第二次启动验证已有实例的会话哈希并复用面板。崩溃后操作系统自动释放锁，残留 PID 记录不会阻止重新启动。

默认素材路径为 Mac `~/Movies/片段取材`、Windows `~/Videos/片段取材`。Shark Mac 包沿用 `~/Library/Application Support/ClipFetcher-BookmarkPreview`，Windows Edge 包使用 `%LOCALAPPDATA%/ClipFetcher-BookmarkPreview`。单实例定位文件保存 PID、随机标识、本机 URL 和会话令牌的 SHA-256。

`npm run test:desktop` 覆盖单实例、已有面板识别、令牌不落盘、无效地址和崩溃后恢复。`scripts/smoke-package.mjs` 只验收打包后端及媒体工具，不替代原生界面、真实云盘和剪辑软件验收。

## FFmpeg 及公开发行边界

媒体工具禁用 GPL、version3、nonfree 和自动检测的外部库，静态链接 FFmpeg 自身组件，Mac 只依赖系统动态库。保留原生视频/音频解码、流复制、AAC 编码等所需功能。没有打包 Homebrew 的 GPL 版本，也没有依赖用户电脑里的 `/opt/homebrew`。

每份包附 LGPL 2.1 许可、FFmpeg `LICENSE.md`、同版本完整未改源码压缩包、具体配置与重建脚本。Node 官方分发中的完整许可证也随包保留。FFmpeg/ffprobe 是独立可替换命令行程序。

Mac 构建末尾的 ad-hoc 签名只满足本地可执行性；它不等于 Developer ID 签名或 Apple 公证。公开发行前需为最终嵌套程序和外壳完成正确签名、公证、独立干净机器测试，以及发布页和更新渠道。Windows 试用包也尚未完成发行者代码签名。当前没有自动更新、收费、远端账户服务或自动发布。

官方依据：[Node 下载](https://nodejs.org/dist/)、[FFmpeg 下载](https://ffmpeg.org/download.html)、[FFmpeg 许可](https://ffmpeg.org/legal.html)、[Apple 公证](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。
