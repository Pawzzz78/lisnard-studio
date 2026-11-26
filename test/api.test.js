// Test d'intégration : nécessite une base Postgres (DATABASE_URL), sinon ignoré.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const enabled = Boolean(process.env.DATABASE_URL);
const YT = 'TESTtest_01';

let server;
let base;
let cookie = '';
let pool;

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  if (!enabled) return;
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  server.close();
  await pool.end();
});

test('admin protégée, connexion, ajout, recherche, correction', { skip: !enabled }, async () => {
  assert.equal((await call('GET', '/api/admin/videos')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'pw-test' })).status, 200);

  const bad = await call('POST', '/api/admin/videos', { input: 'pas une url', mode: 'empty' });
  assert.equal(bad.status, 400);

  // Une requête venant d'un autre site est refusée même avec le cookie.
  const csrf = await call('POST', '/api/admin/videos', { input: YT, mode: 'empty' }, { Origin: 'https://evil.example' });
  assert.equal(csrf.status, 403);

  const created = await call('POST', '/api/admin/videos', {
    input: `https://youtu.be/${YT}`,
    mode: 'paste',
    title: 'Vidéo de test',
    published_at: '2025-01-02',
    transcript: '[00:01] nous devons simplifier\n[00:05] la vie des entrepreneurs français',
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await call('POST', '/api/admin/videos', { input: YT, mode: 'empty' })).status, 409);

  const stored = async () => (await pool.query('SELECT norm_text, published_at FROM videos WHERE id = $1', [id])).rows[0];
  assert.equal((await stored()).published_at, '2025-01-02');
  assert.match((await stored()).norm_text, /nous devons simplifier la vie des entrepreneurs francais/);

  // Correction manuelle : l'ancienne formulation disparaît, la nouvelle apparaît.
  const saved = await call('PUT', `/api/admin/videos/${id}/segments`, {
    segments: [
      { start_ms: 1000, text: 'nous devons alléger' },
      { start_ms: 5000, text: 'la vie des entrepreneurs français' },
    ],
  });
  assert.equal(saved.status, 200);
  assert.doesNotMatch((await stored()).norm_text, /nous devons simplifier/);
  assert.match((await stored()).norm_text, /nous devons alleger la vie/);

  const detail = await call('GET', `/api/admin/videos/${id}`);
  assert.equal(detail.body.video.edited, true);
  assert.equal(detail.body.segments.length, 2);

  assert.equal((await call('DELETE', `/api/admin/videos/${id}`)).status, 200);
  assert.equal((await call('GET', `/api/admin/videos/${id}`)).status, 404);
});

