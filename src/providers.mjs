// Provider capabilities describe the routes this application has actually verified.
// Preparing a magnet never contacts a provider or creates an offline task.
export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

const definitions = [
  {
    id: 'xunlei',
    name: '迅雷云盘',
    availability: 'verified',
    bridgeSupported: true,
    cloudUrl: 'https://pan.xunlei.com/',
    magnetImport: 'manual',
    note: '已通过本机 CloudDrive2 / WebDAV 验证原码 4K 片段读取。磁力任务需先在迅雷官方页面或客户端添加。',
    steps: [
      '在迅雷官方页面或客户端登录自己的迅雷账号，将磁力链接添加为云端下载任务，选择需要的视频。',
      '等待云端任务完成，在本机 CloudDrive2 添加同一个迅雷账号。',
      '回到本工具连接本机 CloudDrive2 / WebDAV，刷新目录并选择视频，然后输入时间、选择本机保存位置。',
    ],
  },
  {
    id: 'baidu',
    name: '百度网盘',
    availability: 'needs-verification',
    bridgeSupported: true,
    cloudUrl: 'https://pan.baidu.com/',
    magnetImport: 'manual',
    note: 'CloudDrive2 官方支持百度网盘；本工具尚未完成百度原文件片段读取实测。BT / 磁力离线入口与权限以官方客户端、账号及当前版本为准。',
    steps: [
      '先在百度网盘官方客户端确认自己的账号是否提供可用的 BT / 磁力离线入口；本工具不保证任意账号均可使用。',
      '如官方客户端支持该链接，手动创建云端任务并等待完成；如不支持，请将已有的视频上传或合法转存到自己的百度网盘。',
      '在本机 CloudDrive2 添加自己的百度网盘，回到本工具连接 WebDAV 并选择视频。',
      '首次先检查源文件并试取短片段，确认账号下载权限、原文件 Range 读取及播放正常后再使用；失败时不会改为下载整片。',
    ],
  },
];

export const providers = Object.freeze(definitions.map(provider => Object.freeze({
  ...provider,
  steps: Object.freeze([...provider.steps]),
})));

const MAX_MAGNET_LENGTH = 8192;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function invalidMagnet() {
  return new ProviderError('MAGNET_INVALID', '请输入有效的磁力链接，必须包含一个 40 位十六进制或 32 位 Base32 的 BTIH。');
}

function normalizeInfoHash(value) {
  if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (!/^[a-z2-7]{32}$/i.test(value)) throw invalidMagnet();
  // 32 Base32 digits are exactly 160 bits, so there is no padding to accept.
  let buffer = 0;
  let bits = 0;
  const bytes = [];
  for (const digit of value.toUpperCase()) {
    buffer = (buffer << 5) | BASE32.indexOf(digit);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function prepareMagnet({ providerId, magnet } = {}) {
  const provider = providers.find(item => item.id === providerId);
  if (!provider) throw new ProviderError('PROVIDER_INVALID', '请选择迅雷云盘或百度网盘。');
  if (typeof magnet !== 'string' || !magnet || magnet.length > MAX_MAGNET_LENGTH
    || CONTROL_CHARACTERS.test(magnet) || magnet.trim() !== magnet
    || /%(?![0-9a-f]{2})/i.test(magnet) || magnet.includes('#')) throw invalidMagnet();

  let url;
  try { url = new URL(magnet); } catch { throw invalidMagnet(); }
  if (url.protocol !== 'magnet:' || url.host || url.username || url.password || url.pathname
    || !/^magnet:\?/i.test(magnet)) throw invalidMagnet();

  // Reject encoded controls and invalid UTF-8 as well as their literal forms.
  for (const part of url.search.slice(1).split('&')) {
    const separator = part.indexOf('=');
    const rawKey = separator === -1 ? part : part.slice(0, separator);
    const rawValue = separator === -1 ? '' : part.slice(separator + 1);
    try {
      if (CONTROL_CHARACTERS.test(decodeURIComponent(rawKey.replace(/\+/g, ' ')))
        || CONTROL_CHARACTERS.test(decodeURIComponent(rawValue.replace(/\+/g, ' ')))) throw invalidMagnet();
    } catch { throw invalidMagnet(); }
  }
  const topics = url.searchParams.getAll('xt');
  if (topics.length !== 1 || !/^urn:btih:/i.test(topics[0])) throw invalidMagnet();
  const infoHash = normalizeInfoHash(topics[0].slice('urn:btih:'.length));
  const displayName = url.searchParams.get('dn')?.trim().slice(0, 200) || infoHash;

  return {
    providerId: provider.id,
    displayName,
    infoHash,
    magnet: url.href,
    cloudUrl: provider.cloudUrl,
    instructions: [...provider.steps],
    automaticImport: false,
  };
}
