import { mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeClipName } from '../public/clip-options.mjs';

const MAX_DIRECTORY_ATTEMPTS = 1000;
const failure = (code, message) => Object.assign(new Error(message), { code });
const cancelled = () => failure('CANCELLED', '任务已取消。');

/** Reserve a new directory; existing files, directories and links are never reused. */
export async function reserveNamedDirectory({ outputDir, clipName, signal } = {}) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || outputDir.includes('\0'))
    throw failure('INVALID_OUTPUT', '输出目录必须使用完整绝对路径。');
  if (typeof clipName !== 'string' || !clipName || sanitizeClipName(clipName) !== clipName)
    throw failure('INVALID_CLIP_NAME', '素材名称无效，请使用不含路径的简短文件名。');

  for (let attempt = 1; attempt <= MAX_DIRECTORY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw cancelled();
    const name = attempt === 1 ? clipName : `${clipName} (${attempt})`;
    const directory = path.join(outputDir, name);
    try {
      // Exclusive mkdir is the reservation. Do not pre-check or follow a collision.
      await mkdir(directory);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      if (error.code === 'ENAMETOOLONG')
        throw failure('OUTPUT_PATH_TOO_LONG', '素材名称或保存路径过长，请缩短名称或选择较短的保存路径。');
      throw failure('OUTPUT_NOT_WRITABLE', '无法创建素材文件夹，请检查目录权限和剩余空间；名称或保存路径过长时请缩短后重试。');
    }
    if (signal?.aborted) {
      // This call created the directory. Remove it only while it is still empty.
      await rmdir(directory).catch(() => {});
      throw cancelled();
    }
    return directory;
  }
  throw failure('OUTPUT_NAME_EXHAUSTED', '同名素材文件夹过多，请修改素材名称后重试。');
}
