/** Veille #projetlisnard (public) : publications TikTok et Instagram du hashtag et leurs auteurs, lues dans la base. */
import { Router } from 'express';
import { HttpError, ah, jsonErrors } from '../http-error.js';
import { HASHTAG, KEY, PLATFORMS, SORTS, coverPath, listVeille } from '../veille/veille.js';
import { getSetting } from '../settings.js';

export const veilleRouter = Router();

veilleRouter.get(
  '/',
  ah(async (req, res) => {
    const platform = req.query.platform ? String(req.query.platform) : null;
    const sort = String(req.query.sort ?? 'recent');
    const author = req.query.author ? String(req.query.author).replace(/^@/, '') : null;
    if (platform && !PLATFORMS.includes(platform)) throw new HttpError(400, 'Plateforme inconnue.');
    if (!Object.hasOwn(SORTS, sort)) throw new HttpError(400, 'Tri inconnu.');
    if (author && !/^[\w.]{1,60}$/.test(author)) throw new HttpError(400, 'Auteur invalide.');
    const [list, okAt] = await Promise.all([listVeille({ platform, sort, author, limit: req.query.limit, offset: req.query.offset }), getSetting('veille_last_ok', null)]);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ...list, hashtag: HASHTAG, platform, sort, author, updated_at: okAt });
  }),
);

veilleRouter.get('/cover/:key', (req, res) => {
  if (!KEY.test(req.params.key)) return res.status(404).json({ error: 'Vignette introuvable.' });
  res.sendFile(coverPath(req.params.key), { headers: { 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'image/jpeg' } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Vignette introuvable.' });
  });
});

veilleRouter.use(jsonErrors());
