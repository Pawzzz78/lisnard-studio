/**
 * Téléchargement automatique des interviews pour le studio de clips.
 *
 *  1. Dès qu'une vidéo synchronisée a sa transcription, son fichier est téléchargé avec yt-dlp (outil libre) en 720p au plus, validé avec
 *     ffprobe (mêmes contrôles qu'un dépôt à la main) et rangé sur le volume (<STORAGE_DIR>/videos). La base ne garde que ses références.
 *  2. Les clips sont alors autorisés tout seuls (une seule fois : si l'admin les désactive ensuite, le choix est respecté) et les extraits
 *     sont proposés par le modèle.
 *  3. Les fichiers téléchargés par le site (file_source = 'auto') sont supprimés après VIDEO_RETENTION_DAYS jours (90 par défaut), jamais
 *     ceux déposés à la main. La transcription et les réglages des clips restent.
 *
 * Variables : voir .env.example (AUTO_DOWNLOAD, AUTO_DOWNLOAD_*, VIDEO_RETENTION_DAYS, YTDLP_*).
 * Les noms de fichiers ne viennent que de l'identifiant YouTube (11 caractères sûrs) ; yt-dlp est lancé sans shell, avec l'adresse
 * construite par nos soins.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { generateClipSuggestions, getClipSuggestions } from './clip-suggestions.js';
import { pool } from './db.js';
import { DURATION_TOLERANCE_S, finishUpload, maxVideoBytes, partPath, removeVideoFiles, storageDir } from './media.js';
import { llmConfigured } from './openrouter.js';
import { getSetting, setSetting } from './settings.js';
import { autoAnalyze, removeFaces } from './studio/faces.js';
import { videoInUse } from './studio/render.js';

const run = promisify(execFile);
const HOUR = 3600 * 1000;
const LOCK_ID = 727002;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const flag = (v, d) => (v == null || v === '' ? d : /^(on|true|1|oui)$/i.test(String(v)));

export const fetchConfig = () => ({
  enabled: flag(process.env.AUTO_DOWNLOAD, false),
  maxHeight: Math.min(2160, Math.max(240, num(process.env.AUTO_DOWNLOAD_MAX_HEIGHT, 720))),
  minDurationS: Math.max(0, num(process.env.AUTO_DOWNLOAD_MIN_S, 600)), // format long seulement
  retentionDays: Math.max(1, num(process.env.VIDEO_RETENTION_DAYS, 90)),
  minFreeMb: Math.max(0, num(process.env.AUTO_DOWNLOAD_MIN_FREE_MB, 1500)),
  timeoutMin: Math.max(1, num(process.env.AUTO_DOWNLOAD_TIMEOUT_MIN, 60)),
  enableClips: flag(process.env.AUTO_ENABLE_CLIPS, true),
  maxAttempts: 5,
});

export class FetchError extends Error {
  constructor(message, code = 'other') {
    super(message);
    this.code = code;
  }
}

// --- yt-dlp : installation et mise à jour -------------------------------------------------------------------------------------------------

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
export const ytdlpPath = () => process.env.YTDLP_PATH || path.join(storageDir(), 'bin', 'yt-dlp');
const assetName = () => (process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux');
const exists = (file) => fs.stat(file).then((s) => s.isFile(), () => false);

/**
 * Programme yt-dlp prêt à l'emploi : celui de YTDLP_PATH, sinon l'exécutable officiel (version autonome, sans Python) téléchargé une fois
 * dans <STORAGE_DIR>/bin et vérifié avec la somme SHA-256 publiée avec la version.
 */
export async function ensureYtdlp({ fetchImpl = fetch } = {}) {
  const file = ytdlpPath();
  if (process.env.YTDLP_PATH || (await exists(file))) return file;
  const get = async (name) => {
    const res = await fetchImpl(`${RELEASE}/${name}`, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new FetchError(`Téléchargement de yt-dlp impossible (${name} : ${res.status}).`, 'tool');
    return Buffer.from(await res.arrayBuffer());
  };
  const name = assetName();
  const [binary, sums] = await Promise.all([get(name), get('SHA2-256SUMS')]);
  const expected = sums.toString('utf8').split('\n').map((l) => l.trim().split(/\s+/)).find(([, n]) => n === name)?.[0];
  const actual = crypto.createHash('sha256').update(binary).digest('hex');
  if (!expected || expected.toLowerCase() !== actual) throw new FetchError('Somme de contrôle de yt-dlp incorrecte : installation refusée.', 'tool');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, binary, { mode: 0o755 });
  await fs.rename(tmp, file);
  return file;
}

