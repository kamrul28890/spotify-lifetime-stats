import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const nodeBin = process.execPath;
const port = 6173;
const tempDir = mkdtempSync(join(tmpdir(), 'spotify-stats-test-'));
const dbPath = join(tempDir, 'test.sqlite');
let server;

before(async () => {
  server = spawn(nodeBin, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SPOTIFY_STATS_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer();
});

after(() => {
  server?.kill();
  rmSync(tempDir, { recursive: true, force: true });
});

test('imports Spotify history fixture and computes split stats', async () => {
  const fixture = readFileSync(join(root, 'fixtures/sample-history.json'));
  const form = new FormData();
  form.append('files', new Blob([fixture], { type: 'application/json' }), 'sample-history.json');

  const imported = await jsonFetch('/api/import', { method: 'POST', body: form });
  assert.equal(imported.records_seen, 4);
  assert.equal(imported.records_inserted, 4);
  assert.equal(imported.music_plays, 3);
  assert.equal(imported.podcast_plays, 1);
  assert.equal(imported.skipped_plays, 1);

  const stats = await jsonFetch('/api/stats');
  assert.equal(stats.overview.total_plays, 4);
  assert.equal(stats.overview.music_plays, 3);
  assert.equal(stats.overview.podcast_plays, 1);
  assert.equal(stats.topTracks[0].track_name, 'Midnight City');
  assert.equal(stats.topShows[0].show_name, 'The Example Show');
});

test('skips duplicate records on repeated import', async () => {
  const fixture = readFileSync(join(root, 'fixtures/sample-history.json'));
  const form = new FormData();
  form.append('files', new Blob([fixture], { type: 'application/json' }), 'sample-history.json');

  const imported = await jsonFetch('/api/import', { method: 'POST', body: form });
  assert.equal(imported.records_inserted, 0);
  assert.equal(imported.duplicate_records, 4);
});

test('exports CSV from dashboard data', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/export/tracks`);
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.match(csv, /track_name,artist_name,album_name/);
  assert.match(csv, /Midnight City/);
});

test('imports the same history from a ZIP archive', async () => {
  const fixture = readFileSync(join(root, 'fixtures/sample-history.zip'));
  const form = new FormData();
  form.append('files', new Blob([fixture], { type: 'application/zip' }), 'sample-history.zip');

  const imported = await jsonFetch('/api/import', { method: 'POST', body: form });
  assert.equal(imported.files[0].source_file, 'sample-history.json');
  assert.equal(imported.records_seen, 4);
  assert.equal(imported.duplicate_records, 4);
});

async function jsonFetch(path, options) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  return body;
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error('Server did not start in time.');
}
