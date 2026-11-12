// Section « Edit », partie publique : modèles en ligne, aperçu, création du montage, fichier, statistiques, validations.
// Nécessite Postgres via DATABASE_URL et ffmpeg (sinon ignoré).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;
const YT = 'EDTtest_001';
const YT2 = 'EDTtest_002';

let pool;
let server;
let base;
let dir;
let online;
let offline;

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const wait = async (id) => {
  let job;
  for (let i = 0; i < 1200; i++) {
    job = (await call('GET', `/api/edit/jobs/${id}`)).body;
    if (job.status !== 'queued' && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  return job;
};
const probe = async (url, name) => {
  const res = await fetch(base + url);
  const f = path.join(dir, name);
  await fs.writeFile(f, Buffer.from(await res.arrayBuffer()));
  return { res, info: JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]).toString()) };
};

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-public-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.STUDIO_RENDERS_PER_HOUR = '100';
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM edit_templates');
  await pool.query('DELETE FROM edit_images');
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1', ['EDTtest%']);
  // only the interviews of this test are in the studio
  await pool.query("UPDATE videos SET clips_enabled = FALSE WHERE clips_enabled AND youtube_id NOT LIKE 'EDTtest%'");
  for (const [yt, src, date] of [[YT, 'testsrc2', '2026-11-02'], [YT2, 'smptehdbars', '2026-10-01']]) {
    const file = path.join(process.env.STORAGE_DIR, 'videos', `${yt}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}=d=40:s=640x360:r=25`, '-f', 'lavfi', '-i', 'sine=f=300:d=40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    const { size } = await fs.stat(file);
    const { rows } = await pool.query(
      `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
       VALUES ($1, $2, 'Chaîne', $3, 'manual', 'fr', 40, $4, $5, 40, 640, 360, TRUE, now(), TRUE) RETURNING id`,
      [yt, `Interview ${yt}`, date, `${yt}.mp4`, size],
    );
    await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, Array.from({ length: 40 }, (_, i) => ({ start_ms: i * 1000, duration_ms: 950, text: `Ligne ${i} de l’interview.` }))));
    const h = (await pool.query('SELECT text_hash FROM videos WHERE id = $1', [rows[0].id])).rows[0].text_hash;
    const clips = [{ start_ms: 2000, end_ms: 16000, duration_s: 14, title: 'Un', why: 'x', score: 9, text: 'a' }, { start_ms: 20000, end_ms: 34000, duration_s: 14, title: 'Deux', why: 'y', score: 8, text: 'b' }];
    await pool.query('INSERT INTO clip_suggestions (video_id, content, model, text_hash) VALUES ($1, $2::jsonb, $3, $4) ON CONFLICT (video_id) DO UPDATE SET content = EXCLUDED.content, text_hash = EXCLUDED.text_hash', [rows[0].id, JSON.stringify({ prompt_version: 'c4', clips }), 'test', h]);
  }
  const { addImage } = await import('../src/edit/images.js');
  const jpg = path.join(dir, 'p.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=1200x900', '-frames:v', '1', jpg]);
  await addImage({ data: await fs.readFile(jpg), title: 'Photo' });
  const T = await import('../src/edit/templates.js');
  online = await T.createTemplate({ recipe_id: 'punch', name: 'Punch électro', track_id: 'electro-motivant', length_beats: 16, start_s: 4 });
  await T.updateTemplate(online.id, { ...online.template, texts: [{ text: 'Il a osé', beat: 0 }, { text: 'Lisnard 2027', beat: 8 }] });
  offline = await T.createTemplate({ recipe_id: 'hype', name: 'Hors ligne', track_id: 'pop-optimiste', length_beats: 16 });
  // a preview file stands for the admin's rendered one
  await fs.mkdir(T.previewsDir(), { recursive: true });
  for (const t of [online, offline]) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', T.previewPath(t.id)]);
    await pool.query('UPDATE edit_templates SET preview_at = now() WHERE id = $1', [t.id]);
  }
  await pool.query('UPDATE edit_templates SET enabled = TRUE WHERE id = $1', [online.id]);
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM edit_templates');
  await pool.query('DELETE FROM edit_images');
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1', ['EDTtest%']);
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('page Edit : modèles en ligne seulement (avec leur aperçu), interviews du studio, photos, limites', { skip: !enabled }, async () => {
  const r = await call('GET', '/api/edit');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.templates.map((t) => t.name), ['Punch électro']);
  assert.deepEqual(r.body.templates[0].texts, ['Il a osé', 'Lisnard 2027']);
  assert.equal(r.body.templates[0].track_title, 'Électro motivant');
  assert.deepEqual(r.body.videos.map((v) => v.youtube_id), [YT, YT2], 'les plus récentes d’abord');
  assert.equal(r.body.photos, 1);
  assert.deepEqual(r.body.limits, { maxTexts: 3, maxTextLen: 60, maxVideos: 3 });
  const prev = await fetch(base + r.body.templates[0].preview_url);
  assert.equal(prev.status, 200);
  assert.equal(prev.headers.get('content-type'), 'video/mp4');
  assert.equal((await fetch(`${base}/api/edit/templates/${offline.id}/preview.mp4`)).status, 404, 'modèle hors ligne : pas d’aperçu public');
  // the page itself is served, with the new navigation
  const page = await (await fetch(`${base}/edit/`)).text();
  assert.match(page, /<a href="\/">Clipping<\/a><a href="\/edit\/" aria-current="page">Edit<\/a>/);
});

