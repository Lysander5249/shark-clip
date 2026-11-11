import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server.mjs';

// This fake executable exercises the real child-process/error path without a
// real movie, cloud account, credentials, FFmpeg installation, or network source.
const TEST_OPTIONS = { timeout: 15000, skip: process.platform === 'win32' ? 'Executable fixture uses a POSIX shebang.' : false };
const privateUrl = 'https://fixture-user:fixture-password@private.example.test/movie.mkv?token=fixture-private-token';
const stderr = `Fixture parser: deliberate failure 2\nOpening ${privateUrl}: I/O timeout\n${'bounded-diagnostic '.repeat(500)}`;

async function fixture(t, { arbitraryRevealError = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-probe-diagnostic-'));
  let app;
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const executable = path.join(directory, 'ffprobe');
  await writeFile(executable, `#!${process.execPath}\nif (process.argv.includes('-version')) {\n  process.stdout.write('ffprobe version local-diagnostic-fixture\\n');\n  process.exit(0);\n}\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(2);\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const source = path.join(directory, 'local-fixture.mkv');
  // checkedInput validates this nonempty local file; the fake probe deliberately
  // rejects it, so no parser behavior is assumed or mocked inside the server.
  await writeFile(source, Buffer.from('local synthetic fixture, intentionally not a movie'));
  const dataDir = path.join(directory, 'state');
  if (arbitraryRevealError) {
    await mkdir(dataDir);
    await writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify({ schemaVersion: 1, jobs: [{
      id: 'local-fixture-history', type: 'extract', sourceLabel: 'Local fixture', status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
      result: { candidatePath: source }, metrics: { receivedBytes: 0, requests: 0 },
    }] }), { mode: 0o600 });
  }
  app = await startServer({ outputDir: path.join(directory, 'output'), dataDir,
    ffmpegPath: executable, ffprobePath: executable,
    ...(arbitraryRevealError ? { reveal: async () => {
      throw Object.assign(new Error('Fixture system action failed.'), {
        code: 'FIXTURE_SYSTEM_FAILURE',
        // Merely claiming a media tool must not make arbitrary system details
        // eligible for the engine's trusted, already-redacted diagnostic field.
        details: { tool: 'ffprobe', exitCode: 3, diagnostic: privateUrl, arbitrary: 'fixture-arbitrary-private-detail' },
      });
    } } : {}),
  });
  const bootstrap = await fetch(`${app.url}/api/bootstrap`).then(response => response.json());
  assert.equal(bootstrap.dependencies.ffprobe.available, true);
  return { source, async post(route, body) {
    const response = await fetch(app.url + route, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken,
    }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  } };
}

test('source probe API preserves bounded media-tool diagnostics while redacting private source addresses', TEST_OPTIONS, async t => {
  const { source, post } = await fixture(t);
  const { status, data } = await post('/api/probe', { source: { type: 'local', value: source } });
  assert.equal(status, 400);
  assert.equal(data.error.code, 'MEDIA_PROCESS_FAILED');
  const diagnostic = data.error.mediaDiagnostic;
  assert(diagnostic, 'the failed source probe must expose its safe tool diagnostic instead of only a generic message');
  assert.deepEqual(Object.keys(diagnostic).sort(), ['diagnostic', 'exitCode', 'tool']);
  assert.equal(diagnostic.tool, 'ffprobe');
  assert.equal(diagnostic.exitCode, 2);
  assert(diagnostic.diagnostic.startsWith('Fixture parser: deliberate failure 2\n'));
  assert(diagnostic.diagnostic.includes('I/O timeout'));
  assert(diagnostic.diagnostic.includes('[链接已隐藏]'));
  assert(diagnostic.diagnostic.length <= 6000);
  const serialized = JSON.stringify(data);
  for (const secret of ['private.example.test', 'fixture-user', 'fixture-password', 'fixture-private-token', privateUrl]) {
    assert(!serialized.includes(secret), `source diagnostic leaked ${secret}`);
  }
  assert.equal(data.error.details, undefined, 'the raw MediaError details object must not be serialized');
});

test('API errors outside the media engine cannot expose arbitrary details by naming a trusted media tool', TEST_OPTIONS, async t => {
  const { source, post } = await fixture(t, { arbitraryRevealError: true });
  const { status, data } = await post('/api/reveal', { path: source });
  assert.equal(status, 400);
  assert.equal(data.error.code, 'FIXTURE_SYSTEM_FAILURE');
  assert.equal(data.error.mediaDiagnostic, undefined);
  assert.equal(data.error.details, undefined);
  const serialized = JSON.stringify(data);
  for (const secret of ['private.example.test', 'fixture-user', 'fixture-password', 'fixture-private-token', 'fixture-arbitrary-private-detail']) {
    assert(!serialized.includes(secret), `untrusted system error leaked ${secret}`);
  }
});