/** Met yt-dlp à jour (YouTube change souvent) au plus une fois par jour ; sans effet si YTDLP_PATH est imposé. */
export async function updateYtdlp({ exec = run, now = Date.now() } = {}) {
  if (process.env.YTDLP_PATH) return false;
  const last = await getSetting('ytdlp_updated_at', null);
  if (last && now - Date.parse(last) < 24 * HOUR) return false;
  await setSetting('ytdlp_updated_at', new Date(now).toISOString());
  await exec(await ensureYtdlp(), ['-U'], { timeout: 120_000 }).catch((e) => console.error(`yt-dlp : mise à jour impossible : ${String(e.stderr || e.message).slice(0, 200)}`));
  return true;
}

export async function ytdlpVersion({ exec = run } = {}) {
  const file = ytdlpPath();
  if (!(await exists(file))) return null;
  return exec(file, ['--version'], { timeout: 20_000 }).then((r) => String(r.stdout).trim(), () => null);
}

// --- téléchargement -------------------------------------------------------------------------------------------------------------------------

/** Message pour l'admin et décision de nouvelle tentative à partir de ce que yt-dlp a écrit. */
export function explainFailure(stderr) {
  const text = String(stderr ?? '');
  const last = text.split('\n').reverse().find((l) => /ERROR/i.test(l)) ?? text.trim().split('\n').pop() ?? '';
  if (/sign in to confirm|not a bot|confirm you.re not a bot|cookies/i.test(text)) {
    return new FetchError("YouTube bloque le téléchargement depuis ce serveur (contrôle « robot »). Il faut un proxy ou des cookies (YTDLP_PROXY / YTDLP_COOKIES_FILE).", 'blocked');
  }
  if (/HTTP Error 429|too many requests/i.test(text)) return new FetchError('YouTube limite les téléchargements depuis ce serveur (429).', 'blocked');
  if (/private video|video unavailable|has been removed|members-only|age.restricted|not available in your country|live event will begin/i.test(text)) {
    return new FetchError(`Vidéo indisponible au téléchargement : ${last.replace(/^ERROR:\s*(\[[^\]]*\]\s*)?/i, '').slice(0, 160)}`, 'unavailable');
  }
  if (/larger than max-filesize|File is larger/i.test(text)) return new FetchError('Vidéo trop volumineuse (limite MAX_VIDEO_MB).', 'unavailable');
  return new FetchError(`yt-dlp a échoué : ${last.replace(/^ERROR:\s*/i, '').slice(0, 220) || 'erreur inconnue'}`, 'other');
}

/** Arguments de yt-dlp : 720p au plus, MP4, une seule vidéo, aucune interaction. */
export function ytdlpArgs(youtubeId, outTemplate, cfg = fetchConfig()) {
  const h = cfg.maxHeight;
  const args = [
    '--no-playlist', '--no-progress', '--no-warnings', '--no-cache-dir', '--no-mtime',
    '--socket-timeout', '30', '--retries', '5', '--fragment-retries', '5',
    '-f', `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]`,
    '--merge-output-format', 'mp4',
    '--max-filesize', String(maxVideoBytes()),
    '-o', outTemplate,
  ];
  // YouTube demande aujourd'hui un moteur JavaScript pour déchiffrer ses adresses : Node est déjà là
  if (process.env.YTDLP_JS_RUNTIME !== 'off') args.push('--js-runtimes', process.env.YTDLP_JS_RUNTIME || 'node');
  if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY);
  if (process.env.YTDLP_COOKIES_FILE) args.push('--cookies', process.env.YTDLP_COOKIES_FILE);
  args.push('--', `https://www.youtube.com/watch?v=${youtubeId}`);
  return args;
}

const TEMP = (youtubeId) => new RegExp(`^${youtubeId}\\.dl\\.`);

async function clearTemp(youtubeId) {
  const dir = path.join(storageDir(), 'uploads');
  for (const name of await fs.readdir(dir).catch(() => [])) if (TEMP(youtubeId).test(name)) await fs.rm(path.join(dir, name), { force: true });
}

