// Sons tendance TikTok : classement Apify (simulé), téléchargement, rangs, grâce de 14 jours, calendrier hebdomadaire
// (nécessite Postgres via DATABASE_URL et ffmpeg, sinon ignorés). Aucun appel réseau réel.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let hasFfmpeg = true;
try {
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;

let pool;
let dir;
let wav;
let T; // trending.js
let M; // music.js

const CDN = 'https://sf16-ies-music-va.tiktokcdn.com';
const item = (n, extra = {}) => ({ position: n, musicId: `s${n}x`, musicTitle: `Son ${n}`, musicAuthor: `Artiste ${n}`, musicIsCommercial: true, musicIsOriginal: false, musicAudioUrl: `${CDN}/a${n}.mp3`, ...extra });

/** Faux Apify + faux serveur audio. `items` : le classement ; `calls` : toutes les requêtes. */
const fakeFetch = (items, { runStatus = 'SUCCEEDED', calls = [], audioStatus = 200 } = {}) => async (url, init = {}) => {
  const u = new URL(url);
  calls.push({ method: init.method ?? 'GET', url: String(url), auth: init.headers?.Authorization });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.hostname === 'api.apify.com') {
    if (init.headers?.Authorization !== 'Bearer tok-test') return json({}, 401);
    if (u.pathname.endsWith('/runs') && init.method === 'POST') return json({ data: { id: 'run1', status: 'READY', defaultDatasetId: 'ds1' } }, 201);
    if (u.pathname.startsWith('/v2/actor-runs/')) return json({ data: { id: 'run1', status: runStatus, defaultDatasetId: 'ds1' } });
    if (u.pathname.startsWith('/v2/datasets/')) return json(items);
  }
  if (u.hostname.endsWith('tiktokcdn.com')) return new Response(audioStatus === 200 ? wav : 'nope', { status: audioStatus, headers: { 'Content-Type': 'audio/mpeg' } });
  return new Response('?', { status: 404 });
};

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trending-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  const f = path.join(dir, 's.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=10', '-ar', '22050', f]);
  wav = await fs.readFile(f);
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM studio_music');
  await pool.query("DELETE FROM settings WHERE key = 'trending_sounds'");
  M = await import('../src/studio/music.js');
  T = await import('../src/studio/trending.js');
});
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM studio_music');
  await pool.query("DELETE FROM settings WHERE key = 'trending_sounds'");
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

const cfg = (extra = {}) => ({ ...T.trendingConfig({ APIFY_TOKEN: 'tok-test' }), pollMs: 1, ...extra });
const tracks = () => M.publicTracks().filter((t) => t.category === 'tendance');

test('configuration : sans jeton la fonction est inactive, valeurs par défaut sûres', () => {
  const c = T.trendingConfig({});
  assert.equal(c.token, '');
  const on = T.trendingConfig({ APIFY_TOKEN: ' abc ' });
  assert.deepEqual([on.token, on.country, on.count, on.commercialOnly, on.songsOnly, on.actor], ['abc', 'FR', 100, true, true, 's_actors~tiktok-trending-sounds-scraper']);
  assert.equal(T.trendingConfig({ APIFY_TOKEN: 'a', TRENDING_COUNT: '500' }).count, 100);
  assert.equal(T.trendingConfig({ APIFY_TOKEN: 'a', TRENDING_COMMERCIAL_ONLY: 'off' }).commercialOnly, false);
});

test('classement : doublons, sons non commerciaux, sons originaux et sons sans fichier écartés', () => {
  const c = T.trendingConfig({ APIFY_TOKEN: 'a' });
  const out = T.normalizeSounds([item(3), item(1), item(2, { musicIsCommercial: false }), item(1), item(4, { musicIsOriginal: true }), item(5, { musicAudioUrl: undefined }), item(6, { musicAudioUrl: 'http://x/a.mp3' }), { musicId: '??', musicTitle: 'x' }, null], c);
  assert.deepEqual(out.map((s) => [s.id, s.rank]), [['s1x', 1], ['s3x', 2]]);
  assert.equal(T.normalizeSounds([item(1)], { ...c, count: 1 }).length, 1);
});

