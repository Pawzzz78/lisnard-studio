// Téléchargement automatique des vidéos : yt-dlp est remplacé par un petit script qui copie une vraie vidéo de test
// (nécessite Postgres via DATABASE_URL et ffmpeg ; les parties sans base de données tournent partout).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { FetchError, downloadVideo, ensureYtdlp, explainFailure, fetchConfig, ytdlpArgs } from '../src/video-fetch.js';

const run = promisify(execFile);
const enabled = Boolean(process.env.DATABASE_URL) && (await run('ffmpeg', ['-version']).then(() => true, () => false));
const ID = (n) => `VFtest_${String(n).padStart(4, '0')}`; // 11 caractères
const saved = { ...process.env };
let dir;
let stub;
let log;
let sample;
let db;
let vf;

const stubScript = `#!/bin/sh
echo "$@" >> "$STUB_LOG"
out=""; prev=""
for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
case "\${STUB_MODE:-ok}" in
  bot) echo "ERROR: [youtube] x: Sign in to confirm you’re not a bot" >&2; exit 1;;
  private) echo "ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video" >&2; exit 1;;
  generic) echo "ERROR: unable to download video data: HTTP Error 500" >&2; exit 1;;
  nofile) exit 0;;
esac
cp "$STUB_VIDEO" "$(echo "$out" | sed 's/%(ext)s/mp4/')"
`;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-fetch-'));
  log = path.join(dir, 'stub.log');
  stub = path.join(dir, 'yt-dlp');
  await fs.writeFile(stub, stubScript, { mode: 0o755 });
  Object.assign(process.env, { STORAGE_DIR: path.join(dir, 'storage'), YTDLP_PATH: stub, STUB_LOG: log, STUB_MODE: 'ok', STUDIO_FACES: 'off', AUTO_DOWNLOAD: 'on' });
  for (const k of ['YTDLP_PROXY', 'YTDLP_COOKIES_FILE', 'YTDLP_JS_RUNTIME', 'AUTO_DOWNLOAD_MIN_S', 'VIDEO_RETENTION_DAYS', 'AUTO_DOWNLOAD_MIN_FREE_MB']) delete process.env[k];
  if (!enabled) return;
  sample = path.join(dir, 'sample.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample]);
  process.env.STUB_VIDEO = sample;
  db = await import('../src/db.js');
  vf = await import('../src/video-fetch.js');
  await db.initDb();
  await db.pool.query("DELETE FROM videos WHERE youtube_id LIKE 'VFtest\\_%'");
  await db.pool.query("DELETE FROM settings WHERE key IN ('fetch_cooldown_until', 'fetch_last_error', 'ytdlp_updated_at', 'video_purge_at')");
});

after(async () => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  if (enabled) {
    await db.pool.query("DELETE FROM videos WHERE youtube_id LIKE 'VFtest\\_%'");
    await db.pool.query("DELETE FROM settings WHERE key IN ('fetch_cooldown_until', 'fetch_last_error', 'ytdlp_updated_at', 'video_purge_at')");
    await db.pool.end();
  }
  await fs.rm(dir, { recursive: true, force: true });
});

const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const mode = (m) => (process.env.STUB_MODE = m);

/** Vidéo synchronisée avec transcription (ou non), sans fichier. */
async function addVideo(n, { published = '1 day', duration = 700, sync = 'done', text = true, file = null, source = null, enabledClips = false } = {}) {
  const { rows } = await db.pool.query(
    `INSERT INTO videos (youtube_id, title, source, lang, sync_status, duration_s, published_at, file_name, file_size, file_duration_s, file_uploaded_at, file_source, clips_enabled)
     VALUES ($1, $2, 'supadata', 'fr', $3, $4, now() - $5::interval, $6, $7, $8, $9, $10, $11) RETURNING id, youtube_id, title, duration_s`,
    [ID(n), `Interview ${n}`, sync, duration, published, file, file ? 4 : null, file ? 4 : null, file ? new Date() : null, source, enabledClips],
  );
  if (text) await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, [{ start_ms: 0, duration_ms: 5000, text: 'bonjour à tous' }, { start_ms: 5000, duration_ms: 5000, text: 'merci' }, { start_ms: 10000, duration_ms: 5000, text: 'au revoir' }]));
  return rows[0];
}
const row = async (n) => (await db.pool.query('SELECT * FROM videos WHERE youtube_id = $1', [ID(n)])).rows[0];
const videoFile = (n) => path.join(process.env.STORAGE_DIR, 'videos', `${ID(n)}.mp4`);
const exists = (f) => fs.stat(f).then(() => true, () => false);

