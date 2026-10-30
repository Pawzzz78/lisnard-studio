// Studio de clips public : liste, aperçu, rendu ffmpeg, file d'attente, limites, nettoyage
// (nécessite Postgres via DATABASE_URL et ffmpeg, sinon ignorés).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
const YT = 'STUtest_001'; // clips autorisés
const YT_OFF = 'STUtest_002'; // fichier présent, clips non autorisés
const DURATION = 12;

let pool;
let server;
let base;
let dir;
let studio;
let core;
let videoRowId;

const api = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers, res };
};
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' }));
const waitFor = async (id, until, ms = 60_000) => {
  const t0 = Date.now();
  for (;;) {
    const r = await api('GET', `/api/studio/render/${id}`);
    if (until(r.body)) return r.body;
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${JSON.stringify(r.body)}`);
    await new Promise((r2) => setTimeout(r2, 150));
  }
};
const REQ = (extra = {}) => ({
  youtube_id: YT,
  extracts: [{ start_ms: 1000, end_ms: 5000 }, { start_ms: 7000, end_ms: 10500 }],
  layout: { fit: 'blur', quality: 'fast' },
  style: { preset: 'hormozi' },
  music: { id: 'lofi-doux', volume: 0.3 },
  ...extra,
});

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.STUDIO_RENDERS_PER_HOUR = '100';
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  const sample = path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=duration=${DURATION}:size=640x360:rate=25`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${DURATION}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample]);
  await fs.copyFile(sample, path.join(process.env.STORAGE_DIR, 'videos', `${YT_OFF}.mp4`));
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = ANY($1)', [[YT, YT_OFF]]);
  for (const [yt, on] of [[YT, true], [YT_OFF, false]]) {
    const { rows } = await pool.query(
      `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
       VALUES ($1, 'Interview de test du studio', 'Chaîne', '2025-03-01', 'manual', 'fr', $2::int, $3, 1000, $2::real, 640, 360, TRUE, now(), $4) RETURNING id`,
      [yt, DURATION, `${yt}.mp4`, on],
    );
    await db.withTransaction((c) =>
      db.replaceSegments(c, rows[0].id, Array.from({ length: 12 }, (_, i) => ({ start_ms: i * 1000, duration_ms: 950, text: `Ligne numéro ${i} de la transcription de test.` }))),
    );
    if (yt === YT) videoRowId = rows[0].id;
  }
  studio = await import('../src/studio/render.js');
  core = await import('../public/js/studio-core.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => enabled && studio.resetStudioState());
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id = ANY($1)', [[YT, YT_OFF]]);
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('éléments de l\'éditeur : 22 polices présentes, 10 musiques, 5 styles', async () => {
  const { FONTS, FONTS_DIR } = await import('../src/studio/render.js');
  const { BUILTIN_MUSIC: MUSIC } = await import('../src/studio/music.js');
  assert.equal(FONTS.length, 22);
  assert.equal(new Set(FONTS.map((f) => f.ass_name)).size, 22); // un nom de police unique par fichier
  for (const f of FONTS) assert.ok((await fs.stat(path.join(FONTS_DIR, f.file))).size > 5000, f.file);
  assert.equal(MUSIC.length, 10);
  for (const m of MUSIC) assert.ok((await fs.stat(m.path)).size > 100_000, m.id);
  assert.deepEqual([...new Set(MUSIC.map((m) => m.category))].sort(), ['cinematique', 'epique', 'motivant', 'autre'].sort());
  if (!enabled) return;
  const a = (await api('GET', '/api/studio/assets')).body;
  assert.deepEqual([a.fonts.length, a.music.length, a.presets.length], [22, 10, 5]);
  assert.equal(a.limits.maxTotalS, 90);
  assert.deepEqual(a.presets.map((p) => p.id), ['hormozi', 'un-mot', 'karaoke', 'classique', 'boite']);
});

test('studio : seules les vidéos autorisées sont listées, sans jamais exposer le fichier', { skip: !enabled }, async () => {
  const list = (await api('GET', '/api/studio/videos')).body.videos.map((v) => v.youtube_id);
  assert.ok(list.includes(YT) && !list.includes(YT_OFF));
  assert.equal((await api('GET', `/api/studio/videos/${YT_OFF}`)).status, 404);
  assert.equal((await api('GET', '/api/studio/videos/pas-un-id')).status, 404);
  const d = (await api('GET', `/api/studio/videos/${YT}`)).body;
  assert.equal(d.video.title, 'Interview de test du studio');
  assert.equal(d.lines.length, 12);
  assert.deepEqual(d.lines[1], [1000, 1950, 'Ligne numéro 1 de la transcription de test.']);
  assert.ok(!JSON.stringify(d).includes('.mp4') && !JSON.stringify(d).includes('file_name'));
  // le fichier d'origine n'a aucune adresse publique
  for (const p of [`/api/studio/file/${YT}`, `/videos/${YT}.mp4`, `/api/admin/videos/${videoRowId}/file`]) assert.ok([401, 404].includes((await fetch(base + p)).status), p);
});

test('tutoriels : vidéos verticales de moins d\'une minute avec leur affiche, lisibles par morceaux', { skip: !hasFfmpeg }, async () => {
  const dirUrl = new URL('../public/tutoriels/', import.meta.url);
  for (const name of ['debutant', 'avance']) {
    const file = new URL(`${name}.mp4`, dirUrl).pathname;
    const info = probe(file);
    const video = info.streams.find((s) => s.codec_type === 'video');
    assert.equal(video.codec_name, 'h264', name); // lu partout (navigateurs, téléphones)
    assert.deepEqual([video.width, video.height], [720, 1280], name); // vertical, comme un téléphone
    assert.ok(info.streams.some((s) => s.codec_type === 'audio'), `${name} : musique`);
    const dur = Number(info.format.duration);
    assert.ok(dur > 20 && dur < 60, `${name} : ${dur} s, il en faut moins d'une minute`);
    assert.ok(Number(info.format.size) < 8 * 1024 * 1024, `${name} : moins de 8 Mo`);
    assert.ok((await fs.stat(new URL(`${name}.jpg`, dirUrl))).size > 5000, `${name} : affiche`);
    if (enabled) {
      const res = await fetch(`${base}/tutoriels/${name}.mp4`, { headers: { Range: 'bytes=0-99' } });
      assert.deepEqual([res.status, res.headers.get('content-type')], [206, 'video/mp4'], name); // le lecteur peut sauter dans la vidéo
    }
  }
});

test('demande : extraits, cadrage, style et musique validés', { skip: !enabled }, async () => {
  const { normalizeRequest } = studio;
  const video = { file_duration_s: 120 };
  const ok = normalizeRequest({ extracts: [{ start_ms: 1000, end_ms: 31000 }], style: { preset: 'karaoke', size: 5000 }, music: { id: 'lofi-doux', volume: 9 }, layout: { fit: 'crop', cropX: -3, quality: 'x' } }, video);
  assert.deepEqual([ok.total, ok.style.size, ok.music.volume, ok.layout.fit, ok.layout.cropX, ok.layout.quality, ok.voice], [30, 220, 1, 'crop', 0, 'hd', 1]);
  const bad = (body, re) => assert.throws(() => normalizeRequest(body, video), (e) => e.status === 400 && re.test(e.message), JSON.stringify(body).slice(0, 80));
  bad({}, /au moins un extrait/);
  bad({ extracts: [{ start_ms: 0, end_ms: 1000 }] }, /au moins 3 secondes/);
  bad({ extracts: [{ start_ms: 5000, end_ms: 4000 }] }, /invalide/);
  bad({ extracts: [{ start_ms: 0, end_ms: 200_000 }] }, /dépasse la durée/);
  bad({ extracts: [{ start_ms: 0, end_ms: 50_000 }, { start_ms: 60_000, end_ms: 110_000 }] }, /90 secondes/);
  bad({ extracts: Array.from({ length: 5 }, () => ({ start_ms: 0, end_ms: 5000 })) }, /4 extraits/);
  bad({ extracts: [{ start_ms: 0, end_ms: 5000 }], music: { id: 'inconnue' } }, /Musique inconnue/);
});

test('commande ffmpeg : cadrage, sous-titres, mixage musique, durée', { skip: !enabled }, () => {
  const req = studio.normalizeRequest(REQ(), { file_duration_s: DURATION });
  const args = studio.buildFfmpegArgs({ file: '/x/in.mp4', req, hasAudio: true, assPath: '/x/a.ass', out: '/x/out.mp4' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.equal(args.filter((a) => a === '-i').length, 3); // 2 extraits + 1 musique
  assert.match(graph, /concat=n=2:v=1:a=1/);
  assert.match(graph, /ass=\/x\/a\.ass:fontsdir=.*fonts\/studio\[vo\]/);
  assert.match(graph, /scale=720:1280/); // qualité « fast »
  assert.match(graph, /boxblur/); // fond flou
  assert.match(graph, /amix=inputs=2/);
  assert.match(graph, /volume=0.3/);
  assert.equal(args[args.indexOf('-t', args.length - 12) + 1], '7.5');
  const sansMusique = studio.buildFfmpegArgs({ file: '/x/in.mp4', req: { ...req, music: null }, hasAudio: false, assPath: '/x/a.ass', out: '/x/o.mp4' });
  assert.doesNotMatch(sansMusique[sansMusique.indexOf('-filter_complex') + 1], /amix/);
  assert.match(sansMusique[sansMusique.indexOf('-filter_complex') + 1], /anullsrc/); // vidéo sans son
  const crop = studio.buildFfmpegArgs({ file: '/x/in.mp4', req: { ...req, layout: { fit: 'crop', cropX: 0.25, quality: 'hd' } }, hasAudio: true, assPath: '/x/a.ass', out: '/x/o.mp4' });
  assert.match(crop[crop.indexOf('-filter_complex') + 1], /crop=1080:1920:\(iw-ow\)\*0\.25/);
  const prev = studio.buildFfmpegArgs({ file: '/x/in.mp4', req, hasAudio: true, out: '/x/p.mp4', kind: 'preview' });
  assert.doesNotMatch(prev[prev.indexOf('-filter_complex') + 1], /ass=|amix/); // l'aperçu n'a ni sous-titres ni musique
  assert.match(prev[prev.indexOf('-filter_complex') + 1], /scale=360:640/);
});

test('aperçu : 360 × 640, mis en cache, retiré si les clips ne sont plus autorisés', { skip: !enabled }, async () => {
  const p = await api('POST', '/api/studio/preview', REQ());
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.duration_s, 7.5);
  assert.match(p.body.url, /^\/api\/studio\/preview\/[0-9a-f]{40}\.mp4$/);
  const file = path.join(process.env.STORAGE_DIR, 'previews', `${p.body.url.split('/').pop()}`);
  const info = probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.deepEqual([v.width, v.height], [360, 640]);
  assert.ok(Math.abs(Number(info.format.duration) - 7.5) < 0.4);
  const t0 = Date.now();
  const again = await api('POST', '/api/studio/preview', REQ());
  assert.equal(again.body.url, p.body.url);
  assert.ok(Date.now() - t0 < 600, 'servi depuis le cache');
  // lecture partielle pour le lecteur vidéo
  const part = await fetch(base + p.body.url, { headers: { Range: 'bytes=0-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-type'), 'video/mp4');
  // un autre cadrage = un autre aperçu
  const other = await api('POST', '/api/studio/preview', REQ({ layout: { fit: 'crop', cropX: 0.7, quality: 'fast' } }));
  assert.notEqual(other.body.url, p.body.url);
  // autorisation retirée : l'aperçu n'est plus servi
  await pool.query('UPDATE videos SET clips_enabled = FALSE WHERE youtube_id = $1', [YT]);
  assert.equal((await fetch(base + p.body.url)).status, 404);
  assert.equal((await api('POST', '/api/studio/preview', REQ())).status, 404);
  await pool.query('UPDATE videos SET clips_enabled = TRUE WHERE youtube_id = $1', [YT]);
  assert.equal((await fetch(`${base}/api/studio/preview/${'0'.repeat(40)}.mp4`)).status, 404);
  assert.equal((await fetch(`${base}/api/studio/preview/..%2F..%2Fetc%2Fpasswd`)).status, 404);
});

test('rendu complet : MP4 vertical avec sous-titres, musique et durée exacte', { skip: !enabled }, async () => {
  const sent = await api('POST', '/api/studio/render', REQ());
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const id = sent.body.id;
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal((await api('GET', `/api/studio/render/${id}/file`)).status, 409); // pas encore prêt
  const seen = [];
  const done = await waitFor(id, (s) => (seen.push(s.progress), s.status === 'done' || s.status === 'error'));
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.ok(seen.every((p, i) => !i || p >= seen[i - 1]), 'progression croissante');
  assert.equal(done.progress, 1);
  assert.match(done.filename, /^studio-lisnard-interview-de-test-du-studio-[0-9a-f]{6}\.mp4$/);
  const res = await fetch(`${base}/api/studio/render/${id}/file`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="studio-lisnard-/);
  const out = path.join(dir, 'out.mp4');
  await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
  const info = probe(out);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.deepEqual([v.codec_name, v.width, v.height, a.codec_name], ['h264', 720, 1280, 'aac']);
  assert.ok(Math.abs(Number(info.format.duration) - 7.5) < 0.3, `durée ${info.format.duration}`);
  // des sous-titres sont bien incrustés : l'image au milieu du clip n'est pas celle du seul cadrage
  const withSubs = path.join(dir, 'with.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2', '-i', out, '-frames:v', '1', '-vf', 'crop=720:300:0:600', withSubs]);
  const prev = await api('POST', '/api/studio/preview', REQ());
  const noSubs = path.join(dir, 'nosubs.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2', '-i', path.join(process.env.STORAGE_DIR, 'previews', prev.body.url.split('/').pop()), '-frames:v', '1', '-vf', 'scale=720:1280,crop=720:300:0:600', noSubs]);
  const a1 = (await fs.readFile(withSubs)).length;
  const a2 = (await fs.readFile(noSubs)).length;
  assert.notEqual(a1, a2);
  // supprimer un clip terminé
  assert.equal((await api('DELETE', `/api/studio/render/${id}`)).status, 200);
  assert.equal((await api('GET', `/api/studio/render/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/studio/render/${id}/file`)).status, 404);
});

test('rendu : tous les styles produisent une vidéo (karaoké, un mot, classique, fond sombre)', { skip: !enabled }, async () => {
  for (const preset of ['un-mot', 'karaoke', 'classique', 'boite']) {
    const r = await api('POST', '/api/studio/render', REQ({ style: { preset, font: 'bangers', color: '#00FF99', outlineColor: '#FF00AA', x: 0.4, y: 0.4, size: 90 }, music: null, extracts: [{ start_ms: 1000, end_ms: 4500 }] }));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const done = await waitFor(r.body.id, (s) => s.status === 'done' || s.status === 'error');
    assert.equal(done.status, 'done', `${preset}: ${JSON.stringify(done)}`);
    await api('DELETE', `/api/studio/render/${r.body.id}`);
  }
});

test('file d\'attente : un seul rendu à la fois, position, annulation', { skip: !enabled }, async () => {
  const a = await api('POST', '/api/studio/render', REQ());
  const b = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 2000, end_ms: 6000 }] }));
  assert.equal(b.status, 202);
  const second = (await api('GET', `/api/studio/render/${b.body.id}`)).body;
  assert.ok(['queued', 'running'].includes(second.status));
  if (second.status === 'queued') assert.equal(second.position, 1);
  // un visiteur ne peut pas avoir plus de 2 clips en cours
  const c = await api('POST', '/api/studio/render', REQ());
  assert.equal(c.status, 429);
  assert.match(c.body.error, /en cours de création/);
  // annulation du 2e
  assert.equal((await api('DELETE', `/api/studio/render/${b.body.id}`)).status, 200);
  const cancelled = await waitFor(b.body.id, (s) => s.status === 'cancelled').catch(() => null);
  if (cancelled) assert.equal(cancelled.status, 'cancelled');
  assert.equal((await waitFor(a.body.id, (s) => s.status === 'done' || s.status === 'error')).status, 'done');
});