test('actualisation : télécharge, convertit, classe ; seul Apify reçoit le jeton', { skip: !enabled }, async () => {
  const calls = [];
  const items = Array.from({ length: 6 }, (_, i) => item(i + 1));
  const r = await T.refreshTrending({ cfg: cfg(), fetchImpl: fakeFetch(items, { calls }) });
  assert.deepEqual([r.total, r.added, r.failed, r.removed], [6, 6, 0, 0]);
  const list = tracks();
  assert.deepEqual(list.map((t) => t.title), ['Son 1', 'Son 2', 'Son 3', 'Son 4', 'Son 5', 'Son 6']);
  assert.equal(list[0].credit, 'Artiste 1');
  assert.match(list[0].license, /TikTok/);
  assert.ok(await fs.stat(M.findTrack(list[0].id).path), 'fichier MP3 sur le disque');
  assert.equal(M.publicTracks()[0].category, 'tendance', 'les tendances passent avant le reste');
  for (const c of calls) assert.equal(Boolean(c.auth), new URL(c.url).hostname === 'api.apify.com', `jeton uniquement pour Apify : ${c.url}`);
  const run = calls.find((c) => c.method === 'POST');
  assert.match(run.url, /acts\/s_actors~tiktok-trending-sounds-scraper\/runs/);
  const st = await T.trendingStatus(cfg());
  assert.deepEqual([st.available, st.running, st.live], [true, false, 6]);
  assert.ok(st.last_ok_at);
});

test('semaine suivante : un son déjà là n\'est pas retéléchargé, il change de rang ; un son sorti n\'est plus proposé mais reste utilisable', { skip: !enabled }, async () => {
  const before = Object.fromEntries(tracks().map((t) => [t.title, t.id]));
  const calls = [];
  const items = [2, 1, 3, 4, 5, 7].map((n, i) => item(n, { position: i + 1 })); // 6 sorti, 7 nouveau, 2 devient premier
  const r = await T.refreshTrending({ cfg: cfg(), fetchImpl: fakeFetch(items, { calls }) });
  assert.deepEqual([r.total, r.added], [6, 1]);
  assert.equal(calls.filter((c) => c.url.includes('tiktokcdn.com')).length, 1, 'un seul fichier téléchargé : le nouveau');
  assert.deepEqual(tracks().map((t) => t.title), ['Son 2', 'Son 1', 'Son 3', 'Son 4', 'Son 5', 'Son 7']);
  assert.equal(tracks()[0].id, before['Son 2'], 'même morceau, nouveau rang');
  assert.equal(M.publicTracks().some((t) => t.id === before['Son 6']), false, 'plus proposé');
  assert.ok(M.findTrack(before['Son 6']), 'mais un brouillon ou un rendu qui l\'utilise fonctionne encore');
});

test('suppression des sons sortis du classement depuis plus de 14 jours (ligne et fichier)', { skip: !enabled }, async () => {
  const { rows } = await pool.query("SELECT id, file FROM studio_music WHERE source = 'tiktok' AND rank IS NULL");
  assert.equal(rows.length, 1);
  await pool.query("UPDATE studio_music SET last_seen_at = now() - interval '15 days' WHERE id = $1", [rows[0].id]);
  assert.equal(await T.purgeOldTrending(), 1);
  await assert.rejects(fs.stat(path.join(M.libraryDir(), rows[0].file)));
  assert.equal((await pool.query('SELECT 1 FROM studio_music WHERE id = $1', [rows[0].id])).rowCount, 0);
});

test('un son masqué par l\'admin le reste après l\'actualisation', { skip: !enabled }, async () => {
  const victim = tracks().find((t) => t.title === 'Son 3');
  await M.updateTrack(victim.id, { enabled: false });
  assert.equal(tracks().some((t) => t.id === victim.id), false);
  await T.refreshTrending({ cfg: cfg(), fetchImpl: fakeFetch([item(3), item(1), item(2), item(4), item(5), item(7)]) });
  assert.equal(tracks().some((t) => t.id === victim.id), false, 'toujours masqué');
});

