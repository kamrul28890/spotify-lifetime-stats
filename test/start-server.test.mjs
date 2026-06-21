import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';

test('startServer binds an ephemeral port and uses the given dbPath', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'spotify-stats-start-'));
  const dbPath = join(tempDir, 'test.sqlite');

  const { server, port } = await startServer({ host: '127.0.0.1', port: 0, dbPath });
  try {
    assert.ok(port > 0, 'expected an OS-assigned port, got ' + port);

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json();
    assert.equal(response.ok, true);
    assert.equal(body.dbPath, dbPath);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(tempDir, { recursive: true, force: true });
  }
});
