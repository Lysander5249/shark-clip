import http from 'node:http';
import https from 'node:https';

const DAV = 'DAV:';
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_ENTRIES = 1000;
const REQUEST_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';
// XML 1.0 NCName ranges, including non-ASCII namespace prefixes.
const NAME_START = '[A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}]';
const NAME_EXTRA = '[.0-9\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]';
const NCNAME = `${NAME_START}(?:${NAME_START}|${NAME_EXTRA})*`;
const XML_QNAME = new RegExp(`^${NCNAME}(?::${NCNAME})?`, 'u');

export class WebDavError extends Error {
  constructor(code, message) { super(message); this.name = 'WebDavError'; this.code = code; }
}
const fail = (code, message) => new WebDavError(code, message);
const invalidXml = () => fail('WEBDAV_XML_INVALID', '网盘返回的目录 XML 不完整或格式不受支持。');
const invalidUrl = () => fail('WEBDAV_URL_INVALID', '请输入本机 CloudDrive2 的 WebDAV 目录地址，不要在地址中包含凭据、查询参数或特殊路径。');
const unsafeHref = () => fail('WEBDAV_HREF_UNSAFE', '网盘目录返回了跨服务、越界或不安全的文件路径，已停止。');

function validCharacters(value) {
  for (const char of value) {
    const n = char.codePointAt(0);
    if (!(n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xD7FF) || (n >= 0xE000 && n <= 0xFFFD) || (n >= 0x10000 && n <= 0x10FFFF))) throw invalidXml();
  }
  return value;
}

function entities(value) {
  validCharacters(value);
  let output = '', position = 0;
  while (position < value.length) {
    const start = value.indexOf('&', position);
    if (start < 0) return output + value.slice(position);
    output += value.slice(position, start);
    const end = value.indexOf(';', start + 1);
    if (end < 0) throw invalidXml();
    const entity = value.slice(start + 1, end);
    const standard = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(standard, entity)) output += standard[entity];
    else if (/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) {
      const number = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isSafeInteger(number) || number > 0x10FFFF || number < 0) throw invalidXml();
      output += validCharacters(String.fromCodePoint(number));
    } else throw invalidXml();
    position = end + 1;
  }
  return output;
}