// --- sans base de données ----------------------------------------------------------------------------------------------------------------

test('arguments de yt-dlp : 720p au plus, une seule vidéo, adresse construite par le site, proxy et cookies facultatifs', () => {
  const cfg = fetchConfig();
  const args = ytdlpArgs('abcDEF_1234', '/tmp/x.%(ext)s', cfg);
  assert.ok(args.includes('--no-playlist'));
  assert.match(args[args.indexOf('-f') + 1], /height<=720/);
  assert.equal(args[args.indexOf('-o') + 1], '/tmp/x.%(ext)s');
  assert.equal(args[args.indexOf('--merge-output-format') + 1], 'mp4');
  assert.equal(Number(args[args.indexOf('--max-filesize') + 1]) > 0, true);
  assert.deepEqual(args.slice(args.indexOf('--js-runtimes'), args.indexOf('--js-runtimes') + 2), ['--js-runtimes', 'node']);
  assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=abcDEF_1234']); // après « -- » : jamais pris pour une option
  assert.ok(!args.includes('--proxy') && !args.includes('--cookies'));
  Object.assign(process.env, { YTDLP_PROXY: 'http://proxy.test:8080', YTDLP_COOKIES_FILE: '/data/cookies.txt', YTDLP_JS_RUNTIME: 'off', AUTO_DOWNLOAD_MAX_HEIGHT: '480' });
  try {
    const more = ytdlpArgs('abcDEF_1234', '/tmp/x.%(ext)s', fetchConfig());
    assert.equal(more[more.indexOf('--proxy') + 1], 'http://proxy.test:8080');
    assert.equal(more[more.indexOf('--cookies') + 1], '/data/cookies.txt');
    assert.ok(!more.includes('--js-runtimes'));
    assert.match(more[more.indexOf('-f') + 1], /height<=480/);
  } finally {
    for (const k of ['YTDLP_PROXY', 'YTDLP_COOKIES_FILE', 'YTDLP_JS_RUNTIME', 'AUTO_DOWNLOAD_MAX_HEIGHT']) delete process.env[k];
  }
});

test('échecs de yt-dlp : message clair et décision (bloqué, indisponible, autre)', () => {
  const code = (s) => explainFailure(s).code;
  assert.equal(code("ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser"), 'blocked');
  assert.equal(code('ERROR: HTTP Error 429: Too Many Requests'), 'blocked');
  assert.equal(code("ERROR: [youtube] x: Private video. Sign in if you've been granted access"), 'unavailable');
  assert.equal(code('ERROR: [youtube] x: Video unavailable'), 'unavailable');
  assert.equal(code('ERROR: File is larger than max-filesize (3000000000 bytes > 2000000000 bytes). Aborting.'), 'unavailable');
  const other = explainFailure('WARNING: x\nERROR: unable to download video data: HTTP Error 500');
  assert.equal(other.code, 'other');
  assert.match(other.message, /HTTP Error 500/);
  assert.match(explainFailure('ERROR: Sign in to confirm you’re not a bot').message, /proxy ou des cookies/);
  assert.ok(explainFailure('') instanceof FetchError);
});

