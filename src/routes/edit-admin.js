/** Admin de la section « Edit » : modèles de montage, photothèque de David Lisnard, temps forts des sons, aperçus. */
import express, { Router } from 'express';
import { EDIT, EFFECTS, GRADES, RECIPES } from '../../public/js/edit-core.js';
import { HttpError, ah } from '../http-error.js';
import { trackBeats } from '../edit/beats.js';
import { IMAGE_LIMITS, addImage, deleteImage, imagePath, listImages, updateImage } from '../edit/images.js';
import { createTemplate, deleteTemplate, getTemplate, listTemplates, previewPath, setTemplateState, startPreview, updateTemplate } from '../edit/templates.js';
import { ensureMusic, findTrack, publicTracks } from '../studio/music.js';
import { FONTS, getJob, publicJob } from '../studio/render.js';

export const editAdminRouter = Router();

const sendFile = (res, file, type) =>
  res.sendFile(file, { headers: { 'Cache-Control': 'private, no-store', 'Content-Type': type } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Fichier introuvable.' });
  });

/** Tout ce dont la page de l'admin a besoin. */
editAdminRouter.get(
  '/',
  ah(async (_req, res) => {
    await ensureMusic();
    res.set('Cache-Control', 'no-store');
    res.json({
      templates: await listTemplates({ all: true }),
      images: await listImages({ all: true }),
      recipes: Object.entries(RECIPES).map(([id, r]) => ({ id, label: r.label, hint: r.hint, grade: r.grade, sections: r.sections })),
      effects: EFFECTS,
      grades: GRADES,
      fonts: FONTS.map(({ id, label, category }) => ({ id, label, category })),
      tracks: publicTracks().map(({ id, title, category, duration_s, url, credit }) => ({ id, title, category, duration_s, url, credit })),
      limits: { ...EDIT, image: IMAGE_LIMITS },
    });
  }),
);

/** Temps forts d'un son (calculés à la première demande, puis gardés). */
editAdminRouter.get(
  '/tracks/:id/beats',
  ah(async (req, res) => {
    await ensureMusic();
    const track = findTrack(String(req.params.id));
    if (!track) throw new HttpError(404, 'Son introuvable.');
    res.set('Cache-Control', 'no-store');
    res.json(await trackBeats(track));
  }),
);

// --- photothèque ----------------------------------------------------------------------------------

/** Dépôt d'une photo (corps brut) ; `rights=1` : l'admin confirme en avoir les droits. */
editAdminRouter.post(
  '/images',
  express.raw({ type: () => true, limit: IMAGE_LIMITS.maxBytes + 1024 }),
  ah(async (req, res) => {
    if (req.query.rights !== '1') throw new HttpError(400, 'Confirme que tu as le droit d’utiliser cette photo.');
    const image = await addImage({ data: req.body, title: req.query.title, credit: req.query.credit });
    res.status(201).json({ image, images: await listImages({ all: true }) });
  }),
);

editAdminRouter.patch(
  '/images/:id',
  ah(async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    res.json({ image: await updateImage(req.params.id, { title: b.title, credit: b.credit, enabled: b.enabled }) });
  }),
);

editAdminRouter.delete(
  '/images/:id',
  ah(async (req, res) => {
    await deleteImage(req.params.id);
    res.json({ images: await listImages({ all: true }) });
  }),
);

/** Photo ou vignette (`?thumb=1`), pour l'admin (y compris une photo masquée). */
editAdminRouter.get('/images/:id/file', (req, res) => {
  const file = imagePath(req.params.id, { thumb: req.query.thumb === '1' });
  if (!file) return res.status(404).json({ error: 'Photo introuvable.' });
  sendFile(res, file, 'image/jpeg');
});

// --- modèles ---------------------------------------------------------------------------------------

editAdminRouter.post(
  '/templates',
  ah(async (req, res) => res.status(201).json({ template: await createTemplate(req.body ?? {}) })),
);

editAdminRouter.put(
  '/templates/:id',
  ah(async (req, res) => res.json({ template: await updateTemplate(req.params.id, req.body?.template) })),
);

editAdminRouter.patch(
  '/templates/:id',
  ah(async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    res.json({ template: await setTemplateState(req.params.id, { enabled: b.enabled, position: b.position }) });
  }),
);

editAdminRouter.delete(
  '/templates/:id',
  ah(async (req, res) => {
    await deleteTemplate(req.params.id);
    res.json({ ok: true });
  }),
);

/** Lance le rendu de l'aperçu d'un modèle ; son état se suit avec GET /jobs/:id. */
editAdminRouter.post(
  '/templates/:id/preview',
  ah(async (req, res) => res.status(202).json({ job: await startPreview(req.params.id, { ip: req.ip }) })),
);

editAdminRouter.get(
  '/templates/:id/preview.mp4',
  ah(async (req, res) => {
    const t = await getTemplate(req.params.id);
    if (!t.has_preview) throw new HttpError(404, 'Pas encore d’aperçu pour ce modèle.');
    sendFile(res, previewPath(t.id), 'video/mp4');
  }),
);

editAdminRouter.get('/jobs/:id', (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job || job.kind !== 'edit') return res.status(404).json({ error: 'Rendu introuvable ou expiré.' });
  res.set('Cache-Control', 'no-store').json(publicJob(job));
});
