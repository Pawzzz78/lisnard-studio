// Le mur #projetlisnard : lecture des éléments d'Apify (TikTok, Instagram), client Apify simulé, actualisation et page (Postgres requis)
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ApifyError, runActor } from '../src/veille/apify.js';
import { coverUrlAllowed, normalizeInstagram, normalizeItems, normalizeTiktok, refreshDue } from '../src/veille/veille.js';

const enabled = Boolean(process.env.DATABASE_URL);

const tt = (over = {}) => ({ id: '7400000000000000001', text: 'Mon clip #projetlisnard', createTimeISO: '2026-11-01T10:00:00.000Z', authorMeta: { name: 'jean.d', nickName: 'Jean D' }, playCount: 1200, diggCount: 80, commentCount: 4, webVideoUrl: 'https://www.tiktok.com/@jean.d/video/7400000000000000001?lang=fr', videoMeta: { coverUrl: 'https://p16-sign.tiktokcdn.com/a.jpeg' }, hashtags: [{ name: 'projetlisnard' }], ...over });
const ig = (over = {}) => ({ shortCode: 'DAbc123xyz', url: 'https://www.instagram.com/p/DAbc123xyz/', caption: 'Bravo #ProjetLisnard', ownerUsername: 'marie_l', ownerFullName: 'Marie L', timestamp: '2026-11-02T09:00:00.000Z', likesCount: 30, commentsCount: 2, videoViewCount: 500, displayUrl: 'https://scontent.cdninstagram.com/v/x.jpg', ...over });

test('TikTok : élément lu, adresse nettoyée ; publicité, sans hashtag et illisible écartés', () => {
  const p = normalizeTiktok(tt());
  assert.equal(p.key, 'tt_7400000000000000001');
  assert.equal(p.url, 'https://www.tiktok.com/@jean.d/video/7400000000000000001');
  assert.deepEqual([p.author, p.nickname, p.views, p.likes, p.comments], ['jean.d', 'Jean D', 1200, 80, 4]);
  assert.equal(normalizeTiktok(tt({ isAd: true })).skip, 'ad');
  assert.equal(normalizeTiktok(tt({ text: 'rien', hashtags: [] })).skip, 'hashtag');
  assert.equal(normalizeTiktok(tt({ id: 'x' })).skip, 'invalid');
});

test('Instagram : élément lu (hashtag dans la légende, casse ignorée), variantes de champs, illisible écarté', () => {
  const p = normalizeInstagram(ig());
  assert.equal(p.key, 'ig_DAbc123xyz');
  assert.deepEqual([p.platform, p.author, p.views, p.likes, p.created_at], ['instagram', 'marie_l', 500, 30, '2026-11-02T09:00:00.000Z']);
  assert.equal(normalizeInstagram(ig({ shortCode: undefined, url: 'https://www.instagram.com/reel/XyZ98765/' })).key, 'ig_XyZ98765');
  assert.equal(normalizeInstagram(ig({ caption: 'sans' })).skip, 'hashtag');
  assert.equal(normalizeInstagram(ig({ ownerUsername: 'pas valide !' })).skip, 'invalid');
  const { posts, skipped } = normalizeItems([ig(), ig(), ig({ caption: 'x' })], 'instagram');
  assert.equal(posts.length, 1);
  assert.deepEqual(skipped, { hashtag: 1 });
});

test('vignettes : seulement la plateforme ou Apify, en HTTPS', () => {
  assert.ok(coverUrlAllowed('https://p16-sign.tiktokcdn.com/a.jpeg', 'tiktok'));
  assert.ok(coverUrlAllowed('https://scontent-cdg4-1.cdninstagram.com/v/x.jpg', 'instagram'));
  assert.ok(!coverUrlAllowed('https://scontent.cdninstagram.com/v/x.jpg', 'tiktok'));
  assert.ok(!coverUrlAllowed('http://p16-sign.tiktokcdn.com/a.jpeg', 'tiktok'));
  assert.ok(!coverUrlAllowed('https://evil.example/x.jpg', 'instagram'));
});

test('actualisation planifiée : due si jamais faite, si trop vieille, ou une heure après un échec', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  assert.equal(refreshDue(null, 12, now), true);
  assert.equal(refreshDue({ status: 'ok', finished_at: '2026-11-06T06:00:00Z' }, 12, now), false);
  assert.equal(refreshDue({ status: 'ok', finished_at: '2026-11-05T23:00:00Z' }, 12, now), true);
  assert.equal(refreshDue({ status: 'failed', finished_at: '2026-11-06T10:30:00Z' }, 12, now), true);
});

