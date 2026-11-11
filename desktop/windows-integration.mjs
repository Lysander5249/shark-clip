import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { win32 as path } from 'node:path';
import { promisify } from 'node:util';
import { validatePickedPath } from '../src/picker.mjs';

const run = promisify(execFile);
export const EDGE_DOWNLOAD_URL = 'https://www.microsoft.com/edge/download';
const fail = (code, message) => Object.assign(new Error(message), { code });

function pickerScript(directory) {
  const dialog = directory ? 'FolderBrowserDialog' : 'OpenFileDialog';
  const result = directory ? 'SelectedPath' : 'FileName';
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.' + dialog,
    'try {',
    '  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '    $bytes = [Text.Encoding]::UTF8.GetBytes($dialog.' + result + ')',
    '    [Console]::Write([Convert]::ToBase64String($bytes))',
    '  }',
    '} finally { $dialog.Dispose() }',
  ].join('\n');
}

// The path is transported as data. Shell PIDLs handle Unicode and avoid the
// Explorer command-line grammar for filenames containing spaces or commas.
const revealScript = [
  '$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CLIP_FETCHER_REVEAL_PATH))',
  'if ([IO.Directory]::Exists($target)) {',
  '  $explorer = New-Object -ComObject Shell.Application',
  '  $explorer.Open($target)',
  '} else {',
  "  Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class ClipFetcherExplorer {',
  '  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr unused, uint mode);',
  '  [DllImport("ole32.dll")] static extern void CoUninitialize();',
  '  [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]',
  '  static extern int SHParseDisplayName(string path, IntPtr context, out IntPtr item, uint attributes, out uint result);',
  '  [DllImport("shell32.dll", ExactSpelling = true)]',
  '  static extern int SHOpenFolderAndSelectItems(IntPtr item, uint count, IntPtr children, uint flags);',
  '  public static void Select(string path) {',
  '    Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero, 2));',
  '    IntPtr item = IntPtr.Zero;',
  '    try {',
  '      uint attributes;',
  '      Marshal.ThrowExceptionForHR(SHParseDisplayName(path, IntPtr.Zero, out item, 0, out attributes));',
  '      Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(item, 0, IntPtr.Zero, 0));',
  '    } finally {',
  '      Marshal.FreeCoTaskMem(item);',
  '      CoUninitialize();',
  '    }',
  '  }',
  '}',
  "'@",
  '  [ClipFetcherExplorer]::Select($target)',
  '}',
].join('\n');

function panelUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !url.username && !url.password
      && !url.search && !url.hash && ['/', '/bookmark/install'].includes(url.pathname);
  } catch { return false; }
}

export function createWindowsIntegration({ env = process.env, execute = run, launch = spawn, check = access } = {}) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const edgeRoots = [env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'], env.ProgramW6432 || env.PROGRAMW6432,
    env.ProgramFiles || env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean);

  function runScript(script, { signal, timeout, extraEnv } = {}) {
    const encoded = Buffer.from("$ErrorActionPreference = 'Stop'\n" + script, 'utf16le').toString('base64');
    return execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, timeout, signal, maxBuffer: 65536, env: { ...env, ...extraEnv } });
  }
  async function pick(directory, { signal } = {}) {
    const { stdout } = await runScript(pickerScript(directory), { signal, timeout: 120000 });
    if (stdout === '') return null;
    if (typeof stdout !== 'string') return validatePickedPath('', 'win32');
    const bytes = Buffer.from(stdout, 'base64');
    if (bytes.toString('base64') !== stdout) return validatePickedPath('', 'win32');
    const selected = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return validatePickedPath(selected, 'win32');
  }
  return {
    async openBrowser(browser, url) {
      if (browser !== 'edge' || !panelUrl(url)) throw fail('BROWSER_OPEN_FAILED', '只能在 Edge 打开本机片段取材面板。');
      let edge;
      for (const root of new Set(edgeRoots)) {
        if (!path.isAbsolute(root)) continue;
        const candidate = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
        try { await check(candidate); edge = candidate; break; } catch { /* Try the next standard location. */ }
      }
      if (!edge) throw fail('BROWSER_MISSING', '未找到 Microsoft Edge，请安装后重试。');
      try {
        await new Promise((resolve, reject) => {
          const child = launch(edge, [url], { detached: true, stdio: 'ignore', windowsHide: true });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
      } catch {
        throw fail('BROWSER_OPEN_FAILED', '未能启动 Microsoft Edge，请手动打开本机面板。');
      }
    },
    pickFile: options => pick(false, options),
    pickDirectory: options => pick(true, options),
    async reveal(filename) {
      const selected = validatePickedPath(filename, 'win32');
      try {
        await runScript(revealScript, { timeout: 15000,
          extraEnv: { CLIP_FETCHER_REVEAL_PATH: Buffer.from(selected, 'utf8').toString('base64') } });
      } catch {
        throw fail('REVEAL_FAILED', '无法在资源管理器中打开这份素材。');
      }
    },
  };
}
