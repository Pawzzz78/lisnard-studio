import { Router } from 'express';
import { retrySummary, runSummaryCycle } from '../auto-summaries.js';
import { HttpError, ah } from '../http-error.js';
import { pool } from '../db.js';
import { discoverChannel, overview, previewShorts, purgeShorts, runCycle, setSetting } from '../sync.js';
import { runFetchCycle, filesOverview, retryFailed } from '../video-fetch.js';
import { runPlayImport } from '../play.js';
import { YouTubeApiError, resolveChannel, youtubeApiConfigured } from '../youtube.js';

export const syncRouter = Router();


const idParam = (req) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Introuvable.');
  return id;
};

const minDuration = (v) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 36000) throw new HttpError(400, 'Durée minimale invalide.');
  return Math.round(n);
};

async function getChannel(id) {
  const { rows } = await pool.query('SELECT * FROM channels WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Chaîne introuvable.');
  return rows[0];
}

syncRouter.get('/overview', ah(async (_req, res) => res.json(await overview())));

// --- téléchargement automatique des fichiers vidéo (yt-dlp) ---------------------------------------------------------
syncRouter.get('/files', ah(async (_req, res) => res.json(await filesOverview())));

/** Lance un passage de téléchargement tout de suite (en arrière-plan : un téléchargement peut durer plusieurs minutes). */
syncRouter.post(
  '/files/run',
  ah(async (_req, res) => {
    const o = await filesOverview();
    if (!o.enabled) throw new HttpError(409, "Le téléchargement automatique est désactivé (variable AUTO_DOWNLOAD=on).");
    runFetchCycle().catch((e) => console.error(`vidéos : ${e.message}`));
    res.status(202).json({ started: true });
  }),
);

/** Remet à zéro les vidéos en échec et la pause due à un blocage de YouTube. */
syncRouter.post('/files/retry', ah(async (_req, res) => res.json({ reset: await retryFailed() })));

// Imports the new interventions listed on Lisnard Play right away
syncRouter.post('/play', ah(async (_req, res) => res.json(await runPlayImport())));

/** Ajoute une chaîne et liste aussitôt ses vidéos (aucun crédit Supadata n'est consommé à ce stade). */
syncRouter.post(
  '/channels',
  ah(async (req, res) => {
    if (!youtubeApiConfigured()) {
      throw new HttpError(503, "YOUTUBE_API_KEY n'est pas configurée (clé « YouTube Data API v3 » Google).");
    }
    const min = minDuration(req.body?.min_duration_s);
    const excludeShorts = req.body?.exclude_shorts !== false; // Shorts exclus par défaut
    const info = await resolveChannel(req.body?.input);
    const { rows } = await pool.query(
      `INSERT INTO channels (youtube_channel_id, title, handle, uploads_playlist_id, min_duration_s, exclude_shorts)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (youtube_channel_id) DO NOTHING RETURNING *`,
      [info.youtube_channel_id, info.title, info.handle, info.uploads_playlist_id, min, excludeShorts],
    );
    if (!rows[0]) throw new HttpError(409, 'Cette chaîne est déjà suivie.');
    let added = 0;
    let error = null;
    try {
      added = (await discoverChannel(rows[0])).added;
    } catch (e) {
      // Only YouTube's own messages are meant for the admin; anything else is logged
      if (!(e instanceof YouTubeApiError)) console.error(e);
      error = e instanceof YouTubeApiError ? e.message : 'Liste des vidéos indisponible pour le moment.';
    }
    res.status(201).json({ channel: rows[0], added, error });
  }),
);

syncRouter.patch(
  '/channels/:id',
  ah(async (req, res) => {
    const ch = await getChannel(idParam(req));
    const enabled = req.body?.enabled === undefined ? ch.enabled : Boolean(req.body.enabled);
    const min = req.body?.min_duration_s === undefined ? ch.min_duration_s : minDuration(req.body.min_duration_s);
    const excludeShorts = req.body?.exclude_shorts === undefined ? ch.exclude_shorts : Boolean(req.body.exclude_shorts);
    await pool.query('UPDATE channels SET enabled = $2, min_duration_s = $3, exclude_shorts = $4 WHERE id = $1', [
      ch.id,
      enabled,
      min,
      excludeShorts,
    ]);
    res.json({ ok: true });
  }),
);

