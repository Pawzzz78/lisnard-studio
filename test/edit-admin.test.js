// Section « Edit », admin : photothèque, temps forts des sons, modèles, aperçu rendu et mise en ligne.
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

let pool;
let server;
let base;
let dir;
let cookie = '';

const call = async (method, p, body, withCookie = true) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(withCookie && cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const upload = (data, query = {}, type = 'image/jpeg') =>
  fetch(`${base}/api/admin/edit/images?${new URLSearchParams({ rights: '1', ...query })}`, { method: 'POST', headers: { 'Content-Type': type, Cookie: cookie }, body: data });
const image = (name, src, size) => {
  const f = path.join(dir, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}=s=${size}`, '-frames:v', '1', f]);
  return fs.readFile(f);
};
const reset = async () => {
  await pool.query('DELETE FROM edit_templates');
  await pool.query('DELETE FROM edit_images');
};

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-admin-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  process.env.STUDIO_RENDERS_PER_HOUR = '100';
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await reset();
  // no interview in the studio for these tests: previews are made from the photo library
  await pool.query("UPDATE videos SET clips_enabled = FALSE WHERE clips_enabled AND youtube_id NOT LIKE 'EDTtest%'");
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await call('POST', '/api/admin/login', { password: 'pw-test' }, false);
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  if (!enabled) return;
  await reset();
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('admin Edit : réservé à l’admin ; recettes, effets, sons et polices fournis', { skip: !enabled }, async () => {
  assert.equal((await call('GET', '/api/admin/edit', undefined, false)).status, 401);
  const r = await call('GET', '/api/admin/edit');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.recipes.map((x) => x.id), ['punch', 'cinematique', 'hype', 'nostalgie']);
  assert.ok(r.body.recipes[0].sections.length >= 1, 'recette complète, pour « repartir d’une recette »');
  assert.ok(r.body.tracks.some((t) => t.id === 'electro-motivant'));
  assert.ok(r.body.fonts.some((f) => f.id === 'anton'));
  assert.ok(r.body.effects.punch && r.body.grades.warm);
  assert.equal(r.body.limits.maxSlots, 40);
});

test('photothèque : droits à confirmer, fichiers invalides refusés, photo réduite, vignette, masquage, suppression', { skip: !enabled }, async () => {
  const jpg = await image('big.jpg', 'mandelbrot', '3000x2000');
  const noRights = await fetch(`${base}/api/admin/edit/images`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Cookie: cookie }, body: jpg });
  assert.equal(noRights.status, 400);
  assert.equal((await upload(Buffer.from('pas une image'))).status, 422);
  const small = await upload(await image('small.png', 'color', '200x150'), {}, 'image/png');
  assert.equal(small.status, 422);
  assert.match((await small.json()).error, /trop petite/);
  const ok = await upload(jpg, { title: 'Meeting', credit: '© Test' });
  assert.equal(ok.status, 201);
  const { image: img } = await ok.json();
  assert.match(img.id, /^i[0-9a-f]{12}$/);
  assert.deepEqual([img.width, img.height], [2160, 1440], 'réduite à 2160 px');
  assert.deepEqual([img.title, img.credit, img.enabled], ['Meeting', '© Test', true]);
  const thumb = await fetch(`${base}/api/admin/edit/images/${img.id}/file?thumb=1`, { headers: { Cookie: cookie } });
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-'], { input: Buffer.from(await thumb.arrayBuffer()) }).toString());
  assert.equal(info.streams[0].width, 360);
  assert.equal((await fetch(`${base}/api/admin/edit/images/../../etc/file`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await call('PATCH', `/api/admin/edit/images/${img.id}`, { enabled: false })).body.image.enabled, false);
  const { listImages } = await import('../src/edit/images.js');
  assert.equal((await listImages()).length, 0, 'masquée : plus proposée');
  const del = await call('DELETE', `/api/admin/edit/images/${img.id}`);
  assert.deepEqual(del.body.images, []);
  await assert.rejects(fs.stat(path.join(process.env.STORAGE_DIR, 'edit', 'images', `${img.id}.jpg`)));
  assert.equal((await call('DELETE', `/api/admin/edit/images/${img.id}`)).status, 404);
});

test('temps forts d’un son : tempo, fiabilité et forme d’onde ; son inconnu refusé', { skip: !enabled }, async () => {
  const r = await call('GET', '/api/admin/edit/tracks/electro-motivant/beats');
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.body.bpm - 124) < 1, `${r.body.bpm} BPM`);
  assert.equal(r.body.reliable, true);
  assert.ok(r.body.peaks.length > 100 && r.body.peaks.every((v) => v >= 0 && v <= 1));
  assert.equal((await call('GET', '/api/admin/edit/tracks/inconnu/beats')).status, 404);
});

test('modèles : création depuis une recette, réglages validés, aperçu rendu puis mise en ligne ; modifier efface l’aperçu', { skip: !enabled, timeout: 120_000 }, async () => {
  await reset();
  for (const [i, src] of ['mandelbrot', 'cellauto', 'life'].entries()) assert.equal((await upload(await image(`p${i}.jpg`, src, '1600x1200'))).status, 201);
  const created = await call('POST', '/api/admin/edit/templates', { recipe_id: 'punch', name: 'Punch électro', track_id: 'electro-motivant', start_s: 4, length_beats: 16 });
  assert.equal(created.status, 201);
  const t = created.body.template;
  assert.deepEqual([t.name, t.enabled, t.has_preview, t.track_ok, t.template.recipe.grade], ['Punch électro', false, false, true, 'contrast']);
  // invalid settings: clear refusal
  const bad = await call('PUT', `/api/admin/edit/templates/${t.id}`, { template: { ...t.template, length_beats: 4 } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /temps/);
  assert.equal((await call('POST', '/api/admin/edit/templates', { recipe_id: 'inconnue', track_id: 'electro-motivant' })).status, 400);
  assert.equal((await call('POST', '/api/admin/edit/templates', { recipe_id: 'punch', track_id: 'son-inexistant' })).status, 400);
  // no preview yet: cannot go online
  const early = await call('PATCH', `/api/admin/edit/templates/${t.id}`, { enabled: true });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /aperçu/);
  const upd = await call('PUT', `/api/admin/edit/templates/${t.id}`, { template: { ...t.template, texts: [{ text: 'Il a osé', beat: 0 }] } });
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.body.template.template.texts, [{ text: 'Il a osé', beat: 0 }]);
  // preview: rendered through the shared queue, then kept
  const start = await call('POST', `/api/admin/edit/templates/${t.id}/preview`, {});
  assert.equal(start.status, 202);
  let job = start.body.job;
  for (let i = 0; i < 600 && (job.status === 'queued' || job.status === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 100));
    job = (await call('GET', `/api/admin/edit/jobs/${job.id}`)).body;
  }
  assert.equal(job.status, 'done', job.error ?? '');
  let one;
  for (let i = 0; i < 50; i++) {
    one = (await call('GET', '/api/admin/edit')).body.templates.find((x) => x.id === t.id);
    if (one.has_preview) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(one.has_preview, true);
  const mp4 = await fetch(`${base}/api/admin/edit/templates/${t.id}/preview.mp4`, { headers: { Cookie: cookie } });
  assert.equal(mp4.headers.get('content-type'), 'video/mp4');
  const got = path.join(dir, 'preview.mp4');
  await fs.writeFile(got, Buffer.from(await mp4.arrayBuffer()));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', got]).toString());
  assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [360, 640]);
  assert.ok(Number(probe.format.duration) > 6 && Number(probe.format.duration) < 9, `16 temps à 124 BPM ≈ 7,7 s (${probe.format.duration})`);
  // online: offered to visitors
  assert.equal((await call('PATCH', `/api/admin/edit/templates/${t.id}`, { enabled: true })).body.template.enabled, true);
  const { listTemplates } = await import('../src/edit/templates.js');
  assert.deepEqual((await listTemplates()).map((x) => x.id), [t.id]);
  // changing the settings wipes the preview: hidden from visitors until a new preview is made
  await call('PUT', `/api/admin/edit/templates/${t.id}`, { template: { ...t.template, name: 'Punch 2' } });
  assert.deepEqual(await listTemplates(), []);
  await assert.rejects(fs.stat(path.join(process.env.STORAGE_DIR, 'edit', 'previews', `${t.id}.mp4`)));
  assert.equal((await call('GET', `/api/admin/edit/jobs/${'0'.repeat(24)}`)).status, 404);
});

test('modèles : ordre, suppression ; sans photo ni interview, pas d’aperçu possible', { skip: !enabled }, async () => {
  await reset();
  const a = (await call('POST', '/api/admin/edit/templates', { recipe_id: 'hype', track_id: 'pop-optimiste' })).body.template;
  const b = (await call('POST', '/api/admin/edit/templates', { recipe_id: 'nostalgie', track_id: 'lofi-doux' })).body.template;
  assert.ok(b.position > a.position);
  await call('PATCH', `/api/admin/edit/templates/${b.id}`, { position: a.position - 1 });
  assert.deepEqual((await call('GET', '/api/admin/edit')).body.templates.map((x) => x.id), [b.id, a.id]);
  const none = await call('POST', `/api/admin/edit/templates/${a.id}/preview`, {});
  assert.equal(none.status, 409);
  assert.match(none.body.error, /photos/);
  assert.equal((await call('DELETE', `/api/admin/edit/templates/${a.id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/admin/edit/templates/${a.id}`)).status, 404);
});

test('analyse en tâche de fond : chaque son une seule fois', { skip: !enabled }, async () => {
  const { warmBeats } = await import('../src/edit/beats.js');
  const make = (name, hz) => {
    const f = path.join(dir, `${name}.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='if(lt(mod(t,0.5),0.02),sin(2*PI*${hz}*t),0)':s=22050:d=6`, f]);
    return { id: `test-warm-${name}`, path: f };
  };
  const tracks = [make('a', 1000), make('b', 1500)];
  await pool.query("DELETE FROM music_beats WHERE track_id LIKE 'test-warm-%'");
  let calls = 0;
  const { analyzeFile } = await import('../src/edit/beats.js');
  const analyze = (f) => (calls++, analyzeFile(f));
  assert.equal(await warmBeats(tracks, { analyze }), 2);
  assert.equal(await warmBeats(tracks, { analyze }), 0, 'déjà analysés');
  assert.equal(calls, 2);
  await pool.query("DELETE FROM music_beats WHERE track_id LIKE 'test-warm-%'");
});