// Deliberately constrained XML 1.0 parser: no DTD/entities, no recovery, bounded tree.
// Element matching uses resolved namespaces, never a prefix-specific regular expression.
function parseXml(input) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { throw invalidXml(); }
  validCharacters(source);
  source = source.replace(/\r\n?/g, '\n');
  let position = 0, root = null, count = 0, declaration = false;
  const stack = [];
  const whitespace = () => { while (/[ \t\n]/.test(source[position] || '') && position < source.length) position++; };
  const name = () => {
    const match = XML_QNAME.exec(source.slice(position));
    if (!match) throw invalidXml();
    position += match[0].length;
    return match[0];
  };
  while (position < source.length) {
    if (source[position] !== '<') {
      const next = source.indexOf('<', position);
      const raw = source.slice(position, next < 0 ? source.length : next);
      if (raw.includes(']]>')) throw invalidXml();
      const value = entities(raw);
      if (stack.length) stack.at(-1).text += value;
      else if (/[^ \t\n]/.test(value)) throw invalidXml();
      position = next < 0 ? source.length : next;
      continue;
    }
    if (source.startsWith('<!--', position)) {
      const end = source.indexOf('-->', position + 4);
      const content = source.slice(position + 4, end);
      if (end < 0 || content.includes('--') || content.endsWith('-')) throw invalidXml();
      position = end + 3; continue;
    }
    if (source.startsWith('<![CDATA[', position)) {
      const end = source.indexOf(']]>', position + 9);
      if (end < 0 || !stack.length) throw invalidXml();
      stack.at(-1).text += source.slice(position + 9, end);
      position = end + 3; continue;
    }
    if (source.startsWith('<!', position)) throw invalidXml();
    if (source.startsWith('<?', position)) {
      const end = source.indexOf('?>', position + 2);
      if (end < 0) throw invalidXml();
      const instruction = source.slice(position + 2, end);
      if (/^xml(?:[ \t\n]|$)/i.test(instruction)) {
        if (position !== 0 || declaration || !/^xml[ \t\n]+version[ \t\n]*=[ \t\n]*(['"])1\.0\1(?:[ \t\n]+encoding[ \t\n]*=[ \t\n]*(['"])[Uu][Tt][Ff]-8\2)?(?:[ \t\n]+standalone[ \t\n]*=[ \t\n]*(['"])(?:yes|no)\3)?[ \t\n]*$/.test(instruction)) throw invalidXml();
        declaration = true;
      } else if (!/^[A-Za-z_][A-Za-z0-9_.-]*(?:[ \t\n]|$)/.test(instruction)) throw invalidXml();
      position = end + 2; continue;
    }
    if (source.startsWith('</', position)) {
      position += 2;
      const closing = name(); whitespace();
      if (source[position++] !== '>' || !stack.length || stack.at(-1).name !== closing) throw invalidXml();
      stack.pop(); continue;
    }
    position++;
    const nodeName = name(), attributes = new Map();
    let closed = false;
    while (position < source.length) {
      const before = position; whitespace();
      if (source.startsWith('/>', position)) { closed = true; position += 2; break; }
      if (source[position] === '>') { position++; break; }
      if (before === position) throw invalidXml();
      const key = name(); whitespace();
      if (attributes.has(key) || source[position++] !== '=') throw invalidXml();
      whitespace();
      const quote = source[position++];
      if (quote !== '"' && quote !== "'") throw invalidXml();
      const end = source.indexOf(quote, position);
      if (end < 0 || source.slice(position, end).includes('<')) throw invalidXml();
      attributes.set(key, entities(source.slice(position, end)));
      position = end + 1;
    }
    if (position > source.length || source[position - 1] !== '>') throw invalidXml();
    const namespaces = new Map(stack.at(-1)?.namespaces || [['xml', 'http://www.w3.org/XML/1998/namespace']]);
    for (const [key, value] of attributes) {
      if (key !== 'xmlns' && !key.startsWith('xmlns:')) continue;
      const prefix = key === 'xmlns' ? '' : key.slice(6);
      if (prefix === 'xmlns' || value === 'http://www.w3.org/2000/xmlns/' || (prefix === 'xml' && value !== 'http://www.w3.org/XML/1998/namespace') || (prefix !== 'xml' && value === 'http://www.w3.org/XML/1998/namespace') || (prefix && !value)) throw invalidXml();
      namespaces.set(prefix, value);
    }
    function expanded(qname, isAttribute = false) {
      const parts = qname.split(':');
      const prefix = parts.length === 2 ? parts[0] : '';
      if (prefix && !namespaces.has(prefix)) throw invalidXml();
      return [isAttribute && !prefix ? '' : namespaces.get(prefix) || '', parts.at(-1)];
    }
    const seenAttributes = new Set();
    for (const key of attributes.keys()) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
      const identity = JSON.stringify(expanded(key, true));
      if (seenAttributes.has(identity)) throw invalidXml();
      seenAttributes.add(identity);
    }
    const [namespace, local] = expanded(nodeName);
    const node = { name: nodeName, namespace, local, namespaces, text: '', children: [] };
    if (++count > 20_000 || stack.length >= 32) throw invalidXml();
    if (stack.length) stack.at(-1).children.push(node);
    else { if (root) throw invalidXml(); root = node; }
    if (!closed) stack.push(node);
  }
  if (!root || stack.length) throw invalidXml();
  return root;
}

function canonicalPath(raw, error) {
  if (!raw.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(raw)) throw error();
  const pieces = raw.split('/').map(piece => {
    let decoded;
    try { decoded = decodeURIComponent(piece); } catch { throw error(); }
    let check = decoded;
    for (let depth = 0; depth < 8; depth++) {
      if (check === '.' || check === '..' || /[/\\\u0000-\u001f\u007f]/.test(check)) throw error();
      if (!/%[0-9a-fA-F]{2}/.test(check)) break;
      try { check = decodeURIComponent(check); } catch { throw error(); }
      if (depth === 7) throw error();
    }
    return encodeURIComponent(decoded).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  });
  if (pieces.slice(1, -1).includes('')) throw error();
  return pieces.join('/');
}

