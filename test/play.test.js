// Lisnard Play import: a local fake of its tRPC API (needs Postgres via DATABASE_URL, skipped otherwise)
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { playQuotesOf, youtubeIdOf } from '../src/play.js';
import { playClipsFrom } from '../src/clip-suggestions.js';

const enabled = Boolean(process.env.DATABASE_URL);
const IDS = { known: 'PLAtest_aa1', tv: 'PLAtest_bb2', embed: 'PLAtest_cc3', short: 'PLAtest_dd4', live: 'PLAtest_ee5', excluded: 'PLAtest_ff6' };
let server;
let pool;
let play;
let calls = [];

const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const page1 = {
  items: [
    { id: 'i1', kind: 'tv', title: 'Sur BFMTV', outlet: 'BFMTV', date: ago(2), thumbnailUrl: `https://i3.ytimg.com/vi/${IDS.tv}/hqdefault.jpg` },
    { id: 'i2', kind: 'presse', title: 'Article', outlet: 'Le Figaro', date: ago(3), thumbnailUrl: 'https://img.example/a.jpg' },
    { id: 'i3', kind: 'radio', title: 'Matinale', outlet: 'RTL', date: ago(4), thumbnailUrl: 'https://img.example/b.jpg' },
    { id: 'i4', kind: 'tv', title: 'Déjà là', outlet: 'TF1', date: ago(30), thumbnailUrl: `https://i.ytimg.com/vi/${IDS.known}/hqdefault.jpg` },
  ],
  nextCursor: 'c2',
};
const page2 = {
  items: [
    { id: 'i5', kind: 'stream', title: 'Short', date: ago(50), thumbnailUrl: `https://i.ytimg.com/vi/${IDS.short}/hqdefault.jpg` },
    { id: 'i6', kind: 'stream', title: 'En direct', date: ago(51), thumbnailUrl: `https://i.ytimg.com/vi/${IDS.live}/hqdefault.jpg` },
    { id: 'i7', kind: 'tv', title: 'Supprimée', date: ago(52), thumbnailUrl: `https://i.ytimg.com/vi/${IDS.excluded}/hqdefault.jpg` },
  ],
  nextCursor: null,
};

before(async () => {
  if (!enabled) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const input = JSON.parse(url.searchParams.get('input') ?? '{}');
    calls.push(`${url.pathname} ${JSON.stringify(input)}`);
    const send = (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: { data } }));
    if (url.pathname === '/api/trpc/interventions.list' && input.format === 'long') return send({ items: [], nextCursor: null });
    if (url.pathname === '/api/trpc/interventions.list') return send(input.cursor === 'c2' ? page2 : page1);
    if (url.pathname === '/api/trpc/interventions.byId') {
      return send(input.id === 'i3' ? { id: 'i3', media: { kind: 'embed', provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${IDS.embed}?feature=oembed` } } : { id: input.id, media: null });
    }
    res.writeHead(404).end();
  }).listen(0);
  process.env.PLAY_URL = `http://127.0.0.1:${server.address().port}`;
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1', ['PLAtest%']);
  await pool.query('DELETE FROM excluded_videos WHERE youtube_id LIKE $1', ['PLAtest%']);
  await pool.query("DELETE FROM settings WHERE key IN ('play_seen', 'play_last_run', 'play_retry', 'play_cursor', 'play_long_done')");
  await pool.query("INSERT INTO videos (youtube_id, title, source) VALUES ($1, 'Déjà là', 'manual')", [IDS.known]);
  await pool.query("INSERT INTO excluded_videos (youtube_id, reason) VALUES ($1, 'manual')", [IDS.excluded]);
  play = await import('../src/play.js');
});

after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1', ['PLAtest%']);
  await pool.query('DELETE FROM excluded_videos WHERE youtube_id LIKE $1', ['PLAtest%']);
  await pool.query("DELETE FROM settings WHERE key IN ('play_seen', 'play_last_run', 'play_retry', 'play_cursor', 'play_long_done')");
  server.close();
  await pool.end();
});

