// Mur des clips : lecture des résultats d'Apify, classement, vignettes, modération, actualisation planifiée
// (nécessite Postgres via DATABASE_URL et ffmpeg ; Apify et le serveur de vignettes sont simulés en local).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ApifyError, runActor } from '../src/wall/apify.js';
import { coverUrlAllowed, enhanceStoredCovers, normalizeItem, normalizeItems, refreshDue, wallConfig, washedOut } from '../src/wall/wall.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;

const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
let coverBase = '';
/** Un élément tel que le renvoie l'acteur clockworks/tiktok-scraper. */
const item = (id, o = {}) => ({
  id: String(id),
  text: o.text ?? `Super clip #lisnard2027 numéro ${id} #politique`,
  createTimeISO: o.date ?? iso(2),
  isAd: o.ad ?? false,
  authorMeta: { id: '99', name: o.author ?? `fan${id}`, nickName: o.nick ?? `Fan ${id}`, verified: false },
  webVideoUrl: `https://www.tiktok.com/@${o.author ?? `fan${id}`}/video/${id}?lang=fr`,
  videoMeta: { duration: o.duration ?? 31, coverUrl: o.cover ?? `${coverBase}/cover/${id}.jpg`, originalCoverUrl: o.cover ?? `${coverBase}/cover/${id}.jpg` },
  playCount: o.views ?? 1000,
  diggCount: o.likes ?? 100,
  commentCount: o.comments ?? 10,
  shareCount: o.shares ?? 5,
  collectCount: o.saves ?? 2,
  hashtags: o.hashtags ?? [{ name: 'lisnard2027' }, { name: 'politique' }],
});

// --- lecture d'un élément ------------------------------------------------------------------------------------------------------

test('élément de l\'acteur : champs lus, adresse nettoyée, nombres et date normalisés', () => {
  const c = normalizeItem(item('7301234567890123456', { views: 12345, likes: 678, comments: 9, date: '2026-09-01T10:00:00.000Z' }), 'lisnard2027');
  assert.equal(c.id, '7301234567890123456');
  assert.equal(c.url, 'https://www.tiktok.com/@fan7301234567890123456/video/7301234567890123456'); // sans ?lang=fr
  assert.deepEqual([c.views, c.likes, c.comments, c.shares, c.saves, c.duration_s], [12345, 678, 9, 5, 2, 31]);
  assert.equal(c.created_at, '2026-09-01T10:00:00.000Z');
  assert.deepEqual(c.hashtags, ['lisnard2027', 'politique']);
  assert.equal(c.nickname, 'Fan 7301234567890123456');
  // variantes : date en secondes, statistiques regroupées, hashtags en texte
  const v = normalizeItem({ id: '1234567890', desc: 'Bravo #Lisnard2027', createTime: 1_790_000_000, author: { uniqueId: 'marie.d' }, stats: { playCount: '500', diggCount: 50, commentCount: 5 }, hashtags: ['#Lisnard2027'] }, 'lisnard2027');
  assert.deepEqual([v.author, v.views, v.likes, v.comments, v.created_at], ['marie.d', 500, 50, 5, new Date(1_790_000_000_000).toISOString()]);
  assert.equal(v.url, 'https://www.tiktok.com/@marie.d/video/1234567890');
});

test('éléments écartés : publicité, autre hashtag, erreur de l\'acteur, identifiant ou auteur invalide ; doublons fusionnés', () => {
  assert.equal(normalizeItem(item('1234567890', { ad: true }), 'lisnard2027').skip, 'ad');
  assert.equal(normalizeItem(item('1234567891', { text: 'rien à voir', hashtags: [{ name: 'autre' }] }), 'lisnard2027').skip, 'hashtag');
  assert.equal(normalizeItem({ error: 'No videos found', input: 'lisnard2027' }, 'lisnard2027').skip, 'error');
  assert.equal(normalizeItem({ ...item('12'), id: 'abc' }, 'lisnard2027').skip, 'invalid');
  assert.equal(normalizeItem({ ...item('1234567892'), authorMeta: { name: '../etc' } }, 'lisnard2027').skip, 'invalid');
  assert.equal(normalizeItem(null, 'x').skip, 'invalid');
  // hashtag trouvé dans la légende seulement
  assert.equal(normalizeItem({ ...item('1234567893'), hashtags: [] }, 'lisnard2027').skip, undefined);
  const { clips, skipped } = normalizeItems([item('1234567894'), item('1234567894', { views: 5000 }), item('1234567895', { ad: true }), { error: 'x' }], 'lisnard2027');
  assert.equal(clips.length, 1);
  assert.equal(clips[0].views, 5000); // le dernier gagne
  assert.deepEqual(skipped, { ad: 1, error: 1 });
  // texte nettoyé : caractères de contrôle supprimés, longueur bornée
  assert.ok(normalizeItem(item('1234567896', { text: `#lisnard2027 ${'a'.repeat(900)}\u0000\u0007` }), 'lisnard2027').text.length <= 600);
});

