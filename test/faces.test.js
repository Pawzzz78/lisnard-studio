// Cadrage automatique sur le visage, de bout en bout : détection (YuNet) dans une vidéo de test avec un vrai visage qui se
// déplace puis change de plan, analyse côté admin, trajectoire du cadre, rendu ffmpeg, et détection du visage dans le clip produit
// (nécessite Postgres via DATABASE_URL et ffmpeg, sinon ignorés).
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { loadYunet } from '../src/studio/yunet.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;
const YT = 'FACtest_001';
const DURATION = 30;
// visage de 220 px de large : centre x = 260 px (jusqu'à 6 s), glisse jusqu'à 760 px (à 16 s), puis changement de plan à 20 s : 990 px
const FACE_CENTER = (t) => (t < 20 ? 260 + 500 * Math.min(1, Math.max(0, (t - 6) / 10)) : 990) / 1280;

let pool;
let server;
let base;
let dir;
let videoId;
let cookie = '';
let net; // détecteur partagé par les tests de bout en bout

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  // Keep every cookie by name: the studio also sets the library owner cookie
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const jar = new Map(cookie ? cookie.split('; ').map((x) => [x.split('=')[0], x]) : []);
    jar.set(kv.split('=')[0], kv);
    cookie = [...jar.values()].join('; ');
  }
  return { status: res.status, body: await res.json().catch(() => null) };
};
const waitFor = async (fn, ms = 90_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 200));
  }
};
/** Visage détecté dans l'image de la vidéo `file` à l'instant t : centre horizontal (0–1) ou null. */
async function faceAt(file, t) {
  // asynchrone : le serveur du test tourne dans ce même processus et ne doit pas être bloqué
  const { stdout: rgb } = await promisify(execFile)('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=180:320,pad=192:320:0:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24, encoding: 'buffer' });
  const found = net.detect(new Uint8Array(rgb), 192, 320);
  if (!found.length) return null;
  const f = found[0];
  return (f.x + f.w / 2) / 180;
}

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'faces-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.STUDIO_RENDERS_PER_HOUR = '100';
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  const sample = path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`);
  const face = new URL('./fixtures/face.jpg', import.meta.url).pathname;
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:r=10:d=20', '-f', 'lavfi', '-i', 'color=c=0x705020:s=1280x720:r=10:d=10',
    '-loop', '1', '-framerate', '10', '-i', face, '-f', 'lavfi', '-i', `sine=frequency=300:duration=${DURATION}`,
    '-filter_complex', "[0:v][1:v]concat=n=2:v=1:a=0[bg];[2:v]scale=-2:240[f];[bg][f]overlay=x='if(lt(t,20),150+500*min(1,max(0,(t-6)/10)),880)':y=140:shortest=1,format=yuv420p[v]",
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-c:a', 'aac', '-t', String(DURATION), sample]);
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  const { rows } = await pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
     VALUES ($1, 'Interview de test du cadrage', 'Chaîne', '2025-03-01', 'manual', 'fr', $2::int, $3, 1000, $2::real, 1280, 720, TRUE, now(), TRUE) RETURNING id`,
    [YT, DURATION, `${YT}.mp4`],
  );
  videoId = rows[0].id;
  await db.withTransaction((c) =>
    db.replaceSegments(c, videoId, Array.from({ length: 30 }, (_, i) => ({ start_ms: i * 1000, duration_ms: 950, text: `Ligne numéro ${i} de la transcription de test.` }))),
  );
  net = loadYunet();
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

test('détecteur : trouve un vrai visage et pas de visage dans une image vide', { skip: !hasFfmpeg }, () => {
  const net = loadYunet();
  const w = 192;
  const h = 128;
  assert.deepEqual(net.detect(new Uint8Array(w * h * 3).fill(90), w, h), []);
  // le portrait de test, mis à l'échelle sur un fond uni
  const jpg = new URL('./fixtures/face.jpg', import.meta.url).pathname;
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', jpg, '-vf', 'scale=96:-2,pad=192:128:48:10:gray', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  const found = net.detect(new Uint8Array(rgb), w, h);
  assert.equal(found.length, 1);
  assert.ok(found[0].score > 0.8 && found[0].x > 40 && found[0].x + found[0].w < 150, JSON.stringify(found[0]));
});