test('installation de yt-dlp : somme de contrôle vérifiée, aucun exécutable si elle ne correspond pas', async () => {
  const storage = path.join(dir, 'install');
  const saveBin = process.env.YTDLP_PATH;
  delete process.env.YTDLP_PATH;
  process.env.STORAGE_DIR = storage;
  try {
    const binary = Buffer.from('#!/bin/sh\necho 2099.01.01\n');
    const name = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
    const good = crypto.createHash('sha256').update(binary).digest('hex');
    const seen = [];
    const mk = (sum) => async (url) => {
      seen.push(url);
      return url.endsWith('SHA2-256SUMS') ? new Response(`${sum}  ${name}\n${'0'.repeat(64)}  autre-fichier\n`) : new Response(binary);
    };
    await assert.rejects(ensureYtdlp({ fetchImpl: mk('f'.repeat(64)) }), /Somme de contrôle/);
    assert.equal(await exists(path.join(storage, 'bin', 'yt-dlp')), false);
    assert.equal(await ensureYtdlp({ fetchImpl: mk(good) }), path.join(storage, 'bin', 'yt-dlp'));
    assert.ok(((await fs.stat(path.join(storage, 'bin', 'yt-dlp'))).mode & 0o111) !== 0, 'exécutable');
    assert.ok(seen.every((u) => u.startsWith('https://github.com/yt-dlp/yt-dlp/releases/latest/download/')));
    const before = seen.length;
    await ensureYtdlp({ fetchImpl: mk('f'.repeat(64)) }); // déjà installé : rien n'est retéléchargé
    assert.equal(seen.length, before);
    await assert.rejects(ensureYtdlp({ fetchImpl: async () => new Response('', { status: 404 }) }).then(async () => {
      await fs.rm(path.join(storage, 'bin'), { recursive: true });
      return ensureYtdlp({ fetchImpl: async () => new Response('', { status: 404 }) });
    }), /Téléchargement de yt-dlp impossible/);
  } finally {
    process.env.YTDLP_PATH = saveBin;
    process.env.STORAGE_DIR = path.join(dir, 'storage');
  }
});

test('téléchargement : le fichier arrive dans uploads/<id>.part, rien ne traîne en cas d\'échec', { skip: !enabled }, async () => {
  await fs.rm(log, { force: true });
  mode('ok');
  const size = await downloadVideo(ID(90));
  assert.equal(size, (await fs.stat(sample)).size);
  assert.equal(await exists(path.join(process.env.STORAGE_DIR, 'uploads', `${ID(90)}.part`)), true);
  assert.match((await calls())[0], /watch\?v=VFtest_0090$/);
  await fs.rm(path.join(process.env.STORAGE_DIR, 'uploads', `${ID(90)}.part`), { force: true });
  mode('nofile');
  await assert.rejects(downloadVideo(ID(90)), /aucun fichier vidéo/);
  mode('bot');
  await assert.rejects(downloadVideo(ID(90)), (e) => e.code === 'blocked');
  const left = await fs.readdir(path.join(process.env.STORAGE_DIR, 'uploads'));
  assert.deepEqual(left.filter((n) => n.startsWith(ID(90))), []);
  mode('ok');
});

// --- avec la base de données ----------------------------------------------------------------------------------------------------------

test('choix des vidéos : synchronisées, transcrites, longues, récentes, sans fichier, pas en échec', { skip: !enabled }, async () => {
  const ok = await addVideo(1);
  await addVideo(2, { text: false }); // pas de transcription (traitement en pause : pas de fichier à stocker)
  await addVideo(3, { duration: 300 }); // trop courte (format long seulement)
  await addVideo(4, { published: '120 days' }); // plus vieille que la durée de conservation
  await addVideo(5, { sync: null }); // ajoutée à la main : jamais touchée
  await addVideo(6, { file: `${ID(6)}.mp4`, source: null }); // a déjà un fichier
  await addVideo(7);
  await db.pool.query("UPDATE videos SET fetch_attempts = 5 WHERE youtube_id = $1", [ID(7)]); // en échec définitif
  await addVideo(8);
  await db.pool.query("UPDATE videos SET fetch_next_at = now() + interval '3 hours', fetch_attempts = 1 WHERE youtube_id = $1", [ID(8)]); // nouvelle tentative plus tard
  const mine = (await vf.pendingVideos(500)).filter((v) => v.youtube_id.startsWith('VFtest_'));
  assert.deepEqual(mine.map((v) => v.youtube_id), [ok.youtube_id]);
  // les plus récentes d'abord
  await addVideo(9, { published: '2 hours' });
  assert.deepEqual((await vf.pendingVideos(500)).filter((v) => v.youtube_id.startsWith('VFtest_')).map((v) => v.youtube_id), [ID(9), ID(1)]);
  await db.pool.query("DELETE FROM videos WHERE youtube_id LIKE 'VFtest\\_%' AND youtube_id <> $1", [ID(90)]);
});

