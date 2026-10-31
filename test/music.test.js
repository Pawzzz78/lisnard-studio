// Bibliothèque de musiques du studio : dépôt par l'admin, conversion, catalogue public, rendu avec un morceau déposé
// (nécessite Postgres via DATABASE_URL et ffmpeg, sinon ignorés).
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
let server;
let base;
let dir;
let cookie = '';
let wav; // 10 s de son
let short; // 2 s
let studio;

const json = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const upload = (data, query = {}, withCookie = true) =>
  fetch(`${base}/api/admin/studio/music?${new URLSearchParams({ rights: '1', ...query })}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', ...(withCookie && cookie ? { Cookie: cookie } : {}) }, body: data });
const sine = (seconds) => {
  const f = path.join(dir, `s${seconds}.wav`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`, '-ar', '22050', f]);
  return f;
};

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  wav = await fs.readFile(sine(10));
  short = await fs.readFile(sine(2));
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM studio_music');
  await pool.query('DELETE FROM studio_music_hidden');
  studio = await import('../src/studio/render.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await json('POST', '/api/admin/login', { password: 'pw-test' });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM studio_music');
  await pool.query('DELETE FROM studio_music_hidden');
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('bibliothèque : réservée à l\'admin, droits à confirmer, fichiers invalides refusés', { skip: !enabled }, async () => {
  assert.equal((await upload(wav, {}, false)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/studio/music`)).status, 401);
  const noRights = await fetch(`${base}/api/admin/studio/music?title=x`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', Cookie: cookie }, body: wav });
  assert.equal(noRights.status, 400);
  assert.match((await noRights.json()).error, /droit/);
  const notAudio = await upload(Buffer.from('ceci n\'est pas un son, juste du texte'), { title: 'Texte' });
  assert.equal(notAudio.status, 422);
  const tooShort = await upload(short, { title: 'Court' });
  assert.equal(tooShort.status, 422);
  assert.match((await tooShort.json()).error, /trop court/);
  assert.equal((await upload(Buffer.alloc(0), { title: 'Vide' })).status, 400);
  const list = (await json('GET', '/api/admin/studio/music')).body;
  assert.equal(list.library.length, 0);
  assert.deepEqual(await fs.readdir(path.join(process.env.STORAGE_DIR, 'music')).catch(() => []), []); // aucun résidu
});

test('bibliothèque : un morceau déposé est converti, proposé au studio, lisible et utilisable dans un rendu', { skip: !enabled }, async () => {
  const res = await upload(wav, { title: '  Ascension   épique ', category: 'epique', credit: 'Auteur · Pixabay', filename: 'x.wav' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.library.length, 1);
  const t = body.library[0];
  assert.deepEqual([t.title, t.category, t.credit, t.enabled, t.builtin], ['Ascension épique', 'epique', 'Auteur · Pixabay', true, false]);
  assert.ok(t.duration_s >= 9.5 && t.duration_s <= 10.5, String(t.duration_s));
  assert.match(t.id, /^m[0-9a-f]{10}$/);
  // converti en MP3 sur le volume
  const stored = path.join(process.env.STORAGE_DIR, 'music', `${t.id}.mp3`);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', stored], { encoding: 'utf8' }));
  assert.equal(info.streams[0].codec_name, 'mp3');
  assert.equal(info.streams[0].channels, 2);

  // catalogue public : le morceau déposé arrive en tête, avec son adresse de lecture
  const assets = (await json('GET', '/api/studio/assets')).body;
  assert.equal(assets.music.length, 11);
  assert.equal(assets.music[0].id, t.id);
  assert.equal(assets.music[0].url, `/api/studio/music/${t.id}`);
  assert.equal(assets.music.find((m) => m.id === 'cinematique').url, '/music/cinematique.mp3');
  assert.deepEqual(assets.music_categories.map((c) => c.id), ['tendance', 'motivant', 'epique', 'cinematique', 'autre']);
  assert.ok(!('path' in assets.music[0]));

  // lecture avec Range
  const full = await fetch(base + assets.music[0].url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  const part = await fetch(base + assets.music[0].url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  // utilisable dans une demande de rendu, avec le fichier du volume
  const req = studio.normalizeRequest({ extracts: [{ start_ms: 0, end_ms: 10_000 }], music: { id: t.id, volume: 0.4 } }, { file_duration_s: 60 });
  assert.equal(req.music.id, t.id);
  const args = studio.buildFfmpegArgs({ file: '/x/in.mp4', req, hasAudio: true, assPath: '/x/a.ass', out: '/x/o.mp4' });
  assert.ok(args.includes(stored));

  // masqué : disparaît du studio, devient illisible en public, mais l'admin peut encore l'écouter
  const hid = await json('PATCH', `/api/admin/studio/music/${t.id}`, { enabled: false });
  assert.equal(hid.status, 200);
  assert.equal((await json('GET', '/api/studio/assets')).body.music.length, 10);
  assert.equal((await fetch(base + assets.music[0].url)).status, 404);
  assert.equal((await fetch(`${base}/api/admin/studio/music/${t.id}/file`, { headers: { Cookie: cookie } })).status, 200);
  assert.throws(() => studio.normalizeRequest({ extracts: [{ start_ms: 0, end_ms: 10_000 }], music: { id: t.id } }, { file_duration_s: 60 }), /Musique inconnue/);
  await json('PATCH', `/api/admin/studio/music/${t.id}`, { enabled: true });
});

test('bibliothèque : modification, masquage d\'un morceau d\'origine, suppression', { skip: !enabled }, async () => {
  const [t] = (await json('GET', '/api/admin/studio/music')).body.library;
  const edited = await json('PATCH', `/api/admin/studio/music/${t.id}`, { title: 'Nouveau titre', category: 'motivant', credit: '' });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.library[0].title, edited.body.library[0].category, edited.body.library[0].credit], ['Nouveau titre', 'motivant', '']);
  assert.equal((await json('PATCH', `/api/admin/studio/music/${t.id}`, { category: 'inconnue' })).status, 400);
  assert.equal((await json('PATCH', `/api/admin/studio/music/${t.id}`, { title: '   ' })).status, 400);
  assert.equal((await json('PATCH', '/api/admin/studio/music/absent', { title: 'x' })).status, 404);

  // un morceau d'origine se masque (il ne se supprime pas)
  assert.equal((await json('PATCH', '/api/admin/studio/music/lofi-doux', { enabled: false })).status, 200);
  const ids = (await json('GET', '/api/studio/assets')).body.music.map((m) => m.id);
  assert.ok(!ids.includes('lofi-doux') && ids.includes('cinematique'));
  assert.equal((await json('DELETE', '/api/admin/studio/music/lofi-doux')).status, 404);
  assert.equal((await json('PATCH', '/api/admin/studio/music/lofi-doux', { enabled: true })).status, 200);

  const del = await json('DELETE', `/api/admin/studio/music/${t.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.library.length, 0);
  await assert.rejects(fs.stat(path.join(process.env.STORAGE_DIR, 'music', `${t.id}.mp3`)));
  assert.equal((await json('GET', '/api/studio/assets')).body.music.length, 10);
});
