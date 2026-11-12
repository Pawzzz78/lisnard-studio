/**
 * Résumés de vidéos, stockés en base.
 *
 * - Ils sont générés AUTOMATIQUEMENT en arrière-plan (auto-summaries.js) dès qu'une vidéo est transcrite, jamais à
 *   la demande d'un visiteur (aucun coût déclenché par le public).
 * - Un résumé n'est écrit qu'UNE fois : une fois en base, il n'est jamais refait automatiquement (ni si la transcription
 *   est corrigée, ni si les consignes évoluent). Seul le bouton « Régénérer » de l'admin le remplace.
 * - Un résumé corrigé à la main (edited_at) est signalé comme tel dans l'admin.
 * - source_hash garde l'empreinte de la transcription au moment du résumé : l'admin s'en sert pour signaler qu'elle a
 *   changé depuis. Elle n'influence pas l'affichage.
 */
import { pool } from './db.js';
import { HttpError } from './http-error.js';
import { completeWithOpenRouter } from './openrouter.js';
import { PROMPT_VERSION, sanitizeSummary, summarizeTranscript, summaryModel } from './summarize.js';

/** Empreinte enregistrée avec un résumé : transcription + version des consignes (l'admin s'en sert pour signaler une transcription modifiée). */
const currentSourceHash = (textHash) => `${textHash}:${PROMPT_VERSION}`;

const inflight = new Map(); // `${videoId}:${hash}` -> Promise : une seule génération à la fois par vidéo

/**
 * Génère et stocke le résumé d'une vidéo { id, youtube_id, text_hash }. Lève LlmError si le modèle échoue.
 * Deux appels simultanés pour la même vidéo (travail de fond + bouton de l'admin) ne font qu'un seul appel au modèle.
 * Un résumé déjà en base n'est jamais écrasé, sauf avec `force` (bouton « Régénérer » de l'admin).
 */
export function generateSummary(video, { complete = completeWithOpenRouter, force = false } = {}) {
  const key = `${video.id}:${video.text_hash}`;
  const running = inflight.get(key);
  if (running) return running;
  const promise = (async () => {
    const { rows: segments } = await pool.query('SELECT start_ms, text FROM segments WHERE video_id = $1 ORDER BY position', [video.id]);
    const model = summaryModel();
    const markdown = await summarizeTranscript(segments, { complete, model, videoId: video.id });
    const { rows } = await pool.query(
      `INSERT INTO video_summaries (video_id, content, model, source_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (video_id) DO UPDATE
         SET content = EXCLUDED.content, model = EXCLUDED.model, source_hash = EXCLUDED.source_hash, created_at = now(),
             edited_at = NULL
         WHERE $5
       RETURNING created_at`,
      [video.id, markdown, model, currentSourceHash(video.text_hash), force],
    );
    if (!rows[0]) return { skipped: 'résumé déjà présent' }; // écrit entre-temps (par l'admin, par exemple) : on ne l'écrase pas
    await pool.query(
      'UPDATE videos SET summary_attempts = 0, summary_next_at = NULL, summary_error = NULL WHERE id = $1 AND text_hash = $2',
      [video.id, video.text_hash],
    );
    return { markdown, model, created_at: rows[0].created_at };
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Bouton « Régénérer » de l'admin : régénère tout de suite le résumé d'une vidéo. */
export async function regenerateNow(videoId, { complete } = {}) {
  const { rows } = await pool.query(
    `SELECT id, youtube_id, text_hash, norm_text <> '' AS has_text FROM videos WHERE id = $1`,
    [videoId],
  );
  if (!rows[0]) throw new HttpError(404, 'Vidéo introuvable.');
  if (!rows[0].has_text) throw new HttpError(409, "Cette vidéo n'a pas de transcription à résumer.");
  return generateSummary(rows[0], { complete, force: true });
}


const MAX_EDITED_CHARS = 8000;

/** Enregistre un résumé corrigé à la main dans l'admin. Le Markdown est nettoyé comme celui de l'IA (HTML, liens retirés). */
export async function saveEditedSummary(videoId, markdown) {
  const raw = String(markdown ?? '');
  if (raw.length > MAX_EDITED_CHARS * 2) throw new HttpError(400, `Résumé trop long (${MAX_EDITED_CHARS} caractères au maximum).`);
  // les repères de temps « ## [12:34] Titre » écrits par l'admin sont conservés (il sait ce qu'il fait)
  const labels = new Set([...raw.matchAll(/^\s*#{1,6}\s+\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[-–]\s*[\d:]+)?\]/gm)].map((m) => m[1]));
  const text = sanitizeSummary(raw, { labels });
  if (text.length < 10) throw new HttpError(400, 'Le résumé est vide. Pour revenir à un résumé automatique, utilise « Régénérer ».');
  const { rows: found } = await pool.query(`SELECT id, text_hash, norm_text <> '' AS has_text FROM videos WHERE id = $1`, [videoId]);
  if (!found[0]) throw new HttpError(404, 'Vidéo introuvable.');
  if (!found[0].has_text) throw new HttpError(409, "Cette vidéo n'a pas de transcription : elle n'apparaît pas sur le site.");
  const { rows } = await pool.query(
    `INSERT INTO video_summaries (video_id, content, model, source_hash, edited_at)
     VALUES ($1, $2, 'manuel', $3, now())
     ON CONFLICT (video_id) DO UPDATE
       SET content = EXCLUDED.content, model = 'manuel', source_hash = EXCLUDED.source_hash, created_at = now(), edited_at = now()
     RETURNING edited_at`,
    [videoId, text, currentSourceHash(found[0].text_hash)],
  );
  await pool.query('UPDATE videos SET summary_attempts = 0, summary_next_at = NULL, summary_error = NULL WHERE id = $1', [videoId]);
  return { markdown: text, edited_at: rows[0].edited_at };
}

export function resetSummaryState() {
  inflight.clear();
}