test('transcription envoyée par un script (Whisper) : acceptée sans écraser l\'existant', { skip: !enabled }, async () => {
  const YT2 = 'TESTtest_02';
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT2]);
  try {
    assert.equal((await call('POST', '/api/admin/login', { password: 'pw-test' })).status, 200);
    const created = await call('POST', '/api/admin/videos', { input: YT2, mode: 'empty', title: 'Sans sous-titres' });
    const id = created.body.id;
    // vidéo en échec dans la synchro (pas de sous-titres)
    await pool.query(`UPDATE videos SET sync_status = 'failed', sync_error = 'Pas de sous-titres' WHERE id = $1`, [id]);

    const segs = [
      { start_ms: 0, duration_ms: 4000, text: 'bonjour à tous' },
      { start_ms: 4000, duration_ms: 3000, text: 'parlons de la réémigration' },
      { start_ms: 7000, text: '   ' },
    ];
    for (const bad of [{}, { segments: [] }, { segments: [{ text: 'x' }] }, { segments: segs, source: 'inconnue' }, { segments: segs, lang: 'français !' }]) {
      assert.equal((await call('POST', `/api/admin/videos/${id}/transcript`, bad)).status, 400, JSON.stringify(bad).slice(0, 50));
    }
    const ok = await call('POST', `/api/admin/videos/${id}/transcript`, { segments: segs, source: 'whisper', lang: 'fr' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.segment_count, 2); // le segment vide est écarté

    const { rows } = await pool.query('SELECT source, edited, lang, sync_status, sync_error, norm_text FROM videos WHERE id = $1', [id]);
    assert.deepEqual([rows[0].source, rows[0].edited, rows[0].lang, rows[0].sync_status, rows[0].sync_error], ['whisper', false, 'fr', 'done', null]);
    assert.match(rows[0].norm_text, /parlons de la reemigration/);

    // pas d'écrasement par erreur (corrections manuelles) ; seulement avec overwrite: true
    assert.equal((await call('POST', `/api/admin/videos/${id}/transcript`, { segments: segs })).status, 409);
    assert.equal((await call('POST', `/api/admin/videos/${id}/transcript`, { segments: [{ start_ms: 0, text: 'autre' }], overwrite: true })).status, 200);
    assert.equal((await call('GET', `/api/admin/videos/${id}`)).body.segments.length, 1);

    // protégé par la session
    cookie = '';
    assert.equal((await call('POST', `/api/admin/videos/${id}/transcript`, { segments: segs })).status, 401);
  } finally {
    await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT2]);
    await pool.query('DELETE FROM excluded_videos WHERE youtube_id = $1', [YT2]);
  }
});

test('anciennes routes publiques (recherche, tendances, résumés) retirées', { skip: !enabled }, async () => {
  for (const p of ['/api/search?q=abc', '/api/latest', '/api/videos', '/api/summary/TESTtest_01', '/api/trends?q=abc', '/api/trends/words', '/api/stats']) {
    assert.equal((await call('GET', p)).status, 404, p);
  }
  assert.equal((await call('GET', '/api/health')).status, 200);
});

