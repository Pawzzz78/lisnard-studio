/** Veille #projetlisnard (admin) : état, actualisation à la demande, masquage de publications et d'auteurs. */
import { Router } from 'express';
import { HttpError, ah } from '../http-error.js';
import { setAuthorHidden, setPostHidden, startVeilleRefresh, veilleOverview } from '../veille/veille.js';

export const veilleAdminRouter = Router();

veilleAdminRouter.get(
  '/',
  ah(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await veilleOverview());
  }),
);

veilleAdminRouter.post(
  '/refresh',
  ah(async (_req, res) => {
    const r = await startVeilleRefresh({ trigger: 'admin' });
    if (!r.started) throw new HttpError(409, r.reason);
    res.status(202).json({ started: true });
  }),
);

veilleAdminRouter.patch(
  '/posts/:key',
  ah(async (req, res) => {
    await setPostHidden(req.params.key, req.body?.hidden === true);
    res.json({ ok: true });
  }),
);

veilleAdminRouter.put(
  '/authors/:platform/:name',
  ah(async (req, res) => {
    await setAuthorHidden(req.params.platform, req.params.name, req.body?.hidden === true);
    res.json({ ok: true });
  }),
);