test('limites : clips par heure, réponses claires', { skip: !enabled }, async () => {
  process.env.STUDIO_RENDERS_PER_HOUR = '2';
  try {
    studio.resetStudioState();
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const r = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 1000, end_ms: 4500 }], music: null }));
      assert.equal(r.status, 202);
      await waitFor(r.body.id, (s) => s.status === 'done');
      ids.push(r.body.id);
    }
    const third = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 1000, end_ms: 4500 }] }));
    assert.equal(third.status, 429);
    assert.match(third.body.error, /2 clips par heure/);
  } finally {
    process.env.STUDIO_RENDERS_PER_HOUR = '100';
  }
  assert.equal((await api('POST', '/api/studio/render', { youtube_id: YT_OFF, extracts: [{ start_ms: 0, end_ms: 5000 }] })).status, 404);
  assert.equal((await api('POST', '/api/studio/render', { youtube_id: YT })).status, 400);
  assert.equal((await api('GET', '/api/studio/render/0000')).status, 404);
});

test('nettoyage : rien n\'est conservé plus d\'une heure', { skip: !enabled }, async () => {
  const r = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 1000, end_ms: 4500 }], music: null }));
  await waitFor(r.body.id, (s) => s.status === 'done');
  const file = path.join(process.env.STORAGE_DIR, 'renders', `${r.body.id}.mp4`);
  assert.ok((await fs.stat(file)).size > 1000);
  await studio.cleanup(Date.now() + 5 * 60_000); // 5 minutes plus tard : conservé
  assert.ok((await fs.stat(file)).size > 1000);
  await studio.cleanup(Date.now() + 2 * 3600_000); // 2 h plus tard : supprimé
  await assert.rejects(fs.stat(file));
  assert.equal((await api('GET', `/api/studio/render/${r.body.id}`)).status, 404);
  assert.deepEqual((await fs.readdir(path.join(process.env.STORAGE_DIR, 'renders'))).filter((n) => n.startsWith(r.body.id)), []);
  void core;
});

