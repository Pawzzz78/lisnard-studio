/**
 * Synchronisation automatique des chaînes YouTube.
 *
 *  1. Découverte : liste les uploads d'une chaîne (API YouTube) et met les vidéos inconnues
 *     en file d'attente (sync_status = 'pending'). Au 1er passage on liste tout l'historique,
 *     ensuite seulement les nouveautés (≈ 1 requête/jour).
 *  2. Traitement : récupère la transcription des vidéos en attente (Supadata, mode native).
 *
 * Garanties : on n'écrit JAMAIS sur une vidéo déjà présente. Une transcription n'est posée que
 * sur une vidéo créée par la synchro, encore en attente, sans aucun segment et jamais éditée,
 * sous verrou de ligne. Les vidéos ajoutées à la main (sync_status NULL), celles déjà transcrites
 * (automatiquement ou corrigées à la main) ne sont ni relues ni modifiées.
 */
import { playConfig } from './play.js';
import { removeVideoFiles } from './media.js';
import { pool, replaceSegments, withTransaction } from './db.js';
import { getSetting, setSetting } from './settings.js';
import { summariesOverview } from './auto-summaries.js';
import { SHORT_MAX_S } from './constants.js';
import { fetchLocalized } from './localize.js';
import { TranscriptError, supadataConfigured } from './transcripts.js';
import { TranslationError } from './translate.js';
import { iterateUploads, listShortIds, youtubeApiConfigured } from './youtube.js';

const LOCK_ID = 727001;
const HOUR = 3600 * 1000;

