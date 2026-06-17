# Spotify Lifetime Stats

Spotify Lifetime Stats is a private local dashboard for analyzing your Spotify Extended Streaming History export. It imports Spotify JSON or ZIP exports, stores normalized listening records in SQLite, and shows lifetime stats for music and podcasts.

Raw listening history stays on your machine. Spotify API login is optional and is only used to enrich imported history with metadata such as genres, artwork, durations, and external Spotify links.

## Features

- Import Spotify Extended Streaming History ZIP files or loose JSON files.
- Deduplicate repeated imports by file hash and record identity.
- Track total hours, plays, skip rate, music plays, podcast plays, first play, and last play.
- Rank top songs, artists, albums, podcast shows, and podcast episodes.
- Chart listening over time, hour-of-day habits, biggest listening days, and streaks.
- Infer genres from Spotify artist metadata after enrichment.
- Export tracks, artists, albums, podcasts, and raw plays as CSV.
- Keep tokens and listening history in a local SQLite database.

## Requirements

- Node.js 24 or newer.
- macOS, Linux, or Windows with a modern browser.
- `unzip` available on the system path for importing ZIP exports.

This project intentionally has no external npm dependencies. It uses Node's built-in HTTP server and SQLite support.

## Quick Start

```bash
npm start
```

If `npm` is not available, run the start script directly:

```bash
./scripts/start.sh
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173).

## Import Your Spotify Data

1. Open your Spotify account privacy/data page.
2. Request **Extended Streaming History**.
3. Wait for Spotify to email the download link.
4. Download the ZIP file.
5. Open the local app and import the ZIP.

The app also accepts individual JSON files from the export.

## Spotify API Enrichment

Enrichment is optional, but it unlocks genre stats, cover art, durations, and better entity matching.

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add this redirect URI:

   ```text
   http://127.0.0.1:5173/callback
   ```

3. Copy the app's Client ID.
4. Paste the Client ID into the dashboard.
5. Click **Save**, **Connect**, then **Enrich**.

The app uses Authorization Code with PKCE and these scopes:

- `user-top-read`
- `user-read-recently-played`
- `user-library-read`
- `playlist-read-private`
- `playlist-read-collaborative`

The app does not use Spotify's deprecated Audio Features or Audio Analysis endpoints.

## Configuration

Optional environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local server host |
| `PORT` | `5173` | Local server port |
| `SPOTIFY_STATS_DB` | `work/data/spotify-stats.sqlite` | SQLite database path |

## Project Structure

```text
public/       Browser dashboard
server/       Local HTTP API, SQLite schema, import logic, Spotify enrichment
scripts/      Start and test scripts
fixtures/     Sample Spotify history fixture
test/         Node test runner integration tests
work/         Local runtime data, ignored by git
```

## Tests

Run the integration tests:

```bash
npm test
```

Or run the script directly:

```bash
./scripts/test.sh
```

The tests start the local server against a temporary SQLite database, import the sample fixture, verify music and podcast stats, confirm duplicate handling, and check CSV export.

## Privacy Notes

- Imported listening history is stored locally in SQLite.
- Spotify tokens are stored locally in the same SQLite database.
- Runtime data is written under `work/`, which is ignored by git.
- Do not commit your real Spotify export or database.