test('téléchargement réussi : fichier validé et rangé, vidéo marquée « auto », échecs précédents effacés', { skip: !enabled }, async () => {
  const v = await addVideo(10, { duration: 4 }); // durée de la vidéo de test : 4 s
  await db.pool.query("UPDATE videos SET fetch_attempts = 2, fetch_error = 'ancienne erreur' WHERE id = $1", [v.id]);
  await fs.rm(log, { force: true });
  assert.equal(await vf.fetchVideo(v), true);
  const r = await row(10);
  assert.deepEqual([r.file_name, r.file_source, r.fetch_attempts, r.fetch_error, r.file_has_audio, r.file_width, r.file_height], [`${ID(10)}.mp4`, 'auto', 0, null, true, 320, 180]);
  assert.ok(r.file_duration_s >= 3.5 && r.file_duration_s <= 4.5);
  assert.equal(await exists(videoFile(10)), true);
  assert.equal(await exists(path.join(process.env.STORAGE_DIR, 'uploads', `${ID(10)}.part`)), false);
  assert.equal((await calls()).length, 1);
  assert.equal(r.clips_enabled, false); // l'autorisation des clips est une étape séparée
});

test('clips autorisés automatiquement, une seule fois, seulement pour les fichiers téléchargés par le site', { skip: !enabled }, async () => {
  const manual = await addVideo(11, { file: `${ID(11)}.mp4`, source: null }); // déposée à la main : l'admin décide
  const suggested = [];
  const suggest = async (id) => {
    suggested.push(id);
    return { clips: [] };
  };
  // cloud retranscription on: nothing is published before it is over
  assert.equal(await vf.enableReadyClips({ suggest, retxOn: true }), 0);
  assert.equal((await row(10)).clips_enabled, false);
  await db.pool.query("UPDATE videos SET source = 'grok' WHERE youtube_id = $1", [ID(10)]);
  const n = await vf.enableReadyClips({ suggest, retxOn: true });
  assert.ok(n >= 1);
  const auto = await row(10);
  assert.deepEqual([auto.clips_enabled, auto.auto_enabled_at !== null], [true, true]);
  assert.ok(suggested.includes(auto.id));
  assert.equal((await row(11)).clips_enabled, false);
  assert.ok(!suggested.includes(manual.id));
  // l'admin désactive les clips : le choix est respecté
  await db.pool.query('UPDATE videos SET clips_enabled = FALSE WHERE id = $1', [auto.id]);
  suggested.length = 0;
  await vf.enableReadyClips({ suggest, retxOn: false });
  assert.equal((await row(10)).clips_enabled, false);
  assert.ok(!suggested.includes(auto.id));
  // option désactivée : rien n'est autorisé
  const other = await addVideo(12, { duration: 4 });
  await vf.fetchVideo(other);
  assert.equal(await vf.enableReadyClips({ suggest, retxOn: false, cfg: { ...fetchConfig(), enableClips: false } }), 0);
  assert.equal((await row(12)).clips_enabled, false);
});

