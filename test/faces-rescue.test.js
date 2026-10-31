// Deuxième chance pour les visages que la première détection n'a pas vus : choix des images à reprendre (pur), puis de bout en bout
// sur une vidéo où un visage devient trop petit pour la première passe (nécessite Postgres via DATABASE_URL et ffmpeg, sinon ignoré).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { RESCUE, planRescue, runs, shotRanges } from '../src/studio/faces-rescue.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;
const face = [0.5, 0.4, 0.1, 0.15, 0.9];
const none = [];

test('plans : découpés aux changements de plan, en indices d\'images', () => {
  assert.deepEqual(shotRanges(100, 5, [8]), [{ i0: 0, i1: 39 }, { i0: 40, i1: 99 }]);
  assert.deepEqual(shotRanges(100, 5, []), [{ i0: 0, i1: 99 }]);
  assert.deepEqual(shotRanges(100, 5, [0, 8, 8, 400]), [{ i0: 0, i1: 39 }, { i0: 40, i1: 99 }]); // coupes hors vidéo ou en double ignorées
  assert.deepEqual(shotRanges(0, 5, [3]), []);
});

test('reprise : les images sans visage dans un plan où un visage est vu, et des sondes dans les plans longs sans visage', () => {
  // plan 1 (images 0 à 39) : un visage une image sur deux ; plan 2 (40 à 99) : aucun visage, 12 s
  const frames = Array.from({ length: 100 }, (_, i) => (i < 40 && i % 2 === 0 ? [face] : none));
  const plan = planRescue(frames, 5, [8]);
  assert.equal(plan.lost.length, 20); // les 20 images sans visage du plan 1
  assert.ok(plan.lost.every((i) => i < 40 && i % 2 === 1));
  assert.equal(plan.probes.length, 1);
  assert.deepEqual(plan.probes[0].shot, { i0: 40, i1: 99 });
  // une sonde toutes les 2 s (10 images à 5 images par seconde), jamais hors du plan
  assert.ok(plan.probes[0].idx.every((i) => i >= 40 && i <= 99));
  assert.ok(plan.probes[0].idx.slice(1).every((i, k) => i - plan.probes[0].idx[k] === 10));
  assert.equal(plan.limit, 60); // 60 % des images au plus
  // plan court sans visage : pas de sonde ; peu d'images avec visage : pas de reprise des autres
  const short = Array.from({ length: 100 }, (_, i) => (i === 0 || i === 1 ? [face] : none));
  const p2 = planRescue(short, 5, [], { budget: 1 });
  assert.equal(p2.lost.length, 0);
  assert.equal(planRescue(Array.from({ length: 12 }, () => none), 5, []).probes.length, 0); // 2,4 s : trop court
});

test('reprise : le budget borne le nombre d\'images reprises', () => {
  const frames = Array.from({ length: 1000 }, (_, i) => (i % 5 === 0 ? [face] : none)); // 800 images sans visage
  const plan = planRescue(frames, 5, [], { budget: 0.1 });
  assert.equal(plan.lost.length, 100);
  assert.equal(plan.limit, 100);
});

test('reprise : images consécutives regroupées par appel de ffmpeg', () => {
  assert.deepEqual(runs([5, 1, 2, 3, 3, 10, 11]), [{ i0: 1, n: 3 }, { i0: 5, n: 1 }, { i0: 10, n: 2 }]);
  const long = runs(Array.from({ length: 100 }, (_, i) => i), RESCUE.batch);
  assert.deepEqual(long.map((r) => r.n), [40, 40, 20]);
  assert.deepEqual(runs([]), []);
});

// --- de bout en bout -----------------------------------------------------------------------------

