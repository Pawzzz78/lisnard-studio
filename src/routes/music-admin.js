/** Bibliothèque de musiques du studio (admin) : liste, dépôt, modification, masquage, suppression. */
import express, { Router } from 'express';
import { HttpError, ah } from '../http-error.js';
import { addTrack, adminTracks, deleteTrack, ensureMusic, libraryFile, MUSIC_LIMITS, updateTrack } from '../studio/music.js';
import { refreshTrending, trendingConfig, trendingStatus } from '../studio/trending.js';

export const musicAdminRouter = Router();


musicAdminRouter.get(
  '/',
  ah(async (_req, res) => {
    await ensureMusic();
    res.set('Cache-Control', 'no-store');
    res.json({ ...adminTracks(), limits: MUSIC_LIMITS, trending_status: await trendingStatus() });
  }),
);

/** État des sons tendance TikTok (l'admin le relit pendant une actualisation). */
musicAdminRouter.get(
  '/trending',
  ah(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await trendingStatus());
  }),
);

/** Lance l'actualisation tout de suite (elle tourne en arrière-plan : quelques minutes). */
musicAdminRouter.post(
  '/trending/refresh',
  ah(async (_req, res) => {
    const cfg = trendingConfig();
    const st = await trendingStatus(cfg);
    if (!st.available) throw new HttpError(409, `Sons tendance indisponibles : ${st.reason}.`);
    if (st.running) throw new HttpError(409, 'Une actualisation est déjà en cours.');
    await ensureMusic();
    refreshTrending({ cfg }).then(
      (r) => console.log(`Sons tendance : ${r.total} sons (${r.added} nouveaux, ${r.failed} ignorés, ${r.removed} supprimés).`),
      (e) => console.warn(`Sons tendance : ${e.message}`),
    );
    res.status(202).json({ ...st, running: true });
  }),
);

/** Dépôt d'un fichier audio (corps brut). Titre, catégorie et crédit dans l'adresse ; `rights=1` : l'admin confirme avoir les droits. */
musicAdminRouter.post(
  '/',
  express.raw({ type: () => true, limit: MUSIC_LIMITS.maxBytes + 1024 }),
  ah(async (req, res) => {
    if (req.query.rights !== '1') throw new HttpError(400, 'Confirme que tu as le droit d’utiliser ce morceau.');
    const track = await addTrack({ data: req.body, title: req.query.title, category: req.query.category, credit: req.query.credit, filename: req.query.filename });
    res.status(201).json({ track: { id: track.id }, ...adminTracks(), limits: MUSIC_LIMITS });
  }),
);

musicAdminRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    res.json({ ...(await updateTrack(String(req.params.id), { title: b.title, category: b.category, credit: b.credit, enabled: b.enabled })), limits: MUSIC_LIMITS });
  }),
);

musicAdminRouter.delete(
  '/:id',
  ah(async (req, res) => res.json({ ...(await deleteTrack(String(req.params.id))), limits: MUSIC_LIMITS })),
);

/** Écoute par l'admin, y compris d'un morceau masqué. */
musicAdminRouter.get(
  '/:id/file',
  ah(async (req, res) => {
    await ensureMusic();
    const file = libraryFile(String(req.params.id), { any: true });
    if (!file) throw new HttpError(404, 'Morceau introuvable.');
    res.sendFile(file, { acceptRanges: true, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'audio/mpeg' } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Fichier introuvable sur le serveur.' });
    });
  }),
);
