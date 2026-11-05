// Fichiers vidéo disparus du disque : l'interview est retirée du studio (nécessite Postgres via DATABASE_URL, sinon ignoré)
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const enabled = Boolean(process.env.DATABASE_URL);
const ids = ['FCKtest_001', 'FCKtest_002', 'FCKtest_003', 'FCKtest_004'];
let pool;
let dir;
let check;
const old = () => new Date(Date.now() - 3600_000);

const seed = async (rows) => {
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1', ['FCKtest%']);
  // la base de test peut contenir des vidéos d'autres tests (avec un fichier qui n'existe pas dans ce dossier de stockage)
  await pool.query("UPDATE videos SET file_name = NULL, clips_enabled = FALSE WHERE file_name IS NOT NULL AND youtube_id NOT LIKE 'FCKtest%'");
  for (const [yt, file, uploaded, src] of rows) {
    await pool.query(
      `INSERT INTO videos (youtube_id, title, source, lang, file_name, file_size, file_duration_s, file_uploaded_at, file_source, clips_enabled)
       VALUES ($1, $2, 'manual', 'fr', $3, 1000, 10, $4, $5, TRUE)`,
      [yt, `Interview ${yt}`, file, uploaded, src],
    );
  }
};
const state = async () => Object.fromEntries((await pool.query("SELECT youtube_id, file_name, clips_enabled, file_source FROM videos WHERE youtube_id LIKE 'FCKtest%'")).rows.map((r) => [r.youtube_id, r]));
const put = (yt) => fs.writeFile(path.join(dir, 'storage', 'videos', `${yt}.mp4`), 'x'.repeat(100));

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fck-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  await fs.mkdir(path.join(dir, 'storage', 'videos'), { recursive: true });
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  check = await import('../src/video-files-check.js');
});
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1', ['FCKtest%']);
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('fichier disparu : retiré du studio, les autres ne bougent pas', { skip: !enabled }, async () => {
  await seed([[ids[0], `${ids[0]}.mp4`, old(), 'auto'], [ids[1], `${ids[1]}.mp4`, old(), null], [ids[2], `${ids[2]}.mp4`, old(), null]]);
  await put(ids[0]);
  await put(ids[1]); // le 3e a disparu du disque
  const b = await check.checkVideoFiles({ recheckMs: 0 });
  assert.deepEqual([b.checked, b.missing, b.reset], [3, 1, 1]);
  const s = await state();
  assert.deepEqual([s[ids[2]].file_name, s[ids[2]].clips_enabled], [null, false], 'plus dans le studio');
  assert.deepEqual([s[ids[0]].clips_enabled, s[ids[1]].clips_enabled], [true, true]);
  assert.equal((await check.checkVideoFiles({ recheckMs: 0 })).reset, 0);
});

test('un fichier qui revient pendant la revérification n\'est pas retiré', { skip: !enabled }, async () => {
  await seed([[ids[0], `${ids[0]}.mp4`, old(), null], [ids[1], `${ids[1]}.mp4`, old(), null]]);
  await put(ids[0]);
  await fs.rm(path.join(dir, 'storage', 'videos', `${ids[1]}.mp4`), { force: true });
  const run = check.checkVideoFiles({ recheckMs: 300 });
  setTimeout(() => put(ids[1]), 100); // le fichier est remis en place pendant l'attente
  const r = await run;
  assert.deepEqual([r.missing, r.reset, (await state())[ids[1]].clips_enabled], [1, 0, true]);
});

test('prudence : fichier tout récent ignoré, dossier absent ou tous les fichiers manquants = rien de touché', { skip: !enabled }, async () => {
  // déposé il y a une minute : encore en cours de mise en place
  await seed([[ids[0], `${ids[0]}.mp4`, new Date(), null]]);
  assert.deepEqual([(await check.checkVideoFiles({ recheckMs: 0 })).checked, (await check.checkVideoFiles({ recheckMs: 0 })).reset], [0, 0]);
  // tous les fichiers manquent (volume probablement absent)
  await seed(ids.slice(0, 3).map((yt) => [yt, `${yt}.mp4`, old(), null]));
  for (const yt of ids) await fs.rm(path.join(dir, 'storage', 'videos', `${yt}.mp4`), { force: true });
  const all = await check.checkVideoFiles({ recheckMs: 0 });
  assert.match(all.skipped, /tous les fichiers/);
  assert.equal(Object.values(await state()).every((v) => v.clips_enabled), true);
  // dossier des vidéos absent (volume pas monté)
  await fs.rename(path.join(dir, 'storage', 'videos'), path.join(dir, 'storage', 'videos-away'));
  assert.match((await check.checkVideoFiles({ recheckMs: 0 })).skipped, /absent/);
  await fs.rename(path.join(dir, 'storage', 'videos-away'), path.join(dir, 'storage', 'videos'));
});