test('échecs : classement trop pauvre, Apify en échec, jeton refusé = l\'ancien classement est conservé', { skip: !enabled }, async () => {
  const keep = tracks().map((t) => t.id);
  await assert.rejects(T.refreshTrending({ cfg: cfg(), fetchImpl: fakeFetch([item(1), item(2)]) }), /classement conservé/);
  await assert.rejects(T.refreshTrending({ cfg: cfg(), fetchImpl: fakeFetch([item(1)], { runStatus: 'FAILED' }) }), /échoué/);
  await assert.rejects(T.refreshTrending({ cfg: cfg({ token: 'mauvais' }), fetchImpl: fakeFetch([]) }), /refuse le jeton/);
  await assert.rejects(T.refreshTrending({ cfg: cfg(), fetchImpl: fakeFetch(Array.from({ length: 6 }, (_, i) => item(i + 20)), { audioStatus: 500 }) }), /Aucun son/);
  assert.deepEqual(tracks().map((t) => t.id), keep);
  const st = await T.trendingStatus(cfg());
  assert.ok(st.last_error && st.last_error_at, 'l\'erreur est visible dans l\'admin');
  await assert.rejects(T.refreshTrending({ cfg: T.trendingConfig({}) }), /pas activés/);
});

test('hôte audio inconnu : refusé, et le jeton ne part pas ailleurs', { skip: !enabled }, async () => {
  const calls = [];
  const items = Array.from({ length: 6 }, (_, i) => item(i + 40, { musicAudioUrl: `https://evil.example.com/a${i}.mp3` }));
  await assert.rejects(T.refreshTrending({ cfg: cfg(), fetchImpl: fakeFetch(items, { calls }) }), /Aucun son/);
  assert.equal(calls.some((c) => c.url.includes('evil.example.com')), false);
  const ok = await T.refreshTrending({ cfg: cfg({ extraHosts: ['example.com'] }), fetchImpl: async (u, i) => (String(u).includes('evil.example.com') ? new Response(wav, { headers: { 'Content-Type': 'audio/mpeg' } }) : fakeFetch(items)(u, i)) });
  assert.equal(ok.added, 6);
});

test('calendrier : une fois par semaine, nouvel essai 6 h après une erreur, jamais sans jeton', { skip: !enabled }, async () => {
  const now = Date.now();
  const set = (v) => pool.query("INSERT INTO settings (key, value) VALUES ('trending_sounds', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(v)]);
  const iso = (ms) => new Date(now - ms).toISOString();
  const H = 3600 * 1000;
  assert.equal(await T.dueNow(T.trendingConfig({}), now), false, 'sans jeton');
  await set({});
  assert.equal(await T.dueNow(cfg(), now), true, 'jamais fait');
  await set({ status: 'ok', last_ok_at: iso(6 * 24 * H) });
  assert.equal(await T.dueNow(cfg(), now), false, 'moins d\'une semaine');
  await set({ status: 'ok', last_ok_at: iso(7 * 24 * H + 1000) });
  assert.equal(await T.dueNow(cfg(), now), true, 'plus d\'une semaine');
  await set({ status: 'error', last_ok_at: iso(9 * 24 * H), last_error_at: iso(2 * H) });
  assert.equal(await T.dueNow(cfg(), now), false, 'erreur récente');
  await set({ status: 'error', last_ok_at: iso(9 * 24 * H), last_error_at: iso(7 * H) });
  assert.equal(await T.dueNow(cfg(), now), true, 'on réessaie');
  await set({ status: 'running', started_at: iso(10 * 60 * 1000), last_ok_at: iso(9 * 24 * H) });
  assert.equal(await T.dueNow(cfg(), now), false, 'déjà en cours');
  await set({ status: 'running', started_at: iso(3 * H), last_ok_at: iso(9 * 24 * H) });
  assert.equal(await T.dueNow(cfg(), now), true, 'travail resté bloqué : on relance');
});
