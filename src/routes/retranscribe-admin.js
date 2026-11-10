// Admin de la retranscription (Grok STT + relecture) : état, réglages, lancement et restauration par vidéo.
import { Router } from 'express';
import { pool } from '../db.js';
import { HttpError, ah } from '../http-error.js';
import { restoreTranscript, retranscribeVideo, retxOverview, saveRetxSettings } from '../retranscribe/retranscribe.js';

export const retranscribeAdminRouter = Router();

const idOf = (req) => {
  if (!/^\d{1,9}$/.test(req.params.id)) throw new HttpError(404, 'Vidéo introuvable.');
  return Number(req.params.id);
};

retranscribeAdminRouter.get('/overview', ah(async (_req, res) => res.json(await retxOverview())));

retranscribeAdminRouter.put('/settings', ah(async (req, res) => {
  const { paused, dailyHours } = req.body ?? {};
  if (dailyHours !== undefined && !(Number(dailyHours) >= 0)) throw new HttpError(400, 'Plafond invalide.');
  res.json(await saveRetxSettings({ paused, dailyHours }));
}));

retranscribeAdminRouter.get('/videos/:id', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT source, edited, translated, file_name IS NOT NULL AND file_has_audio AS has_audio, retx_status, retx_error, retx_at, retx_stats,
            EXISTS (SELECT 1 FROM transcript_backups b WHERE b.video_id = v.id) AS has_backup
     FROM videos v WHERE id = $1`,
    [idOf(req)],
  );
  if (!rows[0]) throw new HttpError(404, 'Vidéo introuvable.');
  res.json(rows[0]);
}));

// Runs in the background: an hour-long interview takes a few minutes
retranscribeAdminRouter.post('/videos/:id/run', ah(async (req, res) => {
  const id = idOf(req);
  retranscribeVideo(id, { manual: true }).catch((e) => console.error(`Retranscription de la vidéo ${id} :`, e.message));
  res.status(202).json({ started: true });
}));

retranscribeAdminRouter.post('/videos/:id/restore', ah(async (req, res) => {
  if (!(await restoreTranscript(idOf(req)))) throw new HttpError(404, 'Aucune ancienne transcription sauvegardée pour cette vidéo.');
  res.json({ ok: true });
}));