test('aperçu : rendu rapide en 360 × 640 avec les interviews les plus récentes, lisible dans la page', { skip: !enabled, timeout: 120_000 }, async () => {
  const r = await call('POST', '/api/edit/preview', { template_id: online.id });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.ok(r.body.plan.slots >= 6 && r.body.plan.duration > 6);
  const job = await wait(r.body.job.id);
  assert.equal(job.status, 'done', job.error ?? '');
  const { res, info } = await probe(`/api/edit/jobs/${job.id}/file`, 'preview.mp4');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.ok(!/attachment/.test(res.headers.get('content-disposition') ?? ''), 'lu dans la page, pas téléchargé');
  assert.deepEqual([info.streams[0].width, info.streams[0].height], [360, 640]);
  assert.ok(Math.abs(Number(info.format.duration) - r.body.plan.duration) < 0.15);
});

test('création : interviews choisies, textes de l’adhérent, sans photos ; téléchargement compté à part des clips', { skip: !enabled, timeout: 120_000 }, async () => {
  const r = await call('POST', '/api/edit/render', { template_id: online.id, youtube_ids: [YT2], photos: false, texts: ['Mon texte', '', 'En plus'], quality: 'fast' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await wait(r.body.job.id);
  assert.equal(job.status, 'done', job.error ?? '');
  assert.match(job.filename, /^edit-lisnard-punch-electro-[0-9a-f]{6}\.mp4$/);
  const { res, info } = await probe(`/api/edit/jobs/${job.id}/file?use=download`, 'final.mp4');
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.deepEqual([info.streams[0].width, info.streams[0].height], [720, 1280]);
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
  const { rows } = await pool.query('SELECT kind FROM studio_events WHERE job_id = $1 ORDER BY kind', [job.id]);
  assert.deepEqual(rows.map((x) => x.kind), ['edit', 'edit_download']);
  assert.equal((await call('POST', `/api/edit/jobs/${job.id}/used`, { use: 'share' })).status, 204);
  // the montage used only the chosen interview, and the member's texts
  const { buildEdit } = await import('../src/edit/session.js');
  const built = await buildEdit({ template_id: online.id, youtube_ids: [YT2], photos: false, texts: ['Mon texte', '', 'En plus'] });
  assert.ok(built.plan.slots.every((s) => s.kind === 'video' && s.youtube_id === YT2));
  assert.deepEqual(built.plan.texts.map((t) => t.text), ['Mon texte', 'En plus']);
  assert.ok(built.plan.slots.every((s) => s.crop_x === 0.5), 'pas de visages analysés : cadre au centre');
  // no texts given: the template's; with photos: some photo slots
  const dflt = await buildEdit({ template_id: online.id });
  assert.deepEqual(dflt.plan.texts.map((t) => t.text), ['Il a osé', 'Lisnard 2027']);
  assert.ok(dflt.plan.slots.some((s) => s.kind === 'photo'));
  assert.deepEqual([...new Set(dflt.plan.slots.filter((s) => s.kind === 'video').map((s) => s.youtube_id))].sort(), [YT, YT2]);
});

test('refus clairs : modèle hors ligne ou inconnu, trop d’interviews, interview inconnue, trop de textes ; montage inconnu', { skip: !enabled }, async () => {
  const bad = async (body, status, re) => {
    const r = await call('POST', '/api/edit/preview', body);
    assert.equal(r.status, status, JSON.stringify(r.body));
    if (re) assert.match(r.body.error, re);
  };
  await bad({ template_id: offline.id }, 404, /plus proposé/);
  await bad({ template_id: 999999 }, 404);
  await bad({ template_id: online.id, youtube_ids: [YT, YT2, 'EDTtest_003', 'EDTtest_004'] }, 400, /3 interviews/);
  await bad({ template_id: online.id, youtube_ids: ['../../etc/x'] }, 400, /invalide/);
  await bad({ template_id: online.id, youtube_ids: ['EDTtest_009'] }, 404, /plus disponible/);
  await bad({ template_id: online.id, texts: ['a', 'b', 'c', 'd'] }, 400, /textes/);
  assert.equal((await call('GET', `/api/edit/jobs/${'0'.repeat(24)}`)).status, 404);
  assert.equal((await call('GET', '/api/edit/jobs/pas-un-id/file')).status, 404);
});
