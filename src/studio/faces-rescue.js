/**
 * Deuxième chance pour les visages que la première détection n'a pas vus.
 *
 * La première passe regarde toute la vidéo en définition moyenne (rapide). Elle rate les petits visages (plans larges, deux personnes
 * assises à une table) et les images où un visage est un instant mal posé. Cette deuxième passe, plus fine et donc plus lente, ne
 * regarde que ce qui vaut la peine :
 *  - les images SANS visage dans un plan où un visage a été vu ailleurs (la personne est là, la détection a seulement hésité) ;
 *  - dans les plans longs où rien n'a été vu, quelques images « sondes » : si une sonde trouve un visage, tout le plan est repris.
 * Le nombre d'images reprises est borné (RESCUE.budget des images de la vidéo, RESCUE.maxMs de calcul) pour que l'analyse ne s'allonge pas sans fin.
 * Module pur : le calcul des images à reprendre est testable sans vidéo.
 */
export const RESCUE = {
  side: 1280, // grand côté de l'image d'analyse de la deuxième passe
  budget: 0.6, // part maximale des images de la vidéo reprises (la durée maximale ci-dessous borne aussi le calcul)
  minFacesInShot: 3, // images avec visage pour dire qu'un visage est « vu » dans un plan
  probeEveryS: 2, // une image sonde toutes les 2 s dans un plan sans visage…
  minProbeShotS: 4, // … s'il dure au moins 4 s
  batch: 40, // images décodées par appel de ffmpeg
  maxMs: 40 * 60_000, // durée maximale de la deuxième passe : au-delà, on garde ce qui a été trouvé
};

/** Plans entre deux coupes de montage : [{ i0, i1 }] (indices d'images, inclus). `cuts` en secondes. */
export function shotRanges(total, fps, cuts = []) {
  if (!total) return [];
  const edges = [...new Set(cuts.map((c) => Math.ceil(c * fps - 1e-9)).filter((i) => i > 0 && i < total))].sort((a, b) => a - b);
  const bounds = [0, ...edges, total];
  return bounds.slice(1).map((end, k) => ({ i0: bounds[k], i1: end - 1 }));
}

const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, k) => a + k);

/**
 * Images à reprendre : { lost, probes, limit }.
 *  - lost : indices des images sans visage dans les plans où des visages ont été vus ;
 *  - probes : [{ shot: { i0, i1 }, idx: [indices des images sondes] }] pour les plans longs sans visage ;
 *  - limit : nombre maximal d'images à reprendre au total (sondes comprises).
 */
export function planRescue(frames, fps, cuts = [], { budget = RESCUE.budget } = {}) {
  const limit = Math.floor(frames.length * budget);
  const lost = [];
  const probes = [];
  for (const shot of shotRanges(frames.length, fps, cuts)) {
    const withFaces = range(shot.i0, shot.i1).filter((i) => frames[i].length).length;
    if (withFaces >= RESCUE.minFacesInShot) lost.push(...range(shot.i0, shot.i1).filter((i) => !frames[i].length));
    else if (withFaces === 0 && (shot.i1 - shot.i0 + 1) / fps >= RESCUE.minProbeShotS) {
      const step = Math.max(1, Math.round(RESCUE.probeEveryS * fps));
      const idx = [];
      for (let i = shot.i0 + Math.floor(step / 2); i <= shot.i1; i += step) idx.push(i);
      if (idx.length) probes.push({ shot, idx });
    }
  }
  return { lost: lost.slice(0, limit), probes, limit };
}

/** Indices consécutifs regroupés en suites de `batch` images au plus : [{ i0, n }]. */
export function runs(indices, batch = RESCUE.batch) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i === last.i0 + last.n && last.n < batch) last.n++;
    else out.push({ i0: i, n: 1 });
  }
  return out;
}
