import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const safeError = Symbol('picker error');
const fail = (code, message) => Object.assign(new Error(message), { code, [safeError]: true });
const cancelled = () => fail('CANCELLED', '工具正在关闭，文件选择已停止。');

export function validatePickedPath(value, platform = process.platform) {
  if (value === null) return null;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || !paths.isAbsolute(value)) {
    throw fail('PICKER_INVALID_RESULT', '系统选择器未返回有效的完整本地路径，请重试或手动填写。');
  }
  return value;
}

function executionFailure(error, signal) {
  if (signal?.aborted || error?.code === 'ABORT_ERR') return cancelled();
  if (error?.[safeError]) return error;
  if (error?.code === 'ETIMEDOUT' || (error?.killed && ['SIGTERM', 'SIGKILL'].includes(error?.signal))) {
    return fail('PICKER_TIMEOUT', '等待系统选择窗口超时。请关闭仍打开的窗口后重试，或手动填写完整本地路径。');
  }
  if (['EPERM', 'EACCES'].includes(error?.code)) {
    return fail('PICKER_PERMISSION', '本机服务没有打开系统选择窗口的权限。请使用桌面版，或手动填写完整本地路径。');
  }
  return fail('PICKER_UNAVAILABLE', '无法打开系统选择窗口。请使用桌面版，或在输入框中手动填写完整本地路径。');
}

// The browser panel delegates to the local service. It cannot obtain an OS path
// from a browser directory handle. Native desktop launchers supply their own hook.
export function createSystemPicker({ platform = process.platform, execute = run, timeoutMs = 120000 } = {}) {
  return async function systemPicker(directory, signal) {
    if (signal?.aborted) throw cancelled();
    let executable, args;
    if (platform === 'darwin') {
      executable = '/usr/bin/osascript';
      args = ['-e', directory ? 'POSIX path of (choose folder with prompt "选择素材保存文件夹")' : 'POSIX path of (choose file with prompt "选择用于取片的本地视频")'];
    } else if (platform === 'win32') {
      executable = 'powershell.exe';
      const script = `Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $picker=New-Object System.Windows.Forms.${directory ? 'FolderBrowserDialog' : 'OpenFileDialog'}; if($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($picker.${directory ? 'SelectedPath' : 'FileName'})}`;
      args = ['-NoProfile', '-STA', '-Command', script];
    } else {
      throw fail('PICKER_UNAVAILABLE', '此系统暂不提供选择窗口，请填写完整本地路径。');
    }
    try {
      const result = await execute(executable, args, { timeout: timeoutMs, maxBuffer: 32768, windowsHide: platform === 'win32', signal });
      if (signal?.aborted) throw cancelled();
      if (typeof result?.stdout !== 'string') throw fail('PICKER_INVALID_RESULT', '系统选择器未返回有效的完整本地路径，请重试或手动填写。');
      // osascript appends one newline. Do not trim legitimate spaces from a name.
      const value = platform === 'darwin' ? result.stdout.replace(/\r?\n$/u, '') : result.stdout;
      if (platform === 'win32' && value === '') return null;
      return validatePickedPath(value, platform);
    } catch (error) {
      if (!signal?.aborted && platform === 'darwin' && error?.code === 1 && /\(-128\)\s*$/u.test(String(error.stderr || ''))) return null;
      throw executionFailure(error, signal);
    }
  };
}

function withShutdown(operation, signal) {
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => finish(reject, cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve().then(() => {
      if (signal.aborted) throw cancelled();
      return operation();
    }).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

// A single guard covers file/folder requests and both native and fallback paths.
export function createPathPicker({ pickFile, pickDirectory, signal, platform = process.platform, execute, timeoutMs } = {}) {
  const systemPicker = createSystemPicker({ platform, execute, timeoutMs });
  let pending = false;
  return async function pickPath(directory) {
    if (signal?.aborted) throw cancelled();
    if (pending) throw fail('PICKER_BUSY', '系统选择窗口已经打开，请先完成或取消当前选择。');
    pending = true;
    try {
      const custom = directory ? pickDirectory : pickFile;
      const selected = await withShutdown(() => custom ? custom({ signal }) : systemPicker(directory, signal), signal);
      if (signal?.aborted) throw cancelled();
      return validatePickedPath(selected, platform);
    } catch (error) {
      throw executionFailure(error, signal);
    } finally {
      pending = false;
    }
  };
}