test('échecs : blocage de YouTube = pause sans compter, vidéo indisponible = définitif, autre = nouvelle tentative plus tard', { skip: !enabled }, async () => {
  const cooldown = async () => (await db.pool.query("SELECT value FROM settings WHERE key = 'fetch_cooldown_until'")).rows[0]?.value;
  const v = await addVideo(20, { duration: 4 });
  mode('bot');
  assert.equal(await vf.fetchVideo(v), false);
  let r = await row(20);
  assert.deepEqual([r.fetch_attempts, r.file_name], [0, null]);
  assert.match(r.fetch_error, /bloque le téléchargement/);
  assert.ok(new Date(await cooldown()) > new Date(Date.now() + 2 * 3600_000), 'pause de quelques heures');
  // pendant la pause, un passage ne télécharge rien
  await fs.rm(log, { force: true });
  assert.equal((await vf.runFetchCycle({ exec: undefined, limit: 50 })).fetched, 0);
  assert.equal((await calls()).length, 0);
  assert.equal(await vf.retryFailed() >= 1, true); // « Réessayer » lève la pause
  assert.equal(await cooldown() ?? null, null);

  mode('private');
  await vf.fetchVideo(v);
  r = await row(20);
  assert.deepEqual([r.fetch_attempts, /indisponible/.test(r.fetch_error)], [5, true]);
  assert.equal((await vf.pendingVideos(500)).some((p) => p.youtube_id === ID(20)), false);

  await vf.retryFailed();
  mode('generic');
  await vf.fetchVideo(v);
  r = await row(20);
  assert.equal(r.fetch_attempts, 1);
  const wait = (new Date(r.fetch_next_at) - Date.now()) / 3600_000;
  assert.ok(wait > 1.5 && wait <= 2.01, `prochaine tentative dans ${wait} h`);
  await vf.fetchVideo({ ...v });
  assert.ok((new Date((await row(20)).fetch_next_at) - Date.now()) / 3600_000 > 3.5, 'délai doublé à la 2e tentative');
  mode('ok');
  await vf.retryFailed();
});

test('fichier de durée différente ou espace insuffisant : écarté, rien n\'est attaché', { skip: !enabled }, async () => {
  const wrong = await addVideo(30, { duration: 100 }); // la vidéo YouTube dure 100 s, le fichier 4 s
  assert.equal(await vf.fetchVideo(wrong), false);
  const r = await row(30);
  assert.equal(r.file_name, null);
  assert.match(r.fetch_error, /différente/);
  assert.equal(await exists(videoFile(30)), false);

  const ok = await addVideo(31, { duration: 4 });
  await fs.rm(log, { force: true });
  assert.equal(await vf.fetchVideo(ok, { cfg: { ...fetchConfig(), minFreeMb: 10 ** 9 } }), false);
  const full = await row(31);
  assert.deepEqual([full.file_name, full.fetch_attempts], [null, 0]); // pas de tentative comptée : le nettoyage libérera de la place
  assert.match(full.fetch_error, /Espace libre insuffisant/);
  assert.equal((await calls()).length, 0, 'rien n\'est téléchargé quand il n\'y a pas de place');
});

test('un fichier déposé à la main pendant le téléchargement n\'est jamais remplacé', { skip: !enabled }, async () => {
  const v = await addVideo(40, { duration: 4 });
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  await fs.writeFile(videoFile(40), 'FICHIER DEPOSE A LA MAIN'); // l'admin vient de le déposer
  const exec = async (bin, args, opts) => {
    const out = await run(bin, args, opts);
    await db.pool.query("UPDATE videos SET file_name = $2, file_size = 4, file_duration_s = 4, file_uploaded_at = now() WHERE id = $1", [v.id, `${ID(40)}.mp4`]);
    return out;
  };
  assert.equal(await vf.fetchVideo(v, { exec }), false);
  const r = await row(40);
  assert.deepEqual([r.file_name, r.file_source], [`${ID(40)}.mp4`, null]);
  assert.equal(await exists(path.join(process.env.STORAGE_DIR, 'uploads', `${ID(40)}.part`)), false);
  assert.equal(await fs.readFile(videoFile(40), 'utf8'), 'FICHIER DEPOSE A LA MAIN'); // le fichier manuel est intact : le site ne l'a ni remplacé ni supprimé
});

