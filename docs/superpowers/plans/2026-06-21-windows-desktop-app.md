# Windows Desktop App (Electron Wrapper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing Spotify Lifetime Stats server + dashboard as a native Windows desktop app (own window, own icon, Start Menu entry, no terminal) via Electron + electron-builder.

**Architecture:** Electron's main process starts the existing HTTP server in-process on an OS-assigned ephemeral port with a per-user SQLite path, then opens a `BrowserWindow` pointed at that local URL. No changes to `public/` or the API. `npm start`/`npm test` keep working exactly as today.

**Tech Stack:** Node.js (`node:http`, `node:sqlite`, ESM), Electron, electron-builder (NSIS), `adm-zip`.

## Global Constraints

- Windows-only packaging target — no Mac/Linux build config.
- No code signing (unsigned installer is acceptable; Windows SmartScreen warning is expected).
- No system tray, no autostart, no background/always-running mode — closing the window quits the app.
- `npm start`, `npm test`, `scripts/start.sh`, `scripts/test.sh` must keep working byte-for-byte as today, using their existing fixed-port/env-var behavior.
- Zero behavior change to any existing dashboard feature (import, stats, CSV export, Spotify enrichment OAuth) — Electron is additive.
- This plan adds the project's first runtime npm dependency (`adm-zip`) and first devDependencies (`electron`, `electron-builder`). No other new dependencies.
- Spec reference: `docs/superpowers/specs/2026-06-21-windows-desktop-app-design.md`.

---

### Task 1: Export `startServer()` from `server/index.mjs` with ephemeral port + injectable dbPath

**Files:**
- Modify: `server/index.mjs:1-60` (module header / server bootstrap), and append a CLI guard at the end of the file.
- Create: `test/start-server.test.mjs`

**Interfaces:**
- Produces: `export async function startServer(options = {}): Promise<{ server: http.Server, port: number, dbPath: string }>`.
  `options.host` (default `process.env.HOST || '127.0.0.1'`), `options.port` (default `process.env.PORT || 5173`; pass `0` for an OS-assigned ephemeral port), `options.dbPath` (default `process.env.SPOTIFY_STATS_DB || work/data/spotify-stats.sqlite`).
  Running `node server/index.mjs` directly still self-starts with the same env-var defaults as today (unchanged CLI behavior) — this is how Task 3's Electron main process and the existing `test/app.test.mjs` both already use the file, in two different ways.

- [ ] **Step 1: Write the new test for the programmatic start path**

Create `test/start-server.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/start-server.test.mjs`
Expected: FAIL — `startServer is not a function` (or `is not exported`), because `server/index.mjs` doesn't export it yet.

- [ ] **Step 3: Refactor the module header to expose `startServer()`**

In `server/index.mjs`, replace lines 1-60 (everything from the top of the file through the existing `server.listen(...)` call) with:

```js
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const publicDir = join(rootDir, 'public');
const dataDir = join(rootDir, 'work', 'data');
const uploadDir = join(rootDir, 'work', 'uploads');
const scopes = [
  'user-top-read',
  'user-read-recently-played',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative'
];

let host;
let port;
let dbPath;
let redirectUri;
let db;

let enrichmentState = {
  status: 'not_started',
  message: 'No enrichment run has started.',
  processed: 0,
  total: 0,
  updated_at: new Date().toISOString()
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

    if (url.pathname.startsWith('/api/')) {
      await routeApi(req, res, url);
      return;
    }

    await routeStatic(req, res, url);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || 'Unexpected server error' });
  }
});

export async function startServer(options = {}) {
  host = options.host || process.env.HOST || '127.0.0.1';
  port = options.port !== undefined ? options.port : Number(process.env.PORT || 5173);
  dbPath = options.dbPath || process.env.SPOTIFY_STATS_DB || join(dataDir, 'spotify-stats.sqlite');
  redirectUri = `http://${host}:${port}/callback`;

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uploadDir, { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  initDb();

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });

  port = server.address().port;
  redirectUri = `http://${host}:${port}/callback`;

  console.log(`Spotify Lifetime Stats running at http://${host}:${port}`);
  console.log(`Database: ${dbPath}`);

  return { server, port, dbPath };
}
```

Note `uploadDir`/`spawnSync`/`writeFileSync`/`rmSync` are still used by `extractUploadFiles()` at this point — Task 2 removes that usage. Don't touch `extractUploadFiles()` in this task.

- [ ] **Step 4: Add the CLI self-start guard at the end of the file**

Append to the very end of `server/index.mjs` (after the final `round()` function):

```js

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `node --test test/start-server.test.mjs`
Expected: PASS — 1 passing test.

