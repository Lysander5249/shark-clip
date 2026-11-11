import path from 'node:path';
import { mkdir, readdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { ROOT, run } from './build-common.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';

// Only distributable extension assets enter the archive. Unit fixtures and local
// pairing/session data cannot be picked up from the working directory.
const source = path.join(ROOT, 'browser-helper');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.host_permissions.includes('<all_urls>')) throw new Error('Invalid helper manifest');
const staging = path.join(ROOT, 'work', 'browser-helper-package');
await mkdir(staging, { recursive: true });
const folder = path.join(staging, 'clip-fetcher-browser-helper');
await rm(folder, { recursive: true, force: true }); await mkdir(folder);
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isFile() && /\.(?:json|m?js|html|css|md)$/.test(entry.name)) await cp(path.join(source, entry.name), path.join(folder, entry.name));
}
const archive = path.join(ROOT, 'public', 'browser-helper.zip');
await rm(archive, { force: true });
if (process.platform === 'darwin') await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', folder, archive]);
else if (process.platform === 'win32') {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath ${quote(folder)} -DestinationPath ${quote(archive)}`]);
} else throw new Error('Build the browser helper archive on macOS or Windows.');
await writeFile(archive, markZipNamesUtf8(await readFile(archive)));
console.log(JSON.stringify({ archive, version: manifest.version, realCloudTested: false }));