test('analyse admin : visages et changement de plan détectés, résultat enregistré', { skip: !enabled }, async () => {
  assert.equal((await fetch(`${base}/api/admin/videos/${videoId}/faces`, { method: 'POST' })).status, 401); // sans session
  const before = await call('GET', `/api/admin/videos/${videoId}/clips`);
  assert.equal(before.body.faces.status, 'none');
  const started = await call('POST', `/api/admin/videos/${videoId}/faces`);
  assert.equal(started.status, 200);
  assert.ok(['queued', 'running'].includes(started.body.faces.status), JSON.stringify(started.body.faces));
  const done = await waitFor(async () => {
    const r = await call('GET', `/api/admin/videos/${videoId}/clips`);
    return r.body.faces.status === 'ready' || r.body.faces.status === 'failed' ? r.body.faces : null;
  });
  assert.equal(done.status, 'ready', JSON.stringify(done));
  assert.equal(done.summary.seconds, DURATION);
  assert.ok(done.summary.cuts >= 1);
  assert.ok(done.summary.share > 0.9 && Math.abs(done.summary.median_w - 0.085) < 0.02, JSON.stringify(done.summary)); // qualité de la détection
  const { rows } = await pool.query('SELECT content FROM video_faces WHERE video_id = $1', [videoId]);
  const { frames, cuts, fps, aspect } = rows[0].content;
  assert.deepEqual([fps, Math.round(aspect * 100) / 100], [5, 1.78]);
  assert.ok(frames.length >= DURATION * fps - 1 && frames.length <= DURATION * fps + 1, `${frames.length} images pour ${DURATION} s à ${fps} images par seconde`);
  assert.ok(cuts.some((c) => Math.abs(c - 20) < 0.6), `coupes ${cuts}`);
  for (const t of [1, 4, 10, 14, 19, 22, 28]) {
    assert.equal(frames[t * fps].length, 1, `t=${t}`);
    const [x, , w] = frames[t * fps][0];
    assert.ok(Math.abs(x + w / 2 - FACE_CENTER(t)) < 0.03, `t=${t} : visage en ${x + w / 2}, attendu ${FACE_CENTER(t)}`);
  }
  // la vidéo est proposée avec le cadrage automatique possible
  assert.equal((await call('GET', `/api/studio/videos/${YT}`)).body.faces.ready, true);
});

test('détection trop pauvre (visages rarement vus) : le studio annonce que le cadrage automatique est indisponible', { skip: !enabled }, async () => {
  const { rows } = await pool.query("SELECT content->'stats' AS stats FROM video_faces WHERE video_id = $1", [videoId]);
  try {
    await pool.query("UPDATE video_faces SET content = jsonb_set(content, '{stats}', '{\"share\":0.1,\"median_w\":0.03}') WHERE video_id = $1", [videoId]);
    const poor = (await call('GET', `/api/studio/videos/${YT}`)).body.faces;
    assert.deepEqual([poor.ready, poor.poor], [false, true]);
    assert.equal((await call('GET', `/api/admin/videos/${videoId}/clips`)).body.faces.summary.share, 0.1);
  } finally {
    await pool.query("UPDATE video_faces SET content = jsonb_set(content, '{stats}', $2::jsonb) WHERE video_id = $1", [videoId, JSON.stringify(rows[0].stats)]);
  }
  assert.equal((await call('GET', `/api/studio/videos/${YT}`)).body.faces.ready, true);
});

test('trajectoire : le cadre suit le visage, saute à la coupe, et reste le même pour l\'aperçu et le rendu', { skip: !enabled }, async () => {
  const body = { youtube_id: YT, extracts: [{ start_ms: 2000, end_ms: 28000 }] };
  const r = await call('POST', '/api/studio/framing', body);
  assert.equal(r.status, 200);
  const { segments, faces, coverage } = r.body;
  assert.equal(faces, 1);
  assert.ok(coverage > 0.9, String(coverage));
  const { cropXAtClip } = await import('../public/js/framing.js');
  const cw = 9 / 16 / (16 / 9);
  const toX = (c) => (c - cw / 2) / (1 - cw);
  // t du clip = t de la vidéo − 2 s
  assert.ok(Math.abs(cropXAtClip(segments, 1) - toX(FACE_CENTER(3))) < 0.02);
  assert.ok(Math.abs(cropXAtClip(segments, 18.5) - toX(FACE_CENTER(20.5))) < 0.06, `après la coupe : ${cropXAtClip(segments, 18.5)}`);
  const before = cropXAtClip(segments, 17.5);
  assert.ok(Math.abs(cropXAtClip(segments, 18.5) - before) > 0.2 || Math.abs(before - toX(FACE_CENTER(19))) < 0.1);
  // rien sans le mode plein écran ou sans analyse
  assert.deepEqual((await call('POST', '/api/studio/framing', { youtube_id: 'STUtest_999', extracts: body.extracts })).status, 404);
});

