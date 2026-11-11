import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { startServer } from '../server.mjs';
import { acquireDesktopInstance } from './single-instance.mjs';
import { createNativeDialogs } from './native-dialogs.mjs';
import { createWindowsIntegration, EDGE_DOWNLOAD_URL } from './windows-integration.mjs';

// This entry point is shared by the native Mac app and the Windows portable app.
// Packaged media tools take precedence over a user's PATH. No cloud password is
// written by this launcher, and no remote application server is involved.
const directory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.dirname(directory);
const desktopConfigPath = path.join(applicationRoot, 'desktop-config.json');
const desktopConfig = existsSync(desktopConfigPath) ? JSON.parse(readFileSync(desktopConfigPath, 'utf8')) : {};
const edition = desktopConfig.edition;
const windowsEdgeEdition = ['windows-edge-xunlei', 'windows-edge-cloud'].includes(edition);
const windowsIntegration = process.platform === 'win32' && windowsEdgeEdition ? createWindowsIntegration() : null;
const dataProfile = desktopConfig.dataProfile || 'ClipFetcher';
if (typeof dataProfile !== 'string' || !/^ClipFetcher(?:-[A-Za-z0-9-]{1,40})?$/.test(dataProfile)) throw new Error('安装包数据目录配置无效。');
const bin = path.join(applicationRoot, 'bin');
const suffix = process.platform === 'win32' ? '.exe' : '';
const bundled = name => path.join(bin, name + suffix);
for (const tool of ['ffmpeg', 'ffprobe']) {
  if (!existsSync(bundled(tool))) throw new Error(`安装包缺少 ${tool}，请重新解压完整安装包。`);
}
process.env.PATH = [bin, process.env.PATH || ''].join(path.delimiter);
const outputDir = process.env.CLIP_FETCHER_OUTPUT_DIR || path.join(os.homedir(), process.platform === 'win32' ? 'Videos' : 'Movies', '片段取材');
const dataDir = process.env.CLIP_FETCHER_DATA_DIR || (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', dataProfile)
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), dataProfile));

const instance = await acquireDesktopInstance({ dataDir });
const openPanel = async url => {
  if (windowsIntegration) {
    try { await windowsIntegration.openBrowser('edge', url); }
    catch (error) {
      console.log(error.code === 'BROWSER_MISSING' ? '未找到 Microsoft Edge。' : '未能自动打开 Microsoft Edge。');
      console.log('请保持本窗口运行，在 Edge 地址栏打开 ' + url);
      console.log('Microsoft Edge 官方下载 ' + EDGE_DOWNLOAD_URL);
    }
  } else if (process.platform === 'win32') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], () => {});
  else if (process.platform === 'darwin') execFile('/usr/bin/open', [url], () => {});
};
if (instance.alreadyRunning) {
  console.log(`CLIP_FETCHER_ALREADY_RUNNING=${instance.url || ''}`);
  if (process.argv.includes('--browser') && instance.url) await openPanel(instance.url);
  await new Promise(resolve => process.stdout.write('片段取材已经在运行，请使用已有应用窗口。\n', resolve));
  process.exit(0);
}
let app;
const dialogs = process.env.CLIP_FETCHER_NATIVE_DIALOGS === '1' && process.platform === 'darwin'
  ? createNativeDialogs({ input: process.stdin, output: process.stdout }) : null;
try {
  app = await startServer({ port: 0, outputDir, dataDir, edition, ffmpegPath: bundled('ffmpeg'), ffprobePath: bundled('ffprobe'),
    ...windowsIntegration,
    ...(dialogs ? { pickFile: () => dialogs.request('file'), pickDirectory: () => dialogs.request('directory'),
      onBookmarkReady: () => { process.stdout.write('CLIP_FETCHER_FOCUS=1\n'); } } : {}) });
  const bootstrap = await fetch(app.url + '/api/bootstrap').then(response => response.json());
  await instance.ready(app.url, bootstrap.sessionToken);
} catch (error) {
  dialogs?.close();
  if (app) await app.close();
  await instance.release();
  throw error;
}
// The native launcher only accepts this narrowly specified loopback URL line.
console.log(`CLIP_FETCHER_URL=${app.url}`);
if (process.argv.includes('--browser')) {
  console.log('片段取材正在运行。关闭此窗口会停止取材任务。');
  await openPanel(app.url);
}
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  dialogs?.close();
  const forcedExit = setTimeout(() => process.exit(0), 5000).unref();
  await app.close();
  await instance.release();
  clearTimeout(forcedExit);
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, close);
// A crash/forced quit of the GUI must not leave a server and credentials behind.
if (process.env.CLIP_FETCHER_PARENT_PID) {
  const parent = Number(process.env.CLIP_FETCHER_PARENT_PID);
  if (Number.isSafeInteger(parent) && parent > 1) setInterval(() => {
    try { process.kill(parent, 0); } catch { void close(); }
  }, 1500).unref();
}