test('youtubeIdOf : embed, watch, youtu.be, miniature ; rien sinon', () => {
  assert.equal(youtubeIdOf('https://www.youtube.com/embed/FPH3rkSPWJA?feature=oembed'), 'FPH3rkSPWJA');
  assert.equal(youtubeIdOf('https://www.youtube.com/watch?t=3&v=FPH3rkSPWJA'), 'FPH3rkSPWJA');
  assert.equal(youtubeIdOf('https://youtu.be/FPH3rkSPWJA'), 'FPH3rkSPWJA');
  assert.equal(youtubeIdOf('https://i3.ytimg.com/vi/FPH3rkSPWJA/hqdefault.jpg'), 'FPH3rkSPWJA');
  assert.equal(youtubeIdOf('https://img.example/a.jpg'), null);
  assert.equal(youtubeIdOf(null), null);
});

test('Lisnard Play : nouvelles vidéos YouTube mises en file, presse, Shorts, directs et exclusions écartés', { skip: !enabled }, async () => {
  const metas = {
    [IDS.tv]: { title: 'Lisnard sur BFMTV', channel: 'BFMTV', channel_id: 'UCx', published_at: '2026-11-04', duration_s: 900, live: false },
    [IDS.embed]: { title: 'Matinale RTL', channel: 'RTL', channel_id: 'UCy', published_at: '2026-11-04', duration_s: 1200, live: false },
    [IDS.short]: { title: 'Short', duration_s: 40, live: false },
    [IDS.live]: { title: 'Direct', duration_s: null, live: true },
  };
  const asked = [];
  const fetchMeta = async (id) => (asked.push(id), metas[id] ?? null);
  const r = await play.runPlayImport({ fetchMeta });
  assert.deepEqual([r.scanned, r.found, r.added], [7, 6, 2]);
  const { rows } = await pool.query("SELECT youtube_id, sync_status, title, channel FROM videos WHERE youtube_id LIKE 'PLAtest%' ORDER BY youtube_id");
  assert.deepEqual(rows.map((x) => [x.youtube_id, x.sync_status]), [[IDS.known, null], [IDS.tv, 'pending'], [IDS.embed, 'pending']].sort());
  assert.ok(!asked.includes(IDS.known) && !asked.includes(IDS.excluded), 'pas d’appel YouTube pour une vidéo connue ou exclue');
  assert.ok(calls.some((c) => c.includes('interventions.byId') && c.includes('i3')), 'détail demandé pour la radio sans miniature YouTube');
  assert.ok(!calls.some((c) => c.includes('interventions.byId') && c.includes('i2')), 'pas de détail pour un article de presse');
  const last = (await pool.query("SELECT value FROM settings WHERE key = 'play_last_run'")).rows[0].value;
  assert.equal(last.ok, true);

  // next pass: everything seen stops at the first page; the live one is checked again
  calls = [];
  asked.length = 0;
  metas[IDS.live] = { title: 'Replay', channel: 'X', duration_s: 3600, live: false };
  const again = await play.runPlayImport({ fetchMeta });
  assert.deepEqual([again.scanned, again.added], [0, 1], 'rien de nouveau à lire, le direct devenu replay est ajouté');
  assert.deepEqual(asked, [IDS.live]);
});

test('Lisnard Play : pas de clé YouTube, arriéré au-delà des pages lues', { skip: !enabled }, async () => {
  await pool.query("DELETE FROM settings WHERE key IN ('play_seen', 'play_last_run', 'play_retry', 'play_cursor', 'play_long_done')");
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1 AND youtube_id <> $2', ['PLAtest%', IDS.known]);
  const metas = (id) => ({ title: id, channel: 'C', duration_s: 900, live: false });
  // no API key and no injected lookup: the pass fails instead of marking everything as seen
  const key = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  await assert.rejects(play.importFromPlay(), /YOUTUBE_API_KEY/);
  if (key) process.env.YOUTUBE_API_KEY = key;
  assert.deepEqual((await pool.query("SELECT value FROM settings WHERE key = 'play_seen'")).rows, []);
  // one page per pass: the second pass resumes the older page instead of losing it
  process.env.PLAY_MAX_PAGES = '1';
  const a = await play.importFromPlay({ fetchMeta: async (id) => metas(id) });
  assert.equal(a.scanned, 4);
  assert.equal((await pool.query("SELECT value FROM settings WHERE key = 'play_cursor'")).rows[0].value, 'c2');
  const b = await play.importFromPlay({ fetchMeta: async (id) => metas(id) });
  assert.equal(b.scanned, 3, 'page plus ancienne reprise');
  assert.equal((await pool.query("SELECT value FROM settings WHERE key = 'play_cursor'")).rows[0].value, null);
  delete process.env.PLAY_MAX_PAGES;
});