test('adresses de vignettes : seulement TikTok / Apify en HTTPS', () => {
  const extra = process.env.WALL_COVER_HOSTS; // réglage des tests de bout en bout : ici on veut le comportement réel
  delete process.env.WALL_COVER_HOSTS;
  after(() => extra !== undefined && (process.env.WALL_COVER_HOSTS = extra));
  for (const ok of ['https://p16-sign-va.tiktokcdn.com/obj/a.jpeg?x=1', 'https://p19-sign.tiktokcdn-eu.com/a.jpg', 'https://api.apify.com/v2/key-value-stores/x/records/y']) assert.ok(coverUrlAllowed(ok), ok);
  for (const bad of ['http://p16.tiktokcdn.com/a.jpg', 'https://evil.example.com/a.jpg', 'https://tiktokcdn.com.evil.com/a.jpg', 'https://127.0.0.1/a.jpg', 'file:///etc/passwd', 'pas une adresse']) assert.ok(!coverUrlAllowed(bad), bad);
});

test('réglages : valeurs par défaut et poids du classement', () => {
  const keep = { ...process.env };
  try {
    for (const k of ['WALL_HASHTAG', 'WALL_RESULTS', 'WALL_REFRESH_HOURS', 'WALL_WEIGHTS', 'APIFY_TIKTOK_ACTOR']) delete process.env[k];
    delete process.env.WALL_MAX;
    const d = wallConfig();
    assert.deepEqual([d.hashtag, d.results, d.refreshHours, d.weights, d.actor, d.max], ['lisnard2027', 100, 24, [1, 10, 50], 'clockworks/tiktok-scraper', 13]);
    Object.assign(process.env, { WALL_HASHTAG: '#Lisnard2028', WALL_RESULTS: '5000', WALL_REFRESH_HOURS: '0', WALL_WEIGHTS: '2, 20, 100', WALL_MAX: '500' });
    const c = wallConfig();
    assert.deepEqual([c.hashtag, c.results, c.refreshHours, c.weights, c.max], ['lisnard2028', 1000, 0, [2, 20, 100], 60]);
    process.env.WALL_WEIGHTS = 'n’importe quoi';
    assert.deepEqual(wallConfig().weights, [1, 10, 50]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test('actualisation planifiée : due selon l\'âge de la dernière exécution', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const at = (h) => new Date(now - h * 3_600_000).toISOString();
  assert.equal(refreshDue(null, 12, now), true);
  assert.equal(refreshDue({ status: 'ok', started_at: at(13), finished_at: at(13) }, 12, now), true);
  assert.equal(refreshDue({ status: 'ok', started_at: at(3), finished_at: at(3) }, 12, now), false);
  assert.equal(refreshDue({ status: 'failed', started_at: at(0.5), finished_at: at(0.5) }, 12, now), false); // un échec récent n'est pas relancé tout de suite
  assert.equal(refreshDue({ status: 'failed', started_at: at(2), finished_at: at(2) }, 12, now), true); // …mais on réessaie au bout d'une heure
  assert.equal(refreshDue({ status: 'running', started_at: at(0.1) }, 12, now), false);
  assert.equal(refreshDue({ status: 'running', started_at: at(2) }, 12, now), true); // restée « en cours » après un redémarrage
  assert.equal(refreshDue(null, 0, now), false); // 0 : seulement à la demande
});

// --- Apify simulé ---------------------------------------------------------------------------------------------------------------

let apify;
let apifyBase;
const calls = [];
let datasetItems = [];
let failRun = null;
let polls = 0;

before(async () => {
  apify = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
      if (req.headers.authorization !== 'Bearer tok') return send(401, { error: { type: 'user-or-token-not-found', message: 'User was not found or authentication token is not valid' } });
      if (req.method === 'POST' && url.pathname === '/v2/acts/clockworks~tiktok-scraper/runs') return send(201, { data: { id: 'run1', status: 'READY', defaultDatasetId: 'ds1' } });
      if (url.pathname === '/v2/actor-runs/run1') {
        polls++;
        if (failRun) return send(200, { data: { id: 'run1', status: failRun, statusMessage: 'Proxy error', defaultDatasetId: 'ds1' } });
        return send(200, { data: { id: 'run1', status: polls < 2 ? 'RUNNING' : 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.17 } });
      }
      if (url.pathname === '/v2/datasets/ds1/items') {
        const off = Number(url.searchParams.get('offset'));
        const lim = Number(url.searchParams.get('limit'));
        return send(200, datasetItems.slice(off, off + lim));
      }
      return send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise((r) => apify.listen(0, '127.0.0.1', r));
  apifyBase = `http://127.0.0.1:${apify.address().port}`;
  Object.assign(process.env, { APIFY_POLL_MS: '1', APIFY_WAIT_SECONDS: '0' });
});
after(() => apify.close());

test('client Apify : lance l\'acteur, attend la fin, lit les résultats par pages, renvoie le coût', { skip: !enabled }, async () => {
  datasetItems = Array.from({ length: 7 }, (_, i) => ({ id: String(1000 + i) }));
  calls.length = 0;
  polls = 0;
  const { items, run } = await runActor({ token: 'tok', actor: 'clockworks/tiktok-scraper', baseUrl: apifyBase, input: { hashtags: ['lisnard2027'], resultsPerPage: 7 }, maxItems: 7 });
  assert.equal(items.length, 7);
  assert.equal(run.usageTotalUsd, 0.17);
  const start = calls[0];
  assert.deepEqual([start.method, start.path, start.auth, start.body.hashtags], ['POST', '/v2/acts/clockworks~tiktok-scraper/runs', 'Bearer tok', ['lisnard2027']]);
  assert.ok(!calls.some((c) => c.query.includes('token='))); // le jeton ne passe jamais dans l'adresse
  assert.ok(calls.filter((c) => c.path === '/v2/actor-runs/run1').length >= 2);
  // plus d'éléments que demandé : on s'arrête à maxItems, en plusieurs pages si besoin
  datasetItems = Array.from({ length: 1300 }, (_, i) => ({ id: String(2000 + i) }));
  polls = 5;
  assert.equal((await runActor({ token: 'tok', actor: 'clockworks/tiktok-scraper', baseUrl: apifyBase, input: {}, maxItems: 1100 })).items.length, 1100);
});

test('client Apify : messages clairs (jeton absent ou refusé, exécution échouée, acteur inconnu)', { skip: !enabled }, async () => {
  const base = { baseUrl: apifyBase, input: {}, maxItems: 5 };
  await assert.rejects(runActor({ ...base, token: '', actor: 'a/b' }), (e) => e instanceof ApifyError && /APIFY_TOKEN manquant/.test(e.message));
  await assert.rejects(runActor({ ...base, token: 'mauvais', actor: 'clockworks/tiktok-scraper' }), /Jeton Apify refusé/);
  failRun = 'FAILED';
  polls = 5;
  await assert.rejects(runActor({ ...base, token: 'tok', actor: 'clockworks/tiktok-scraper' }), /a échoué \(FAILED : Proxy error\)/);
  failRun = null;
  await assert.rejects(runActor({ ...base, token: 'tok', actor: 'inconnu/acteur' }), /introuvable/);
  await assert.rejects(runActor({ ...base, token: 'tok', actor: 'clockworks/tiktok-scraper', baseUrl: 'http://127.0.0.1:1' }), /ne répond pas/);
});

// --- mur de bout en bout --------------------------------------------------------------------------------------------------------

let pool;
let server;
let base;
let dir;
let cover;
let coverServer;
let cookie = '';
let wall;
const asked = []; // adresses demandées au serveur de vignettes

const call = async (method, p, body, auth = true) => {
  const res = await fetch(base + p, { method, headers: { ...(body && method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}) }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const refresh = async () => {
  const r = await call('POST', '/api/admin/wall/refresh');
  if (r.status === 202) await wall.wallIdle();
  return r;
};

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wall-test-'));
  Object.assign(process.env, { STORAGE_DIR: path.join(dir, 'storage'), ADMIN_PASSWORD: 'pw-test', SESSION_SECRET: 'x'.repeat(32), WALL_ALLOW_HTTP: '1' });
  const jpg = path.join(dir, 'c.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:d=1', '-frames:v', '1', jpg]);
  cover = await fs.readFile(jpg);
  coverServer = http.createServer((req, res) => {
    asked.push(req.url);
    if (req.url.includes('9999')) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(cover);
  });
  await new Promise((r) => coverServer.listen(0, '127.0.0.1', r));
  coverBase = `http://127.0.0.1:${coverServer.address().port}`;
  process.env.WALL_COVER_HOSTS = '127.0.0.1';
  Object.assign(process.env, { APIFY_BASE_URL: apifyBase, WALL_MIN_GAP_MS: '0' });
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM wall_clips');
  await pool.query('DELETE FROM wall_hidden_authors');
  await pool.query("DELETE FROM settings WHERE key IN ('wall_last_run', 'wall_last_ok')");
  wall = await import('../src/wall/wall.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-test' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM wall_clips');
  await pool.query('DELETE FROM wall_hidden_authors');
  await pool.query("DELETE FROM settings WHERE key IN ('wall_last_run', 'wall_last_ok')");
  server.close();
  coverServer.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('mur vide avant la première actualisation ; admin protégée ; sans jeton l\'actualisation est refusée', { skip: !enabled }, async () => {
  const empty = await call('GET', '/api/wall', undefined, false);
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.body.clips, empty.body.total, empty.body.updated_at, empty.body.hashtag], [[], 0, null, 'lisnard2027']);
  assert.match(empty.headers.get('cache-control'), /max-age=60/);
  for (const [m, p] of [['GET', '/api/admin/wall'], ['POST', '/api/admin/wall/refresh'], ['PATCH', '/api/admin/wall/clips/1234567'], ['PUT', '/api/admin/wall/authors/x']]) assert.equal((await call(m, p, {}, false)).status, 401, `${m} ${p}`);
  delete process.env.APIFY_TOKEN;
  const r = await call('POST', '/api/admin/wall/refresh');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /APIFY_TOKEN manquant/);
  const o = (await call('GET', '/api/admin/wall')).body;
  assert.deepEqual([o.config.has_token, o.config.enabled, o.counts.total], [false, true, 0]);
  process.env.APIFY_TOKEN = 'tok';
});

test('actualisation : résultats d\'Apify enregistrés, filtrés, classés ; vignettes copiées ; coût et statut gardés', { skip: !enabled }, async () => {
  datasetItems = [
    item('7000000000000000001', { views: 100_000, likes: 3_000, comments: 40, author: 'alice', date: iso(2) }), // score 100000 + 30000 + 2000 = 132000
    item('7000000000000000002', { views: 20_000, likes: 9_000, comments: 400, author: 'bob', date: iso(10) }), // 20000 + 90000 + 20000 = 130000
    item('7000000000000000003', { views: 500_000, likes: 1_000, comments: 5, author: 'carla', date: iso(40) }), // 500000 + 10000 + 250 = 510250
    item('7000000000000000004', { views: 1_000, likes: 10, comments: 1, author: 'dave', date: iso(1) }), // 1150
    item('7000000000000000005', { views: 9_999_999, ad: true, author: 'pub' }), // publicité : écartée
    item('7000000000000000006', { views: 777, hashtags: [{ name: 'autre' }], text: 'sans le hashtag', author: 'hors' }), // autre hashtag : écarté
    { error: 'No videos found' }, // élément d'erreur : écarté
    item('7000000000000000007', { views: 50, author: 'eve', cover: 'https://evil.example.com/x.jpg' }), // vignette hors TikTok : jamais appelée
    item('7000000000000009999', { views: 60, author: 'fred' }), // vignette introuvable : carte sans image
  ];
  calls.length = 0;
  polls = 0;
  asked.length = 0;
  const r = await refresh();
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const last = (await call('GET', '/api/admin/wall')).body;
  assert.equal(last.last_run.status, 'ok', JSON.stringify(last.last_run));
  assert.deepEqual([last.last_run.received, last.last_run.kept, last.last_run.added, last.last_run.skipped, last.last_run.cost_usd], [9, 6, 6, { ad: 1, hashtag: 1, error: 1 }, 0.17]);
  assert.deepEqual([last.counts.total, last.counts.covers], [6, 4]);
  assert.ok(last.last_run.sample_keys.includes('playCount') && last.last_run.sample_keys.includes('authorMeta'));
  // ce qui est envoyé à l'acteur
  const start = calls.find((c) => c.method === 'POST');
  assert.deepEqual([start.body.hashtags, start.body.resultsPerPage, start.body.shouldDownloadVideos], [['lisnard2027'], 100, false]);
  assert.ok(!asked.some((u) => u.includes('evil')));

  // classement par défaut : score = vues + 10 × j'aime + 50 × commentaires
  const top = (await call('GET', '/api/wall', undefined, false)).body;
  // eve et fred ont les compteurs par défaut de l'aide `item` : 100 j'aime et 10 commentaires
  assert.deepEqual(top.clips.map((c) => [c.id.slice(-1), c.score, c.rank]), [['3', 510250, 1], ['1', 132000, 2], ['2', 130000, 3], ['9', 1560, 4], ['7', 1550, 5], ['4', 1150, 6]]);
  assert.equal(top.total, 6);
  assert.ok(top.updated_at);
  assert.deepEqual(top.weights, { views: 1, likes: 10, comments: 50 });
  const c1 = top.clips.find((c) => c.id.endsWith('1'));
  assert.deepEqual([c1.author, c1.nickname, c1.views, c1.likes, c1.comments, c1.url, c1.duration_s], ['alice', 'Fan 7000000000000000001', 100_000, 3_000, 40, 'https://www.tiktok.com/@alice/video/7000000000000000001', 31]);
  assert.match(c1.cover, /^\/api\/wall\/cover\/7000000000000000001$/);
  assert.equal(top.clips.find((c) => c.id.endsWith('9999')).cover, null);
  assert.equal(top.clips.find((c) => c.id.endsWith('7')).cover, null);

  // autres classements et périodes
  const ids = async (q) => (await call('GET', `/api/wall?${q}`, undefined, false)).body.clips.map((c) => c.id.slice(-1));
  assert.deepEqual((await ids('sort=views')).slice(0, 4), ['3', '1', '2', '4']);
  assert.deepEqual((await ids('sort=likes')).slice(0, 3), ['2', '1', '3']);
  assert.deepEqual((await ids('sort=comments')).slice(0, 2), ['2', '1']);
  assert.equal((await call('GET', '/api/wall?sort=recent', undefined, false)).status, 400); // plus de classement « récents »
  assert.ok((await call('GET', '/api/wall?sort=views', undefined, false)).body.clips.every((c, i) => c.rank === i + 1));
  assert.deepEqual((await ids('period=7')).sort(), ['1', '4', '7', '9']); // moins de 7 jours : ni le clip de 10 jours (2) ni celui de 40 jours (3)
  const p30 = await ids('period=30');
  assert.ok(p30.includes('2') && !p30.includes('3'));
  // pages
  const page2 = (await call('GET', '/api/wall?limit=2&offset=2', undefined, false)).body;
  assert.deepEqual([page2.clips.map((c) => c.id.slice(-1)), page2.clips.map((c) => c.rank), page2.total], [['2', '9'], [3, 4], 6]);
  assert.equal((await call('GET', '/api/wall?sort=n-importe-quoi', undefined, false)).status, 400);
  assert.equal((await call('GET', '/api/wall?period=12', undefined, false)).status, 400);

  // vignettes : JPEG de 360 px de large, servies avec un cache
  const cv = await fetch(`${base}/api/wall/cover/7000000000000000001`);
  assert.equal(cv.status, 200);
  assert.equal(cv.headers.get('content-type'), 'image/jpeg');
  assert.match(cv.headers.get('cache-control'), /max-age=86400/);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-'], { input: Buffer.from(await cv.arrayBuffer()) }).toString());
  assert.equal(info.streams[0].width, 360);
  assert.equal((await fetch(`${base}/api/wall/cover/7000000000000009999`)).status, 404);
  assert.equal((await fetch(`${base}/api/wall/cover/../../etc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/api/wall/cover/abc`)).status, 404);
});

test('modération : clip masqué ou auteur masqué disparaît du mur, et le reste après une actualisation', { skip: !enabled }, async () => {
  const ids = async () => (await call('GET', '/api/wall?limit=60', undefined, false)).body.clips.map((c) => c.id.slice(-1));
  assert.ok((await ids()).includes('3'));
  assert.equal((await call('PATCH', '/api/admin/wall/clips/7000000000000000003', { hidden: true })).status, 200);
  assert.equal((await call('PATCH', '/api/admin/wall/clips/1111111111', { hidden: true })).status, 404);
  assert.ok(!(await ids()).includes('3'));
  assert.equal((await call('PUT', '/api/admin/wall/authors/@Alice', { hidden: true })).status, 200); // insensible à la casse et au @
  assert.ok(!(await ids()).includes('1'));
  assert.equal((await call('PUT', '/api/admin/wall/authors/../x', { hidden: true })).status, 404);
  assert.equal((await call('PUT', '/api/admin/wall/authors/a b', { hidden: true })).status, 400);
  const o = (await call('GET', '/api/admin/wall')).body;
  assert.deepEqual(o.hidden_authors, ['alice']);
  assert.ok(o.clips.find((c) => c.id.endsWith('3')).hidden && o.clips.find((c) => c.id.endsWith('1')).author_hidden);
  assert.equal(o.counts.hidden, 1);

  // nouvelle actualisation : compteurs mis à jour, rien de nouveau, et les masquages restent
  datasetItems[1] = item('7000000000000000002', { views: 40_000, likes: 9_500, comments: 450, author: 'bob', date: iso(10) });
  datasetItems.push(item('7000000000000000008', { views: 5, author: 'gina' }));
  polls = 0;
  const r = await refresh();
  assert.equal(r.status, 202);
  const run = (await call('GET', '/api/admin/wall')).body.last_run;
  assert.deepEqual([run.status, run.added], ['ok', 1]);
  const after = (await call('GET', '/api/wall?limit=60', undefined, false)).body.clips;
  assert.ok(!after.some((c) => c.id.endsWith('3') || c.id.endsWith('1')));
  assert.equal(after.find((c) => c.id.endsWith('2')).views, 40_000);
  assert.ok(after.some((c) => c.id.endsWith('8')));
  // démasquer
  await call('PATCH', '/api/admin/wall/clips/7000000000000000003', { hidden: false });
  await call('PUT', '/api/admin/wall/authors/alice', { hidden: false });
  assert.ok((await ids()).includes('3') && (await ids()).includes('1'));
});

test('actualisation : une seule à la fois, pas trop rapprochées, échec d\'Apify expliqué sans toucher au mur', { skip: !enabled }, async () => {
  process.env.WALL_MIN_GAP_MS = '120000';
  const tooSoon = await call('POST', '/api/admin/wall/refresh');
  assert.equal(tooSoon.status, 409);
  assert.match(tooSoon.body.error, /récente/);
  process.env.WALL_MIN_GAP_MS = '0';
  const before = (await call('GET', '/api/wall?limit=60', undefined, false)).body.total;
  // exécution Apify en échec : le mur reste tel quel, l'admin voit l'erreur
  failRun = 'FAILED';
  polls = 5;
  const bad = await call('POST', '/api/admin/wall/refresh');
  assert.equal(bad.status, 202);
  await wall.wallIdle();
  failRun = null;
  const o = (await call('GET', '/api/admin/wall')).body;
  assert.equal(o.last_run.status, 'failed');
  assert.match(o.last_run.error, /a échoué \(FAILED/);
  assert.equal((await call('GET', '/api/wall?limit=60', undefined, false)).body.total, before);
  // jeton refusé : message précis
  process.env.APIFY_TOKEN = 'faux';
  await call('POST', '/api/admin/wall/refresh');
  await wall.wallIdle();
  assert.match((await call('GET', '/api/admin/wall')).body.last_run.error, /Jeton Apify refusé/);
  process.env.APIFY_TOKEN = 'tok';
  // deux demandes en même temps : la seconde est refusée
  polls = 0;
  const [a, b] = await Promise.all([call('POST', '/api/admin/wall/refresh'), call('POST', '/api/admin/wall/refresh')]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  await wall.wallIdle();
  polls = 0;
  const both = await Promise.all([wall.startWallRefresh(), wall.startWallRefresh()]);
  assert.deepEqual(both.map((r) => r.started), [true, false]);
  await wall.wallIdle();
});

test('classement : 13 clips au plus, les meilleurs d\'après le score ; les onglets réordonnent ces 13 ; la période choisit les 13 de la période', { skip: !enabled }, async () => {
  await pool.query('DELETE FROM wall_clips');
  // 30 clips : le n° i a i × 1 000 vues (score croissant avec i) ; les plus récents sont les moins bons
  for (let i = 1; i <= 30; i++) {
    await pool.query(
      `INSERT INTO wall_clips (id, url, author, text, hashtags, created_at, views, likes, comments, has_cover) VALUES ($1, $2, $3, '#lisnard2027', '["lisnard2027"]', now() - ($4 || ' days')::interval, $5, 0, 0, FALSE)`,
      [String(8000000000000000000n + BigInt(i)), `https://www.tiktok.com/@u${i}/video/${8000000000000000000n + BigInt(i)}`, `u${i}`, String(31 - i), i * 1000],
    );
  }
  const get = async (q = '') => (await call('GET', `/api/wall?${q}`, undefined, false)).body;
  const n = (c) => Number(BigInt(c.id) - 8000000000000000000n);
  const top = await get('limit=60');
  assert.equal(top.total, 13);
  assert.equal(top.max, 13);
  assert.equal(top.clips.length, 13);
  assert.deepEqual(top.clips.map(n), Array.from({ length: 13 }, (_, i) => 30 - i)); // du 30 au 18 : les 17 moins bons n'apparaissent pas
  assert.deepEqual(top.clips.map((c) => c.rank), Array.from({ length: 13 }, (_, i) => i + 1));
  // pages : la dernière est tronquée à 13, pas de 14e clip
  assert.equal((await get('limit=10&offset=10')).clips.length, 3);
  assert.equal((await get('limit=10&offset=13')).clips.length, 0);
  // un autre tri réordonne les mêmes 13 clips, sans en ajouter
  const byViews = (await get('sort=views&limit=60')).clips.map(n);
  assert.deepEqual([...byViews].sort((a, b) => a - b), Array.from({ length: 13 }, (_, i) => 18 + i));
  // période : les 13 meilleurs des 7 derniers jours seulement (les clips 25 à 30 ont moins de 7 jours : 6 clips)
  const week = await get('period=7&limit=60');
  assert.deepEqual([week.total, week.clips.map(n)], [6, [30, 29, 28, 27, 26, 25]]); // le clip 24 a exactement 7 jours : trop vieux
  // réglage : un mur plus petit
  process.env.WALL_MAX = '5';
  assert.deepEqual((await get('limit=60')).clips.map(n), [30, 29, 28, 27, 26]);
  delete process.env.WALL_MAX;
});

test('mur : classement ou période inconnus refusés, même hérités de l\'objet', { skip: !enabled }, async () => {
  for (const q of ['sort=toString', 'period=constructor', 'sort=__proto__']) {
    assert.equal((await fetch(`${base}/api/wall?${q}`)).status, 400, q);
  }
});

// --- vignettes délavées (fondu blanc au début de la vidéo) ---------------------------------------------------------------------------

/** Image de test : `testsrc2` dont les trois canaux sont ramenés dans une plage (expression sur `val`), comme un voile blanc. */
const makeImage = (file, lut) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:d=1', '-frames:v', '1', '-vf', lut ? `lutrgb=r=${lut}:g=${lut}:b=${lut}` : 'null', '-q:v', '3', file]);
/** 10e et 90e centiles de luminance d'une image. */
const lumaSpread = (file) => {
  const out = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']).toString();
  const n = (k) => Number(new RegExp(`signalstats\\.${k}=([\\d.]+)`).exec(out)[1]);
  return { low: n('YLOW'), high: n('YHIGH') };
};

test('vignettes : seules les images délavées (sans vrai noir, sans contraste) sont reconnues', { skip: !hasFfmpeg }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wall-washed-'));
  try {
    const f = (name) => path.join(tmp, name);
    makeImage(f('normale.jpg'), null);
    makeImage(f('voilee.jpg'), '200+val*0.2'); // tons entre 200 et 251 : le fondu blanc
    makeImage(f('nuit.jpg'), 'val*0.2'); // sombre mais contrastée dans sa plage : pas un voile blanc
    makeImage(f('claire.jpg'), '160+val*0.42'); // fond blanc d'une infographie : contraste suffisant
    assert.equal(await washedOut(f('normale.jpg')), false);
    assert.equal(await washedOut(f('voilee.jpg')), true);
    assert.equal(await washedOut(f('nuit.jpg')), false);
    assert.equal(await washedOut(f('claire.jpg')), false);
    assert.equal(await washedOut(f('absente.jpg')), false); // jamais d'erreur
    await fs.writeFile(f('texte.jpg'), 'pas une image');
    assert.equal(await washedOut(f('texte.jpg')), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('vignettes : celles déjà enregistrées et délavées retrouvent leur contraste, les autres ne bougent pas', { skip: !hasFfmpeg }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wall-washed-'));
  const saved = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = tmp;
  try {
    const dirCovers = path.join(tmp, 'wall', 'covers');
    await fs.mkdir(dirCovers, { recursive: true });
    makeImage(path.join(dirCovers, '7000000000000000301.jpg'), '200+val*0.2');
    makeImage(path.join(dirCovers, '7000000000000000302.jpg'), null);
    const before = await fs.readFile(path.join(dirCovers, '7000000000000000302.jpg'));
    await fs.writeFile(path.join(dirCovers, 'notes.txt'), 'autre fichier');
    const wash = lumaSpread(path.join(dirCovers, '7000000000000000301.jpg'));
    assert.ok(wash.low >= 190 && wash.high - wash.low < 60, JSON.stringify(wash));
    assert.equal(await enhanceStoredCovers(), 1);
    const after = lumaSpread(path.join(dirCovers, '7000000000000000301.jpg'));
    assert.ok(after.low < 80 && after.high - after.low > 100, `contraste retrouvé : ${JSON.stringify(after)}`);
    assert.equal(await washedOut(path.join(dirCovers, '7000000000000000301.jpg')), false);
    assert.deepEqual(await fs.readFile(path.join(dirCovers, '7000000000000000302.jpg')), before); // fichier intact
    assert.equal(await enhanceStoredCovers(), 0); // rien à refaire : pas de recompression à chaque passage
    assert.equal(await enhanceStoredCovers(), 0);
    assert.deepEqual((await fs.readdir(dirCovers)).sort(), ['7000000000000000301.jpg', '7000000000000000302.jpg', 'notes.txt']); // aucun fichier temporaire
  } finally {
    process.env.STORAGE_DIR = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('vignettes : une vignette délavée téléchargée est corrigée dès son enregistrement', { skip: !enabled }, async () => {
  const original = cover;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wall-washed-'));
  try {
    const faded = path.join(tmp, 'v.jpg');
    makeImage(faded, '200+val*0.2');
    cover = await fs.readFile(faded);
    const id = '7000000000000000401';
    assert.equal(await wall.saveCover({ id, cover_url: `${coverBase}/cover/${id}.jpg` }), true);
    const stored = lumaSpread(wall.coverPath(id));
    assert.ok(stored.low < 80 && stored.high - stored.low > 100, JSON.stringify(stored));
    cover = original; // une vignette normale n'est pas retouchée
    const normal = '7000000000000000402';
    await wall.saveCover({ id: normal, cover_url: `${coverBase}/cover/${normal}.jpg` });
    assert.equal(await washedOut(wall.coverPath(normal)), false);
  } finally {
    cover = original;
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(wall.coverPath('7000000000000000401'), { force: true });
    await fs.rm(wall.coverPath('7000000000000000402'), { force: true });
  }
});