/** Télécharge la vidéo vers uploads/<id>.part (prêt pour finishUpload). Renvoie la taille en octets. */
export async function downloadVideo(youtubeId, { exec = run, cfg = fetchConfig() } = {}) {
  const dir = path.join(storageDir(), 'uploads');
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(storageDir(), 'videos'), { recursive: true }); // finishUpload y range le fichier validé
  await clearTemp(youtubeId);
  const binary = await ensureYtdlp();
  try {
    await exec(binary, ytdlpArgs(youtubeId, path.join(dir, `${youtubeId}.dl.%(ext)s`), cfg), { timeout: cfg.timeoutMin * 60_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    await clearTemp(youtubeId);
    if (e.code === 'ENOENT') throw new FetchError('yt-dlp est introuvable sur le serveur.', 'tool');
    if (e.killed || e.signal) throw new FetchError(`Téléchargement interrompu après ${cfg.timeoutMin} min.`, 'other');
    throw explainFailure(`${e.stderr ?? ''}\n${e.message ?? ''}`);
  }
  const produced = (await fs.readdir(dir)).find((n) => new RegExp(`^${youtubeId}\\.dl\\.(mp4|mkv|webm)$`).test(n));
  if (!produced) {
    await clearTemp(youtubeId);
    throw new FetchError('yt-dlp n\'a produit aucun fichier vidéo.', 'other');
  }
  await fs.rename(path.join(dir, produced), partPath(youtubeId));
  await clearTemp(youtubeId);
  return (await fs.stat(partPath(youtubeId))).size;
}

// --- choix et traitement des vidéos ---------------------------------------------------------------------------------------------------

/** Vidéos à télécharger : synchronisées, transcrites, longues, récentes, sans fichier, et pas en échec définitif ni en attente de nouvelle tentative. */
export async function pendingVideos(limit = 1, cfg = fetchConfig()) {
  const { rows } = await pool.query(
    `SELECT v.id, v.youtube_id, v.title, v.duration_s FROM videos v
     WHERE v.sync_status IS NOT NULL AND v.file_name IS NULL AND v.norm_text <> ''
       AND v.duration_s IS NOT NULL AND v.duration_s >= $1
       AND (v.published_at IS NULL OR v.published_at >= now() - make_interval(days => $2::int))
       AND v.fetch_attempts < $3 AND (v.fetch_next_at IS NULL OR v.fetch_next_at <= now())
     ORDER BY v.published_at DESC NULLS LAST, v.id DESC LIMIT $4`,
    [cfg.minDurationS, cfg.retentionDays, cfg.maxAttempts, limit],
  );
  return rows;
}

async function freeMb() {
  try {
    const st = await fs.statfs(storageDir());
    return Math.floor((st.bavail * st.bsize) / 1024 / 1024);
  } catch {
    return Infinity;
  }
}

async function recordFailure(v, e, cfg) {
  const code = e instanceof FetchError ? e.code : 'other';
  const message = (e instanceof FetchError ? e.message : `Erreur : ${e.message}`).slice(0, 400);
  if (code === 'blocked') {
    // YouTube nous bloque : inutile d'insister sur chaque vidéo, on réessaie dans quelques heures
    await setSetting('fetch_cooldown_until', new Date(Date.now() + 3 * HOUR).toISOString());
    await pool.query('UPDATE videos SET fetch_error = $2 WHERE id = $1', [v.id, message]);
  } else if (code === 'space') {
    await pool.query('UPDATE videos SET fetch_error = $2 WHERE id = $1', [v.id, message]); // le nettoyage ou l'admin libérera de la place
  } else if (code === 'unavailable') {
    await pool.query('UPDATE videos SET fetch_attempts = $3, fetch_error = $2 WHERE id = $1', [v.id, message, cfg.maxAttempts]);
  } else {
    await pool.query(
      `UPDATE videos SET fetch_attempts = fetch_attempts + 1, fetch_error = $2,
         fetch_next_at = now() + least(interval '24 hours', interval '1 hour' * power(2, fetch_attempts + 1)) WHERE id = $1`,
      [v.id, message],
    );
  }
  await setSetting('fetch_last_error', `${new Date().toISOString()} — ${v.title ?? v.youtube_id} : ${message}`);
}

/** Télécharge, valide et attache le fichier d'une vidéo. Renvoie true si le fichier est en place. */
export async function fetchVideo(v, { exec, cfg = fetchConfig() } = {}) {
  try {
    if ((await freeMb()) < cfg.minFreeMb) throw new FetchError(`Espace libre insuffisant sur le volume (moins de ${cfg.minFreeMb} Mo).`, 'space');
    const size = await downloadVideo(v.youtube_id, { exec, cfg });
    // un fichier déposé à la main entre-temps a priorité : on ne le remplace jamais
    const { rows: still } = await pool.query('SELECT 1 FROM videos WHERE id = $1 AND file_name IS NULL', [v.id]);
    if (!still[0]) {
      await fs.rm(partPath(v.youtube_id), { force: true });
      return false;
    }
    const meta = await finishUpload(v.youtube_id, size);
    if (v.duration_s != null && Math.abs(meta.duration_s - v.duration_s) > DURATION_TOLERANCE_S) {
      await removeVideoFiles(v.youtube_id);
      throw new FetchError(`Durée du fichier (${meta.duration_s} s) différente de celle de la vidéo YouTube (${v.duration_s} s) : fichier écarté.`, 'other');
    }
    const { rowCount } = await pool.query(
      `UPDATE videos SET file_name = $2, file_size = $3, file_duration_s = $4, file_width = $5, file_height = $6, file_has_audio = $7,
         file_uploaded_at = now(), file_source = 'auto', fetch_attempts = 0, fetch_next_at = NULL, fetch_error = NULL
       WHERE id = $1 AND file_name IS NULL`,
      [v.id, meta.name, meta.size, meta.duration_s, meta.width, meta.height, meta.has_audio],
    );
    if (!rowCount) return false; // un fichier a été déposé à la main dans l'intervalle : on n'y touche pas
    await removeFaces(v.id);
    const { rows } = await pool.query(
      'SELECT id, youtube_id, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at FROM videos WHERE id = $1',
      [v.id],
    );
    if (rows[0]) autoAnalyze(rows[0]); // détection des visages pour le cadrage automatique
    return true;
  } catch (e) {
    await recordFailure(v, e, cfg);
    console.error(`vidéos : ${v.youtube_id} : ${e.message}`);
    return false;
  }
}

/** Autorise les clips des vidéos téléchargées par le site, une seule fois, et lance la proposition d'extraits. */
export async function enableReadyClips({ suggest = generateClipSuggestions, cfg = fetchConfig(), retxOn } = {}) {
  if (!cfg.enableClips) return 0;
  // With the cloud retranscription on, publish only once it is over (done, or failed and kept the initial text):
  // clips and subtitles come from the Grok text, never from the YouTube captions it replaces
  const waitRetx = retxOn ?? (llmConfigured() && !(await getSetting('retx_settings', {}))?.paused);
  const retxOver = waitRetx
    ? `AND (source = 'grok' OR retx_status IN ('initial', 'restored') OR edited OR COALESCE(translated, FALSE) OR NOT COALESCE(file_has_audio, FALSE))`
    : '';
  const { rows } = await pool.query(
    `SELECT id FROM videos WHERE file_source = 'auto' AND file_name IS NOT NULL AND norm_text <> '' AND auto_enabled_at IS NULL AND NOT clips_enabled ${retxOver} ORDER BY id`,
  );
  for (const { id } of rows) {
    const { rowCount } = await pool.query('UPDATE videos SET clips_enabled = TRUE, auto_enabled_at = now() WHERE id = $1 AND auto_enabled_at IS NULL', [id]);
    if (!rowCount) continue;
    if (llmConfigured() || suggest !== generateClipSuggestions) {
      try {
        if (!(await getClipSuggestions(id))) await suggest(id);
      } catch (e) {
        console.error(`vidéos : extraits de la vidéo ${id} : ${e.message}`); // les extraits pourront être relancés depuis l'admin
      }
    }
  }
  // vidéo déjà autorisée à la main avant : on note qu'on n'a plus rien à faire
  await pool.query(`UPDATE videos SET auto_enabled_at = now() WHERE file_source = 'auto' AND clips_enabled AND auto_enabled_at IS NULL`);
  return rows.length;
}

/** Supprime les fichiers téléchargés par le site au-delà de la durée de conservation ; la transcription et les clips restent. */
export async function purgeOldFiles({ cfg = fetchConfig(), inUse = videoInUse } = {}) {
  const { rows } = await pool.query(
    `SELECT id, youtube_id FROM videos
     WHERE file_source = 'auto' AND file_name IS NOT NULL
       AND COALESCE(published_at, file_uploaded_at) < now() - make_interval(days => $1::int)`,
    [cfg.retentionDays],
  );
  let removed = 0;
  for (const v of rows) {
    if (inUse(v.youtube_id)) continue; // un clip est en cours de création : on réessaiera au prochain passage
    await removeVideoFiles(v.youtube_id);
    await removeFaces(v.id);
    await pool.query(
      `UPDATE videos SET file_name = NULL, file_size = NULL, file_duration_s = NULL, file_width = NULL, file_height = NULL, file_has_audio = NULL,
         file_uploaded_at = NULL, file_source = NULL, clips_enabled = FALSE, auto_enabled_at = NULL WHERE id = $1 AND file_source = 'auto'`,
      [v.id],
    );
    removed++;
  }
  // restes d'un téléchargement interrompu
  const dir = path.join(storageDir(), 'uploads');
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!/^[A-Za-z0-9_-]{11}\.dl\./.test(name)) continue;
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 6 * HOUR) await fs.rm(path.join(dir, name), { force: true });
  }
  return removed;
}