test('Lisnard Play : les interventions trop anciennes sont marquées vues sans être importées', { skip: !enabled }, async () => {
  await pool.query("DELETE FROM settings WHERE key IN ('play_seen', 'play_last_run', 'play_retry', 'play_cursor', 'play_long_done')");
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1 AND youtube_id <> $2', ['PLAtest%', IDS.known]);
  process.env.PLAY_MAX_AGE_DAYS = '1';
  const asked = [];
  const r = await play.importFromPlay({ fetchMeta: async (id) => (asked.push(id), { title: id, duration_s: 900, live: false }) });
  delete process.env.PLAY_MAX_AGE_DAYS;
  assert.equal(r.scanned, 3, 'seules les interventions de moins d’un jour sont lues');
  assert.deepEqual(asked.sort(), [IDS.tv, IDS.embed].sort(), 'aucune vidéo ancienne vérifiée');
  assert.equal((await pool.query("SELECT value FROM settings WHERE key = 'play_seen'")).rows[0].value.length, 7, 'les anciennes sont marquées vues');
  assert.equal((await pool.query("SELECT value FROM settings WHERE key = 'play_cursor'")).rows[0].value, null, 'pas d’arriéré au-delà de la fenêtre');
});

test('Citations Play : nettoyées puis calées sur la transcription (début de ligne, 15 à 60 s)', () => {
  const quotes = playQuotesOf({ quotes: [{ text: '  Je propose  une droite indépendante. ', startS: 396, theme: 'campaign' }, { text: '', startS: 3 }, { text: 'x', startS: 'a' }] });
  assert.deepEqual(quotes, [{ text: 'Je propose une droite indépendante.', start_s: 396, theme: 'campaign' }]);
  const rows = Array.from({ length: 40 }, (_, i) => ({ start_ms: 380_000 + i * 4000, duration_ms: 4000, text: `Phrase ${i}.` }));
  const [c] = playClipsFrom(quotes, rows);
  assert.equal(c.start_ms, 396_000);
  assert.ok(c.duration_s >= 15 && c.duration_s <= 60);
  assert.equal(c.source, 'play');
  const [bare] = playClipsFrom(quotes, []);
  assert.equal(bare.start_ms, 396_000);
  assert.equal(bare.end_ms, 416_000);
});

test('Titres des citations : écrits par le modèle, citations inchangées si la réponse est inutilisable', async () => {
  const { titleQuotes } = await import('../src/play.js');
  const quotes = [{ text: 'Je propose une droite indépendante.', start_s: 396, theme: null }];
  const ok = await titleQuotes(quotes, { complete: async () => '```json\n{"titles":["Lisnard veut une « droite indépendante » !"]}\n```' });
  assert.equal(ok[0].title, 'Lisnard veut une droite indépendante');
  const ko = await titleQuotes(quotes, { complete: async () => 'pas du json' });
  assert.equal(ko[0].title, undefined);
  assert.equal(playClipsFrom(ok)[0].title, 'Lisnard veut une droite indépendante');
});

test('légende d’une citation Play : la citation entière, jamais coupée au milieu d’une idée', async () => {
  const { playClipsFrom, cutAtSentence } = await import('../src/clip-suggestions.js');
  const text = 'il faut beaucoup moins de prélèvements sur les entreprises pour les rendre plus compétitives, moins de prélèvements sur le travail, sur les salariés, pour que le travail paie.';
  const [clip] = playClipsFrom([{ text, start_s: 10 }], []);
  assert.ok(clip.description.startsWith(`« ${text} »`));
  assert.equal(cutAtSentence('Une idée complète ici. Une deuxième phrase bien trop longue pour tenir', 40), 'Une idée complète ici.');
  assert.equal(cutAtSentence('un texte sans point qui continue encore et encore', 25), 'un texte sans point qui…');
});
