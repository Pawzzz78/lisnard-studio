// Unicité des clips téléchargés depuis le studio (section « Créer ») : chaque téléchargement est un fichier différent, visuellement
// identique ; la version propre (pour la bibliothèque) reste intacte. Nécessite Postgres via DATABASE_URL et ffmpeg (sinon ignoré).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;
const YT = 'UNQtest_001';

let pool;
let server;
let base;
let dir;
let studio;

const api = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const REQ = { youtube_id: YT, extracts: [{ start_ms: 500, end_ms: 3500 }], layout: { fit: 'blur', quality: 'fast' }, style: { preset: 'hormozi' }, music: null };
const md5 = async (f) => crypto.createHash('md5').update(await fs.readFile(f)).digest('hex');
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f], { encoding: 'utf8' }));
/** Rend REQ, attend la fin, télécharge le fichier servi ; renvoie { job, served (fichier téléchargé) }. */
async function render(body = REQ) {
  const r = await api('POST', '/api/studio/render', body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  let s;
  for (let i = 0; i < 600; i++) {
    s = (await api('GET', `/api/studio/render/${r.body.id}`)).body;
    if (s.status === 'done' || s.status === 'error') break;
    await new Promise((x) => setTimeout(x, 100));
  }
  assert.equal(s.status, 'done', s.error ?? '');
  const served = path.join(dir, `${r.body.id}.dl.mp4`);
  await fs.writeFile(served, Buffer.from(await (await fetch(`${base}/api/studio/render/${r.body.id}/file?use=download`)).arrayBuffer()));
  return { job: studio.getJob(r.body.id), status: s, served };
}

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-uniq-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.STUDIO_RENDERS_PER_HOUR = '100';
  delete process.env.STUDIO_UNIQ;
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  // a still picture (color bars) with a tone: the 1 to 3 frames trimmed from the start do not change what is compared
  const file = path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=d=6:s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  const { size } = await fs.stat(file);
  const { rows } = await pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
     VALUES ($1, 'Interview unique', 'Chaîne', '2026-11-01', 'manual', 'fr', 6, $2, $3, 6, 640, 360, TRUE, now(), TRUE) RETURNING id`,
    [YT, `${YT}.mp4`, size],
  );
  await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, Array.from({ length: 6 }, (_, i) => ({ start_ms: i * 1000, duration_ms: 950, text: `Phrase numéro ${i}.` }))));
  studio = await import('../src/studio/render.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => enabled && studio.resetStudioState());
after(async () => {
  if (!enabled) return;
  delete process.env.STUDIO_UNIQ;
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('chaque téléchargement est un fichier différent, visuellement identique à la version propre ; la version propre reste intacte', { skip: !enabled, timeout: 120_000 }, async () => {
  const a = await render();
  const b = await render();
  assert.equal(a.status.unique, true);
  assert.notEqual(await md5(a.served), await md5(b.served), 'deux personnes, deux fichiers différents');
  assert.notEqual(await md5(a.served), await md5(a.job.out), 'le fichier téléchargé n’est pas la version propre');
  assert.equal(await md5(a.served), await md5(a.job.outServed), 'c’est bien la copie unique qui est servie');
  // same picture size, same sound, duration within 3 frames
  const [pa, pc] = [probe(a.served), probe(a.job.out)];
  const dims = (p) => p.streams.filter((s) => s.codec_type === 'video').map((s) => [s.width, s.height])[0];
  assert.deepEqual(dims(pa), dims(pc));
  assert.ok(pa.streams.some((s) => s.codec_type === 'audio'));
  const gap = Number(pc.format.duration) - Number(pa.format.duration);
  assert.ok(gap >= 0 && gap <= 0.16, `1 à 3 images retirées au début (${gap} s)`);
  // looks the same: structural similarity of a frame, clean vs unique
  const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', '1', '-i', a.job.out, '-ss', '1', '-i', a.served, '-lavfi', '[0:v][1:v]ssim', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
  const ssim = Number(/All:([0-9.]+)/.exec(r.stderr)?.[1]);
  assert.ok(ssim > 0.8 && ssim < 0.999, `SSIM ${ssim} : même image à l’œil, mais pas le même fichier`);
});

test('unicité coupée (STUDIO_UNIQ=off) : un seul fichier, servi tel quel', { skip: !enabled, timeout: 60_000 }, async () => {
  process.env.STUDIO_UNIQ = 'off';
  try {
    const a = await render();
    assert.equal(a.status.unique, false);
    assert.equal(a.job.outServed, null);
    assert.equal(await md5(a.served), await md5(a.job.out));
  } finally {
    delete process.env.STUDIO_UNIQ;
  }
});

test('commande ffmpeg : deux sorties en une passe (propre, puis unique), le début n’est retiré que de la copie unique', { skip: !enabled }, async () => {
  const { buildFfmpegArgs, normalizeRequest } = studio;
  const video = { youtube_id: YT, file_duration_s: 6, file_has_audio: true };
  const req = normalizeRequest(REQ, video);
  const plain = buildFfmpegArgs({ file: 'in.mp4', req, hasAudio: true, assPath: 'a.ass', out: 'clean.mp4', outServed: null });
  assert.equal(plain.at(-1), 'clean.mp4');
  assert.ok(!plain.includes('served.mp4'));
  const args = buildFfmpegArgs({ file: 'in.mp4', req, hasAudio: true, assPath: 'a.ass', out: 'clean.mp4', outServed: 'served.mp4', uniq: { seed: 42, level: 'gentle', rubberband: false } });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /\[vo\]split=2\[vclean\]\[vs\]/);
  assert.match(fc, /\[vs\]crop=.*eq=brightness=.*noise=alls=.*\[vu\]/);
  assert.match(fc, /\[as\]equalizer=.*volume=.*\[au\]/);
  assert.equal(args.at(-1), 'served.mp4');
  const cleanAt = args.indexOf('clean.mp4');
  assert.ok(!args.slice(0, cleanAt).includes('-ss') || args.indexOf('-ss') < args.indexOf('-filter_complex'), 'pas de coupe sur la version propre');
  const ssAt = args.lastIndexOf('-ss');
  assert.ok(ssAt > cleanAt && ssAt < args.length - 1, 'coupe du début, sur la seule copie unique');
  // the same seed always gives the same filters; another seed, other ones
  const again = buildFfmpegArgs({ file: 'in.mp4', req, hasAudio: true, assPath: 'a.ass', out: 'clean.mp4', outServed: 'served.mp4', uniq: { seed: 42, level: 'gentle', rubberband: false } });
  assert.deepEqual(again, args);
  const other = buildFfmpegArgs({ file: 'in.mp4', req, hasAudio: true, assPath: 'a.ass', out: 'clean.mp4', outServed: 'served.mp4', uniq: { seed: 7, level: 'gentle', rubberband: false } });
  assert.notEqual(other[other.indexOf('-filter_complex') + 1], fc);
});