/** Retire la chaîne du suivi. Les vidéos déjà importées et leurs transcriptions ne sont pas touchées. */
syncRouter.delete(
  '/channels/:id',
  ah(async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM channels WHERE id = $1', [idParam(req)]);
    if (!rowCount) throw new HttpError(404, 'Chaîne introuvable.');
    res.json({ ok: true });
  }),
);

syncRouter.post(
  '/channels/:id/discover',
  ah(async (req, res) => {
    const ch = await getChannel(idParam(req));
    try {
      res.json(await discoverChannel(ch));
    } catch (e) {
      if (e instanceof YouTubeApiError) throw new HttpError(502, e.message);
      throw e;
    }
  }),
);

/** Aperçu : combien de Shorts seraient supprimés ? (ne supprime rien) */
syncRouter.post(
  '/channels/:id/shorts/preview',
  ah(async (req, res) => {
    res.json(await previewShorts(await getChannel(idParam(req))));
  }),
);

/** Supprime les Shorts déjà importés de la chaîne (jamais les vidéos ajoutées à la main) et les exclut ensuite. */
syncRouter.post(
  '/channels/:id/shorts/purge',
  ah(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirmation requise.');
    res.json(await purgeShorts(await getChannel(idParam(req))));
  }),
);

syncRouter.post(
  '/pause',
  ah(async (_req, res) => {
    await setSetting('processing_paused', true);
    res.json({ ok: true });
  }),
);

syncRouter.post(
  '/resume',
  ah(async (_req, res) => {
    await setSetting('processing_paused', false);
    await setSetting('cooldown_until', null);
    runCycle().catch((e) => console.error(`sync : ${e.message}`));
    res.status(202).json({ ok: true });
  }),
);

/** Lance une passe tout de suite (au lieu d'attendre la prochaine). */
syncRouter.post(
  '/run',
  ah(async (_req, res) => {
    runCycle().catch((e) => console.error(`sync : ${e.message}`));
    res.status(202).json({ ok: true });
  }),
);

// --- résumés automatiques -----------------------------------------------------------

syncRouter.post(
  '/summaries/pause',
  ah(async (_req, res) => {
    await setSetting('summaries_paused', true);
    res.json({ ok: true });
  }),
);

syncRouter.post(
  '/summaries/resume',
  ah(async (_req, res) => {
    await setSetting('summaries_paused', false);
    await setSetting('summary_cooldown_until', null);
    runSummaryCycle({ graceMinutes: 0 }).catch((e) => console.error(`résumés : ${e.message}`));
    res.status(202).json({ ok: true });
  }),
);

/** Lance une passe tout de suite, sans attendre le délai de grâce après une modification. */
syncRouter.post(
  '/summaries/run',
  ah(async (_req, res) => {
    await setSetting('summary_cooldown_until', null);
    runSummaryCycle({ graceMinutes: 0 }).catch((e) => console.error(`résumés : ${e.message}`));
    res.status(202).json({ ok: true });
  }),
);

/** Remet à zéro les tentatives d'une vidéo dont le résumé est en échec. */
syncRouter.post(
  '/summaries/:id/retry',
  ah(async (req, res) => {
    if (!(await retrySummary(idParam(req)))) throw new HttpError(404, 'Vidéo introuvable.');
    runSummaryCycle({ graceMinutes: 0 }).catch((e) => console.error(`résumés : ${e.message}`));
    res.status(202).json({ ok: true });
  }),
);

/** Remet une vidéo en échec dans la file. Refusé si elle a déjà une transcription ou des corrections. */
syncRouter.post(
  '/videos/:id/retry',
  ah(async (req, res) => {
    const { rowCount } = await pool.query(
      `UPDATE videos SET sync_status = 'pending', sync_attempts = 0, sync_error = NULL, sync_next_at = now()
       WHERE id = $1 AND sync_status = 'failed' AND NOT edited
         AND NOT EXISTS (SELECT 1 FROM segments WHERE video_id = $1)`,
      [idParam(req)],
    );
    if (!rowCount) throw new HttpError(409, 'Cette vidéo ne peut pas être relancée.');
    res.json({ ok: true });
  }),
);