test('mentions légales : page présente avec le contact, aucun lien vers l\'admin sur les pages publiques', { skip: !enabled }, async () => {
  const legal = await (await fetch(base + '/mentions-legales/')).text();
  assert.match(legal, /forecast\.lab\.0@gmail\.com/);
  assert.match(legal, /Railway/);
  for (const path of ['/', '/mentions-legales/']) {
    const html = path === '/mentions-legales/' ? legal : await (await fetch(base + path)).text();
    assert.doesNotMatch(html, /href="\/admin/, `${path} ne doit pas lier vers l'admin`);
    assert.match(html, /href="\/mentions-legales\/"/);
  }
  assert.equal((await call('GET', '/api/legal')).status, 404);
});

test('admin : horodatages hors limites bornés, ajout simultané d\'une même vidéo refusé proprement', { skip: !enabled }, async () => {
  const YT3 = 'TESTtest_03';
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT3]);
  try {
    assert.equal((await call('POST', '/api/admin/login', { password: 'pw-test' })).status, 200);
    const both = await Promise.all([1, 2].map(() => call('POST', '/api/admin/videos', { input: YT3, mode: 'empty', title: 'Doublon' })));
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    const id = both.find((r) => r.status === 201).body.id;
    const res = await fetch(`${base}/api/admin/videos/${id}/segments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{"segments":[{"start_ms":1e400,"text":"très loin"},{"start_ms":5000000000,"text":"encore plus"}]}',
    });
    assert.equal(res.status, 200);
    const { rows } = await pool.query('SELECT start_ms FROM segments WHERE video_id = $1 ORDER BY position', [id]);
    assert.ok(rows.every((r) => r.start_ms >= 0 && r.start_ms <= 2147483647), JSON.stringify(rows));
  } finally {
    await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT3]);
    await pool.query('DELETE FROM excluded_videos WHERE youtube_id = $1', [YT3]);
  }
});

test('en-têtes de sécurité : CSP stricte sur les pages, HSTS seulement en HTTPS', { skip: !enabled }, async () => {
  const plain = await fetch(base + '/');
  const csp = plain.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /frame-src https:\/\/www\.youtube\.com https:\/\/www\.youtube-nocookie\.com https:\/\/www\.tiktok\.com/);
  assert.match(csp, /img-src [^;]*https:\/\/i\.ytimg\.com/);
  assert.doesNotMatch(csp, /script-src [^;]*unsafe/);
  assert.equal(plain.headers.get('x-frame-options'), 'DENY');
  assert.equal(plain.headers.get('strict-transport-security'), null);
  const secure = await fetch(base + '/', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(secure.headers.get('strict-transport-security'), 'max-age=15552000');
});

test('site réduit au studio : la racine est le studio, les anciennes pages renvoient vers lui', { skip: !enabled }, async () => {
  const home = await (await fetch(base + '/')).text();
  assert.match(home, /<title>Studio Lisnard/);
  assert.match(home, /\/js\/studio\.js/);
  assert.doesNotMatch(home, /Vérifier une phrase|Tendances|Toutes les vidéos|Lisnard Facts/);
  const go = async (path) => {
    const r = await fetch(base + path, { redirect: 'manual' });
    return [r.status, r.headers.get('location')];
  };
  assert.deepEqual(await go('/videos/'), [301, '/']);
  assert.deepEqual(await go('/videos'), [301, '/']);
  assert.deepEqual(await go('/tendances/'), [301, '/']);
  assert.deepEqual(await go('/studio/'), [301, '/']);
  assert.deepEqual(await go('/studio/?v=abcDEF12345'), [301, '/?v=abcDEF12345']); // anciens liens vers une interview
  assert.equal((await fetch(base + '/js/videos.js')).status, 404);
  // l'indexation et le studio restent en place
  assert.equal((await fetch(base + '/api/studio/assets')).status, 200);
  assert.equal((await fetch(base + '/mentions-legales/')).status, 200);
  const legal = await (await fetch(base + '/mentions-legales/')).text();
  assert.match(legal, /Studio Lisnard/);
  assert.doesNotMatch(legal, /Lisnard Facts|vérification des propos/);
});

test('admin : corps lus après la session, cookie abîmé et Origin null refusés proprement', { skip: !enabled }, async () => {
  const raw = (path, body, headers = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await raw('/api/admin/login', '{pas du json')).status, 400);
  assert.equal((await raw('/api/admin/login', JSON.stringify({ password: 'x'.repeat(2000) }))).status, 413);
  // sans session, le corps n'est même pas lu : 401 et non 500
  assert.equal((await raw('/api/admin/videos', '{pas du json')).status, 401);
  const broken = { Cookie: 'adm=%E0%A4%A' };
  assert.equal((await fetch(base + '/api/admin/videos', { headers: broken })).status, 401);
  assert.deepEqual(await (await fetch(base + '/api/admin/me', { headers: broken })).json(), { authenticated: false });
  assert.equal((await call('POST', '/api/admin/login', { password: 'pw-test' })).status, 200);
  assert.equal((await call('POST', '/api/admin/videos', { input: 'x', mode: 'empty' }, { Origin: 'null' })).status, 403);
  assert.equal((await raw('/api/admin/videos', '{pas du json', { Cookie: cookie })).status, 400);
});

test('session glissante : le cookie est renouvelé quand il reste moins de la moitié de la durée', { skip: !enabled }, async () => {
  const { createHmac } = await import('node:crypto');
  const mk = (ms) => {
    const exp = String(Date.now() + ms);
    return `adm=${exp}.${createHmac('sha256', process.env.SESSION_SECRET).update(exp).digest('base64url')}`;
  };
  const get = (c) => fetch(`${base}/api/admin/videos`, { headers: { Cookie: c } });
  const fresh = await get(mk(11 * 3600 * 1000));
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('set-cookie'), null);
  const old = await get(mk(3 * 3600 * 1000));
  assert.equal(old.status, 200);
  assert.match(old.headers.get('set-cookie') ?? '', /^adm=\d+\./);
});