// --- cycle et planificateur -----------------------------------------------------------------------------------------------------------

let running = false;

/** Un passage : mise à jour de yt-dlp, clips à autoriser, nettoyage (au plus toutes les 6 h), puis une vidéo à télécharger. */
export async function runFetchCycle(deps = {}) {
  const cfg = deps.cfg ?? fetchConfig();
  if (!cfg.enabled) return { skipped: 'désactivé' };
  if (running) return { skipped: 'déjà en cours' };
  running = true;
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    if (!rows[0].locked) return { skipped: 'déjà en cours' };
    const out = { purged: 0, fetched: 0, failed: 0, enabled: 0 };
    if (!deps.exec) await updateYtdlp().catch((e) => console.error(`yt-dlp : ${e.message}`));
    const lastPurge = await getSetting('video_purge_at', null);
    if (deps.forcePurge || !lastPurge || Date.now() - Date.parse(lastPurge) > 6 * HOUR) {
      out.purged = await purgeOldFiles({ cfg, inUse: deps.inUse });
      await setSetting('video_purge_at', new Date().toISOString());
    }
    const paused = async () => {
      const until = await getSetting('fetch_cooldown_until', null);
      return Boolean(until && new Date(until) > new Date());
    };
    if (!(await paused())) {
      for (const v of await pendingVideos(deps.limit ?? 1, cfg)) {
        if (await fetchVideo(v, { exec: deps.exec, cfg })) out.fetched++;
        else out.failed++;
        if (await paused()) break; // YouTube nous bloque : on s'arrête là
      }
    }
    out.enabled = await enableReadyClips({ suggest: deps.suggest, cfg });
    return out;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
    running = false;
  }
}