function validateUrl(value, origin, error) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f\\]/.test(value) || value.includes('?') || value.includes('#')) throw error();
  // Inspect the unnormalised pathname before URL can erase literal or encoded dot segments.
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*(.*)$/.exec(value);
  const rawPath = absolute ? absolute[1] || '/' : value;
  if (!absolute && !value.startsWith('/') && origin) return validateUrl(`${origin}${value}`, origin, error);
  const pathname = canonicalPath(rawPath, error);
  let url;
  try { url = origin ? new URL(value, origin) : new URL(value); } catch { throw error(); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || (origin && url.origin !== new URL(origin).origin)) throw error();
  if (pathname !== '/dav' && !pathname.startsWith('/dav/')) throw error();
  url.pathname = pathname;
  return url;
}

function children(node, local) { return node.children.filter(child => child.namespace === DAV && child.local === local); }
function one(node, local, required = false) {
  const matches = children(node, local);
  if (matches.length > 1 || (required && !matches.length)) throw invalidXml();
  return matches[0] || null;
}
function scalar(node) { if (node.children.length) throw invalidXml(); return node.text.trim(); }
function status(node) {
  const match = /^HTTP\/[0-9]+(?:\.[0-9]+)?[ \t]+([0-9]{3})(?:[ \t]+[^\r\n]*)?$/.exec(scalar(node));
  if (!match) throw invalidXml();
  return Number(match[1]);
}

function directoryEntries(body, directory) {
  const root = parseXml(body);
  if (root.namespace !== DAV || root.local !== 'multistatus') throw invalidXml();
  const baseUrl = `${directory.origin}/dav/`;
  const entries = [], seen = new Set();
  const responses = children(root, 'response');
  if (responses.length > MAX_ENTRIES + 2) throw fail('WEBDAV_TOO_MANY_ENTRIES', '目录超过 1000 项，请打开更小的子目录。');
  const directoryPath = directory.pathname.replace(/\/$/, '');
  const parentPath = directoryPath.slice(0, directoryPath.lastIndexOf('/')) || '/dav';
  for (const response of responses) {
    const href = scalar(one(response, 'href', true));
    if (!href || href.startsWith('//')) throw unsafeHref();
    let resolved;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith('/')) resolved = validateUrl(href, directory.origin, unsafeHref);
    else resolved = validateUrl(`${directory.href}${href}`, directory.origin, unsafeHref);
    const path = resolved.pathname.replace(/\/$/, '');
    if (path === directoryPath || path === parentPath) continue;
    // Depth:1 responses may include only immediate children, never recursive descendants.
    if (!path.startsWith(`${directoryPath}/`) || path.slice(directoryPath.length + 1).includes('/')) throw unsafeHref();
    const overall = one(response, 'status');
    if (overall && (status(overall) < 200 || status(overall) >= 300)) continue;
    const properties = new Map();
    let successful = false;
    for (const propstat of children(response, 'propstat')) {
      const code = status(one(propstat, 'status', true));
      const prop = one(propstat, 'prop', true);
      if (code < 200 || code >= 300) continue;
      successful = true;
      for (const child of prop.children) {
        if (child.namespace !== DAV) continue;
        if (properties.has(child.local)) throw invalidXml();
        properties.set(child.local, child);
      }
    }
    if (!successful) continue;
    const resource = properties.get('resourcetype');
    const isDirectory = Boolean(resource && children(resource, 'collection').length);
    if (resolved.pathname.endsWith('/') && !isDirectory) throw invalidXml();
    let size = null;
    if (properties.has('getcontentlength')) {
      const length = scalar(properties.get('getcontentlength'));
      if (length && (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw invalidXml();
      size = length ? Number(length) : null;
    }
    resolved.pathname = path + (isDirectory ? '/' : '');
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);
    entries.push({ name: decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)), url: resolved.href, isDirectory, size: isDirectory ? null : size, lastModified: properties.has('getlastmodified') ? scalar(properties.get('getlastmodified')) || null : null });
    if (entries.length > MAX_ENTRIES) throw fail('WEBDAV_TOO_MANY_ENTRIES', '目录超过 1000 项，请打开更小的子目录。');
  }
  return { baseUrl, directoryUrl: directory.href, entries, parentUrl: directoryPath === '/dav' ? null : `${directory.origin}${parentPath}/` };
}