const syncConfig = () => ({
  intervalHours: Number(process.env.SYNC_INTERVAL_HOURS) || 24,
  batch: Number(process.env.SYNC_BATCH) || 25,
  tickMinutes: 5,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- réglages (voir settings.js) ---------------------------------------------------

export { getSetting, setSetting };

/** Par défaut le traitement est en pause : rien n'est facturé tant que tu n'as pas cliqué sur « Démarrer ». */
export const isPaused = async () => (await getSetting('processing_paused', true)) !== false;

// --- 1. découverte -----------------------------------------------------------------

async function unknownIds(ids) {
  const { rows } = await pool.query(
    `SELECT youtube_id FROM videos WHERE youtube_id = ANY($1)
     UNION SELECT youtube_id FROM excluded_videos WHERE youtube_id = ANY($1)`,
    [ids],
  );
  const known = new Set(rows.map((r) => r.youtube_id));
  return ids.filter((id) => !known.has(id));
}

/** Met en file d'attente les vidéos de la chaîne qu'on ne connaît pas encore. Renvoie { added, skipped }. */
export async function discoverChannel(channel, deps = {}) {
  const iterate = deps.iterateUploads ?? iterateUploads;
  const full = !channel.backfilled_at;
  const intervalMs = syncConfig().intervalHours * HOUR;
  let added = 0;
  let skipped = 0;
  // Liste des Shorts de la chaîne : chargée une seule fois, et seulement si on en a besoin.
  let shorts = null;
  const isShort = async (v) => {
    if (v.duration_s > 0 && v.duration_s <= SHORT_MAX_S) return true;
    shorts ??= await (deps.listShortIds ?? listShortIds)(channel.youtube_channel_id);
    return shorts.ids.has(v.youtube_id);
  };
  try {
    for await (const page of iterate({ playlistId: channel.uploads_playlist_id, unknownIds })) {
      let handled = 0;
      for (const v of page.details) {
        if (v.live) continue; // direct en cours / à venir : on le reprendra plus tard
        if (channel.exclude_shorts !== false && (await isShort(v))) {
          await pool.query(
            `INSERT INTO excluded_videos (youtube_id, reason) VALUES ($1, 'short') ON CONFLICT DO NOTHING`,
            [v.youtube_id],
          );
          skipped++;
          handled++;
          continue;
        }
        if (channel.min_duration_s > 0 && v.duration_s > 0 && v.duration_s < channel.min_duration_s) {
          await pool.query(
            `INSERT INTO excluded_videos (youtube_id, reason) VALUES ($1, 'too_short') ON CONFLICT DO NOTHING`,
            [v.youtube_id],
          );
          skipped++;
          handled++;
          continue;
        }
        // La liste d'exclusion est vérifiée ici même : une vidéo supprimée à la main ne revient jamais.
        const { rowCount } = await pool.query(
          `INSERT INTO videos (youtube_id, title, channel, published_at, thumbnail_url, lang, source,
                               sync_status, sync_next_at, channel_id, duration_s)
           SELECT $1, $2, $3, $4, $5, 'fr', 'supadata', 'pending', now(), $6, $7
           WHERE NOT EXISTS (SELECT 1 FROM excluded_videos WHERE youtube_id = $1)
           ON CONFLICT (youtube_id) DO NOTHING`,
          [
            v.youtube_id,
            (v.title || v.youtube_id).slice(0, 300),
            (v.channel || channel.title || '').slice(0, 200),
            v.published_at,
            v.thumbnail_url ?? `https://i.ytimg.com/vi/${v.youtube_id}/hqdefault.jpg`,
            v.channel_id ?? channel.youtube_channel_id,
            v.duration_s || null,
          ],
        );
        if (rowCount) added++;
        handled++;
      }
      // Passage quotidien : on s'arrête dès qu'une page ne contient plus rien de nouveau.
      if (!full && handled === 0) break;
    }
    await pool.query(
      `UPDATE channels SET last_discovery_at = now(), last_discovery_error = NULL,
         backfilled_at = COALESCE(backfilled_at, now()), discovery_due_at = now() + $2 * interval '1 millisecond'
       WHERE id = $1`,
      [channel.id, intervalMs],
    );
  } catch (e) {
    await pool.query(
      `UPDATE channels SET last_discovery_error = $2, discovery_due_at = now() + interval '1 hour' WHERE id = $1`,
      [channel.id, String(e.message).slice(0, 500)],
    );
    throw e;
  }
  return { added, skipped };
}

// --- Shorts : détection et nettoyage ------------------------------------------------

/**
 * Supprime des vidéos synchronisées considérées comme des Shorts, et les mémorise pour que la synchro ne les
 * rajoute jamais. Ne touche JAMAIS aux vidéos ajoutées à la main (sync_status NULL) ni à celles corrigées à la main.
 * Renvoie les identifiants YouTube supprimés.
 */
async function removeShorts(videoIds) {
  if (!videoIds.length) return [];
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `DELETE FROM videos WHERE id = ANY($1) AND sync_status IS NOT NULL AND NOT edited RETURNING youtube_id`,
      [videoIds],
    );
    const ids = rows.map((r) => r.youtube_id);
    if (ids.length) {
      await c.query(
        `INSERT INTO excluded_videos (youtube_id, reason) SELECT unnest($1::text[]), 'short' ON CONFLICT DO NOTHING`,
        [ids],
      );
    }
    return ids;
  }).then(async (ids) => {
    for (const id of ids) await removeVideoFiles(id).catch((e) => console.warn(`Fichiers de ${id} non supprimés : ${e.message}`)); // fichiers vidéo du studio éventuels
    return ids;
  });
}

/** Vidéos déjà importées d'une chaîne qui sont des Shorts. `detection` : 'playlist' (liste YouTube) ou 'duration'. */
async function findShorts(channel, deps = {}) {
  let list = { ids: new Set(), found: false };
  try {
    list = await (deps.listShortIds ?? listShortIds)(channel.youtube_channel_id);
  } catch {
    // clé YouTube absente ou API indisponible : on se rabat sur la durée seule
  }
  const { rows } = await pool.query(
    `SELECT v.id, v.youtube_id, v.title, v.duration_s, v.sync_status, v.edited,
            (SELECT count(*) FROM segments s WHERE s.video_id = v.id)::int AS segments
     FROM videos v WHERE v.channel_id = $1 AND v.sync_status IS NOT NULL
     ORDER BY v.published_at DESC NULLS LAST`,
    [channel.youtube_channel_id],
  );
  // Un Short : 60 s ou moins, présent dans la liste YouTube des Shorts, ou plus court que la durée minimale de la chaîne.
  const min = channel.min_duration_s > 0 ? channel.min_duration_s : 0;
  const shorts = rows.filter(
    (v) =>
      (v.duration_s != null && (v.duration_s <= SHORT_MAX_S || v.duration_s < min)) || list.ids.has(v.youtube_id),
  );
  return {
    detection: list.found ? 'playlist' : 'duration',
    shorts: shorts.filter((v) => !v.edited),
    protectedCount: shorts.filter((v) => v.edited).length,
  };
}