- [ ] **Step 6: Run the full existing suite to confirm no regression**

Run: `node --test`
Expected: PASS — all tests in `test/app.test.mjs` (which spawn `node server/index.mjs` as a subprocess, exercising the CLI self-start path with `PORT`/`SPOTIFY_STATS_DB` env vars) and `test/start-server.test.mjs` pass, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add server/index.mjs test/start-server.test.mjs
git commit -m "$(cat <<'EOF'
Export startServer() with ephemeral port and injectable dbPath

Lets server/index.mjs be imported and started programmatically (for
the upcoming Electron main process) while keeping `node server/index.mjs`
self-start unchanged for npm start/npm test.
EOF
)"
```

---

### Task 2: Replace the `unzip` shell-out with a pure-JS ZIP reader

**Files:**
- Modify: `server/index.mjs` (imports, `extractUploadFiles()`, remove dead `safeName()`/`uploadDir`)
- Create: `fixtures/sample-history.zip`
- Modify: `test/app.test.mjs` (add one test)

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: no public interface change — `extractUploadFiles(file)` keeps the same signature and return shape (`[{ name, buffer }]`) used by `importUpload()`.

**Why this matters:** `extractUploadFiles()` currently shells out to the `unzip` binary via `spawnSync`. That works in this dev environment because Git Bash provides `unzip` on PATH, but a packaged installer running on a plain Windows machine has no guarantee `unzip.exe` exists anywhere — ZIP imports would fail for every real user. `adm-zip` reads ZIP buffers in pure JS with no external binary.

- [ ] **Step 1: Create a ZIP fixture for the existing JSON fixture**

```bash
cd fixtures
zip -j sample-history.zip sample-history.json
cd ..
```

Verify: `unzip -l fixtures/sample-history.zip` shows exactly one entry named `sample-history.json`.

- [ ] **Step 2: Write a test that imports that ZIP through the running server**

In `test/app.test.mjs`, add a 4th test after the existing `'exports CSV from dashboard data'` test (same file, so it reuses the existing `before`/`after` server lifecycle and runs after the prior two import tests have already inserted these 4 records):

```js
test('imports the same history from a ZIP archive', async () => {
  const fixture = readFileSync(join(root, 'fixtures/sample-history.zip'));
  const form = new FormData();
  form.append('files', new Blob([fixture], { type: 'application/zip' }), 'sample-history.zip');

  const imported = await jsonFetch('/api/import', { method: 'POST', body: form });
  assert.equal(imported.files[0].source_file, 'sample-history.json');
  assert.equal(imported.records_seen, 4);
  assert.equal(imported.duplicate_records, 4);
});
```

This asserts the ZIP is opened and its JSON parsed into the same 4 logical records already imported by the earlier tests in this file (recognized as duplicates by content hash) — proof the ZIP extraction path produces byte-identical records to the plain-JSON path.

- [ ] **Step 3: Run it to confirm it currently passes (characterization baseline)**

Run: `node --test test/app.test.mjs`
Expected: PASS, 4/4 — this passes against the *current* `unzip`-based implementation because `unzip` is present in this dev environment. This step is a safety-net baseline before refactoring, not a red/green TDD step (the bug being fixed is fragility on machines without `unzip`, not incorrect behavior here).

- [ ] **Step 4: Install `adm-zip`**

```bash
npm install adm-zip
```

Expected: `package.json` gains a `"dependencies": { "adm-zip": "^0.5.x" }` entry (npm fills in the resolved version) and `node_modules/` + `package-lock.json` are created.

- [ ] **Step 5: Swap the implementation**

In `server/index.mjs`, change the imports at the top of the file:

```js
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
```

becomes:

```js
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
```

and add, near the top with the other imports:

```js
import AdmZip from 'adm-zip';
```

Remove the now-unused `uploadDir` constant and its directory creation:

```js
const uploadDir = join(rootDir, 'work', 'uploads');
```
(delete this line)

```js
mkdirSync(uploadDir, { recursive: true });
```
(delete this line, inside `startServer()`)

Replace `extractUploadFiles()`:

```js
function extractUploadFiles(file) {
  const extension = extname(file.filename).toLowerCase();
  const looksZip = file.buffer.subarray(0, 2).toString('utf8') === 'PK';
  if (extension !== '.zip' && !looksZip) return [{ name: file.filename, buffer: file.buffer }];

  const tempName = `${Date.now()}-${safeName(file.filename || 'spotify-export.zip')}`;
  const zipPath = join(uploadDir, tempName);
  writeFileSync(zipPath, file.buffer);
  try {
    const listing = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
    if (listing.status !== 0) throw new Error(listing.stderr || 'Unable to inspect ZIP.');
    const names = listing.stdout.split('\n').filter((name) => name.toLowerCase().endsWith('.json'));
    if (!names.length) throw new Error('No JSON files found inside ZIP.');
    return names.map((name) => {
      const output = spawnSync('unzip', ['-p', zipPath, name], { encoding: null, maxBuffer: 200 * 1024 * 1024 });
      if (output.status !== 0) throw new Error(`Unable to read ${name} from ZIP.`);
      return { name, buffer: output.stdout };
    });
  } finally {
    rmSync(zipPath, { force: true });
  }
}
```

with:

```js
function extractUploadFiles(file) {
  const extension = extname(file.filename).toLowerCase();
  const looksZip = file.buffer.subarray(0, 2).toString('utf8') === 'PK';
  if (extension !== '.zip' && !looksZip) return [{ name: file.filename, buffer: file.buffer }];

  const zip = new AdmZip(file.buffer);
  const entries = zip.getEntries().filter(
    (entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith('.json')
  );
  if (!entries.length) throw new Error('No JSON files found inside ZIP.');
  return entries.map((entry) => ({ name: entry.entryName, buffer: entry.getData() }));
}
```

Remove the now-unused `safeName()` function:

```js
function safeName(value) {
  return basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}
```
(delete this function — `basename` is still used elsewhere, in `parseMultipart()`, so keep its import)

- [ ] **Step 6: Run the test again to confirm it still passes**

Run: `node --test`
Expected: PASS, all tests including the new ZIP test, with no `unzip` binary involved.

- [ ] **Step 7: Commit**

```bash
git add server/index.mjs package.json package-lock.json fixtures/sample-history.zip test/app.test.mjs
git commit -m "$(cat <<'EOF'
Replace unzip shell-out with adm-zip for ZIP imports

A packaged Windows installer can't assume unzip.exe is on PATH like
this dev environment's Git Bash does. adm-zip reads ZIP buffers in
pure JS with no external binary, removing that distribution risk.
EOF
)"
```

---

### Task 3: Electron main process (dev mode)

**Files:**
- Create: `electron/main.mjs`
- Modify: `package.json` (`main`, `scripts.app:dev`, `devDependencies`)

**Interfaces:**
- Consumes: `startServer({ host, port, dbPath })` from Task 1 (`server/index.mjs`), returning `{ server, port, dbPath }`.
- Produces: a runnable `npm run app:dev` command that opens a native window showing the dashboard, for Task 4's packaging to build on top of.

- [ ] **Step 1: Install Electron**

```bash
npm install --save-dev electron
```

Expected: `package.json` gains `"devDependencies": { "electron": "^42.x" }` (npm fills in the resolved version).

- [ ] **Step 2: Add the main process entry point**

Create `electron/main.mjs`:

```js
import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';

