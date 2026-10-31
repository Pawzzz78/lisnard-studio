/** Reconnaissance de David Lisnard (admin) : photos de référence, et mise à jour des vidéos déjà analysées. */
import express, { Router } from 'express';
import { HttpError, ah } from '../http-error.js';
import { facesEnabled, identifyAll, reanalyzeOutdated } from '../studio/faces.js';
import { REFERENCE, addReference, deleteReference, listReferences, referenceThumb } from '../studio/references.js';

export const facesAdminRouter = Router();


const refId = (req) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Photo introuvable.');
  return id;
};

facesAdminRouter.get(
  '/references',
  ah(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...(await listReferences()), enabled: facesEnabled(), minFacePx: REFERENCE.minFacePx });
  }),
);

/** Ajout d'une photo (corps brut de l'image, nom d'origine dans `?name=`). */
facesAdminRouter.post(
  '/references',
  express.raw({ type: () => true, limit: REFERENCE.maxBytes + 1024 }),
  ah(async (req, res) => {
    if (!facesEnabled()) throw new HttpError(503, 'Le cadrage automatique est désactivé sur ce serveur.');
    const { id } = await addReference({ bytes: req.body, name: req.query.name });
    res.status(201).json({ id, ...(await listReferences()) });
  }),
);

facesAdminRouter.delete(
  '/references/:id',
  ah(async (req, res) => {
    await deleteReference(refId(req));
    res.json(await listReferences());
  }),
);

facesAdminRouter.get(
  '/references/:id/thumb',
  ah(async (req, res) => {
    const thumb = await referenceThumb(refId(req));
    if (!thumb) throw new HttpError(404, 'Photo introuvable.');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }).send(thumb);
  }),
);

/** Refait l'analyse des visages de toutes les vidéos analysées avec une qualité plus ancienne (définition plus faible). */
facesAdminRouter.post(
  '/reanalyze-all',
  ah(async (_req, res) => res.json({ queued: await reanalyzeOutdated() })),
);

/** Relance la reconnaissance sur toutes les vidéos analysées avec un autre jeu de photos. */
facesAdminRouter.post(
  '/identify-all',
  ah(async (_req, res) => res.json({ queued: await identifyAll() })),
);