export function startVideoFetcher() {
  if (!fetchConfig().enabled) return;
  const tick = () => runFetchCycle().catch((e) => console.error(`vidéos : ${e.message}`));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}

// --- vue d'ensemble pour l'admin -------------------------------------------------------------------------------------------------------

export async function filesOverview() {
  const cfg = fetchConfig();
  const [{ rows: c }, cooldown, lastError, version, free] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE file_source = 'auto' AND file_name IS NOT NULL)::int AS downloaded,
              coalesce(sum(file_size) FILTER (WHERE file_source = 'auto' AND file_name IS NOT NULL), 0)::bigint AS bytes,
              count(*) FILTER (WHERE sync_status IS NOT NULL AND file_name IS NULL AND norm_text <> '' AND duration_s >= $1
                  AND (published_at IS NULL OR published_at >= now() - make_interval(days => $2::int)) AND fetch_attempts < $3)::int AS waiting,
              count(*) FILTER (WHERE sync_status IS NOT NULL AND file_name IS NULL AND fetch_error IS NOT NULL AND norm_text <> '' AND duration_s >= $1
                  AND (published_at IS NULL OR published_at >= now() - make_interval(days => $2::int)))::int AS with_error
       FROM videos`,
      [cfg.minDurationS, cfg.retentionDays, cfg.maxAttempts],
    ),
    getSetting('fetch_cooldown_until', null),
    getSetting('fetch_last_error', null),
    ytdlpVersion(),
    freeMb(),
  ]);
  return {
    enabled: cfg.enabled,
    max_height: cfg.maxHeight,
    min_duration_s: cfg.minDurationS,
    retention_days: cfg.retentionDays,
    downloaded: c[0].downloaded,
    bytes: Number(c[0].bytes),
    waiting: c[0].waiting,
    with_error: c[0].with_error,
    cooldown_until: cooldown && new Date(cooldown) > new Date() ? cooldown : null,
    last_error: lastError,
    ytdlp_version: version,
    free_mb: Number.isFinite(free) ? free : null,
  };
}

/** Autorise de nouveau le téléchargement des vidéos en échec et lève la pause due à un blocage de YouTube. */
export async function retryFailed() {
  const { rowCount } = await pool.query(
    `UPDATE videos SET fetch_attempts = 0, fetch_next_at = NULL, fetch_error = NULL WHERE sync_status IS NOT NULL AND file_name IS NULL AND (fetch_attempts > 0 OR fetch_error IS NOT NULL)`,
  );
  await setSetting('fetch_cooldown_until', null);
  return rowCount;
}
