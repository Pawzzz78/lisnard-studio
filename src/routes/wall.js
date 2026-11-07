/** Mur des clips (public) : classement des TikToks du hashtag suivi, lu dans la base ; vignettes copiées sur le serveur. */
import { Router } from 'express';
import { HttpError, ah, jsonErrors } from '../http-error.js';
import { PERIODS, SORTS, coverPath, lastOkAt, lastRun, listWall, wallConfig } from '../wall/wall.js';

export const wallRouter = Router();


wallRouter.get(
  '/',
  ah(async (req, res) => {
    const cfg = wallConfig();
    const sort = String(req.query.sort ?? 'score');
    const period = String(req.query.period ?? 'all');
    if (!Object.hasOwn(SORTS, sort)) throw new HttpError(400, 'Classement inconnu.');
    if (!Object.hasOwn(PERIODS, period)) throw new HttpError(400, 'Période inconnue.');
    const [list, last, okAt] = await Promise.all([listWall({ sort, period, limit: req.query.limit, offset: req.query.offset }), lastRun(), lastOkAt()]);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      ...list,
      sort,
      period,
      hashtag: cfg.hashtag,
      max: cfg.max,
      weights: { views: cfg.weights[0], likes: cfg.weights[1], comments: cfg.weights[2] },
      updated_at: last?.status === 'ok' ? last.finished_at : (okAt ?? null),
      last_status: last?.status ?? null,
      enabled: cfg.enabled,
    });
  }),
);

wallRouter.get('/cover/:id', (req, res) => {
  if (!/^\d{6,25}$/.test(req.params.id)) return res.status(404).json({ error: 'Vignette introuvable.' });
  res.sendFile(coverPath(req.params.id), { headers: { 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'image/jpeg' } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Vignette introuvable.' });
  });
});

wallRouter.use(jsonErrors());
