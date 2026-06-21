# Windows Desktop App — Design

## Goal

Wrap the existing Spotify Lifetime Stats dashboard so it runs as a real Windows
desktop app: its own window, its own icon, a Start Menu entry, no terminal and
no visible browser chrome. Closing the window quits the app — no tray icon, no
autostart, no background mode.

## Why Electron, and why not rewrite the backend

The app already has a working local HTTP server (`server/index.mjs`) and a
plain HTML/CSS/JS dashboard (`public/`) with zero npm dependencies. Electron
wraps that unchanged: a single `BrowserWindow` loads the dashboard from the
same local HTTP server, running inside the Electron process instead of a
manually-started terminal session.

An IPC-based rewrite (renderer calls main-process functions directly, no HTTP
server at all) was considered and rejected: Spotify's OAuth Authorization Code
with PKCE flow requires a real `http://127.0.0.1:<port>/callback` redirect
URI. Removing the HTTP server would break Spotify enrichment, which the
project already depends on. Keeping the HTTP server is required, not just
convenient.

Tauri was considered as a lighter-weight alternative (smaller final binary,
uses Windows' built-in WebView2) but requires installing the Rust toolchain
to build. Electron was chosen for faster, lower-friction setup; the project
explicitly accepted Electron's larger footprint (~150-200MB packaged app,
first real npm dependencies) in exchange for that simplicity.

## Architecture

```
electron/main.js (Electron main process)
  -> imports server/index.mjs's exported startServer()
  -> starts the HTTP server on an OS-assigned ephemeral port,
     with dbPath under Electron's userData directory
  -> opens a BrowserWindow pointed at http://127.0.0.1:<port>/
  -> removes default app menu bar
  -> quits the app when the window closes
```

No changes to `public/` or the API surface. The dashboard, import flow, CSV
export, and Spotify enrichment OAuth flow all work exactly as they do today,
because they're talking to the same server over the same HTTP API.

## Changes to existing code

### 1. `server/index.mjs`: extract a `startServer()` export

Today the module starts itself as a side effect at load time, reading
`PORT`/`HOST`/`SPOTIFY_STATS_DB` from `process.env` directly. Refactor the
startup logic into an exported async function:

```js
export async function startServer({ host, port, dbPath } = {}) { ... }
// returns { server, port, dbPath }
```

Keep a bottom-of-file CLI guard so running `node server/index.mjs` directly
(as `npm start`, `npm test`, and the existing test suite already do) still
self-starts using the current environment-variable defaults, unchanged. This
is the only change to this file's existing behavior for non-Electron use.

### 2. Dynamic port instead of fixed 5173

The Electron entry point calls `startServer({ port: 0, ... })` so the OS
assigns a free ephemeral port, and uses the returned `port` to build the
BrowserWindow URL and the OAuth redirect URI. This avoids the exact
`EADDRINUSE` collision already observed on this machine (an unrelated
`uvicorn` process squatting on 5173). The existing fixed-port behavior is
preserved for `npm start`/tests, which don't pass `port: 0`.

### 3. Packaged app data directory

`work/data/spotify-stats.sqlite` (relative to the install directory) won't be
writable once installed under `Program Files`. The Electron entry point
passes `dbPath: path.join(app.getPath('userData'), 'spotify-stats.sqlite')`
(resolves to `%APPDATA%\spotify-lifetime-stats\spotify-stats.sqlite`),
keeping packaged-app data fully separate from the dev `work/data/` path.

### 4. Replace the `unzip` shell-out for ZIP imports

`extractUploadFiles()` in `server/index.mjs` currently calls the `unzip`
binary via `spawnSync`. That works in this dev environment because Git Bash
provides `unzip` on PATH, but a regular Windows user installing the packaged
app has no guarantee `unzip.exe` exists anywhere on their system — ZIP
imports would silently fail for every end user. Replace this with a pure-JS
ZIP reader (`yauzl`), removing the external-binary dependency entirely. This
is the project's first real npm dependency, added now specifically because
packaging requires it (no longer optional once distributed beyond this
machine).

### 5. New `electron/main.js`

- Calls `startServer()` with ephemeral port + userData dbPath.
- Creates one `BrowserWindow`, loads the resolved local URL.
- Calls `Menu.setApplicationMenu(null)` to remove the default File/Edit/View
  menu bar (not useful for a single-page dashboard).
- `app.on('window-all-closed', () => app.quit())` — closing the window quits
  the app entirely (no tray/background persistence).

### 6. Packaging

- Add `electron` and `electron-builder` as devDependencies.
- `electron-builder` config targets `win` / `nsis` only (no Mac/Linux build).
- New scripts: `npm run app:dev` (launches Electron against the local
  checkout) and `npm run app:build` (produces the NSIS installer).
- Build output goes to a gitignored `release/` directory.
- App icon: placeholder `.ico` for now (can be swapped later without any
  other change).

## What stays the same

- `public/`, all dashboard features (import, stats, CSV export, Spotify
  enrichment) — unchanged.
- `npm start` / `npm test` / `scripts/start.sh` / `scripts/test.sh` — unchanged
  dev workflow, still using the fixed-port, env-var-driven path.
- Existing integration tests in `test/app.test.mjs` — unchanged, still spawn
  `server/index.mjs` directly via its CLI entry point.

## Out of scope

- Code signing. The installer will be unsigned; Windows SmartScreen will show
  an "unknown publisher" warning on first run. Acceptable for a personal app;
  revisit only if this is ever distributed more broadly.
- Auto-update.
- System tray icon, autostart on login, or any background/always-running
  mode — explicitly declined in favor of a normal "open it, use it, close
  it" desktop app.
- Mac/Linux packaging.
