import path from 'node:path';
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { ROOT, BUILD, DIST, applicationSourceEntries, run, hashFile } from './build-common.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const name = `clip-fetcher-${pkg.version}-source`;
const stage = path.join(BUILD, 'source-package', name);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const entry of [
  ...applicationSourceEntries, 'browser-helper', 'desktop', 'scripts', 'test', '.github', '.gitignore', 'package.json',
  '启动片段取材.command',
]) {
  await cp(path.join(ROOT, entry), path.join(stage, entry), { recursive: true, filter: file => path.basename(file) !== '.DS_Store' });
}
await mkdir(path.join(stage, 'examples'), { recursive: true });
await cp(path.join(ROOT, 'examples/示例视频.mkv'), path.join(stage, 'examples/示例视频.mkv'));
await writeFile(path.join(stage, 'README.md'), `# Shark ${pkg.version}

Shark 在本机按时间范围提取视频片段，支持本地文件和已授权的云盘来源。内置合成示例可以用来验证 MKV 导出和 MP4 工作副本。

安装 Node.js 22+，并将 FFmpeg 和 ffprobe 加入 PATH。运行 \`npm start\`，打开终端显示的本机地址。在 Mac 上运行 \`node --test --test-concurrency=1 test/*.test.mjs\` 执行核心回归。测试素材生成需要带 libx264 的 FFmpeg。桌面回归使用 \`npm run test:desktop\`。

在 Apple Silicon Mac 上运行 \`npm run build:mac\` 生成桌面包。Windows x64 可以按 [桌面构建说明](desktop/README.md) 构建 Edge 便携包。Mac + Chrome 和 Windows + Edge 均支持迅雷和百度抓链，实际云盘出片需在目标设备上验收。

[试用说明](desktop/同学试用须知.md)包括示例、本地素材和云盘使用方法。
`);
await mkdir(DIST, { recursive: true });
const zip = path.join(DIST, `片段取材-${pkg.version}-源码.zip`);
await rm(zip, { force: true });
if (process.platform === 'darwin') await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', stage, zip]);
else if (process.platform === 'win32') await run('tar.exe', ['-a', '-cf', zip, '-C', path.dirname(stage), name]);
else throw new Error('Use a Mac or Windows build machine for ZIP packaging.');
await writeFile(zip, markZipNamesUtf8(await readFile(zip)));
await writeFile(zip + '.sha256', `${await hashFile(zip)}  ${path.basename(zip)}\n`);
console.log(zip);
