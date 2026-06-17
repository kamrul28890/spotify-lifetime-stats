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
const dbPath = process.env.SPOTIFY_STATS_DB || join(dataDir, 'spotify-stats.sqlite');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 5173);
const redirectUri = `http://${host}:${port}/callback`;
const scopes = [
  'user-top-read',
  'user-read-recently-played',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative'
];

mkdirSync(dataDir, { recursive: true });
mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
initDb();

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

server.listen(port, host, () => {
  console.log(`Spotify Lifetime Stats running at http://${host}:${port}`);
  console.log(`Database: ${dbPath}`);
});

async function routeApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    json(res, 200, { ok: true, dbPath, redirectUri });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    json(res, 200, getStats());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/import') {
    const result = await importUpload(req);
    json(res, 200, result);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/export/')) {
    const kind = decodeURIComponent(url.pathname.slice('/api/export/'.length));
    exportCsv(res, kind);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/spotify/config') {
    json(res, 200, {
      clientId: getSetting('spotify_client_id') || '',
      redirectUri,
      scopes,
      authenticated: Boolean(getSetting('spotify_access_token') || getSetting('spotify_refresh_token'))
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/spotify/config') {
    const body = await readJson(req);
    setSetting('spotify_client_id', String(body.clientId || '').trim());
    json(res, 200, { ok: true, redirectUri, scopes });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/spotify/login') {
    const clientId = getSetting('spotify_client_id');
    if (!clientId) {
      json(res, 400, { error: 'Add your Spotify Client ID first.' });
      return;
    }
    const verifier = base64Url(randomBytes(64));
    const challenge = base64Url(Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(verifier))));
    const state = base64Url(randomBytes(16));
    setSetting('spotify_pkce_verifier', verifier);
    setSetting('spotify_oauth_state', state);
    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('state', state);
    json(res, 200, { url: authUrl.toString() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/spotify/callback') {
    const body = await readJson(req);
    const result = await exchangeSpotifyCode(body.code, body.state);
    json(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/enrich/start') {
    runEnrichment().catch((error) => {
      enrichmentState = {
        ...enrichmentState,
        status: 'failed',
        message: error.message || 'Enrichment failed.',
        updated_at: new Date().toISOString()
      };
    });
    json(res, 202, enrichmentState);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/enrich/pause') {
    enrichmentState = {
      ...enrichmentState,
      status: 'paused',
      message: 'Enrichment paused. Start again to resume.',
      updated_at: new Date().toISOString()
    };
    json(res, 200, enrichmentState);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/enrich/status') {
    json(res, 200, enrichmentState);
    return;
  }

  json(res, 404, { error: 'Not found' });
}

async function routeStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/callback') pathname = '/index.html';

  const filePath = resolve(publicDir, `.${pathname}`);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    const fallback = join(publicDir, 'index.html');
    sendFile(res, fallback);
    return;
  }
  sendFile(res, filePath);
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      file_hash TEXT NOT NULL UNIQUE,
      imported_at TEXT NOT NULL,
      record_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL,
      record_key TEXT NOT NULL UNIQUE,
      played_at TEXT NOT NULL,
      ms_played INTEGER NOT NULL DEFAULT 0,
      media_type TEXT NOT NULL,
      track_name TEXT,
      artist_name TEXT,
      album_name TEXT,
      episode_name TEXT,
      show_name TEXT,
      spotify_uri TEXT,
      platform TEXT,
      country TEXT,
      reason_start TEXT,
      reason_end TEXT,
      shuffle INTEGER,
      skipped INTEGER,
      offline INTEGER,
      incognito_mode INTEGER,
      FOREIGN KEY(import_id) REFERENCES raw_imports(id)
    );

    CREATE TABLE IF NOT EXISTS tracks (
      spotify_id TEXT PRIMARY KEY,
      name TEXT,
      duration_ms INTEGER,
      album_id TEXT,
      image_url TEXT,
      external_url TEXT
    );

    CREATE TABLE IF NOT EXISTS artists (
      spotify_id TEXT PRIMARY KEY,
      name TEXT,
      genres_json TEXT,
      image_url TEXT,
      external_url TEXT
    );

    CREATE TABLE IF NOT EXISTS albums (
      spotify_id TEXT PRIMARY KEY,
      name TEXT,
      release_date TEXT,
      image_url TEXT,
      external_url TEXT
    );

    CREATE TABLE IF NOT EXISTS shows (
      spotify_id TEXT PRIMARY KEY,
      name TEXT,
      publisher TEXT,
      image_url TEXT,
      external_url TEXT
    );

    CREATE TABLE IF NOT EXISTS episodes (
      spotify_id TEXT PRIMARY KEY,
      name TEXT,
      show_id TEXT,
      duration_ms INTEGER,
      image_url TEXT,
      external_url TEXT
    );

    CREATE TABLE IF NOT EXISTS play_entities (
      play_id INTEGER PRIMARY KEY,
      track_id TEXT,
      artist_id TEXT,
      album_id TEXT,
      show_id TEXT,
      episode_id TEXT,
      match_confidence REAL NOT NULL DEFAULT 0,
      matched_at TEXT NOT NULL,
      FOREIGN KEY(play_id) REFERENCES plays(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

async function importUpload(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    throw new Error('Import expects multipart/form-data.');
  }

  const body = await readBuffer(req, 500 * 1024 * 1024);
  const files = parseMultipart(body, contentType);
  if (!files.length) throw new Error('No files were uploaded.');

  const started = new Date().toISOString();
  const summary = {
    imported_at: started,
    files: [],
    records_seen: 0,
    records_inserted: 0,
    duplicate_records: 0,
    music_plays: 0,
    podcast_plays: 0,
    skipped_plays: 0,
    total_ms: 0,
    date_min: null,
    date_max: null
  };

  for (const file of files) {
    const extracted = extractUploadFiles(file);
    for (const item of extracted) {
      const result = importJsonFile(item.name, item.buffer);
      summary.files.push(result);
      summary.records_seen += result.records_seen;
      summary.records_inserted += result.records_inserted;
      summary.duplicate_records += result.duplicate_records;
      summary.music_plays += result.music_plays;
      summary.podcast_plays += result.podcast_plays;
      summary.skipped_plays += result.skipped_plays;
      summary.total_ms += result.total_ms;
      summary.date_min = minDate(summary.date_min, result.date_min);
      summary.date_max = maxDate(summary.date_max, result.date_max);
    }
  }

  return summary;
}

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

function importJsonFile(sourceFile, buffer) {
  const fileHash = sha(buffer);
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(text);
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
  if (!Array.isArray(records)) throw new Error(`${sourceFile} is not a Spotify history JSON array.`);

  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM raw_imports WHERE file_hash = ?').get(fileHash);
  let importId = existing?.id;
  if (!importId) {
    const info = db.prepare('INSERT INTO raw_imports (source_file, file_hash, imported_at, record_count) VALUES (?, ?, ?, ?)')
      .run(sourceFile, fileHash, now, records.length);
    importId = Number(info.lastInsertRowid);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO plays (
      import_id, record_key, played_at, ms_played, media_type, track_name, artist_name, album_name,
      episode_name, show_name, spotify_uri, platform, country, reason_start, reason_end,
      shuffle, skipped, offline, incognito_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = {
    source_file: sourceFile,
    records_seen: records.length,
    records_inserted: 0,
    duplicate_records: 0,
    music_plays: 0,
    podcast_plays: 0,
    skipped_plays: 0,
    total_ms: 0,
    date_min: null,
    date_max: null
  };

  db.exec('BEGIN');
  try {
    for (const raw of records) {
      const play = normalizePlay(raw);
      if (!play.played_at) continue;
      const info = insert.run(
        importId,
        play.record_key,
        play.played_at,
        play.ms_played,
        play.media_type,
        play.track_name,
        play.artist_name,
        play.album_name,
        play.episode_name,
        play.show_name,
        play.spotify_uri,
        play.platform,
        play.country,
        play.reason_start,
        play.reason_end,
        boolInt(play.shuffle),
        boolInt(play.skipped),
        boolInt(play.offline),
        boolInt(play.incognito_mode)
      );
      if (info.changes) {
        result.records_inserted += 1;
        result.total_ms += play.ms_played;
        result.date_min = minDate(result.date_min, play.played_at);
        result.date_max = maxDate(result.date_max, play.played_at);
        if (play.media_type === 'podcast') result.podcast_plays += 1;
        else result.music_plays += 1;
        if (play.skipped || play.ms_played <= 30000) result.skipped_plays += 1;
      } else {
        result.duplicate_records += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return result;
}

function normalizePlay(raw) {
  const playedAt = normalizeTimestamp(raw.ts || raw.endTime || raw.played_at);
  const trackName = clean(raw.master_metadata_track_name || raw.trackName || raw.track_name);
  const artistName = clean(raw.master_metadata_album_artist_name || raw.artistName || raw.artist_name);
  const albumName = clean(raw.master_metadata_album_album_name || raw.albumName || raw.album_name);
  const episodeName = clean(raw.episode_name || raw.episodeName);
  const showName = clean(raw.episode_show_name || raw.episodeShowName || raw.show_name);
  const spotifyUri = clean(raw.spotify_track_uri || raw.spotify_episode_uri || raw.spotify_uri);
  const mediaType = episodeName || showName || spotifyUri?.startsWith('spotify:episode:') ? 'podcast' : 'music';
  const msPlayed = Number(raw.ms_played ?? raw.msPlayed ?? raw.ms ?? 0) || 0;
  const skipped = raw.skipped ?? raw.skip ?? raw.reason_end === 'fwdbtn' ?? false;
  const recordKey = sha(JSON.stringify([
    playedAt,
    msPlayed,
    mediaType,
    trackName,
    artistName,
    albumName,
    episodeName,
    showName,
    spotifyUri
  ]));

  return {
    record_key: recordKey,
    played_at: playedAt,
    ms_played: Math.max(0, Math.round(msPlayed)),
    media_type: mediaType,
    track_name: trackName,
    artist_name: artistName,
    album_name: albumName,
    episode_name: episodeName,
    show_name: showName,
    spotify_uri: spotifyUri,
    platform: clean(raw.platform),
    country: clean(raw.conn_country || raw.country),
    reason_start: clean(raw.reason_start),
    reason_end: clean(raw.reason_end),
    shuffle: raw.shuffle,
    skipped,
    offline: raw.offline,
    incognito_mode: raw.incognito_mode
  };
}

function getStats() {
  const overview = db.prepare(`
    SELECT
      COUNT(*) AS total_plays,
      COALESCE(SUM(ms_played), 0) AS total_ms,
      SUM(CASE WHEN media_type = 'music' THEN 1 ELSE 0 END) AS music_plays,
      SUM(CASE WHEN media_type = 'podcast' THEN 1 ELSE 0 END) AS podcast_plays,
      SUM(CASE WHEN skipped = 1 OR ms_played <= 30000 THEN 1 ELSE 0 END) AS skipped_plays,
      MIN(played_at) AS first_played,
      MAX(played_at) AS last_played
    FROM plays
  `).get();

  const distinct = db.prepare(`
    SELECT
      COUNT(DISTINCT NULLIF(track_name || '|' || COALESCE(artist_name, ''), '|')) AS songs,
      COUNT(DISTINCT NULLIF(artist_name, '')) AS artists,
      COUNT(DISTINCT NULLIF(album_name, '')) AS albums,
      COUNT(DISTINCT NULLIF(show_name, '')) AS shows,
      COUNT(DISTINCT NULLIF(episode_name, '')) AS episodes
    FROM plays
  `).get();

  return {
    overview: {
      ...overview,
      ...distinct,
      total_hours: round((overview.total_ms || 0) / 3600000, 2),
      skip_rate: overview.total_plays ? round((overview.skipped_plays || 0) / overview.total_plays * 100, 1) : 0
    },
    imports: allRows('SELECT id, source_file, imported_at, record_count FROM raw_imports ORDER BY imported_at DESC'),
    topTracks: allRows(`
      SELECT track_name, artist_name, album_name, COUNT(*) AS plays, SUM(ms_played) AS ms, MIN(played_at) AS first_played, MAX(played_at) AS last_played
      FROM plays
      WHERE media_type = 'music' AND track_name IS NOT NULL
      GROUP BY track_name, artist_name, album_name
      ORDER BY ms DESC
      LIMIT 50
    `),
    topArtists: allRows(`
      SELECT p.artist_name, COUNT(*) AS plays, SUM(p.ms_played) AS ms, MIN(p.played_at) AS first_played, MAX(p.played_at) AS last_played,
             MAX(a.genres_json) AS genres_json, MAX(a.image_url) AS image_url
      FROM plays p
      LEFT JOIN play_entities pe ON pe.play_id = p.id
      LEFT JOIN artists a ON a.spotify_id = pe.artist_id
      WHERE p.media_type = 'music' AND p.artist_name IS NOT NULL
      GROUP BY p.artist_name
      ORDER BY ms DESC
      LIMIT 50
    `),
    topAlbums: allRows(`
      SELECT p.album_name, p.artist_name, COUNT(*) AS plays, SUM(p.ms_played) AS ms, MAX(al.image_url) AS image_url
      FROM plays p
      LEFT JOIN play_entities pe ON pe.play_id = p.id
      LEFT JOIN albums al ON al.spotify_id = pe.album_id
      WHERE p.media_type = 'music' AND p.album_name IS NOT NULL
      GROUP BY p.album_name, p.artist_name
      ORDER BY ms DESC
      LIMIT 50
    `),
    topShows: allRows(`
      SELECT show_name, COUNT(*) AS plays, SUM(ms_played) AS ms, MIN(played_at) AS first_played, MAX(played_at) AS last_played
      FROM plays
      WHERE media_type = 'podcast' AND show_name IS NOT NULL
      GROUP BY show_name
      ORDER BY ms DESC
      LIMIT 50
    `),
    topEpisodes: allRows(`
      SELECT episode_name, show_name, COUNT(*) AS plays, SUM(ms_played) AS ms
      FROM plays
      WHERE media_type = 'podcast' AND episode_name IS NOT NULL
      GROUP BY episode_name, show_name
      ORDER BY ms DESC
      LIMIT 50
    `),
    genres: getGenreStats(),
    timeline: allRows(`
      SELECT substr(played_at, 1, 7) AS period, COUNT(*) AS plays, SUM(ms_played) AS ms
      FROM plays
      GROUP BY period
      ORDER BY period
    `),
    hourly: allRows(`
      SELECT CAST(strftime('%H', played_at) AS INTEGER) AS hour, COUNT(*) AS plays, SUM(ms_played) AS ms
      FROM plays
      GROUP BY hour
      ORDER BY hour
    `),
    weekday: allRows(`
      SELECT CAST(strftime('%w', played_at) AS INTEGER) AS weekday, COUNT(*) AS plays, SUM(ms_played) AS ms
      FROM plays
      GROUP BY weekday
      ORDER BY weekday
    `),
    streaks: getStreaks(),
    enrichment: enrichmentState
  };
}

function getGenreStats() {
  const rows = allRows(`
    SELECT p.ms_played AS ms, a.genres_json
    FROM plays p
    JOIN play_entities pe ON pe.play_id = p.id
    JOIN artists a ON a.spotify_id = pe.artist_id
    WHERE p.media_type = 'music' AND a.genres_json IS NOT NULL AND a.genres_json != '[]'
  `);
  const genres = new Map();
  for (const row of rows) {
    for (const genre of JSON.parse(row.genres_json || '[]')) {
      const current = genres.get(genre) || { genre, plays: 0, ms: 0 };
      current.plays += 1;
      current.ms += row.ms || 0;
      genres.set(genre, current);
    }
  }
  return [...genres.values()].sort((a, b) => b.ms - a.ms).slice(0, 50);
}

function getStreaks() {
  const days = allRows(`
    SELECT substr(played_at, 1, 10) AS day, SUM(ms_played) AS ms, COUNT(*) AS plays
    FROM plays
    GROUP BY day
    ORDER BY day
  `);
  let best = { start: null, end: null, days: 0 };
  let current = { start: null, end: null, days: 0 };
  let previous = null;
  for (const row of days) {
    const date = new Date(`${row.day}T00:00:00Z`);
    if (!previous || (date - previous) === 86400000) {
      current = {
        start: current.start || row.day,
        end: row.day,
        days: current.days + 1
      };
    } else {
      current = { start: row.day, end: row.day, days: 1 };
    }
    if (current.days > best.days) best = { ...current };
    previous = date;
  }
  const biggestDays = days.sort((a, b) => b.ms - a.ms).slice(0, 10);
  return { longest: best, biggestDays };
}

async function runEnrichment() {
  if (enrichmentState.status === 'running') return;
  const token = await getSpotifyToken();
  const plays = allRows(`
    SELECT p.*
    FROM plays p
    LEFT JOIN play_entities pe ON pe.play_id = p.id
    WHERE pe.play_id IS NULL
    ORDER BY p.played_at DESC
    LIMIT 500
  `);
  enrichmentState = {
    status: 'running',
    message: `Enriching ${plays.length} unmatched plays.`,
    processed: 0,
    total: plays.length,
    updated_at: new Date().toISOString()
  };

  for (const play of plays) {
    if (enrichmentState.status === 'paused') return;
    try {
      if (play.media_type === 'podcast') await enrichPodcast(play, token);
      else await enrichTrack(play, token);
    } catch (error) {
      if (error.retryAfter) {
        enrichmentState = {
          ...enrichmentState,
          status: 'paused',
          message: `Spotify rate limited requests. Try again in ${error.retryAfter} seconds.`,
          updated_at: new Date().toISOString()
        };
        return;
      }
      console.warn(`Unable to enrich play ${play.id}: ${error.message}`);
    }
    enrichmentState = {
      ...enrichmentState,
      processed: enrichmentState.processed + 1,
      updated_at: new Date().toISOString()
    };
  }

  enrichmentState = {
    ...enrichmentState,
    status: 'complete',
    message: 'Enrichment run complete. Start again later to process any newly imported records.',
    updated_at: new Date().toISOString()
  };
}

async function enrichTrack(play, token) {
  let track = null;
  const id = spotifyId(play.spotify_uri, 'track');
  if (id) track = await spotifyFetch(`/v1/tracks/${id}`, token);
  if (!track && play.track_name && play.artist_name) {
    const q = `track:${play.track_name} artist:${play.artist_name}`;
    const search = await spotifyFetch(`/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`, token);
    track = search?.tracks?.items?.[0] || null;
  }
  if (!track) return;

  const album = track.album || {};
  const image = album.images?.[0]?.url || null;
  db.prepare('INSERT OR REPLACE INTO albums (spotify_id, name, release_date, image_url, external_url) VALUES (?, ?, ?, ?, ?)')
    .run(album.id, album.name, album.release_date, image, album.external_urls?.spotify || null);
  db.prepare('INSERT OR REPLACE INTO tracks (spotify_id, name, duration_ms, album_id, image_url, external_url) VALUES (?, ?, ?, ?, ?, ?)')
    .run(track.id, track.name, track.duration_ms, album.id || null, image, track.external_urls?.spotify || null);

  const artist = track.artists?.[0];
  let artistDetails = null;
  if (artist?.id) artistDetails = await spotifyFetch(`/v1/artists/${artist.id}`, token);
  if (artistDetails?.id) {
    db.prepare('INSERT OR REPLACE INTO artists (spotify_id, name, genres_json, image_url, external_url) VALUES (?, ?, ?, ?, ?)')
      .run(
        artistDetails.id,
        artistDetails.name,
        JSON.stringify(artistDetails.genres || []),
        artistDetails.images?.[0]?.url || null,
        artistDetails.external_urls?.spotify || null
      );
  }

  db.prepare(`
    INSERT OR REPLACE INTO play_entities (play_id, track_id, artist_id, album_id, match_confidence, matched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(play.id, track.id, artistDetails?.id || artist?.id || null, album.id || null, id ? 1 : 0.72, new Date().toISOString());
}

async function enrichPodcast(play, token) {
  let episode = null;
  const id = spotifyId(play.spotify_uri, 'episode');
  if (id) episode = await spotifyFetch(`/v1/episodes/${id}`, token);
  if (!episode && play.episode_name) {
    const q = play.show_name ? `${play.episode_name} ${play.show_name}` : play.episode_name;
    const search = await spotifyFetch(`/v1/search?type=episode&limit=1&q=${encodeURIComponent(q)}`, token);
    episode = search?.episodes?.items?.[0] || null;
  }
  if (!episode) return;

  const show = episode.show || {};
  db.prepare('INSERT OR REPLACE INTO shows (spotify_id, name, publisher, image_url, external_url) VALUES (?, ?, ?, ?, ?)')
    .run(show.id, show.name, show.publisher || null, show.images?.[0]?.url || null, show.external_urls?.spotify || null);
  db.prepare('INSERT OR REPLACE INTO episodes (spotify_id, name, show_id, duration_ms, image_url, external_url) VALUES (?, ?, ?, ?, ?, ?)')
    .run(episode.id, episode.name, show.id || null, episode.duration_ms || null, episode.images?.[0]?.url || show.images?.[0]?.url || null, episode.external_urls?.spotify || null);
  db.prepare(`
    INSERT OR REPLACE INTO play_entities (play_id, show_id, episode_id, match_confidence, matched_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(play.id, show.id || null, episode.id, id ? 1 : 0.7, new Date().toISOString());
}

async function getSpotifyToken() {
  const access = getSetting('spotify_access_token');
  const expires = Number(getSetting('spotify_token_expires_at') || 0);
  if (access && Date.now() < expires - 60000) return access;

  const refresh = getSetting('spotify_refresh_token');
  const clientId = getSetting('spotify_client_id');
  if (!refresh || !clientId) throw new Error('Connect Spotify before enrichment.');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: clientId
  });
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error_description || body.error || 'Unable to refresh Spotify token.');
  saveSpotifyTokens(body);
  return body.access_token;
}

async function exchangeSpotifyCode(code, state) {
  if (!code) throw new Error('Missing Spotify authorization code.');
  if (state !== getSetting('spotify_oauth_state')) throw new Error('Spotify OAuth state did not match.');
  const clientId = getSetting('spotify_client_id');
  const verifier = getSetting('spotify_pkce_verifier');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier
  });
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error_description || body.error || 'Unable to connect Spotify.');
  saveSpotifyTokens(body);
  setSetting('spotify_oauth_state', '');
  setSetting('spotify_pkce_verifier', '');
  return { ok: true };
}

function saveSpotifyTokens(body) {
  setSetting('spotify_access_token', body.access_token);
  if (body.refresh_token) setSetting('spotify_refresh_token', body.refresh_token);
  setSetting('spotify_token_expires_at', String(Date.now() + Number(body.expires_in || 3600) * 1000));
}

async function spotifyFetch(path, token) {
  const response = await fetch(`https://api.spotify.com${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (response.status === 429) {
    const error = new Error('Spotify rate limit reached.');
    error.retryAfter = response.headers.get('retry-after') || 'a few';
    throw error;
  }
  if (response.status === 404) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `Spotify API error ${response.status}`);
  return body;
}

function exportCsv(res, kind) {
  const queries = {
    tracks: `SELECT track_name, artist_name, album_name, COUNT(*) AS plays, SUM(ms_played) AS ms, MIN(played_at) AS first_played, MAX(played_at) AS last_played FROM plays WHERE media_type = 'music' GROUP BY track_name, artist_name, album_name ORDER BY ms DESC`,
    artists: `SELECT artist_name, COUNT(*) AS plays, SUM(ms_played) AS ms, MIN(played_at) AS first_played, MAX(played_at) AS last_played FROM plays WHERE media_type = 'music' GROUP BY artist_name ORDER BY ms DESC`,
    albums: `SELECT album_name, artist_name, COUNT(*) AS plays, SUM(ms_played) AS ms FROM plays WHERE media_type = 'music' GROUP BY album_name, artist_name ORDER BY ms DESC`,
    podcasts: `SELECT show_name, episode_name, COUNT(*) AS plays, SUM(ms_played) AS ms FROM plays WHERE media_type = 'podcast' GROUP BY show_name, episode_name ORDER BY ms DESC`,
    plays: `SELECT played_at, media_type, ms_played, track_name, artist_name, album_name, episode_name, show_name, spotify_uri, platform, country, reason_start, reason_end, shuffle, skipped, offline, incognito_mode FROM plays ORDER BY played_at DESC`
  };
  const query = queries[kind];
  if (!query) {
    json(res, 404, { error: 'Unknown export.' });
    return;
  }
  const rows = allRows(query);
  const csv = toCsv(rows);
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${kind}.csv"`
  });
  res.end(csv);
}

function allRows(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function getSetting(key) {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || '';
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, String(value || ''), new Date().toISOString());
}

function parseMultipart(buffer, contentType) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error('Missing multipart boundary.');
  const marker = Buffer.from(`--${boundary}`);
  const files = [];
  let start = buffer.indexOf(marker);
  while (start !== -1) {
    const next = buffer.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const part = buffer.subarray(start + marker.length + 2, next - 2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const header = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const filename = header.match(/filename="([^"]+)"/)?.[1];
      if (filename) files.push({ filename: basename(filename), buffer: content });
    }
    start = next;
  }
  return files;
}

async function readJson(req) {
  return JSON.parse((await readBuffer(req)).toString('utf8') || '{}');
}

function readBuffer(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendFile(res, filePath) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  };
  res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((key) => csvCell(row[key])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}:00Z`).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function spotifyId(uri, type) {
  const match = String(uri || '').match(new RegExp(`spotify:${type}:([^:?]+)`));
  return match?.[1] || null;
}

function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function boolInt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase()) ? 1 : 0;
  return value ? 1 : 0;
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeName(value) {
  return basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function minDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function maxDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
