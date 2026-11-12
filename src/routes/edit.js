/**
 * Section « Edit » (adhérents connectés, comme le studio de clips) : modèles en ligne, interviews disponibles, aperçu rapide (360 × 640)
 * et création du montage, suivi, téléchargement et partage. Les rendus passent par la file des clips (un seul ffmpeg à la fois).
 */
import express, { Router } from 'express';
import { EDIT } from '../../public/js/edit-core.js';
import { HttpError, ah, jsonErrors } from '../http-error.js';
import { enqueueEditRender } from '../edit/render.js';
import { buildEdit, SESSION } from '../edit/session.js';
import { listImages } from '../edit/images.js';
import { listTemplates, previewPath } from '../edit/templates.js';
import { recordEvent } from '../studio/stats.js';
import { cancelJob, config as studioConfig, getJob, publicJob } from '../studio/render.js';
import { listStudioVideos } from './studio.js';

export const editRouter = Router();
editRouter.use(express.json({ limit: '20kb' }));

const editJob = (id) => {
  const job = getJob(String(id));
  if (!job || job.kind !== 'edit') throw new HttpError(404, 'Montage introuvable ou expiré (les montages sont conservés une heure).');
  return job;
};

/** Ce dont la page a besoin : modèles en ligne (avec leur aperçu), interviews disponibles, nombre de photos, limites. */
editRouter.get(
  '/',
  ah(async (_req, res) => {
    const [templates, videos, photos] = await Promise.all([listTemplates(), listStudioVideos(), listImages()]);
    res.set('Cache-Control', 'no-store');
    res.json({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        track_title: t.track_title,
        track_credit: t.track_credit ?? '',
        texts: t.template.texts.map((x) => x.text),
        preview_url: `/api/edit/templates/${t.id}/preview.mp4?v=${encodeURIComponent(new Date(t.preview_at).getTime())}`,
      })),
      videos: videos.map(({ youtube_id, title, published_at, thumbnail_url, duration_s }) => ({ youtube_id, title, published_at, thumbnail_url, duration_s })),
      photos: photos.length,
      limits: { maxTexts: EDIT.maxTexts, maxTextLen: EDIT.maxTextLen, maxVideos: SESSION.maxVideos },
    });
  }),
);

/** Aperçu d'un modèle en ligne. */
editRouter.get(
  '/templates/:id/preview.mp4',
  ah(async (req, res) => {
    const t = (await listTemplates()).find((x) => x.id === Number(req.params.id));
    if (!t) throw new HttpError(404, 'Modèle introuvable.');
    res.sendFile(previewPath(t.id), { headers: { 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'video/mp4' }, acceptRanges: true }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Aperçu introuvable.' });
    });
  }),
);

/** Aperçu du montage (petit, rapide, avec le vrai son) : son état se suit avec GET /jobs/:id. */
editRouter.post(
  '/preview',
  ah(async (req, res) => {
    const { plan, files } = await buildEdit(req.body ?? {});
    const job = await enqueueEditRender({ plan, files, quality: 'preview', ip: req.ip, filename: 'apercu-edit' });
    res.status(202).json({ job: publicJob(job), plan: { duration: plan.duration, slots: plan.slots.length } });
  }),
);

/** Création du montage (HD 1080 × 1920, ou « rapide » 720 × 1280). */
editRouter.post(
  '/render',
  ah(async (req, res) => {
    const { plan, files, template } = await buildEdit(req.body ?? {});
    const quality = req.body?.quality === 'fast' ? 'fast' : 'hd';
    const slug = template.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'montage';
    const job = await enqueueEditRender({ plan, files, quality, ip: req.ip, filename: `edit-lisnard-${slug}` });
    await recordEvent('edit', { jobId: job.id, youtubeId: null, ip: req.ip });
    res.status(202).json({ job: publicJob(job) });
  }),
);

editRouter.get('/jobs/:id', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json(publicJob(editJob(req.params.id)));
  } catch (e) {
    next(e);
  }
});

/** Le fichier : lu dans la page (sans paramètre), ou téléchargé (`?use=download`) / partagé (`?use=share`). */
editRouter.get('/jobs/:id/file', async (req, res, next) => {
  try {
    const job = editJob(req.params.id);
    if (job.status !== 'done') throw new HttpError(409, 'Le montage n’est pas encore prêt.');
    // Same cap as clips on the bytes actually sent (seeking in <video> only costs what is transferred)
    if ((job.bytesServed ?? 0) >= (job.size ?? 0) * studioConfig().fileServeFactor) throw new HttpError(429, 'Ce montage a déjà été téléchargé de nombreuses fois : crée-le à nouveau si besoin.');
    const socket = req.socket;
    const sentBefore = socket.bytesWritten;
    res.on('close', () => {
      job.bytesServed = (job.bytesServed ?? 0) + Math.max(0, socket.bytesWritten - sentBefore);
    });
    const use = req.query.use === 'download' ? 'edit_download' : req.query.use === 'share' ? 'edit_share' : null;
    if (use && req.method === 'GET') await recordEvent(use, { jobId: job.id, youtubeId: null, ip: req.ip });
    res.set('Cache-Control', 'no-store');
    const done = (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Montage expiré.' });
    };
    if (use) res.download(job.out, job.filename, done);
    else res.sendFile(job.out, { headers: { 'Content-Type': 'video/mp4' }, acceptRanges: true }, done);
  } catch (e) {
    next(e);
  }
});

/** Le montage a été récupéré sans passer par le téléchargement du fichier (partage depuis le téléphone, fichier préchargé). */
editRouter.post(
  '/jobs/:id/used',
  ah(async (req, res) => {
    const job = editJob(req.params.id);
    if (job.status !== 'done') throw new HttpError(409, 'Le montage n’est pas encore prêt.');
    const use = req.body?.use === 'download' ? 'edit_download' : req.body?.use === 'share' ? 'edit_share' : null;
    if (!use) throw new HttpError(400, 'Usage inconnu.');
    await recordEvent(use, { jobId: job.id, youtubeId: null, ip: req.ip });
    res.status(204).end();
  }),
);

editRouter.delete(
  '/jobs/:id',
  ah(async (req, res) => {
    await cancelJob(editJob(req.params.id));
    res.status(204).end();
  }),
);

editRouter.use(jsonErrors());