/** Aperçu (rien n'est supprimé) : combien de Shorts, dont combien déjà transcrits. */
export async function previewShorts(channel, deps = {}) {
  const { detection, shorts, protectedCount } = await findShorts(channel, deps);
  return {
    detection,
    total: shorts.length,
    with_transcript: shorts.filter((v) => v.segments > 0).length,
    pending: shorts.filter((v) => v.sync_status === 'pending').length,
    protected: protectedCount,
    examples: shorts.slice(0, 8).map((v) => ({ title: v.title, duration_s: v.duration_s })),
  };
}

/** Supprime les Shorts de la chaîne et les exclut désormais de la synchro. */
export async function purgeShorts(channel, deps = {}) {
  const { detection, shorts, protectedCount } = await findShorts(channel, deps);
  const removed = await removeShorts(shorts.map((v) => v.id));
  await pool.query('UPDATE channels SET exclude_shorts = TRUE WHERE id = $1', [channel.id]);
  return { detection, removed: removed.length, protected: protectedCount };
}

// --- 2. traitement de la file ------------------------------------------------------

function retryPlan(code, attempts, publishedAt) {
  const ageDays = publishedAt ? (Date.now() - new Date(publishedAt).getTime()) / 86400000 : Infinity;
  if (code === 'unavailable') {
    // Les sous-titres automatiques arrivent parfois quelques heures après la mise en ligne :
    // on réessaie les vidéos récentes (6 h, 12 h, 24 h, 48 h) ; une vidéo ancienne sans sous-titres n'en aura pas.
    const max = ageDays <= 3 ? 5 : 1;
    return attempts >= max ? { failed: true } : { delayMs: 6 * HOUR * 2 ** (attempts - 1) };
  }
  return attempts >= 5 ? { failed: true } : { delayMs: HOUR * attempts };
}

/** Traite jusqu'à `limit` vidéos en attente. */
export async function processPending({ limit, fetchFn = fetchLocalized, gapMs = 1100 } = {}) {
  const result = { done: 0, retry: 0, failed: 0, skipped: 0, removed: 0, stopped: null };
  const { rows } = await pool.query(
    `SELECT v.id, v.youtube_id, v.published_at, v.sync_attempts, v.lang, v.duration_s,
            COALESCE(c.exclude_shorts, FALSE) AS exclude_shorts
     FROM videos v LEFT JOIN channels c ON c.youtube_channel_id = v.channel_id
     WHERE v.sync_status = 'pending' AND v.sync_next_at <= now()
     ORDER BY v.published_at DESC NULLS LAST, v.id DESC LIMIT $1`,
    [limit],
  );
  for (const v of rows) {
    // Short déjà en file (ajouté avant que les Shorts soient exclus) : on ne dépense aucun crédit dessus.
    if (v.exclude_shorts && v.duration_s != null && v.duration_s <= SHORT_MAX_S) {
      if ((await removeShorts([v.id])).length) result.removed++;
      continue;
    }
    try {
      const t = await fetchFn(v.youtube_id, v.lang || 'fr');
      const applied = await withTransaction(async (c) => {
        const { rows: cur } = await c.query(
          `SELECT sync_status, edited, (SELECT count(*) FROM segments WHERE video_id = $1)::int AS n
           FROM videos WHERE id = $1 FOR UPDATE`,
          [v.id],
        );
        // Quelqu'un est passé par là (édition, suppression, import manuel) : on ne touche à rien.
        if (!cur[0] || cur[0].sync_status !== 'pending' || cur[0].edited || cur[0].n > 0) return false;
        await replaceSegments(c, v.id, t.segments, {
          edited: false,
          source: 'supadata',
          translated: Boolean(t.translated),
          originalLang: t.originalLang ?? null,
        });
        await c.query(
          `UPDATE videos SET sync_status = 'done', sync_error = NULL, sync_next_at = NULL, lang = $2 WHERE id = $1`,
          [v.id, t.lang],
        );
        return true;
      });
      if (applied) result.done++;
      else result.skipped++;
    } catch (e) {
      const code = e instanceof TranscriptError || e instanceof TranslationError ? e.code : 'upstream';
      if (code === 'quota' || code === 'auth' || code === 'config') {
        result.stopped = { code, message: e.message };
        break;
      }
      const attempts = v.sync_attempts + 1;
      const plan = retryPlan(code, attempts, v.published_at);
      if (plan.failed) {
        await pool.query(
          `UPDATE videos SET sync_status = 'failed', sync_attempts = $2, sync_error = $3, sync_next_at = NULL
           WHERE id = $1 AND sync_status = 'pending'`,
          [v.id, attempts, String(e.message).slice(0, 300)],
        );
        result.failed++;
      } else {
        await pool.query(
          `UPDATE videos SET sync_attempts = $2, sync_error = $3, sync_next_at = now() + $4 * interval '1 millisecond'
           WHERE id = $1 AND sync_status = 'pending'`,
          [v.id, attempts, String(e.message).slice(0, 300), plan.delayMs],
        );
        result.retry++;
      }
    }
    if (gapMs) await sleep(gapMs); // l'offre gratuite Supadata est limitée à 1 requête/seconde
  }
  return result;
}