test('rendu : le visage reste au centre du clip, y compris après la coupe ; sans suivi il sort du cadre', { skip: !enabled }, async () => {
  const render = async (follow) => {
    const r = await call('POST', '/api/studio/render', {
      youtube_id: YT, extracts: [{ start_ms: 2000, end_ms: 28000 }], music: null, style: { preset: 'hormozi' },
      layout: { fit: 'crop', cropX: 0.5, quality: 'fast', follow: follow ? { on: true } : undefined },
    });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const job = await waitFor(async () => {
      const s = (await call('GET', `/api/studio/render/${r.body.id}`)).body;
      assert.notEqual(s.status, 'failed', s.error);
      return s.status === 'done' ? s : null;
    });
    const file = path.join(dir, `out-${follow ? 'follow' : 'fixed'}.mp4`);
    await fs.writeFile(file, Buffer.from(await (await fetch(`${base}/api/studio/render/${job.id}/file`)).arrayBuffer()));
    return file;
  };
  const followed = await render(true);
  // visage détecté dans le clip produit, tout au long : toujours dans la moitié centrale de l'écran
  const xs = [];
  for (let t = 0.5; t < 25.5; t += 1.5) xs.push([t, await faceAt(followed, t)]);
  for (const [t, x] of xs) assert.ok(x !== null && x > 0.2 && x < 0.8, `suivi : t=${t} visage en ${x}`);
  // juste avant la coupe (t vidéo 19,5 = t clip 17,5) et juste après (20,5 = 18,5) : le cadre a sauté avec la coupe
  assert.ok(Math.abs((await faceAt(followed, 18.7)) - 0.5) < 0.2, 'après la coupe, le visage est recentré tout de suite');
  assert.ok(Math.abs((await faceAt(followed, 1)) - 0.5) < 0.1, 'au début, le visage est centré');

  const fixed = await render(false);
  const lost = (await Promise.all([1, 6, 10, 20].map((t) => faceAt(fixed, t)))).filter((x) => x === null || x < 0.15 || x > 0.85);
  assert.ok(lost.length >= 2, 'sans suivi, le visage sort du cadre à plusieurs moments');
});

test('cadrage automatique indisponible sans analyse : le cadre manuel s\'applique', { skip: !enabled }, async () => {
  await call('DELETE', `/api/admin/videos/${videoId}/faces`);
  assert.equal((await call('GET', `/api/admin/videos/${videoId}/clips`)).body.faces.status, 'none');
  assert.equal((await call('GET', `/api/studio/videos/${YT}`)).body.faces.ready, false);
  const r = await call('POST', '/api/studio/framing', { youtube_id: YT, extracts: [{ start_ms: 2000, end_ms: 28000 }] });
  assert.deepEqual(r.body, { segments: null, faces: 0, coverage: 0, split: 0, crowded: 0, recognized: 0, ident_best: null, reason: 'none', missing: 1 });
  const job = await call('POST', '/api/studio/render', { youtube_id: YT, extracts: [{ start_ms: 2000, end_ms: 8000 }], music: null, layout: { fit: 'crop', cropX: 0.5, quality: 'fast', follow: { on: true } } });
  assert.equal(job.status, 202); // le rendu part quand même, avec le cadre manuel
});