/** Faux Apify : chaque acteur rend ses éléments ; `calls` garde les requêtes. */
function fakeApify(itemsByActor, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    const u = new URL(url);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const m = /\/v2\/acts\/([^/]+)\/runs$/.exec(u.pathname);
    if (m) {
      const actor = decodeURIComponent(m[1]).replace('~', '/');
      if (!itemsByActor[actor]) return json({ error: { message: 'Actor not found' } }, 404);
      return json({ data: { id: `run-${actor}`, status: 'SUCCEEDED', defaultDatasetId: `ds-${actor.replace('/', '_')}`, usageTotalUsd: 0.12 } });
    }
    const d = /\/v2\/datasets\/ds-([^/]+)\/items$/.exec(u.pathname);
    if (d) return json(Number(u.searchParams.get('offset')) > 0 ? [] : itemsByActor[d[1].replace('_', '/')]);
    return new Response('not found', { status: 404 });
  };
}

test('client Apify : lance, lit le jeu de résultats, jeton seulement dans l’en-tête ; erreur claire si l’acteur est refusé', async () => {
  const calls = [];
  const fetchImpl = fakeApify({ 'clockworks/tiktok-scraper': [tt()] }, calls);
  const { items, run } = await runActor({ token: 'SECRET42', actor: 'clockworks/tiktok-scraper', input: {}, fetchImpl });
  assert.equal(items.length, 1);
  assert.equal(run.usageTotalUsd, 0.12);
  assert.ok(calls.every((c) => c.auth === 'Bearer SECRET42' && !c.url.includes('SECRET42')));
  await assert.rejects(runActor({ token: 'tok', actor: 'nobody/none', input: {}, fetchImpl }), ApifyError);
});

let pool;
let V;
before(async () => {
  if (!enabled) return;
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query("DELETE FROM hashtag_posts WHERE author IN ('jean.d', 'marie_l', 'paul.p')");
  await pool.query('DELETE FROM hashtag_hidden_authors');
  await pool.query("DELETE FROM settings WHERE key IN ('veille_last_run', 'veille_last_ok')");
  V = await import('../src/veille/veille.js');
});

after(async () => {
  if (!enabled) return;
  await pool.query("DELETE FROM hashtag_posts WHERE author IN ('jean.d', 'marie_l', 'paul.p')");
  await pool.query('DELETE FROM hashtag_hidden_authors');
  await pool.query("DELETE FROM settings WHERE key IN ('veille_last_run', 'veille_last_ok')");
  await pool.end();
});

test('actualisation : TikTok et Instagram enregistrés, comptes et totaux, masquage ; une plateforme en échec n’efface pas l’autre', { skip: !enabled }, async () => {
  process.env.APIFY_TOKEN = 'tok-test';
  const second = tt({ id: '7400000000000000002', authorMeta: { name: 'paul.p' }, webVideoUrl: '', playCount: 50 });
  const fetchImpl = fakeApify({ 'clockworks/tiktok-scraper': [tt(), second, tt({ isAd: true, id: '7400000000000000003' })], 'apify/instagram-hashtag-scraper': [ig()] });
  assert.deepEqual(await V.startVeilleRefresh({ fetchImpl }), { started: true });
  await V.veilleIdle();
  const last = await V.lastRun();
  assert.equal(last.status, 'ok');
  assert.deepEqual([last.platforms.tiktok.kept, last.platforms.tiktok.skipped.ad, last.platforms.instagram.kept], [2, 1, 1]);

  let page = await V.listVeille();
  assert.equal(page.totals.posts, 3);
  assert.deepEqual([page.totals.tiktok, page.totals.instagram, page.totals.authors], [2, 1, 3]);
  assert.equal((await V.listVeille({ platform: 'instagram' })).posts[0].author, 'marie_l');
  assert.equal((await V.listVeille({ sort: 'views' })).posts[0].author, 'jean.d');
  assert.equal((await V.listVeille({ author: 'PAUL.P' })).total, 1);

  await V.setAuthorHidden('tiktok', 'paul.p', true);
  await V.setPostHidden('ig_DAbc123xyz', true);
  page = await V.listVeille();
  assert.deepEqual(page.posts.map((p) => p.author), ['jean.d']);

  // Instagram refused: TikTok counters still update, nothing is lost
  const partial = fakeApify({ 'clockworks/tiktok-scraper': [tt({ playCount: 9000 })] });
  await V.startVeilleRefresh({ fetchImpl: partial });
  await V.veilleIdle();
  const again = await V.lastRun();
  assert.equal(again.status, 'ok');
  assert.equal(again.platforms.instagram.status, 'failed');
  const { rows } = await pool.query("SELECT views, hidden FROM hashtag_posts WHERE key IN ('tt_7400000000000000001', 'ig_DAbc123xyz') ORDER BY key");
  assert.deepEqual(rows.map((r) => [Number(r.views), r.hidden]), [[500, true], [9000, false]]);
});
