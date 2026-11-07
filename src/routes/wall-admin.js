/** Mur des clips (admin) : état de l'actualisation, actualisation à la demande, masquage de clips et d'auteurs. */
import { Router } from 'express';
import { HttpError, ah } from '../http-error.js';
import { setAuthorHidden, setClipHidden, startWallRefresh, wallOverview } from '../wall/wall.js';

export const wallAdminRouter = Router();


wallAdminRouter.get(
  '/',
  ah(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await wallOverview());
  }),
);

/** Lance l'actualisation en arrière-plan (au plus une toutes les deux minutes) : l'admin suit son avancement avec GET /. */
wallAdminRouter.post(
  '/refresh',
  ah(async (_req, res) => {
    const r = await startWallRefresh({ trigger: 'admin', minGapMs: Number(process.env.WALL_MIN_GAP_MS ?? 2 * 60_000) });
    if (!r.started) throw new HttpError(409, r.reason);
    res.status(202).json({ started: true });
  }),
);

wallAdminRouter.patch(
  '/clips/:id',
  ah(async (req, res) => {
    await setClipHidden(req.params.id, req.body?.hidden === true);
    res.json({ ok: true });
  }),
);

wallAdminRouter.put(
  '/authors/:name',
  ah(async (req, res) => {
    await setAuthorHidden(req.params.name, req.body?.hidden === true);
    res.json({ ok: true });
  }),
);