test('conservation : fichiers téléchargés supprimés après 90 jours, jamais ceux déposés à la main', { skip: !enabled }, async () => {
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  const make = async (n, opts) => {
    const v = await addVideo(n, { file: `${ID(n)}.mp4`, ...opts });
    await fs.copyFile(sample, videoFile(n));
    return v;
  };
  const oldAuto = await make(50, { published: '100 days', source: 'auto', enabledClips: true });
  await make(51, { published: '100 days', source: null, enabledClips: true }); // manuel
  await make(52, { published: '10 days', source: 'auto', enabledClips: true }); // récent
  await make(53, { published: '100 days', source: 'auto', enabledClips: true }); // clip en cours de création
  await db.pool.query('INSERT INTO video_faces (video_id, file_stamp, frames, fps, status) VALUES ($1, $2, $3, 5, $4) ON CONFLICT DO NOTHING', [oldAuto.id, 'x', '[]', 'ready']).catch(() => {});
  const removed = await vf.purgeOldFiles({ inUse: (yt) => yt === ID(53) });
  assert.ok(removed >= 1);
  const gone = await row(50);
  assert.deepEqual([gone.file_name, gone.file_source, gone.clips_enabled, gone.file_size], [null, null, false, null]);
  assert.equal(await exists(videoFile(50)), false);
  assert.equal((await db.pool.query('SELECT 1 FROM video_faces WHERE video_id = $1', [oldAuto.id]).catch(() => ({ rows: [] }))).rows.length, 0);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM segments WHERE video_id = $1', [oldAuto.id])).rows[0].n, 3); // la transcription reste
  for (const n of [51, 52, 53]) {
    assert.equal((await row(n)).file_name, `${ID(n)}.mp4`, `vidéo ${n} intacte`);
    assert.equal(await exists(videoFile(n)), true);
  }
  assert.equal((await row(51)).clips_enabled, true);
  // durée de conservation réglable
  process.env.VIDEO_RETENTION_DAYS = '5';
  assert.ok((await vf.purgeOldFiles({ cfg: fetchConfig(), inUse: () => false })) >= 2);
  assert.equal(await exists(videoFile(52)), false);
  assert.equal(await exists(videoFile(51)), true); // toujours le fichier manuel
  delete process.env.VIDEO_RETENTION_DAYS;
});

test('passage complet : désactivé = rien ; activé = téléchargement, clips autorisés ; vue d\'ensemble pour l\'admin', { skip: !enabled }, async () => {
  process.env.AUTO_DOWNLOAD = 'off';
  assert.deepEqual(await vf.runFetchCycle(), { skipped: 'désactivé' });
  process.env.AUTO_DOWNLOAD = 'on';
  await db.pool.query("DELETE FROM videos WHERE youtube_id LIKE 'VFtest\\_%' AND youtube_id <> $1", [ID(90)]);
  const v = await addVideo(60, { duration: 4, published: '1 minute' });
  // les autres tests partagent la base : on ne laisse le passage toucher que notre vidéo
  const suggested = [];
  const out = await vf.runFetchCycle({ exec: (bin, args, opts) => (args.join(' ').includes(ID(60)) ? run(bin, args, opts) : Promise.reject(Object.assign(new Error('autre vidéo'), { stderr: 'ERROR: Video unavailable' }))), limit: 1, suggest: async (id) => suggested.push(id), cfg: { ...fetchConfig(), minDurationS: 4 } });
  assert.equal(out.fetched, 1);
  assert.equal((await row(60)).file_source, 'auto');
  assert.equal((await row(60)).clips_enabled, true);
  assert.ok(suggested.includes(v.id));
  const o = await vf.filesOverview();
  assert.deepEqual([o.enabled, o.max_height, o.retention_days, typeof o.downloaded, typeof o.waiting, typeof o.bytes], [true, 720, 90, 'number', 'number', 'number']);
  assert.ok(o.downloaded >= 1 && o.bytes > 0);
});