const YT = 'RESCtest_01';
let pool;
let server;
let base;
let dir;
let cookie = '';
let videoId;

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie()[0];
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
};
const waitFor = async (fn, ms = 120_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 250));
  }
};
const analyze = async () => {
  assert.equal((await call('POST', `/api/admin/videos/${videoId}/faces`)).status, 200);
  await waitFor(async () => {
    const r = await call('GET', `/api/admin/videos/${videoId}/clips`);
    assert.notEqual(r.body.faces.status, 'failed', JSON.stringify(r.body.faces));
    return r.body.faces.status === 'ready';
  });
  const { rows } = await pool.query('SELECT content FROM video_faces WHERE video_id = $1', [videoId]);
  return rows[0].content;
};

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rescue-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  process.env.STUDIO_FACES_MAX_SIDE = '256'; // première passe volontairement grossière : un visage de 88 px y mesure 18 px
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  const faceJpg = new URL('./fixtures/face.jpg', import.meta.url).pathname;
  // un seul plan de 20 s : le visage mesure 220 px de large jusqu'à 10 s, puis ~88 px (trop petit pour la première passe)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:r=10:d=20', '-loop', '1', '-framerate', '10', '-i', faceJpg, '-loop', '1', '-framerate', '10', '-i', faceJpg,
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=20',
    '-filter_complex', "[1:v]scale=-2:240[big];[2:v]scale=-2:96[small];[0:v][big]overlay=x=520:y=200:enable='lt(t,10)':shortest=1[a];[a][small]overlay=x=600:y=270:enable='gte(t,10)':shortest=1,format=yuv420p[v]",
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-c:a', 'aac', '-t', '20', path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`)]);
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  const { rows } = await pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
     VALUES ($1, 'Interview de test de la deuxième passe', 'Chaîne', '2025-03-01', 'manual', 'fr', 20, $2, 1000, 20, 1280, 720, TRUE, now(), TRUE) RETURNING id`,
    [YT, `${YT}.mp4`],
  );
  videoId = rows[0].id;
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/api/admin/login', { password: 'pw-test' })).status, 200);
});
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('analyse : sans deuxième passe le petit visage est raté, avec elle il est retrouvé', { skip: !enabled }, async () => {
  const withFace = (content, t0, t1) => {
    const [a, b] = [Math.ceil(t0 * content.fps), Math.floor(t1 * content.fps)];
    return content.frames.slice(a, b).filter((f) => f.length).length / (b - a);
  };
  process.env.STUDIO_FACES_RESCUE = 'off';
  const plain = await analyze();
  assert.ok(withFace(plain, 1, 9) > 0.9, 'le grand visage est vu dès la première passe');
  assert.ok(withFace(plain, 11, 19) < 0.2, `le petit visage est raté sans deuxième passe (${withFace(plain, 11, 19)})`);
  assert.equal(plain.stats.rescued, 0);

  delete process.env.STUDIO_FACES_RESCUE;
  const better = await analyze();
  assert.ok(withFace(better, 11, 19) > 0.8, `le petit visage est retrouvé (${withFace(better, 11, 19)})`);
  assert.ok(better.stats.rescued > 0);
  assert.equal(better.quality, 2);
  assert.equal(better.maxSide, 256);
  // au bon endroit : le visage de 96 px de haut (88 px de large) est centré en x = (600 + 44) / 1280
  const f = better.frames[Math.round(15 * better.fps)][0];
  assert.ok(Math.abs(f[0] + f[2] / 2 - 644 / 1280) < 0.03, JSON.stringify(f));
  // l'admin le voit
  const st = (await call('GET', `/api/admin/videos/${videoId}/clips`)).body.faces;
  assert.deepEqual([st.status, st.outdated, st.summary.rescued > 0], ['ready', false, true]);
});

test('analyse ancienne (qualité 1) : « à refaire », puis refaite en une demande', { skip: !enabled }, async () => {
  await pool.query("UPDATE video_faces SET content = (content - 'quality' - 'maxSide') WHERE video_id = $1", [videoId]);
  const st = (await call('GET', `/api/admin/videos/${videoId}/clips`)).body.faces;
  assert.deepEqual([st.status, st.outdated, st.summary.max_side], ['ready', true, 384]);
  assert.equal((await fetch(`${base}/api/admin/faces/reanalyze-all`, { method: 'POST' })).status, 401); // sans session
  const r = await call('POST', '/api/admin/faces/reanalyze-all', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.queued, 1);
  await waitFor(async () => {
    const s = (await call('GET', `/api/admin/videos/${videoId}/clips`)).body.faces;
    return s.status === 'ready' && !s.outdated;
  });
  assert.equal((await call('POST', '/api/admin/faces/reanalyze-all', {})).body.queued, 0); // rien d'ancien
});
