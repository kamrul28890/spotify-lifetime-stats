const state = {
  stats: null,
  activeTab: 'tracks',
  config: null
};

const $ = (selector) => document.querySelector(selector);
const fmt = new Intl.NumberFormat();
const hours = (ms) => `${fmt.format(Math.round((Number(ms) || 0) / 3600000))}h`;
const minutes = (ms) => `${fmt.format(Math.round((Number(ms) || 0) / 60000))}m`;
const date = (value) => value ? new Date(value).toLocaleDateString() : 'n/a';

init();

async function init() {
  bindEvents();
  await loadConfig();
  await loadStats();
  handleOAuthCallback();
  setInterval(loadEnrichmentStatus, 4000);
}

function bindEvents() {
  $('#importForm').addEventListener('submit', importFiles);
  $('#saveClientId').addEventListener('click', saveClientId);
  $('#connectSpotify').addEventListener('click', connectSpotify);
  $('#startEnrichment').addEventListener('click', startEnrichment);
  $('#pauseEnrichment').addEventListener('click', pauseEnrichment);
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab;
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
      renderTable();
    });
  });
}

async function loadConfig() {
  state.config = await api('/api/spotify/config');
  $('#clientIdInput').value = state.config.clientId || '';
  $('#connectionStatus').textContent = state.config.authenticated ? 'Spotify connected' : 'Local app ready';
}

async function loadStats() {
  state.stats = await api('/api/stats');
  renderOverview();
  renderCharts();
  renderLists();
  renderTable();
  renderEnrichment(state.stats.enrichment);
}

async function loadEnrichmentStatus() {
  const status = await api('/api/enrich/status');
  renderEnrichment(status);
}

async function importFiles(event) {
  event.preventDefault();
  const input = $('#fileInput');
  if (!input.files.length) {
    log('Choose a Spotify JSON or ZIP export first.');
    return;
  }
  const form = new FormData();
  [...input.files].forEach((file) => form.append('files', file));
  log('Importing export...');
  const result = await api('/api/import', { method: 'POST', body: form });
  log(`Imported ${fmt.format(result.records_inserted)} new records from ${result.files.length} JSON file(s). ${fmt.format(result.duplicate_records)} duplicates skipped.`);
  input.value = '';
  await loadStats();
}

async function saveClientId() {
  const clientId = $('#clientIdInput').value.trim();
  await api('/api/spotify/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId })
  });
  log('Spotify Client ID saved.');
  await loadConfig();
}

async function connectSpotify() {
  const result = await api('/api/spotify/login');
  window.location.href = result.url;
}

async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('code')) return;
  try {
    await api('/api/spotify/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: params.get('code'), state: params.get('state') })
    });
    history.replaceState({}, '', '/');
    log('Spotify connected. Enrichment is ready.');
    await loadConfig();
  } catch (error) {
    log(error.message);
  }
}

async function startEnrichment() {
  const result = await api('/api/enrich/start', { method: 'POST' });
  renderEnrichment(result);
  log('Enrichment started. You can leave this page open and refresh stats as it progresses.');
  setTimeout(loadStats, 2000);
}

async function pauseEnrichment() {
  const result = await api('/api/enrich/pause', { method: 'POST' });
  renderEnrichment(result);
}

function renderOverview() {
  const o = state.stats.overview;
  const cards = [
    ['Total Hours', fmt.format(o.total_hours || 0), 'All music and podcasts'],
    ['Total Plays', fmt.format(o.total_plays || 0), `${fmt.format(o.music_plays || 0)} music / ${fmt.format(o.podcast_plays || 0)} podcast`],
    ['Songs', fmt.format(o.songs || 0), 'Distinct song + artist pairs'],
    ['Artists', fmt.format(o.artists || 0), 'Music artists'],
    ['Shows', fmt.format(o.shows || 0), 'Podcast shows'],
    ['Skip Rate', `${o.skip_rate || 0}%`, 'Spotify skip flag or <= 30s']
  ];
  $('#overviewCards').innerHTML = cards.map(([label, value, sub]) => `
    <article class="card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(sub)}</span>
    </article>
  `).join('');
}

function renderCharts() {
  renderBarChart('#timelineChart', state.stats.timeline, 'period', 'ms', (row) => `${row.period}: ${minutes(row.ms)}`);
  renderBarChart('#hourChart', state.stats.hourly, 'hour', 'ms', (row) => `${String(row.hour).padStart(2, '0')}:00: ${minutes(row.ms)}`);
}

function renderBarChart(selector, rows, labelKey, valueKey, labelFn) {
  const el = $(selector);
  if (!rows.length) {
    el.innerHTML = '<div class="empty">Import your Spotify export to see this chart.</div>';
    return;
  }
  const max = Math.max(...rows.map((row) => Number(row[valueKey]) || 0), 1);
  el.innerHTML = rows.map((row) => {
    const height = Math.max(2, Math.round((Number(row[valueKey]) || 0) / max * 100));
    return `<div class="bar" style="height:${height}%" data-label="${escapeHtml(labelFn(row))}" title="${escapeHtml(labelFn(row))}"></div>`;
  }).join('');
}

