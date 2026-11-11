/**
 * Retranscription des interviews à partir du son : Grok STT (via OpenRouter), puis micro-relecture par Haiku.
 * - La transcription actuelle est sauvegardée avant d'être remplacée ; « Restaurer » la remet à l'identique.
 * - Échec : une seule nouvelle tentative 30 min plus tard ; second échec : la vidéo garde la « méthode initiale »
 *   (sa transcription actuelle, ou, si elle n'en a pas, les sous-titres YouTube via Supadata comme la synchronisation).
 * - Jamais sur une transcription corrigée à la main ou traduite. Une vidéo à la fois, avec un plafond d'heures d'audio par jour.
 */
import { generateClipSuggestions } from '../clip-suggestions.js';
import { pool, replaceSegments, withTransaction } from '../db.js';
import { fetchLocalized } from '../localize.js';
import { stampOf, videoFilePath } from '../media.js';
import { llmConfigured } from '../openrouter.js';
import { getSetting, setSetting } from '../settings.js';
import { videoSilences } from '../studio/voice.js';
import { audioChunk, planChunks } from './audio.js';
import { contextTerms, fetchDescription } from './context.js';
import { proofreadLines } from './proofread.js';
import { segmentsToLines, transcribeChunk, wordsToLines } from './stt.js';

export const RETX = {
  retryDelayMin: 30,
  maxAttempts: 2, // first try + one retry, then the initial method
  maxRejectedShare: 0.3, // more proofreading corrections refused than this: something is off, the run fails
  defaultDailyHours: 2, // low on purpose: check the quality on the first videos, then raise it from the admin
  tickMs: 10 * 60 * 1000,
};
const LOCK_ID = 7_420_031;
const SETTINGS_KEY = 'retx_settings';

export async function retxSettings() {
  const s = await getSetting(SETTINGS_KEY, {});
  return { paused: Boolean(s.paused), dailyHours: Number.isFinite(Number(s.dailyHours)) ? Math.max(0, Number(s.dailyHours)) : RETX.defaultDailyHours };
}

export async function saveRetxSettings({ paused, dailyHours }) {
  const cur = await retxSettings();
  const next = { paused: paused === undefined ? cur.paused : Boolean(paused), dailyHours: dailyHours === undefined ? cur.dailyHours : Math.min(200, Math.max(0, Number(dailyHours) || 0)) };
  await setSetting(SETTINGS_KEY, next);
  return next;
}

const CANDIDATE = `v.file_name IS NOT NULL AND v.file_has_audio AND NOT v.edited AND NOT COALESCE(v.translated, FALSE)
  AND COALESCE(v.source, '') <> 'grok' AND COALESCE(v.retx_status, 'todo') IN ('todo', 'retry')`;

/** Secondes d'audio retranscrites aujourd'hui (réussites et échecs : l'API a été payée). */
async function secondsToday() {
  const { rows } = await pool.query(`SELECT COALESCE(SUM(file_duration_s), 0)::float AS s FROM videos WHERE retx_at >= date_trunc('day', now())`);
  return rows[0].s;
}

/** Texte de la transcription « méthode Grok », sans écrire en base. */
/** Description YouTube de la vidéo : lue en base, sinon récupérée une fois et gardée. */
async function descriptionOf(video, describe) {
  if (video.description != null) return video.description;
  const text = await describe(video.youtube_id);
  if (text == null) return ''; // fetch failed (YouTube often blocks servers): try again next time, store nothing
  await pool.query('UPDATE videos SET description = $2 WHERE id = $1', [video.id, text]);
  return text;
}

export async function buildTranscript(video, { transcribe = transcribeChunk, chunkAudio = audioChunk, proofread = proofreadLines, silencesOf = videoSilences, describe = fetchDescription } = {}) {
  // Title and description name the show, the guests and the topics: Grok spells them right, Haiku may restore them
  const context = { title: video.title ?? '', description: await descriptionOf(video, describe) };
  const terms = contextTerms(context);
  const file = videoFilePath(video.file_name);
  const silences = (await silencesOf({ id: video.id, stamp: stampOf(video), file, hasAudio: video.file_has_audio })) ?? [];
  const chunks = planChunks(video.file_duration_s, silences);
  if (!chunks.length) throw new Error('Durée de la vidéo inconnue.');
  const lines = [];
  for (const [start, end] of chunks) {
    const buf = await chunkAudio(file, start, end);
    const r = await transcribe(buf, { lang: (video.original_lang || video.lang || 'fr').slice(0, 2), keyterms: terms, videoId: video.id });
    const offset = Math.round(start * 1000);
    const part = r.words.length ? wordsToLines(r.words, offset) : segmentsToLines(r.segments, offset);
    if (!part.length && r.text.trim()) throw new Error('La transcription est revenue sans horaires : impossible de caler les sous-titres.');
    lines.push(...part);
  }
  if (!lines.length) throw new Error('Aucune parole reconnue dans la vidéo.');
  const pr = await proofread(lines, { terms, context, videoId: video.id });
  if (pr.batches && pr.failedBatches === pr.batches) throw new Error('La relecture n’a pas pu se faire.');
  if (pr.rejected > lines.length * RETX.maxRejectedShare) throw new Error(`La relecture a proposé trop de changements refusés (${pr.rejected} lignes) : texte non fiable.`);
  return { lines: pr.lines, stats: { chunks: chunks.length, lines: pr.lines.length, changed: pr.changed, rejected: pr.rejected, failedBatches: pr.failedBatches } };
}