// --- cycle complet -----------------------------------------------------------------

/** Une passe : découverte des chaînes échues, puis traitement d'un lot de la file. */
export async function runCycle(deps = {}) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    if (!rows[0].locked) return { skipped: 'déjà en cours' };
    const out = { discovered: 0, errors: [] };

    if (deps.iterateUploads || youtubeApiConfigured()) {
      const { rows: due } = await pool.query(
        'SELECT * FROM channels WHERE enabled AND discovery_due_at <= now() ORDER BY id',
      );
      for (const ch of due) {
        try {
          out.discovered += (await discoverChannel(ch, deps)).added;
        } catch (e) {
          out.errors.push(`${ch.title || ch.youtube_channel_id} : ${e.message}`);
        }
      }
    }

    const cooldown = await getSetting('cooldown_until', null);
    if (!(await isPaused()) && (deps.fetchFn || supadataConfigured()) && !(cooldown && new Date(cooldown) > new Date())) {
      out.processing = await processPending({ limit: syncConfig().batch, fetchFn: deps.fetchFn, gapMs: deps.gapMs });
      if (out.processing.stopped) {
        const { code, message } = out.processing.stopped;
        await setSetting('cooldown_until', new Date(Date.now() + (code === 'quota' ? 1 : 6) * HOUR).toISOString());
        await setSetting('last_error', `${new Date().toISOString()} — ${message}`);
        out.errors.push(message);
      } else if (out.processing.done) {
        await setSetting('last_error', null);
      }
    }
    return out;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

export function startScheduler() {
  if (process.env.SYNC_ENABLED === 'false') return;
  const tick = () => runCycle().catch((e) => console.error(`sync : ${e.message}`));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, syncConfig().tickMinutes * 60_000).unref();
}

// --- vue d'ensemble pour l'admin ---------------------------------------------------

export async function overview() {
  const [{ rows: channels }, { rows: counts }, { rows: failed }, paused, cooldown, lastError, llmError, summaries] = await Promise.all([
    pool.query(`SELECT c.*, (SELECT count(*)::int FROM videos v WHERE v.channel_id = c.youtube_channel_id) AS video_count
                FROM channels c ORDER BY c.id`),
    pool.query(`SELECT coalesce(sync_status, 'manual') AS status, count(*)::int AS n FROM videos GROUP BY 1`),
    pool.query(`SELECT id, youtube_id, title, sync_error, sync_attempts FROM videos
                WHERE sync_status = 'failed' ORDER BY published_at DESC NULLS LAST LIMIT 100`),
    isPaused(),
    getSetting('cooldown_until', null),
    getSetting('last_error', null),
    getSetting('llm_last_error', null),
    summariesOverview(),
  ]);
  const play = { ...playConfig(), last_run: await getSetting('play_last_run', null) };
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  return {
    keys: { youtube: youtubeApiConfigured(), supadata: supadataConfigured() },
    paused,
    cooldown_until: cooldown && new Date(cooldown) > new Date() ? cooldown : null,
    last_error: lastError,
    llm_error: llmError,
    summaries,
    interval_hours: syncConfig().intervalHours,
    counts: { pending: byStatus.pending ?? 0, done: byStatus.done ?? 0, failed: byStatus.failed ?? 0, manual: byStatus.manual ?? 0 },
    channels,
    failed,
    play,
  };
}
