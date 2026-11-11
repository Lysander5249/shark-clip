// Fixed, local readiness copy. A responding WebDAV service is not an account
// authorization or a promise that media can be read from a cloud provider.
export function setupPlatformLabel(platform) {
  if (platform?.os === 'darwin' && platform.arch === 'arm64') return 'M 系列 Mac';
  if (platform?.os === 'win32' && platform.arch === 'x64') return 'Windows x64';
  return '当前系统未列入这两个发行版本';
}

// Reject accidental credentials in the address before it enters an API body.
export function setupCheckAddress(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\u0000-\u0020\u007f\\]/u.test(text) || text.includes('?') || text.includes('#')) return null;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password ? text : null;
  } catch { return null; }
}

export function setupHealthView(report, { windowsEdge = false, xunleiOnly = windowsEdge } = {}) {
  if (report?.schemaVersion !== 1) return null;
  const toolsReady = report.tools?.ffmpeg === true && report.tools?.ffprobe === true;
  const storageReady = report.storage?.status === 'ready';
  const free = report.storage?.freeBytes;
  const freeText = Number.isSafeInteger(free) && free >= 0
    ? `当前可用空间约 ${(free / (1024 ** 3)).toFixed(1)} GiB。` : '可用空间暂时未知。';
  const cloudResponding = report.cloudDrive?.status === 'responding';
  const cloudUnsupported = report.cloudDrive?.status === 'unsupported_address';
  return {
    headline: !toolsReady || !storageReady ? '有项目需要处理，请按下方提示检查。'
      : windowsEdge ? `本机组件和保存位置已就绪。登录${xunleiOnly ? '迅雷云盘' : '迅雷云盘或百度网盘'}后可使用 Edge 抓链。`
      : cloudResponding ? '本机检查完成。接下来连接云盘账号，确认文件能否读取。'
        : '本地取材环境已就绪。使用云盘前请先准备 CloudDrive2。',
    items: [
      { label: '运行平台', tone: report.platform?.supportedTarget === true ? 'ok' : 'warn', detail: setupPlatformLabel(report.platform) },
      { label: '视频处理组件', tone: toolsReady ? 'ok' : 'error', detail: toolsReady ? 'FFmpeg 和 FFprobe 可用，无需另外安装。'
        : '视频处理组件不可用，请重新解压完整安装包；开发运行请检查配置。' },
      { label: '保存位置', tone: storageReady ? 'ok' : 'error', detail: storageReady
        ? `已验证可以创建文件。${freeText}取片期间仍需留意剩余空间。`
        : report.storage?.code === 'OUTPUT_CLEANUP_FAILED' ? '保存位置的检查文件未能清理，请查看目录权限后重新检查。'
          : '无法写入当前保存位置，请在「保存到你的电脑」中选择其他文件夹，再重新检查。' },
      { label: windowsEdge ? '备用 CloudDrive2 服务' : 'CloudDrive2 服务', tone: cloudResponding ? 'ok' : windowsEdge ? 'info' : 'warn', detail: cloudResponding
        ? '本机 WebDAV 服务有响应；尚未核对账号、网盘授权或视频读取能力。'
        : cloudUnsupported ? '这里只检查本机 WebDAV 地址，请核对下方的 CloudDrive2 地址。'
          : windowsEdge ? '备用 WebDAV 服务未响应。使用 Edge 抓链时可跳过。'
          : '本机 WebDAV 暂无有效响应。请打开 CloudDrive2，检查服务已启动、WebDAV 已启用及地址是否一致。本地文件取材可跳过。' },
    ],
  };
}