Menu.setApplicationMenu(null);

async function createWindow() {
  const dbPath = join(app.getPath('userData'), 'spotify-stats.sqlite');
  const { port } = await startServer({ host: '127.0.0.1', port: 0, dbPath });

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Spotify Lifetime Stats',
    autoHideMenuBar: true
  });

  await window.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
```

- [ ] **Step 3: Wire up `package.json`**

Add `"main": "electron/main.mjs"` at the top level of `package.json`, and add to `"scripts"`:

```json
"app:dev": "electron ."
```

- [ ] **Step 4: Run it and verify the embedded server comes up**

```bash
npm run app:dev > /tmp/electron-dev.log 2>&1 &
sleep 3
cat /tmp/electron-dev.log
```

Expected log output: `Spotify Lifetime Stats running at http://127.0.0.1:<some port>` followed by `Database: ...\AppData\Roaming\spotify-lifetime-stats\spotify-stats.sqlite` (or platform equivalent userData path). Note the printed port for the next step.

- [ ] **Step 5: Verify the server inside the window is actually serving the dashboard**

```bash
curl -s http://127.0.0.1:<port from step 4 log>/api/health
```

Expected: `{"ok":true, ...}` JSON response.

- [ ] **Step 6: Visually confirm the window**

Look at the screen — a window titled "Spotify Lifetime Stats" should be open with no menu bar, no address bar, showing the dashboard UI. If you already have data imported under `work/data/spotify-stats.sqlite` from earlier manual testing, note this window uses a *different* db path (`%APPDATA%\spotify-lifetime-stats\`) since it's the packaged-app path — the dashboard will start empty until you import via this window. This is expected per the design (dev/packaged data paths are intentionally separate).

Close the window (or `taskkill //IM electron.exe //F` from the terminal) when done looking.

- [ ] **Step 7: Commit**

```bash
git add electron/main.mjs package.json package-lock.json
git commit -m "$(cat <<'EOF'
Add Electron main process for a native dev-mode window

npm run app:dev now opens the dashboard in its own window backed by
the same embedded HTTP server, instead of a manually-started terminal
process and a browser tab.
EOF
)"
```

---

### Task 4: Package as a Windows installer

**Files:**
- Create: `electron/icon.ico`
- Modify: `package.json` (`build` config, `scripts.app:build`, `devDependencies`, `.gitignore`)

**Interfaces:**
- Consumes: the `"main": "electron/main.mjs"` entry point and working `app:dev` flow from Task 3.
- Produces: `npm run app:build`, producing an NSIS installer under `release/`.

- [ ] **Step 1: Install electron-builder**

```bash
npm install --save-dev electron-builder
```

Expected: `package.json` gains `"electron-builder": "^26.x"` under `devDependencies`.

- [ ] **Step 2: Ignore build output**

Add to `.gitignore` (in the "Build and cache output" section):

```
release/
```

- [ ] **Step 3: Generate a placeholder icon**

```bash
cat > /tmp/make-icon.mjs << 'SCRIPT'
import { writeFileSync } from 'node:fs';

function buildIco({ size = 256, rgba = [29, 185, 84, 255] }) {
  const pixelCount = size * size;
  const xorData = Buffer.alloc(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    xorData[i * 4 + 0] = rgba[2];
    xorData[i * 4 + 1] = rgba[1];
    xorData[i * 4 + 2] = rgba[0];
    xorData[i * 4 + 3] = rgba[3];
  }
  const andRowBytes = Math.ceil(size / 32) * 4;
  const andData = Buffer.alloc(andRowBytes * size, 0);

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);

  const image = Buffer.concat([header, xorData, andData]);

  const iconDir = Buffer.alloc(6);
  iconDir.writeUInt16LE(0, 0);
  iconDir.writeUInt16LE(1, 2);
  iconDir.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(6 + 16, 12);

  return Buffer.concat([iconDir, entry, image]);
}

writeFileSync(process.argv[2], buildIco({ size: 256 }));
console.log('wrote', process.argv[2]);
SCRIPT
node /tmp/make-icon.mjs electron/icon.ico
rm /tmp/make-icon.mjs
```

Verify: `node -e "const b=require('fs').readFileSync('electron/icon.ico'); console.log(b.length, b.readUInt16LE(2), b.readUInt16LE(4))"` prints `270398 1 1` (270398-byte single-image ICO, type 1, 1 image).

This is a flat Spotify-green 256x256 square — a placeholder. Swap `electron/icon.ico` for real artwork any time; nothing else needs to change.

- [ ] **Step 4: Add the electron-builder config**

Add to `package.json` at the top level:

```json
"build": {
  "appId": "com.spotifylifetimestats.app",
  "productName": "Spotify Lifetime Stats",
  "files": [
    "electron/**/*",
    "server/**/*",
    "public/**/*",
    "package.json"
  ],
  "directories": {
    "output": "release"
  },
  "win": {
    "target": "nsis",
    "icon": "electron/icon.ico"
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true
  }
}
```

And add to `"scripts"`:

```json
"app:build": "electron-builder --win nsis"
```

- [ ] **Step 5: Build the unpacked app first (fast feedback, no installer wizard)**

```bash
npx electron-builder --win dir
```

Expected: succeeds, producing `release/win-unpacked/Spotify Lifetime Stats.exe`. This step's main purpose is to catch packaging misconfiguration (missing files, icon errors) quickly, without running an installer.

- [ ] **Step 6: Run the unpacked build and verify it works end-to-end**

```bash
"release/win-unpacked/Spotify Lifetime Stats.exe" > /tmp/electron-build.log 2>&1 &
sleep 3
cat /tmp/electron-build.log
```

Expected: same `Spotify Lifetime Stats running at http://127.0.0.1:<port>` log line as Task 3. Confirm with `curl http://127.0.0.1:<port>/api/health`. Then in the open window, import `fixtures/sample-history.json` via the dashboard's import UI (or `my_spotify_data.zip` from the repo root, if present) and confirm stats populate — this exercises the packaged app's bundled `adm-zip` path for real, not just the dev-mode `node_modules`. Close the window when done.

- [ ] **Step 7: Build the real installer**

```bash
npm run app:build
```

Expected: succeeds, producing an NSIS installer `.exe` under `release/` (e.g. `release/Spotify Lifetime Stats Setup 1.0.0.exe`). Running that installer interactively (Start Menu shortcut, install directory picker, first launch) is for you to do by hand — an unattended NSIS run isn't something to script blindly since it writes to `Program Files`/Start Menu on your real machine.

- [ ] **Step 8: Commit**

```bash
git add electron/icon.ico package.json package-lock.json .gitignore
git commit -m "$(cat <<'EOF'
Package the Electron app as a Windows NSIS installer

npm run app:build now produces a real installer under release/ (gitignored)
with a Start Menu entry and desktop shortcut, using a placeholder icon
swappable at electron/icon.ico.
EOF
)"
```

---

## Self-Review

- **Spec coverage:** `startServer()` export + ephemeral port + injectable dbPath (Task 1) → spec items 1-3. `adm-zip` swap (Task 2) → spec item 4. `electron/main.mjs`, menu removal, quit-on-close (Task 3) → spec item 5. Packaging, icon, scripts (Task 4) → spec item 6. `npm start`/`npm test` left untouched — verified by Task 1 Step 6 regression run and never modified again afterward. No tray/autostart/signing/cross-platform work included, per spec's explicit out-of-scope list.
- **Placeholder scan:** no TBD/TODO; every step shows complete code or an exact command with expected output.
- **Type consistency:** `startServer(options)` signature and `{ server, port, dbPath }` return shape are identical across Task 1's implementation, Task 1's test, and Task 3's `main.mjs` consumer.