function renderLists() {
  const genres = state.stats.genres || [];
  const maxGenre = Math.max(...genres.map((row) => row.ms || 0), 1);
  $('#genreList').innerHTML = genres.length ? genres.slice(0, 12).map((row) => `
    <div class="list-row">
      <strong>${escapeHtml(row.genre)}</strong>
      <span>${hours(row.ms)}</span>
      <div class="mini-bar"><i style="width:${Math.round(row.ms / maxGenre * 100)}%"></i></div>
    </div>
  `).join('') : '<div class="empty">Connect Spotify and run enrichment to infer genres.</div>';

  const streak = state.stats.streaks?.longest || {};
  const biggest = state.stats.streaks?.biggestDays || [];
  $('#streakList').innerHTML = `
    <div class="list-row">
      <strong>Longest streak</strong>
      <span>${streak.days || 0} days</span>
      <div class="meta">${streak.start ? `${date(streak.start)} to ${date(streak.end)}` : 'No listening days imported yet'}</div>
    </div>
    ${biggest.slice(0, 6).map((row) => `
      <div class="list-row">
        <strong>${date(row.day)}</strong>
        <span>${hours(row.ms)}</span>
        <div class="meta">${fmt.format(row.plays)} plays</div>
      </div>
    `).join('')}
  `;
}

function renderTable() {
  const tables = {
    tracks: {
      title: 'Songs',
      subtitle: 'Music rankings exclude podcasts',
      rows: state.stats.topTracks,
      columns: [
        ['Track', 'track_name'],
        ['Artist', 'artist_name'],
        ['Album', 'album_name'],
        ['Plays', 'plays', fmt.format],
        ['Time', 'ms', hours],
        ['First', 'first_played', date],
        ['Last', 'last_played', date]
      ]
    },
    artists: {
      title: 'Artists',
      subtitle: 'Genres appear after enrichment',
      rows: state.stats.topArtists,
      columns: [
        ['Artist', 'artist_name'],
        ['Plays', 'plays', fmt.format],
        ['Time', 'ms', hours],
        ['Genres', 'genres_json', formatGenres],
        ['First', 'first_played', date],
        ['Last', 'last_played', date]
      ]
    },
    albums: {
      title: 'Albums',
      subtitle: 'Grouped by album and artist',
      rows: state.stats.topAlbums,
      columns: [
        ['Album', 'album_name'],
        ['Artist', 'artist_name'],
        ['Plays', 'plays', fmt.format],
        ['Time', 'ms', hours]
      ]
    },
    shows: {
      title: 'Podcast Shows',
      subtitle: 'Separate from music rankings',
      rows: state.stats.topShows,
      columns: [
        ['Show', 'show_name'],
        ['Plays', 'plays', fmt.format],
        ['Time', 'ms', hours],
        ['First', 'first_played', date],
        ['Last', 'last_played', date]
      ]
    },
    episodes: {
      title: 'Podcast Episodes',
      subtitle: 'Top episodes by listening time',
      rows: state.stats.topEpisodes,
      columns: [
        ['Episode', 'episode_name'],
        ['Show', 'show_name'],
        ['Plays', 'plays', fmt.format],
        ['Time', 'ms', hours]
      ]
    },
    imports: {
      title: 'Imports',
      subtitle: 'Imported source files',
      rows: state.stats.imports,
      columns: [
        ['File', 'source_file'],
        ['Records', 'record_count', fmt.format],
        ['Imported', 'imported_at', (value) => new Date(value).toLocaleString()]
      ]
    }
  };

  const config = tables[state.activeTab];
  $('#tableTitle').textContent = config.title;
  $('#tableSubtitle').textContent = config.subtitle;
  renderDataTable(config.rows, config.columns);
}

function renderDataTable(rows, columns) {
  const table = $('#dataTable');
  if (!rows.length) {
    table.innerHTML = `<tbody><tr><td class="empty">No rows yet.</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `
    <thead><tr>${columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.map((row) => `
        <tr>
          ${columns.map(([, key, formatter]) => {
            const value = formatter ? formatter(row[key]) : row[key];
            return `<td>${escapeHtml(value ?? '')}</td>`;
          }).join('')}
        </tr>
      `).join('')}
    </tbody>
  `;
}

function renderEnrichment(status) {
  $('#enrichmentStatus').textContent = `${status.status}: ${status.message} ${status.total ? `(${status.processed}/${status.total})` : ''}`;
}

function formatGenres(value) {
  try {
    const genres = JSON.parse(value || '[]');
    return genres.slice(0, 4).join(', ');
  } catch {
    return '';
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || body || `Request failed: ${response.status}`);
  return body;
}

function log(message) {
  const el = document.createElement('div');
  el.className = 'message';
  el.textContent = message;
  $('#messageLog').prepend(el);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