function requestDirectory(url, authorization, signal, origin, hops = 0) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method: 'PROPFIND', signal, headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(REQUEST_BODY), 'Accept-Encoding': 'identity', 'User-Agent': 'ClipFetcher/0.1', ...(authorization ? { Authorization: authorization } : {}) } }, response => {
      const rejectResponse = error => { response.destroy(); reject(error); };
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (hops >= 3) return reject(fail('WEBDAV_REDIRECT', 'WebDAV 重定向次数过多，已停止。'));
        let next;
        try {
          const location = response.headers.location;
          if (!location) throw unsafeHref();
          next = validateUrl(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location) || location.startsWith('/') ? location : `${url.href}${location}`, origin, unsafeHref);
          if (!next.pathname.endsWith('/')) next.pathname += '/';
        } catch { return reject(fail('WEBDAV_REDIRECT', '拒绝跨服务、越界或不安全的 WebDAV 重定向。')); }
        resolve(requestDirectory(next, authorization, signal, origin, hops + 1)); return;
      }
      if (response.statusCode === 401) return rejectResponse(fail('AUTH_REQUIRED', 'CloudDrive2 拒绝了 WebDAV 认证（HTTP 401）。请先检查 WebDAV 页是否允许 CloudDrive 账号访问；启用时再核对账号与密码。'));
      if (response.statusCode === 403) return rejectResponse(fail('ACCESS_DENIED', 'CloudDrive2 拒绝了目录访问（HTTP 403）。请检查 WebDAV 根目录与访问权限。'));
      if (response.statusCode !== 207) return rejectResponse(fail('WEBDAV_HTTP', '读取网盘目录失败，请检查 WebDAV 服务与目录设置。'));
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return rejectResponse(fail('WEBDAV_HTTP', 'WebDAV 返回了不受支持的压缩目录响应。'));
      if (Number(response.headers['content-length']) > MAX_BYTES) return rejectResponse(fail('WEBDAV_BUDGET_EXCEEDED', '目录响应超过 1 MiB，已停止读取，请打开更小的目录。'));
      const chunks = []; let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_BYTES) rejectResponse(fail('WEBDAV_BUDGET_EXCEEDED', '目录响应超过 1 MiB，已停止读取，请打开更小的目录。'));
        else chunks.push(chunk);
      });
      response.once('error', () => reject(fail('WEBDAV_HTTP', '网盘目录响应未完整返回，请稍后重试。')));
      response.once('end', () => resolve({ body: Buffer.concat(chunks, length), directory: url }));
    });
    request.once('error', () => reject(fail('WEBDAV_HTTP', '无法连接本机 WebDAV，请检查 CloudDrive2 是否正在运行。')));
    request.end(REQUEST_BODY);
  });
}

export async function listWebDav({ url: value, username = '', password = '', signal } = {}) {
  const url = validateUrl(value, null, invalidUrl);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  if (typeof username !== 'string' || typeof password !== 'string' || username.includes(':') || /[\u0000-\u001f\u007f]/.test(username + password) || username.length + password.length > 8192) throw fail('WEBDAV_CREDENTIALS_INVALID', 'WebDAV 用户名或密码格式不正确。');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('WEBDAV_ARGUMENT_INVALID', '目录读取的取消信号格式不正确。');
  if (signal?.aborted) throw fail('CANCELLED', '目录读取已取消。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const authorization = username || password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : null;
    const result = await requestDirectory(url, authorization, combined, url.origin);
    return directoryEntries(result.body, result.directory);
  } catch (error) {
    if (signal?.aborted) throw fail('CANCELLED', '目录读取已取消。');
    if (controller.signal.aborted) throw fail('TIMEOUT', '目录读取超过 15 秒，已停止。');
    if (error instanceof WebDavError) throw error;
    throw fail('WEBDAV_HTTP', '读取网盘目录失败，请检查 CloudDrive2 设置。');
  } finally { clearTimeout(timer); }
}