test('miroir et cadrage : demande validée, hflip après le cadrage (final seulement), aperçu non recadré', { skip: !enabled }, () => {
  const { normalizeRequest, buildFfmpegArgs } = studio;
  const video = { file_duration_s: 60 };
  const base = { extracts: [{ start_ms: 0, end_ms: 5000 }] };
  assert.equal(normalizeRequest(base, video).layout.mirror, false);
  assert.equal(normalizeRequest({ ...base, layout: { mirror: true } }, video).layout.mirror, true);
  assert.equal(normalizeRequest({ ...base, layout: { mirror: 'oui' } }, video).layout.mirror, false); // seul « true » active le miroir
  const graph = (layout, kind = 'final') => {
    const req = normalizeRequest({ ...base, layout }, video);
    const a = buildFfmpegArgs({ file: '/x/in.mp4', req, hasAudio: true, assPath: '/x/a.ass', out: '/x/o.mp4', kind });
    return a[a.indexOf('-filter_complex') + 1];
  };
  // plein écran : le miroir vient APRÈS le recadrage (la position du cadrage reste celle de la vidéo d'origine)
  assert.match(graph({ fit: 'crop', cropX: 0.3, mirror: true }), /crop=1080:1920:\(iw-ow\)\*0\.3:\(ih-oh\)\*0\.5,setsar=1,hflip\[v0\]/);
  assert.match(graph({ fit: 'blur', mirror: true }), /overlay=\(W-w\)\/2:\(H-h\)\/2,setsar=1,hflip\[v0\]/);
  assert.doesNotMatch(graph({ fit: 'crop', mirror: false }), /hflip/);
  // les sous-titres sont incrustés après le miroir : jamais retournés
  assert.ok(graph({ fit: 'blur', mirror: true }).indexOf('hflip') < graph({ fit: 'blur', mirror: true }).indexOf('ass='));
  // aperçu : jamais de hflip (le navigateur retourne), et en plein écran la vidéo n'est pas recadrée par le serveur
  assert.doesNotMatch(graph({ fit: 'blur', mirror: true }, 'preview'), /hflip/);
  const previewCrop = graph({ fit: 'crop', cropX: 0.9, mirror: true }, 'preview');
  assert.match(previewCrop, /scale=-2:640/);
  assert.doesNotMatch(previewCrop, /crop=|hflip/);
});