test('deux panneaux : visage suivi mal repéré + une deuxième personne = écran coupé en deux, chacune cadrée, jamais dans le vide', { skip: !enabled }, async () => {
  const YT2 = 'FACtest_002';
  const file = path.join(process.env.STORAGE_DIR, 'videos', `${YT2}.mp4`);
  const face = new URL('./fixtures/face.jpg', import.meta.url).pathname;
  // deux personnes côte à côte (gauche et droite), toujours à l'écran, sans coupe
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:r=10:d=20', '-loop', '1', '-framerate', '10', '-i', face, '-loop', '1', '-framerate', '10', '-i', face,
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=20',
    '-filter_complex', '[1:v]scale=-2:250[a];[2:v]scale=-2:250,hflip[b];[0:v][a]overlay=x=230:y=220:shortest=1[t];[t][b]overlay=x=830:y=220:shortest=1,format=yuv420p[v]',
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-c:a', 'aac', '-t', '20', file]);
  const { rows } = await pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
     VALUES ($1, 'Interview à deux', 'Chaîne', '2025-03-01', 'manual', 'fr', 20, $2, 1000, 20, 1280, 720, TRUE, now(), TRUE) RETURNING id`,
    [YT2, `${YT2}.mp4`],
  );
  const id = rows[0].id;
  try {
    await pool.query('INSERT INTO segments (video_id, position, start_ms, duration_ms, text) SELECT $1, i, i * 1000, 950, \'Ligne \' || i FROM generate_series(0, 19) i', [id]);
    await pool.query('UPDATE videos SET norm_text = \'ligne\' WHERE id = $1', [id]);
    assert.equal((await call('POST', `/api/admin/videos/${id}/faces`)).status, 200);
    await waitFor(async () => {
      const r = await call('GET', `/api/admin/videos/${id}/clips`);
      assert.notEqual(r.body.faces.status, 'failed', JSON.stringify(r.body.faces));
      return r.body.faces.status === 'ready';
    });
    const { rows: data } = await pool.query('SELECT content FROM video_faces WHERE video_id = $1', [id]);
    const frames = data[0].content.frames;
    assert.ok(frames.every((f) => f.length === 2), 'les deux personnes sont détectées partout au départ');
    // la personne de droite (la plus grosse) n'est plus repérée entre 7 s et 10 s, 17 s et 20 s : elle est pourtant toujours là sur l'image
    const fps = data[0].content.fps;
    data[0].content.frames = frames.map((f, i) => ((i / fps) % 10 >= 7 ? f.filter((d) => d[0] + d[2] / 2 < 0.5) : f));
    await pool.query('UPDATE video_faces SET content = $2 WHERE video_id = $1', [id, JSON.stringify(data[0].content)]);

    const body = { youtube_id: YT2, extracts: [{ start_ms: 0, end_ms: 20000 }], subject: 'right' };
    const fr = await call('POST', '/api/studio/framing', body);
    assert.equal(fr.status, 200, JSON.stringify(fr.body));
    assert.ok(fr.body.split > 0.9, `écran coupé en deux sur ${fr.body.split} du clip`);
    assert.equal(fr.body.coverage, 1);
    assert.ok(fr.body.segments[0].plan, 'un plan à deux panneaux');

    const r = await call('POST', '/api/studio/render', { ...body, music: null, style: { preset: 'hormozi' }, layout: { fit: 'crop', cropX: 0.5, quality: 'fast', follow: { on: true, subject: 'right' } } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const job = await waitFor(async () => {
      const s = (await call('GET', `/api/studio/render/${r.body.id}`)).body;
      assert.notEqual(s.status, 'failed', s.error);
      return s.status === 'done' ? s : null;
    });
    const out = path.join(dir, 'out-split.mp4');
    await fs.writeFile(out, Buffer.from(await (await fetch(`${base}/api/studio/render/${job.id}/file`)).arrayBuffer()));
    // une moitié de l'écran produit (720 x 1280 : deux panneaux de 720 x 640) : un visage, près du centre, en haut comme en bas, y compris quand la détection a perdu la personne
    const faceIn = async (t, half) => {
      const { stdout: rgb } = await promisify(execFile)('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', `crop=720:640:0:${half === 'top' ? 0 : 640},scale=288:256,pad=288:256:0:0`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24, encoding: 'buffer' });
      const found = net.detect(new Uint8Array(rgb), 288, 256);
      return found.length ? (found[0].x + found[0].w / 2) / 288 : null;
    };
    for (const t of [1, 5, 8, 9, 12, 18]) {
      for (const half of ['top', 'bottom']) {
        const x = await faceIn(t, half);
        assert.ok(x !== null && x > 0.2 && x < 0.8, `t=${t} ${half} : visage en ${x}`);
      }
    }
  } finally {
    await pool.query('DELETE FROM videos WHERE id = $1', [id]);
  }
});