async function loadVideo(id) {
  const { rows } = await pool.query(
    `SELECT id, youtube_id, title, description, lang, original_lang, translated, edited, source, text_hash, file_name, file_size, file_duration_s, file_has_audio,
            file_uploaded_at, retx_status, retx_attempts FROM videos WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Sauvegarde la transcription actuelle d'une vidéo (dans une transaction en cours). */
async function backup(c, v) {
  const { rows } = await c.query('SELECT start_ms, duration_ms, text FROM segments WHERE video_id = $1 ORDER BY position', [v.id]);
  if (!rows.length) return false;
  await c.query(
    `INSERT INTO transcript_backups (video_id, source, edited, translated, original_lang, text_hash, segments) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [v.id, v.source, v.edited, Boolean(v.translated), v.original_lang, v.text_hash, JSON.stringify(rows)],
  );
  return true;
}

/**
 * Retranscrit une vidéo. Renvoie { status: 'done' | 'retry' | 'initial' | 'skipped', error?, stats? }.
 * `manual` (bouton de l'admin) : passe outre le statut et le plafond, mais jamais sur un texte corrigé à la main ou traduit.
 */
export async function retranscribeVideo(id, { manual = false, deps = {} } = {}) {
  const v = await loadVideo(id);
  if (!v) return { status: 'skipped', error: 'Vidéo introuvable.' };
  if (v.edited) return { status: 'skipped', error: 'Transcription corrigée à la main : on n’y touche pas.' };
  if (v.translated) return { status: 'skipped', error: 'Transcription traduite : on n’y touche pas.' };
  if (!v.file_name || !v.file_has_audio) return { status: 'skipped', error: 'Pas de fichier vidéo avec du son.' };
  const attempts = manual ? 0 : (v.retx_attempts ?? 0);
  // Atomic claim: the admin button and the scheduler never run the same video twice at once
  const { rowCount } = await pool.query(`UPDATE videos SET retx_status = 'running', retx_at = now() WHERE id = $1 AND retx_status IS DISTINCT FROM 'running'`, [id]);
  if (!rowCount) return { status: 'skipped', error: 'Retranscription déjà en cours pour cette vidéo.' };
  try {
    const built = await (deps.build ?? buildTranscript)(v, deps);
    const written = await withTransaction(async (c) => {
      const { rows } = await c.query('SELECT edited, translated, text_hash FROM videos WHERE id = $1 FOR UPDATE', [id]);
      // Hand edits or a new import meanwhile: keep them
      if (!rows[0] || rows[0].edited || rows[0].translated || rows[0].text_hash !== v.text_hash) return false;
      await backup(c, v);
      await replaceSegments(c, id, built.lines, { edited: false, source: 'grok', translated: false, originalLang: null });
      await c.query(`UPDATE videos SET retx_status = 'done', retx_attempts = $2, retx_error = NULL, retx_next_at = NULL, retx_stats = $3::jsonb, retx_at = now() WHERE id = $1`, [id, attempts + 1, JSON.stringify(built.stats)]);
      return true;
    });
    if (!written) {
      await pool.query(`UPDATE videos SET retx_status = 'todo' WHERE id = $1 AND retx_status = 'running'`, [id]);
      return { status: 'skipped', error: 'La transcription a changé pendant la retranscription : rien n’a été remplacé.' };
    }
    // Clip suggestions were built on the old text: rebuild them on the new one
    if (llmConfigured() || deps.suggest) await (deps.suggest ?? generateClipSuggestions)(id).catch((e) => console.error(`Extraits après retranscription (vidéo ${id}) : ${e.message}`));
    return { status: 'done', stats: built.stats };
  } catch (e) {
    const message = String(e.message ?? e).slice(0, 500);
    console.error(`Retranscription de la vidéo ${id} : ${message}`);
    if (attempts + 1 < RETX.maxAttempts) {
      await pool.query(
        `UPDATE videos SET retx_status = 'retry', retx_attempts = $2, retx_error = $3, retx_next_at = now() + make_interval(mins => $4) WHERE id = $1`,
        [id, attempts + 1, message, RETX.retryDelayMin],
      );
      return { status: 'retry', error: message };
    }
    await pool.query(`UPDATE videos SET retx_status = 'initial', retx_attempts = $2, retx_error = $3, retx_next_at = NULL WHERE id = $1`, [id, attempts + 1, message]);
    await initialMethod(v, deps).catch((err) => console.error(`Méthode initiale (vidéo ${id}) : ${err.message}`));
    return { status: 'initial', error: message };
  }
}