test('aperçu : la position du cadrage et le miroir ne demandent aucun nouveau calcul au serveur', { skip: !enabled }, async () => {
  const get = (layout) => api('POST', '/api/studio/preview', REQ({ layout }));
  const a = await get({ fit: 'crop', cropX: 0.2, mirror: false, quality: 'fast' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const t0 = Date.now();
  const b = await get({ fit: 'crop', cropX: 0.9, mirror: true, quality: 'hd' });
  assert.equal(b.body.url, a.body.url);
  assert.ok(Date.now() - t0 < 600, 'servi depuis le cache');
  const blur = await get({ fit: 'blur', mirror: true });
  assert.notEqual(blur.body.url, a.body.url); // un autre mode de cadrage est un autre aperçu
  // l'aperçu plein écran garde le format de la vidéo (16:9 à 640 px de haut), le navigateur la recadre
  const info = probe(path.join(process.env.STORAGE_DIR, 'previews', a.body.url.split('/').pop()));
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.deepEqual([v.width, v.height], [1138, 640]);
});

test('rendu en miroir : l\'image est réellement retournée', { skip: !enabled }, async () => {
  const render = async (mirror) => {
    const r = await api('POST', '/api/studio/render', REQ({ layout: { fit: 'crop', cropX: 0.5, quality: 'fast', mirror }, music: null, extracts: [{ start_ms: 1000, end_ms: 4500 }] }));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await waitFor(r.body.id, (s) => s.status === 'done');
    const file = path.join(dir, `mirror-${mirror}.mp4`);
    await fs.writeFile(file, Buffer.from(await (await fetch(`${base}/api/studio/render/${r.body.id}/file`)).arrayBuffer()));
    return file;
  };
  const normal = await render(false);
  const mirrored = await render(true);
  // bande du milieu (ni bandeau en haut, ni sous-titres plus bas) : le miroir de l'original doit ressembler à la version en miroir
  const ssim = (a, b, pre) => {
    const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', '1.5', '-i', a, '-ss', '1.5', '-i', b, '-lavfi', `[0:v]crop=720:300:0:330${pre}[x];[1:v]crop=720:300:0:330[y];[x][y]ssim`, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
    return Number(/All:([0-9.]+)/.exec(r.stderr)?.[1]);
  };
  const flipped = ssim(normal, mirrored, ',hflip');
  const notFlipped = ssim(normal, mirrored, '');
  assert.ok(flipped > 0.9, `SSIM du retournement : ${flipped}`);
  assert.ok(notFlipped < 0.85, `sans retournement : ${notFlipped}`);
  // (les sous-titres ne sont jamais retournés : le miroir précède l'incrustation dans le graphe de filtres, vérifié plus haut)
});

test('corrections de texte : validées, appliquées avec l\'horodatage d\'origine, ligne vide = pas de sous-titre', { skip: !enabled }, async () => {
  const { normalizeEdits, applyEdits, normalizeRequest, assForRequest } = studio;
  const bad = (input, re) => assert.throws(() => normalizeEdits(input), (e) => e.status === 400 && re.test(e.message), JSON.stringify(input)?.slice(0, 60));
  assert.deepEqual(normalizeEdits(undefined), []);
  assert.deepEqual(normalizeEdits({ 1000: '  Bonjour\n\tle   monde \u0007 ' }), [{ start_ms: 1000, text: 'Bonjour le monde' }]);
  bad([], /invalides/);
  bad('texte', /invalides/);
  bad({ abc: 'x' }, /invalide/);
  bad({ '-5': 'x' }, /invalide/);
  bad({ 1000: 42 }, /invalide/);
  bad({ 1000: 'x'.repeat(501) }, /500 caractères/);
  bad(Object.fromEntries(Array.from({ length: 301 }, (_, i) => [i, 'x'])), /300 lignes/);
  assert.equal(normalizeEdits({ 1000: 'x'.repeat(500) })[0].text.length, 500);

  const video = { file_duration_s: DURATION, title: 'Interview', published_at: '2025-03-01' };
  const lines = Array.from({ length: 12 }, (_, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 950, text: `Ligne numéro ${i} de la transcription` }));
  assert.equal(applyEdits(lines, []), lines);
  const edited = applyEdits(lines, [{ start_ms: 2000, text: 'Mot' }, { start_ms: 424242, text: 'inconnue' }]);
  assert.deepEqual(edited[2], { start_ms: 2000, end_ms: 2950, text: 'Mot' });
  assert.deepEqual(edited.filter((_, i) => i !== 2), lines.filter((_, i) => i !== 2)); // le reste est intact, ligne inconnue ignorée
  assert.equal(lines[2].text, 'Ligne numéro 2 de la transcription'); // la transcription d'origine n'est jamais modifiée

  const dialogues = (ass) => ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,')); // texte des sous-titres (couche 1, au-dessus du fond)
  const reqFor = (edits) => normalizeRequest({ extracts: [{ start_ms: 2000, end_ms: 5950 }], style: { preset: 'classique' }, edits }, video);
  const plain = await assForRequest({ req: reqFor(undefined), lines });
  const withEdit = await assForRequest({ req: reqFor({ 2000: 'Salut à tous les amis' }), lines });
  assert.match(withEdit, /Salut/);
  assert.doesNotMatch(plain, /Salut/);
  assert.notEqual(plain, withEdit);
  // ligne vidée : plus aucun mot de cette ligne dans le clip
  const emptied = await assForRequest({ req: reqFor({ 2000: '' }), lines });
  assert.ok(dialogues(emptied).length < dialogues(plain).length);
  // les corrections n'ont aucune incidence sur la durée du clip
  assert.equal(reqFor({ 2000: 'Salut' }).total, reqFor(undefined).total);
});

test('rendu avec texte corrigé : MP4 produit, durée inchangée', { skip: !enabled }, async () => {
  const body = REQ({ layout: { fit: 'blur', quality: 'fast' }, music: null, extracts: [{ start_ms: 1000, end_ms: 4500 }], edits: { 1000: 'Texte corrigé à la main', 2000: '' } });
  const r = await api('POST', '/api/studio/render', body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await waitFor(r.body.id, (s) => s.status === 'done');
  const file = path.join(dir, 'edited.mp4');
  await fs.writeFile(file, Buffer.from(await (await fetch(`${base}/api/studio/render/${r.body.id}/file`)).arrayBuffer()));
  const info = probe(file);
  assert.ok(Math.abs(Number(info.format.duration) - 3.5) < 0.2, `durée ${info.format.duration}`);
  assert.equal((await api('POST', '/api/studio/render', REQ({ edits: { x: 'non' } }))).status, 400);
});

// --- fond des sous-titres : mesuré par libass, dessiné aux coins arrondis ------------------------------------------

const { OUT } = await import('../public/js/studio-core.js');

test('mesure du fond : lecture des lignes sur une image (largeurs, nombre de lignes, marge)', async () => {
  const { rectsFromFrame } = await import('../src/studio/box-probe.js');
  const band = 1400;
  const frame = Buffer.alloc(OUT.w * band);
  const fill = (y0, y1, x0, x1) => {
    for (let y = y0; y < y1; y++) frame.fill(255, y * OUT.w + x0, y * OUT.w + x1);
  };
  // deux lignes de 80 px de haut (+ 1 px de marge de chaque côté), 400 puis 300 px de large, centrées sur x = 540
  fill(500, 500 + 2 + 160, 540 - 202, 540 + 202); // boîte d'1 px autour du texte : le texte fait 400 px (338…738)
  fill(500 + 1 + 80, 500 + 2 + 160, 540 - 202, 540 + 202);
  frame.fill(0);
  fill(500, 500 + 82, 540 - 201, 540 + 201); // ligne 1 : 1 px de marge + 80 px + 1 px
  fill(500 + 80, 500 + 162, 540 - 151, 540 + 151); // ligne 2 : plus étroite
  const rects = rectsFromFrame(frame, { band, pitch: 80, pad: 20, cx: 540 });
  assert.equal(rects.length, 2);
  const cropY = (OUT.h - band) / 2;
  const [a, b] = rects;
  assert.deepEqual([a.x0, a.x1], [-200 - 20, 200 + 20]); // texte de 400 px, marge de 20 px de chaque côté
  assert.deepEqual([b.x0, b.x1], [-150 - 20, 150 + 20]);
  assert.equal(a.y1 - a.y0, 80 + 40); // hauteur de ligne + marge en haut et en bas
  assert.equal(b.y0 + 20, a.y1 - 20); // les lignes sont l'une sous l'autre
  assert.equal(a.y0, cropY + 501 - 20 - OUT.h / 2);
  assert.deepEqual(rectsFromFrame(Buffer.alloc(OUT.w * band), { band, pitch: 80, pad: 20, cx: 540 }), []); // image vide : aucun fond
});

test('fond arrondi : mesuré par libass puis dessiné — coins arrondis, bords pleins, même taille', { skip: !enabled }, async () => {
  const { assForRequest, normalizeRequest, FONTS_DIR } = studio;
  const video = { file_duration_s: DURATION };
  const lns = Array.from({ length: 6 }, (_, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 950, text: 'Les maires doivent pouvoir décider au plus près du terrain' }));
  const make = (boxRadius) => normalizeRequest({ extracts: [{ start_ms: 0, end_ms: 6000 }], style: { preset: 'boite', boxRadius, boxOpacity: 1, boxColor: '#000000', wordsPerGroup: 8 } }, video);
  const frameOf = (ass, name) => {
    const f = path.join(dir, `${name}.ass`);
    const png = path.join(dir, `${name}.png`);
    execFileSync('sh', ['-c', `cat > ${f}`], { input: ass });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x808080:s=1080x1920:d=1:r=1`, '-vf', `ass=${f}:fontsdir=${FONTS_DIR}`, '-frames:v', '1', png]);
    return png;
  };
  const pixels = (png) => execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
  const at = (buf, x, y) => buf[Math.round(y) * 1080 + Math.round(x)];

  const round = await assForRequest({ req: make(1), lines: lns });
  const sharp = await assForRequest({ req: make(0), lines: lns });
  assert.match(round, /\\p1\}m /);
  // premier rectangle du premier groupe, relatif au centre (540 ; 0,62 × 1920 = 1190 pour « boite » : y = 0,7)
  const box = (ass) => {
    const d = ass.split('\n').find((l) => l.startsWith('Dialogue: 0,'));
    const pos = /\\pos\((\d+),(\d+)\)/.exec(d);
    const nums = d.split('\\p1}')[1].split(' ').filter((t) => /^-?[\d.]+$/.test(t)).map(Number);
    return { cx: Number(pos[1]), cy: Number(pos[2]), x0: Math.min(...nums.filter((_, i) => i % 2 === 0)), x1: Math.max(...nums.filter((_, i) => i % 2 === 0)) };
  };
  const roundBox = box(round);
  const sharpBox = box(sharp);
  assert.deepEqual([roundBox.x0, roundBox.x1], [sharpBox.x0, sharpBox.x1]); // l'arrondi ne change pas la taille du fond
  const rP = pixels(frameOf(round, 'round'));
  const sP = pixels(frameOf(sharp, 'sharp'));
  // coin haut-gauche du fond : angle droit = noir ; bords entièrement ronds = fond gris visible
  const first = round.split('\n').find((l) => l.startsWith('Dialogue: 0,')).split('\\p1}')[1].split(' ');
  const top = Math.min(...first.filter((t) => /^-?[\d.]+$/.test(t)).map(Number).filter((_, i) => i % 2 === 1));
  const x0 = roundBox.cx + roundBox.x0;
  const y0 = roundBox.cy + top;
  assert.equal(at(sP, x0 + 2, y0 + 2), 0, 'angle droit : le coin est rempli');
  assert.ok(at(rP, x0 + 2, y0 + 2) > 100, 'arrondi : le coin laisse voir la vidéo');
  assert.equal(at(rP, roundBox.cx, y0 + 3), 0, 'le bord du haut est plein au milieu');
  assert.ok(at(rP, x0 + 3, y0 + 40) < 20 || at(rP, x0 + 12, y0 + 40) < 20, 'le côté est plein à mi-hauteur');
  // même largeur et même hauteur qu'avec le rectangle de libass (aux marges près)
  const extent = (buf) => {
    let minX = 1080, maxX = 0, minY = 1920, maxY = 0;
    for (let y = 900; y < 1500; y++) for (let x = 0; x < 1080; x++) if (buf[y * 1080 + x] < 60) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return [minX, maxX, minY, maxY];
  };
  const [a, b] = [extent(rP), extent(sP)];
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(a[i] - b[i]) <= 2, `bord ${i} : ${a[i]} vs ${b[i]}`);
});

test('extrait précis : bornes à la milliseconde, mots gardés selon l\'horaire, rendu de la durée exacte', { skip: !enabled }, async () => {
  const { assForRequest, normalizeRequest } = studio;
  const video = { file_duration_s: DURATION };
  const lns = Array.from({ length: 12 }, (_, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 950, text: `un deux trois quatre cinq six sept huit` }));
  const req = normalizeRequest({ extracts: [{ start_ms: 2480, end_ms: 6130 }], style: { preset: 'hormozi', mode: 'one' } }, video);
  assert.deepEqual(req.extracts, [{ start_ms: 2480, end_ms: 6130 }]); // pas arrondi à la seconde
  assert.equal(req.total, 3.65);
  const ass = await assForRequest({ req, lines: lns });
  const starts = ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,')).map((l) => l.split(',')[1]);
  assert.ok(starts.length > 20 && starts.length < 5 * 8, `${starts.length} mots affichés`); // 5 lignes touchées, mais seuls les mots dits dans l'extrait
  assert.equal(starts[0] >= '0:00:00.00', true);
  const r = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 2480, end_ms: 6130 }], music: null, layout: { fit: 'blur', quality: 'fast' } }));
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await waitFor(r.body.id, (s2) => s2.status === 'done');
  const file = path.join(dir, 'precise.mp4');
  await fs.writeFile(file, Buffer.from(await (await fetch(`${base}/api/studio/render/${r.body.id}/file`)).arrayBuffer()));
  assert.ok(Math.abs(Number(probe(file).format.duration) - 3.65) < 0.15, `durée ${probe(file).format.duration}`);
});

// --- zooms et images b-roll -------------------------------------------------------------------------------------------------

test('demande : zooms et images b-roll validés', { skip: !enabled }, () => {
  const { normalizeRequest, normalizeBroll } = studio;
  const video = { file_duration_s: 60 };
  const base = { extracts: [{ start_ms: 0, end_ms: 10_000 }] };
  assert.equal(normalizeRequest(base, video).zoom, null);
  assert.deepEqual(normalizeRequest(base, video).broll, []);
  const z = normalizeRequest({ ...base, zoom: { strength: 1.3, focus: { x: 0.4, y: 0.4 }, events: [{ t: 8, kind: 'out' }, { t: 2, kind: 'in' }, { t: 99, kind: 'in' }] } }, video).zoom;
  assert.deepEqual(z.events, [{ t: 2, kind: 'in' }, { t: 8, kind: 'out' }]); // trié, hors clip écarté
  assert.equal(normalizeRequest({ ...base, zoom: { events: [] } }, video).zoom, null);
  assert.equal(normalizeRequest({ ...base, zoom: 'oui' }, video).zoom, null);
  const bad = (input, re) => assert.throws(() => normalizeBroll(input, 10), (e) => e.status === 400 && re.test(e.message), JSON.stringify(input)?.slice(0, 60));
  assert.deepEqual(normalizeBroll([{ id: '123', start: 4, dur: 2 }, { id: 5, start: 1, dur: 0.2 }], 10), [{ id: '5', start: 1, dur: 1 }, { id: '123', start: 4, dur: 2 }]); // trié, durée minimale 1 s
  assert.equal(normalizeBroll([{ id: '1', start: 8, dur: 8 }], 10)[0].dur, 2); // ne dépasse pas la fin du clip
  assert.equal(normalizeBroll([{ id: '1', start: 0, dur: 99 }], 20)[0].dur, 8); // 8 s au plus
  bad('x', /invalides/);
  bad([{ id: 'abc', start: 1, dur: 2 }], /invalide/);
  bad([{ id: '../../etc/passwd', start: 1, dur: 2 }], /invalide/);
  bad([{ id: 'https://exemple.test/a.jpg', start: 1, dur: 2 }], /invalide/); // jamais d'adresse : seulement un numéro
  bad([{ id: '1', start: -1, dur: 2 }], /pendant le clip/);
  bad([{ id: '1', start: 10, dur: 2 }], /pendant le clip/);
  bad([{ id: '1', start: 1, dur: 3 }, { id: '2', start: 3, dur: 2 }], /chevaucher/);
  bad(Array.from({ length: 9 }, (_, i) => ({ id: String(i + 1), start: i, dur: 1 })), /8 images/);
});

test('commande ffmpeg : zoom avant les images avant les sous-titres, entrées dans le bon ordre, rien dans l\'aperçu', { skip: !enabled }, () => {
  const { normalizeRequest, buildFfmpegArgs } = studio;
  const req = normalizeRequest({ extracts: [{ start_ms: 0, end_ms: 10_000 }], music: { id: 'lofi-doux', volume: 0.3 }, zoom: { events: [{ t: 2, kind: 'in' }, { t: 5, kind: 'out' }] }, broll: [{ id: '11', start: 6, dur: 2 }, { id: '22', start: 8, dur: 1.5 }] }, { file_duration_s: 60 });
  const run = (kind) => buildFfmpegArgs({ file: '/x/in.mp4', req, hasAudio: true, assPath: '/x/a.ass', out: '/x/o.mp4', kind, images: { 11: '/s/11.jpg', 22: '/s/22.jpg' } });
  const a = run('final');
  const g = a[a.indexOf('-filter_complex') + 1];
  const inputs = a.reduce((acc, v, i) => (v === '-i' ? [...acc, a[i + 1]] : acc), []);
  assert.deepEqual([inputs[0], inputs[2], inputs[3]].map((p) => p.split('/').pop()), ['in.mp4', '11.jpg', '22.jpg']); // vidéo, musique (n° 1), puis les images
  assert.match(inputs[1], /music/);
  // images : boucle à 30 i/s, durée bornée ; le flux 2 (1re image) puis 3 ; la musique garde son numéro
  assert.ok(a.join(' ').includes('-loop 1 -framerate 30 -t 2 -i /s/11.jpg -loop 1 -framerate 30 -t 1.5 -i /s/22.jpg'));
  assert.match(g, /\[1:a\]aresample/); // musique = entrée 1
  assert.match(g, /\[2:v\]scale=1080:1920.*perspective=.*fade=t=in.*setpts=PTS-STARTPTS\+6\/TB\[bk0\]/);
  assert.match(g, /\[3:v\]scale=1080:1920.*setpts=PTS-STARTPTS\+8\/TB\[bk1\]/);
  // ordre : image, puis zoom, puis images, puis sous-titres
  const at = (re) => g.search(re);
  assert.ok(at(/\[vc\]perspective=/) >= 0 && at(/\[vc\]perspective=/) < at(/\[vz\]\[bk0\]overlay=/) && at(/\[vb0\]\[bk1\]overlay=/) < at(/\[vb1\]ass=/));
  assert.match(g, /\[vb1\]ass=.*\[vo\]/);
  assert.doesNotMatch(g, /zoompan/);
  // aperçu : ni zoom ni images (le navigateur les dessine)
  const p = run('preview');
  const pg = p[p.indexOf('-filter_complex') + 1];
  assert.doesNotMatch(pg, /perspective|overlay=eof|-loop/);
  assert.ok(!p.includes('-loop'));
  // sans effets : graphe d'origine
  const plain = normalizeRequest({ extracts: [{ start_ms: 0, end_ms: 10_000 }] }, { file_duration_s: 60 });
  const pl = buildFfmpegArgs({ file: '/x/in.mp4', req: plain, hasAudio: true, assPath: '/x/a.ass', out: '/x/o.mp4' });
  assert.match(pl[pl.indexOf('-filter_complex') + 1], /\[vc\]ass=/);
});

test('zoom : mouvement lisse mesuré sur de vraies images, fidèle à la courbe de l\'aperçu (aucune saccade)', { skip: !enabled }, () => {
  const { zoomPlan, zoomAt, zoomRect, zoomFilter, sanitizeZoom } = core;
  const W = 540;
  const H = 960;
  const N = 150;
  const z = sanitizeZoom({ strength: 1.32, focus: { x: 0.8, y: 0.3 }, events: [{ t: 0.5, kind: 'in' }, { t: 2.2, kind: 'out' }, { t: 3.3, kind: 'in' }, { t: 4.0, kind: 'out' }] }, 5);
  const plan = zoomPlan(z.events, z.strength);
  // image fixe : une ligne verticale et une ligne horizontale ; leur position dans chaque image donne l'échelle et le décalage réels
  const src = `color=black:s=${W}x${H}:r=30:d=5,drawbox=x=350:y=0:w=4:h=${H}:color=white:t=fill,drawbox=x=0:y=250:w=${W}:h=4:color=white:t=fill,format=yuv420p`;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', src, '-vf', zoomFilter(plan, z.focus, 5), '-frames:v', String(N), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
  const centroid = (frame, line, axis) => {
    let s = 0;
    let w = 0;
    const n = axis === 'x' ? W : H;
    for (let i = 0; i < n; i++) {
      const v = axis === 'x' ? frame[line * W + i] : frame[i * W + line];
      s += v * (i + 0.5);
      w += v;
    }
    return w ? s / w : NaN;
  };
  const xs = [];
  const ideal = [];
  let worst = 0;
  for (let n = 0; n < N; n++) {
    const f = raw.subarray(n * W * H, (n + 1) * W * H);
    const r = zoomRect(zoomAt(plan, n / 30), z.focus);
    const px = ((352 - r.x0 * W) / ((r.x1 - r.x0) * W)) * W;
    const cx = centroid(f, 50, 'x');
    if (px > 4 && px < W - 4) {
      assert.ok(Number.isFinite(cx), `image ${n} : ligne introuvable`);
      worst = Math.max(worst, Math.abs(cx - px));
      xs.push(cx);
      ideal.push(px);
    }
  }
  assert.ok(xs.length > 100);
  assert.ok(worst < 0.5, `écart avec la courbe idéale : ${worst.toFixed(3)} px`); // moins d'un demi-pixel
  // pas de saccade : la variation de vitesse d'une image à l'autre suit celle de la courbe idéale (zoompan : plusieurs pixels d'écart)
  let jitter = 0;
  for (let i = 2; i < xs.length; i++) jitter = Math.max(jitter, Math.abs(xs[i] - 2 * xs[i - 1] + xs[i - 2] - (ideal[i] - 2 * ideal[i - 1] + ideal[i - 2])));
  assert.ok(jitter < 0.6, `irrégularité du mouvement : ${jitter.toFixed(3)} px par image²`);
});

test('rendu avec zoom et image b-roll : image visible au bon moment, zoom sans toucher le reste, durée exacte', { skip: !enabled }, async () => {
  const stockDir = path.join(process.env.STORAGE_DIR, 'stock');
  await fs.mkdir(stockDir, { recursive: true });
  const keepKey = process.env.PIXABAY_API_KEY;
  process.env.PIXABAY_API_KEY = 'cle-de-test'; // le rendu cherche l'image dans le cache du fournisseur actif
  const jpg = path.join(stockDir, 'pixabay-777-f.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xE01010:s=1253x1880', '-frames:v', '1', jpg]);
  const frame = async (id, t) => {
    const file = path.join(dir, `fx-${id}.mp4`);
    await fs.writeFile(file, Buffer.from(await (await fetch(`${base}/api/studio/render/${id}/file`)).arrayBuffer()));
    const png = path.join(dir, `fx-${id}-${t}.png`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', png]);
    return { file, png };
  };
  const render = async (extra) => {
    const r = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 1000, end_ms: 6000 }], music: null, layout: { fit: 'crop', cropX: 0.5, quality: 'fast' }, style: { preset: 'classique' }, ...extra }));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await waitFor(r.body.id, (s) => s.status === 'done');
    return r.body.id;
  };
  const plainId = await render({});
  const fxId = await render({ zoom: { strength: 1.3, events: [{ t: 0.4, kind: 'in' }, { t: 2.0, kind: 'out' }] }, broll: [{ id: '777', start: 3.4, dur: 1.4 }] });
  assert.ok(Math.abs(Number(probe((await frame(fxId, 0.1)).file).format.duration) - 5) < 0.2);
  const ssim = (a, b) => {
    const r = spawnSync('ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
    return Number(/All:([0-9.]+)/.exec(r.stderr)?.[1]);
  };
  const [p0, f0] = [await frame(plainId, 0.2), await frame(fxId, 0.2)];
  assert.ok(ssim(p0.png, f0.png) > 0.985, 'avant le zoom : image inchangée'); // le filtre n'agit que pendant le zoom
  const [p1, f1] = [await frame(plainId, 1.4), await frame(fxId, 1.4)];
  assert.ok(ssim(p1.png, f1.png) < 0.9, 'pendant le zoom : image agrandie');
  const [p2, f2] = [await frame(plainId, 3.0), await frame(fxId, 3.0)];
  assert.ok(ssim(p2.png, f2.png) > 0.97, 'après le retour du zoom : image identique (aux différences de compression près)');
  // image b-roll : plein écran rouge au milieu de sa durée, absente avant et après
  const red = (png) => {
    const px = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'crop=1:1:360:640', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
    return { r: px[0], g: px[1], b: px[2] };
  };
  const mid = red((await frame(fxId, 4.1)).png);
  assert.ok(mid.r > 190 && mid.g < 60 && mid.b < 60, `image b-roll attendue : ${JSON.stringify(mid)}`);
  const before = red((await frame(fxId, 3.0)).png);
  assert.ok(!(before.r > 190 && before.g < 60), 'pas encore d\'image');
  const after = red((await frame(fxId, 4.9)).png);
  assert.ok(!(after.r > 190 && after.g < 60), 'plus d\'image');
  if (keepKey === undefined) delete process.env.PIXABAY_API_KEY;
  else process.env.PIXABAY_API_KEY = keepKey;
});

test('routes des images : recherche et image refusent proprement, état indiqué dans les éléments de l\'éditeur', { skip: !enabled }, async () => {
  const keep = { pexels: process.env.PEXELS_API_KEY, pixabay: process.env.PIXABAY_API_KEY };
  delete process.env.PEXELS_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  try {
    assert.deepEqual((await api('GET', '/api/studio/assets')).body.stock, { enabled: false, provider: null });
    const s = await api('GET', '/api/studio/stock/search?q=mairie');
    assert.equal(s.status, 503);
    assert.match(s.body.error, /pas configurée/);
    assert.equal((await api('GET', '/api/studio/stock/image/abc')).status, 400);
    assert.equal((await api('GET', '/api/studio/stock/image/..%2F..%2Fetc%2Fpasswd')).status, 400);
    process.env.PIXABAY_API_KEY = 'x';
    assert.deepEqual((await api('GET', '/api/studio/assets')).body.stock, { enabled: true, provider: 'Pixabay' });
    assert.equal((await api('GET', '/api/studio/stock/search?q=a')).status, 400); // trop court : refusé avant tout appel
  } finally {
    for (const [k, v] of [['PEXELS_API_KEY', keep.pexels], ['PIXABAY_API_KEY', keep.pixabay]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// --- statistiques : clips créés, téléchargés, partagés ---------------------------------------------------------------------

test('statistiques : un événement par clip et par type, empreinte des visiteurs, entrées invalides ignorées', { skip: !enabled }, async () => {
  const stats = await import('../src/studio/stats.js');
  const job = 'a'.repeat(24);
  await pool.query("DELETE FROM studio_events WHERE job_id = ANY($1)", [[job, 'b'.repeat(24)]]);
  assert.equal(await stats.recordEvent('download', { jobId: job, youtubeId: YT, ip: '203.0.113.7' }), true);
  assert.equal(await stats.recordEvent('download', { jobId: job, youtubeId: YT, ip: '203.0.113.7' }), false); // deuxième téléchargement du même clip : pas recompté
  assert.equal(await stats.recordEvent('share', { jobId: job, youtubeId: YT, ip: '203.0.113.7' }), true); // un autre type compte à part
  assert.equal(await stats.recordEvent('inconnu', { jobId: job, ip: 'x' }), false);
  assert.equal(await stats.recordEvent('download', { jobId: '../etc', ip: 'x' }), false);
  const { rows } = await pool.query('SELECT kind, visitor FROM studio_events WHERE job_id = $1 ORDER BY kind', [job]);
  assert.deepEqual(rows.map((r) => r.kind), ['download', 'share']);
  assert.match(rows[0].visitor, /^[0-9a-f]{16}$/);
  assert.ok(!rows[0].visitor.includes('203') && rows[0].visitor === stats.visitorHash('203.0.113.7')); // stable pour une même connexion, jamais l'adresse
  assert.notEqual(stats.visitorHash('203.0.113.8'), rows[0].visitor);
  // les empreintes de plus de 90 jours sont effacées, les compteurs restent
  await pool.query("UPDATE studio_events SET created_at = now() - interval '91 days' WHERE job_id = $1 AND kind = 'share'", [job]);
  await stats.purgeVisitors();
  const after = await pool.query('SELECT kind, visitor FROM studio_events WHERE job_id = $1 ORDER BY kind', [job]);
  assert.deepEqual(after.rows.map((r) => [r.kind, r.visitor === null]), [['download', false], ['share', true]]);
  await pool.query('DELETE FROM studio_events WHERE job_id = $1', [job]);
});

test('statistiques : le clip créé, le bouton Télécharger et le partage sont comptés, pas la simple lecture', { skip: !enabled }, async () => {
  const count = async (kind, id) => Number((await pool.query('SELECT count(*) FROM studio_events WHERE job_id = $1 AND kind = $2', [id, kind])).rows[0].count);
  const r = await api('POST', '/api/studio/render', REQ({ music: null, layout: { fit: 'blur', quality: 'fast' }, extracts: [{ start_ms: 1000, end_ms: 4500 }] }));
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const id = r.body.id;
  assert.equal(await count('render', id), 1);
  // pas prêt : rien n'est compté
  const early = await fetch(`${base}/api/studio/render/${id}/file?use=download`);
  if (early.status === 409) assert.equal(await count('download', id), 0);
  await waitFor(id, (s) => s.status === 'done');
  const file = `${base}/api/studio/render/${id}/file`;
  await (await fetch(file)).arrayBuffer(); // lecture dans la page : pas un téléchargement
  await fetch(file, { method: 'HEAD' });
  await (await fetch(`${file}?use=download`, { method: 'HEAD' })).arrayBuffer();
  assert.equal(await count('download', id), 0);
  assert.equal((await fetch(`${file}?use=download`)).status, 200);
  assert.equal(await count('download', id), 1);
  await (await fetch(`${file}?use=download`)).arrayBuffer(); // même clip téléchargé deux fois : un seul
  assert.equal(await count('download', id), 1);
  assert.equal((await fetch(`${file}?use=share`)).status, 200);
  assert.equal(await count('share', id), 1);
  await (await fetch(`${file}?use=nimporte`)).arrayBuffer(); // valeur inconnue : rien
  // partage depuis le téléphone (fichier préchargé, sans repasser par le téléchargement) : compté via la route dédiée
  await pool.query("DELETE FROM studio_events WHERE job_id = $1 AND kind = 'share'", [id]);
  assert.equal((await api('POST', `/api/studio/render/${id}/used`, { use: 'nimporte' })).status, 400);
  assert.equal(await count('share', id), 0);
  assert.equal((await api('POST', `/api/studio/render/${id}/used`, { use: 'share' })).status, 204);
  assert.equal((await api('POST', `/api/studio/render/${id}/used`, { use: 'share' })).status, 204); // un seul par clip
  assert.equal(await count('share', id), 1);
  assert.equal((await api('POST', `/api/studio/render/${'a'.repeat(24)}/used`, { use: 'share' })).status, 404);
  const { rows } = await pool.query("SELECT youtube_id, visitor FROM studio_events WHERE job_id = $1 AND kind = 'download'", [id]);
  assert.equal(rows[0].youtube_id, YT);
  assert.ok(rows[0].visitor);
  await pool.query('DELETE FROM studio_events WHERE job_id = $1', [id]);
});

test('statistiques : API de l\'admin protégée, chiffres par période, courbe et interviews', { skip: !enabled }, async () => {
  assert.equal((await api('GET', '/api/admin/studio/stats')).status, 401);
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-test' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ids = ['c', 'd', 'e'].map((c) => c.repeat(24));
  await pool.query('DELETE FROM studio_events');
  for (const [i, id] of ids.entries()) {
    await pool.query("INSERT INTO studio_events (kind, job_id, youtube_id, visitor) VALUES ('render', $1, $2, $3)", [id, YT, `v${i % 2}`]);
  }
  await pool.query("INSERT INTO studio_events (kind, job_id, youtube_id, visitor) VALUES ('download', $1, $2, 'v0'), ('download', $3, $2, 'v1'), ('share', $4, $2, 'v0')", [ids[0], YT, ids[1], ids[2]]);
  await pool.query("INSERT INTO studio_events (kind, job_id, youtube_id, visitor, created_at) VALUES ('render', $1, $2, 'v9', now() - interval '20 days'), ('download', $1, $2, 'v9', now() - interval '20 days')", ['f'.repeat(24), YT]);
  const res = await fetch(`${base}/api/admin/studio/stats`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.deepEqual([s.periods.today.created, s.periods.today.downloaded, s.periods.today.shared], [3, 2, 1]);
  assert.equal(s.periods.today.people_downloaded, 2); // v0 et v1 (v0 a téléchargé et partagé : une personne)
  assert.equal(s.periods.today.retrieved, 3);
  assert.ok(s.periods.today.retrieved <= s.periods.today.created);
  assert.equal(s.periods.d7.created, 3);
  assert.equal(s.periods.d30.created, 4); // le clip de il y a 20 jours entre dans les 30 jours
  assert.equal(s.periods.d30.people_downloaded, 3);
  assert.deepEqual([s.periods.all.created, s.periods.all.downloaded], [4, 3]);
  assert.equal(s.daily.length, 14);
  assert.deepEqual([s.daily.at(-1).created, s.daily.at(-1).downloaded, s.daily.at(-1).shared], [3, 2, 1]); // aujourd'hui : dernier jour
  assert.equal(s.videos[0].youtube_id, YT);
  assert.equal(s.videos[0].title, 'Interview de test du studio');
  assert.deepEqual([s.videos[0].created, s.videos[0].downloaded], [4, 4]);
  assert.equal(s.retention_days, 90);
  await pool.query('DELETE FROM studio_events');
});

test('studio : la légende des extraits proposés est transmise au navigateur', { skip: !enabled }, async () => {
  const { rows } = await pool.query('SELECT id, text_hash FROM videos WHERE youtube_id = $1', [YT]);
  const clips = [{ start_ms: 1000, end_ms: 9000, duration_s: 8, title: 'Un extrait', why: 'x', score: 7, text: 'abc', description: 'Une légende.\n\n#a1 #b2' }, { start_ms: 20000, end_ms: 30000, duration_s: 10, title: 'Ancien format', why: 'y', score: 5, text: 'def' }];
  await pool.query('INSERT INTO clip_suggestions (video_id, content, model, text_hash) VALUES ($1, $2::jsonb, $3, $4) ON CONFLICT (video_id) DO UPDATE SET content = EXCLUDED.content', [rows[0].id, JSON.stringify({ prompt_version: 'c4', clips }), 'test', rows[0].text_hash]);
  try {
    const d = (await api('GET', `/api/studio/videos/${YT}`)).body;
    assert.equal(d.suggestions[0].description, 'Une légende.\n\n#a1 #b2');
    assert.equal(d.suggestions[1].description, null); // extraits générés avant les légendes : pas de légende
  } finally {
    await pool.query('DELETE FROM clip_suggestions WHERE video_id = $1', [rows[0].id]);
  }
});

test('limites anti-abus : cadrage plafonné, file d\'aperçus bornée, volume servi par clip plafonné', { skip: !enabled }, async () => {
  const saved = { ...process.env };
  try {
    process.env.STUDIO_FRAMING_PER_HOUR = '2';
    const framing = () => api('POST', '/api/studio/framing', { youtube_id: YT, extracts: REQ().extracts });
    assert.notEqual((await framing()).status, 429);
    assert.notEqual((await framing()).status, 429);
    const third = await framing();
    assert.equal(third.status, 429);
    assert.match(third.body.error, /cadrage/);

    process.env.STUDIO_PREVIEW_QUEUE = '1';
    const preview = (i) => api('POST', '/api/studio/preview', REQ({ extracts: [{ start_ms: 0, end_ms: 11000 - i * 100 }] }));
    const first = [preview(0), preview(1)];
    await new Promise((r) => setTimeout(r, 300));
    const rest = await Promise.all([2, 3, 4, 5].map(preview));
    const statuses = [...(await Promise.all(first)), ...rest].map((r) => r.status);
    assert.ok(statuses.every((s) => s === 200 || s === 503), statuses.join(','));
    assert.ok(statuses.includes(503), `au moins un refus attendu : ${statuses}`);
    assert.match(rest.find((r) => r.status === 503).body.error, /sollicité/);

    const r = await api('POST', '/api/studio/render', REQ({ music: null, extracts: [{ start_ms: 1000, end_ms: 4500 }] }));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await waitFor(r.body.id, (s) => s.status === 'done');
    const file = `${base}/api/studio/render/${r.body.id}/file`;
    for (let i = 0; i < 3; i++) assert.equal((await fetch(file)).status, 200);
    studio.getJob(r.body.id).bytesServed = Number.POSITIVE_INFINITY;
    const capped = await fetch(file);
    assert.equal(capped.status, 429);
    assert.match((await capped.json()).error, /téléchargé/);
  } finally {
    for (const k of ['STUDIO_FRAMING_PER_HOUR', 'STUDIO_PREVIEW_QUEUE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('mesure du fond : un ffmpeg bloqué est arrêté au bout du délai', { skip: !enabled }, async () => {
  const { measureBoxes } = await import('../src/studio/box-probe.js');
  const req = studio.normalizeRequest({ extracts: [{ start_ms: 0, end_ms: 3000 }], style: { preset: 'boite', boxRadius: 1, wordsPerGroup: 8 } }, { file_duration_s: DURATION });
  const lns = [{ start_ms: 0, end_ms: 2900, text: 'Une ligne mesurée par libass' }];
  const groups = core.groupWords(core.wordsForExtracts(lns, req.extracts).words, req.style);
  const font = studio.FONTS.find((f) => f.id === req.style.font) ?? studio.FONTS[0];
  await assert.rejects(measureBoxes({ groups, style: req.style, font, fontsDir: studio.FONTS_DIR, timeoutMs: 1 }), /délai/);
});

test('écran de fin : carte bleue ajoutée après le clip, son prolongé, sous-titres arrêtés à la fin des extraits', { skip: !enabled }, async () => {
  const card = { on: true, source: true, text: 'Partage la vidéo', dur: 3 };
  const req = studio.normalizeRequest({ ...REQ(), end_card: card }, { file_duration_s: DURATION });
  assert.deepEqual(req.end_card, card);
  assert.equal(req.outTotal, req.total + 3);
  const plain = studio.buildFfmpegArgs({ file: 'in.mp4', req: studio.normalizeRequest(REQ(), { file_duration_s: DURATION }), hasAudio: true, assPath: 'a.ass', out: 'o.mp4' });
  assert.ok(!plain.join(' ').includes('color=c='), 'sans écran de fin, rien ne change');
  const sent = await api('POST', '/api/studio/render', { ...REQ(), music: null, end_card: card });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const done = await waitFor(sent.body.id, (s) => s.status === 'done' || s.status === 'error');
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.ok(Math.abs(done.duration_s - 10.5) < 0.01);
  const out = path.join(dir, 'endcard.mp4');
  await fs.writeFile(out, Buffer.from(await (await fetch(`${base}/api/studio/render/${sent.body.id}/file`)).arrayBuffer()));
  const info = probe(out);
  assert.ok(Math.abs(Number(info.format.duration) - 10.5) < 0.3, `durée ${info.format.duration}`);
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.ok(Math.abs(Number(a.duration) - 10.5) < 0.3, `audio ${a.duration}`);
  // a corner far from the text is the card's navy blue
  const px = execFileSync('ffmpeg', ['-v', 'error', '-ss', '9.5', '-i', out, '-frames:v', '1', '-vf', 'crop=20:20:680:20,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.ok(px[0] < 30 && px[1] > 25 && px[1] < 75 && px[2] > 70 && px[2] < 140, `couleur ${[...px]}`);
});

test('écran de fin dessiné dans le navigateur : image validée, ajoutée telle quelle après le clip', { skip: !enabled }, async () => {
  const jpg = path.join(dir, 'card.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=1080x1920', '-frames:v', '1', jpg]);
  const send = (body, type = 'image/jpeg') => fetch(`${base}/api/studio/endcard`, { method: 'POST', headers: { 'Content-Type': type }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await send(Buffer.from('pas une image'.repeat(100)))).status, 400);
  const up = await send(await fs.readFile(jpg));
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.match(up.body.id, /^[0-9a-f]{40}$/);
  assert.equal((await send(await fs.readFile(jpg))).body.id, up.body.id, 'même image, même identifiant');
  await fs.rm(path.join(process.env.STORAGE_DIR, 'cards', `${up.body.id}.jpg`));
  const twice = await Promise.all([send(await fs.readFile(jpg)), send(await fs.readFile(jpg))]);
  assert.deepEqual(twice.map((r) => r.status), [200, 200], 'deux envois simultanés du même visuel réussissent');
  const missing = await api('POST', '/api/studio/render', { ...REQ(), music: null, end_card: { on: true, source: false, image: 'a'.repeat(40), dur: 2 } });
  assert.equal(missing.status, 409);
  const card = { on: true, source: false, image: up.body.id, dur: 2, design: { template: 'stat', values: { number: '42 %', evil: 'x' } } };
  const sent = await api('POST', '/api/studio/render', { ...REQ(), music: null, end_card: card });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const done = await waitFor(sent.body.id, (s) => s.status === 'done' || s.status === 'error');
  assert.equal(done.status, 'done', JSON.stringify(done));
  const out = path.join(dir, 'cardclip.mp4');
  await fs.writeFile(out, Buffer.from(await (await fetch(`${base}/api/studio/render/${sent.body.id}/file`)).arrayBuffer()));
  assert.ok(Math.abs(Number(probe(out).format.duration) - 9.5) < 0.3);
  const px = execFileSync('ffmpeg', ['-v', 'error', '-ss', '8.8', '-i', out, '-frames:v', '1', '-vf', 'crop=40:40:300:600,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.ok(px[0] > 200 && px[1] < 60 && px[2] < 60, `couleur ${[...px]}`);
  const req = studio.normalizeRequest({ ...REQ(), end_card: card }, { file_duration_s: DURATION });
  assert.deepEqual(req.end_card.design.values, { number: '42 %' }, 'réglages du visuel validés');
});

test('logo du compte : sur la vidéo téléchargée, jamais sur la version propre', { skip: !enabled }, async () => {
  const png = path.join(dir, 'logo.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=200x200', '-frames:v', '1', png]);
  const send = (body, type = 'image/png') => fetch(`${base}/api/studio/logo`, { method: 'POST', headers: { 'Content-Type': type }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await send(Buffer.from('nope'.repeat(50)))).status, 400);
  const up = await send(await fs.readFile(png));
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const logo = { image: up.body.id, pos: 'tl', size: 0.3, opacity: 1 };
  assert.deepEqual(studio.normalizeRequest({ ...REQ(), logo: { ...logo, pos: 'zz', size: 9 } }, { file_duration_s: DURATION }).logo, { ...logo, pos: 'tr', size: 0.4 });
  assert.equal(studio.normalizeRequest({ ...REQ(), logo: { image: '../x' } }, { file_duration_s: DURATION }).logo, null);
  const sent = await api('POST', '/api/studio/render', { ...REQ(), music: null, logo });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const done = await waitFor(sent.body.id, (s) => s.status === 'done' || s.status === 'error');
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(done.has_logo, true);
  const withLogo = path.join(dir, 'withlogo.mp4');
  await fs.writeFile(withLogo, Buffer.from(await (await fetch(`${base}/api/studio/render/${sent.body.id}/file?use=download`)).arrayBuffer()));
  const clean = path.join(process.env.STORAGE_DIR, 'renders', `${sent.body.id}.mp4`);
  const corner = (f, t) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'crop=40:40:70:130,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const a = corner(withLogo, 2);
  assert.ok(a[0] > 200 && a[1] < 60 && a[2] < 60, `logo visible ${[...a]}`);
  const b = corner(clean, 2);
  assert.ok(!(b[0] > 200 && b[1] < 60 && b[2] < 60), `version propre sans logo ${[...b]}`);
  assert.ok(Math.abs(Number(probe(withLogo).format.duration) - Number(probe(clean).format.duration)) < 0.1);
});