/** Méthode initiale : la vidéo garde sa transcription ; sans transcription, on prend les sous-titres YouTube (Supadata). */
async function initialMethod(v, { fetchFn = fetchLocalized } = {}) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM segments WHERE video_id = $1', [v.id]);
  if (rows[0].n > 0) return;
  const t = await fetchFn(v.youtube_id, v.lang || 'fr');
  await withTransaction(async (c) => {
    const { rows: cur } = await c.query('SELECT edited, (SELECT count(*) FROM segments WHERE video_id = $1)::int AS n FROM videos WHERE id = $1 FOR UPDATE', [v.id]);
    if (!cur[0] || cur[0].edited || cur[0].n > 0) return;
    await replaceSegments(c, v.id, t.segments, { edited: false, source: 'supadata', translated: Boolean(t.translated), originalLang: t.originalLang ?? null });
    await c.query('UPDATE videos SET lang = $2 WHERE id = $1', [v.id, t.lang]);
  });
}

/** Remet la dernière transcription sauvegardée (avant la retranscription). */
export async function restoreTranscript(id) {
  return withTransaction(async (c) => {
    const { rows } = await c.query('SELECT * FROM transcript_backups WHERE video_id = $1 ORDER BY id DESC LIMIT 1', [id]);
    const b = rows[0];
    if (!b) return false;
    await c.query('SELECT id FROM videos WHERE id = $1 FOR UPDATE', [id]);
    await replaceSegments(c, id, b.segments, { edited: b.edited, source: b.source ?? 'supadata', translated: b.translated, originalLang: b.original_lang });
    // Restored by hand: the scheduler must not redo it
    await c.query(`UPDATE videos SET retx_status = 'restored', retx_error = NULL, retx_next_at = NULL WHERE id = $1`, [id]);
    await c.query('DELETE FROM transcript_backups WHERE id = $1', [b.id]);
    return true;
  });
}

let running = false;

/** Un passage : au plus une vidéo, la plus récente en attente, dans la limite du plafond du jour. */
export async function runRetranscribeCycle({ deps = {} } = {}) {
  if (running) return { skipped: 'running' };
  const cfg = await retxSettings();
  if (cfg.paused) return { skipped: 'paused' };
  if (!llmConfigured() && !deps.build) return { skipped: 'no-key' };
  running = true;
  const client = await pool.connect();
  try {
    const { rows: lock } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!lock[0].ok) return { skipped: 'locked' };
    try {
      const left = cfg.dailyHours * 3600 - (await secondsToday());
      const { rows } = await client.query(
        `SELECT v.id, v.file_duration_s FROM videos v WHERE ${CANDIDATE} AND (v.retx_next_at IS NULL OR v.retx_next_at <= now())
         ORDER BY v.published_at DESC NULLS LAST, v.id DESC LIMIT 1`,
      );
      if (!rows[0]) return { skipped: 'nothing' };
      if (Number(rows[0].file_duration_s) > left) return { skipped: 'daily-cap' };
      return { id: rows[0].id, ...(await retranscribeVideo(rows[0].id, { deps })) };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    client.release();
    running = false;
  }
}

/** État pour l'admin. */
export async function retxOverview() {
  const { rows: [c] } = await pool.query(
    `SELECT count(*) FILTER (WHERE source = 'grok')::int AS done,
            count(*) FILTER (WHERE ${CANDIDATE.replaceAll('v.', '')})::int AS todo,
            count(*) FILTER (WHERE retx_status = 'initial')::int AS initial,
            count(*) FILTER (WHERE retx_status = 'running')::int AS running,
            COALESCE(SUM(file_duration_s) FILTER (WHERE ${CANDIDATE.replaceAll('v.', '')}), 0)::float AS todo_seconds
     FROM videos`,
  );
  const { rows: failures } = await pool.query(
    `SELECT id, youtube_id, title, retx_status, retx_error, retx_at FROM videos WHERE retx_status IN ('initial', 'retry') ORDER BY retx_at DESC NULLS LAST LIMIT 20`,
  );
  const { rows: [cost] } = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS total, COALESCE(SUM(cost_usd) FILTER (WHERE day = CURRENT_DATE), 0)::float AS today
     FROM api_usage WHERE feature LIKE 'retranscription%'`,
  );
  return { ...c, seconds_today: await secondsToday(), settings: await retxSettings(), cost, failures, configured: llmConfigured() };
}

export function startRetranscribeScheduler() {
  if (!llmConfigured()) return;
  const tick = () => runRetranscribeCycle().catch((e) => console.error('Retranscription :', e.message));
  // A run cut by a restart stays 'running': put it back in line
  pool.query(`UPDATE videos SET retx_status = 'todo' WHERE retx_status = 'running'`).catch(() => {});
  setTimeout(tick, 90_000).unref();
  setInterval(tick, RETX.tickMs).unref();
}
