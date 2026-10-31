// Cadrage automatique sur le visage (mode plein écran) : du « où sont les visages » au « où placer le cadre ».
// Module pur, partagé par le serveur (rendu ffmpeg), le navigateur (aperçu en direct) et les tests.
//
// Entrée : les visages détectés dans l'interview, `frames[i]` = liste de [x, y, w, h, score] (fractions 0–1 de l'image) à l'instant
// i / fps. Sortie : pour chaque extrait, des points-clés { t, x } où t est en secondes depuis le début de l'extrait et x est la
// position du cadre (cropX : 0 = bord gauche de la source, 1 = bord droit, même convention que le réglage manuel).
//
// Le cadre se comporte comme un cadreur : il reste immobile tant que le visage reste près du centre (zone morte), puis se
// déplace en douceur (départ et arrivée progressifs, vitesse limitée). Jamais de tremblement, même si la détection hésite ;
// seule une coupe de montage fait « sauter » le cadre, comme la coupe elle-même.

export const FRAMING = {
  linkGapS: 6, // un visage perdu moins longtemps que ça (détourné, caché par un geste) garde son identité
  maxGapS: 3, // au-delà, la position est maintenue plutôt qu'interpolée
  deadWin: 0.2, // zone morte : part de la largeur du cadre où le visage peut bouger (hochements, gestes) sans que le cadre suive
  vmaxWin: 0.45, // vitesse maximale du cadre, en largeurs de cadre par seconde
  amaxWin: 0.8, // accélération maximale, en largeurs de cadre par seconde²
  stepS: 0.05, // pas d'observation du visage
  minMoveS: 0.8, // durée minimale d'un déplacement du cadre
  minShare: 0.2, // un visage compte s'il apparaît au moins 20 % du temps du visage le plus présent
  samePerson: 0.363, // similarité d'empreintes à partir de laquelle un visage est celui de la personne de référence (seuil SFace d'OpenCV)
  likelyPerson: 0.28, // en dessous du seuil, un visage reste retenu s'il ressemble nettement plus à la personne que les autres visages du plan…
  likelyMargin: 0.1, // … d'au moins cet écart
  minCoverage: 0.5, // en dessous, le visage est trop peu visible dans l'extrait : pas de cadrage automatique
  minFaceWidth: 0.04, // en dessous (fraction de la largeur de l'image), le visage est trop petit pour être suivi de façon fiable
  // deux panneaux : quand le visage suivi n'est pas repéré partout dans un plan alors qu'une deuxième personne y est, l'écran est coupé en
  // deux (la personne suivie en haut, l'autre en bas) : le cadre ne peut plus se retrouver dans le vide
  splitBelow: 0.95, // part du plan où le visage suivi est repéré, en dessous de laquelle on passe en deux panneaux
  splitMinShotS: 1, // un plan plus court que ça reste en cadrage simple (pas de va-et-vient d'une seconde)
  splitFace: 0.3, // largeur du visage dans un panneau (fraction de la largeur du panneau)
  splitMinW: 0.34, // fenêtre d'un panneau : largeur minimale (fraction de la largeur de la source) : plus petit, l'image devient floue
  splitMaxW: 0.6, // … et maximale
  splitMinTogether: 3, // images où les deux personnes sont vues ensemble pour que ce soient bien deux personnes
  splitSepMargin: 1.3, // deux personnes distinctes : leurs visages sont séparés d'au moins 1,3 fois la distance de deux visages qui se touchent
  splitHardMinW: 0.22, // fenêtre minimale d'un panneau quand les deux personnes sont proches (plus petit : trop flou, pas de deux panneaux)
  splitEdge: 0.01, // marge entre la fenêtre d'un panneau et le visage de l'autre personne (fraction de la largeur de la source)
  maxSplitWindows: 8, // au-delà (beaucoup de coupes), le cadrage reste simple : le graphe ffmpeg resterait raisonnable
};

/** Un panneau a le format 9:8 (la moitié d'un écran 9:16). */
export const PANEL = { w: 9, h: 8 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

/** Largeur de la fenêtre 9:16 en fraction de la largeur de la source (aspect = largeur / hauteur de la source). */
export const windowWidth = (aspect) => 9 / 16 / aspect;

/** Limites du plan (entre deux coupes) qui contient [fromS, toS], en secondes ; `total` : durée couverte par les visages. */
export function shotBounds(fromS, toS, cuts = [], total = Infinity) {
  const before = cuts.filter((c) => c <= fromS + 1e-9);
  const after = cuts.filter((c) => c >= toS - 1e-9);
  return { from: before.length ? Math.max(...before) : 0, to: after.length ? Math.min(...after) : total };
}

/** Un visage peut-il être le même qu'au dernier point d'un visage suivi ? (distance en hauteurs d'image, taille cohérente) */
function sameFace(d, last, t, aspect, cx, cy, h) {
  const gap = t - last.t;
  if (gap > FRAMING.linkGapS + 1e-9) return null;
  const ratio = h / last.h;
  if (ratio < 0.5 || ratio > 2) return null; // un gros visage et un petit ne sont pas le même
  const dist = Math.hypot((cx - last.cx) * aspect, cy - last.cy);
  const reach = Math.max(h, last.h) * (0.6 + 0.4 * Math.min(gap, 3)); // un visage ne va pas loin entre deux images, davantage s'il a été perdu un moment
  return dist < Math.max(0.04, reach) ? dist : null;
}

/**
 * Regroupe les détections en visages suivis dans le temps. Renvoie [{ pts, weight, share, meanX, ident }] ;
 * `weight` (taille × netteté × présence) sert à désigner « le visage le plus gros ».
 * Seuls les points de [fromS, toS[ sont gardés et comptés, mais les visages sont suivis sur `link` ({ from, to } : tout le plan)
 * et leur ressemblance avec la personne de référence est lue sur tout le plan : les comparaisons ont été faites sur quelques
 * images du plan, qui n'est pas forcément celles de l'extrait.
 */
export function faceTracks(frames, fps, aspect, fromS, toS, ident = null, link = null) {
  const [linkFrom, linkTo] = [link?.from ?? fromS, link?.to ?? toS];
  const i0 = Math.max(0, Math.ceil(linkFrom * fps - 1e-9));
  const i1 = Math.min(frames.length - 1, Math.ceil(linkTo * fps - 1e-9) - 1); // [from, to[ : l'image tombant pile sur la fin appartient au plan suivant
  const tracks = [];
  for (let i = i0; i <= i1; i++) {
    const t = i / fps;
    const dets = (frames[i] ?? []).map((d, di) => [...d.slice(0, 5), di]).sort((a, b) => b[2] * b[3] - a[2] * a[3]);
    const taken = new Set();
    for (const [x, y, w, h, s, di] of dets) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      let best = null;
      let bestD = Infinity;
      for (const tr of tracks) {
        if (taken.has(tr)) continue;
        const d = sameFace(null, tr.pts[tr.pts.length - 1], t, aspect, cx, cy, h);
        if (d !== null && d < bestD) {
          best = tr;
          bestD = d;
        }
      }
      if (!best) {
        best = { pts: [] };
        tracks.push(best);
      }
      taken.add(best);
      best.pts.push({ t, cx, cy, h, s, w, fi: i, di });
    }
  }
  const inRange = (p) => p.t >= fromS - 1e-9 && p.t < toS - 1e-9;
  const out = tracks
    .map((tr) => {
      const mine = tr.pts.filter(inRange);
      // identité : moyenne du tiers supérieur des ressemblances relevées sur le visage (un mauvais cliché ne compte pas, ni un hasard)
      const sims = ident ? tr.pts.map((p) => ident.get(`${p.fi}:${p.di}`)).filter((v) => v !== undefined).sort((a, b) => b - a) : [];
      const top = sims.slice(0, Math.max(1, Math.ceil(sims.length / 3)));
      return {
        ident: sims.length ? top.reduce((a, v) => a + v, 0) / top.length : null,
        pts: mine,
        count: mine.length,
        weight: mine.reduce((a, p) => a + p.w * aspect * p.h * p.s, 0),
        meanX: mine.length ? mine.reduce((a, p) => a + p.cx, 0) / mine.length : 0.5,
      };
    })
    .filter((tr) => tr.count > 0);
  const most = Math.max(0, ...out.map((tr) => tr.count));
  for (const tr of out) tr.share = most ? tr.count / most : 0;
  return out;
}

/**
 * Visage à suivre : « lisnard » = celui qui ressemble à la personne de référence (sinon le plus gros) ; « auto » = le plus gros ;
 * « left » / « right » = le plus à gauche / à droite parmi les visages présents.
 */
export function pickTrack(tracks, subject = 'auto') {
  const real = tracks.filter((tr) => tr.share >= FRAMING.minShare && tr.count >= 2);
  const pool = real.length ? real : tracks.filter((tr) => tr.share === 1);
  if (!pool.length) return null;
  if (subject === 'lisnard') {
    const known = pool.filter((tr) => tr.ident !== null).sort((a, b) => b.ident - a.ident);
    if (known.length) {
      const [first, second] = known;
      // sûr : la ressemblance atteint le seuil ; probable : elle est plus faible mais nettement au-dessus de celle des autres visages
      if (first.ident >= FRAMING.samePerson || (first.ident >= FRAMING.likelyPerson && first.ident - (second?.ident ?? 0) >= FRAMING.likelyMargin)) {
        first.recognized = true;
        return first;
      }
    }
  }
  if (subject === 'left') return pool.reduce((a, b) => (b.meanX < a.meanX ? b : a));
  if (subject === 'right') return pool.reduce((a, b) => (b.meanX > a.meanX ? b : a));
  return pool.reduce((a, b) => (b.weight > a.weight ? b : a));
}

/** Nombre de visages distincts présents de façon significative dans l'extrait. */
export const faceCount = (tracks) => tracks.filter((tr) => tr.share >= FRAMING.minShare && tr.count >= 2).length;

const median = (a) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const quantile = (a, q) => {
  const s = [...a].sort((p, r) => p - r);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

/**
 * La personne suivie (en haut) et l'autre personne du plan (en bas) : la plus présente parmi les autres visages qui ont été vus EN MÊME TEMPS
 * que la personne suivie ET qui sont bien une autre personne : visage nettement à côté (jamais deux fois la même personne : une double
 * détection, ou un visage perdu puis retrouvé à côté, ne devient pas « l'autre personne »), et pas reconnu comme David Lisnard quand la
 * personne suivie l'est. `gap` : écart horizontal prudent entre les deux visages, `wTop` / `wBottom` : leurs largeurs (fractions de la source).
 */
export function pickPair(tracks, subject = 'auto') {
  const top = pickTrack(tracks, subject);
  if (!top) return null;
  const mine = new Map(top.pts.map((p) => [p.fi, p]));
  const wTop = median(top.pts.map((p) => p.w));
  const others = [];
  for (const tr of tracks) {
    if (tr === top || tr.share < FRAMING.minShare || tr.count < 2) continue;
    const dx = tr.pts.filter((p) => mine.has(p.fi)).map((p) => Math.abs(p.cx - mine.get(p.fi).cx));
    if (dx.length < FRAMING.splitMinTogether) continue;
    const wBottom = median(tr.pts.map((p) => p.w));
    const gap = quantile(dx, 0.25); // le quart des images où ils sont le plus proches : on se protège du pire cas
    if (gap < (FRAMING.splitSepMargin * (wTop + wBottom)) / 2) continue; // trop près : c'est la même personne, ou ce serait la même image deux fois
    if (top.ident !== null && top.ident >= FRAMING.samePerson && tr.ident !== null && tr.ident >= FRAMING.samePerson) continue; // les deux ressemblent à la personne de référence
    others.push({ tr, gap, wBottom });
  }
  others.sort((a, b) => b.tr.count - a.tr.count || b.tr.weight - a.tr.weight);
  const best = others[0];
  return { top, bottom: best?.tr ?? null, gap: best?.gap ?? 0, wTop, wBottom: best?.wBottom ?? 0 };
}

/**
 * Fenêtre d'un panneau pour un visage : largeur `fw` (fraction de la largeur de la source, choisie pour que le visage fasse
 * `splitFace` du panneau, sans dépasser `cap` : la fenêtre ne doit pas montrer l'autre personne), hauteur `fh` (fraction de la hauteur de la source, format 9:8) et centre vertical `cy` (le visage un peu
 * au-dessus du milieu). `aspect` : largeur / hauteur de la source.
 */
export function panelWindow(tracks, aspect, cap = 1) {
  const pts = tracks.flatMap((tr) => tr.pts);
  const maxW = Math.min(FRAMING.splitMaxW, PANEL.w / (PANEL.h * aspect), cap); // la hauteur de la fenêtre ne peut pas dépasser la source ; `cap` : pour ne pas montrer l'autre personne
  const fw = round(clamp(median(pts.map((p) => p.w)) / FRAMING.splitFace, Math.min(FRAMING.splitMinW, maxW), maxW), 4);
  const fh = round((fw * aspect * PANEL.h) / PANEL.w, 4);
  const cy = round(clamp(median(pts.map((p) => p.cy)) + 0.06 * fh, fh / 2, 1 - fh / 2), 4);
  return { fw, fh, cy };
}

/** Médiane glissante sur 5 valeurs : écarte les détections isolées (visage mal placé sur une image). */
const median5 = (a) => a.map((_, i) => [-2, -1, 0, 1, 2].map((d) => a[clamp(i + d, 0, a.length - 1)]).sort((p, q) => p - q)[2]);

/** Courbe douce (départ et arrivée à vitesse nulle) entre deux points-clés. */
const ease = (u) => u * u * (3 - 2 * u);

/**
 * Trajectoire du cadre pour un visage suivi, entre fromS et toS (secondes de la vidéo).
 * Renvoie des points-clés [{ t, x }] (t depuis le début de l'extrait). Entre deux points consécutifs, le cadre glisse avec la
 * courbe douce `ease` (deux points de même x = cadre immobile) : le cadre reste immobile, puis se déplace d'un point à l'autre
 * en démarrant et en s'arrêtant doucement, à une vitesse et une accélération bornées.
 */
export function framingPath(track, fromS, toS, aspect, startX = null, windowW = null) {
  const dur = toS - fromS;
  const cw = windowW ?? windowWidth(aspect); // fenêtre 9:16 par défaut ; un panneau a sa propre largeur
  if (cw >= 0.999) return [{ t: 0, x: 0.5 }, { t: round(dur, 3), x: 0.5 }]; // source plus étroite que l'écran : rien à cadrer
  const k = cw / (1 - cw); // largeur de cadre exprimée en unités de cropX
  const pts = track.pts;
  const target = median5(pts.map((p) => clamp((p.cx - cw / 2) / (1 - cw), 0, 1)));
  const at = (t) => {
    if (t <= pts[0].t) return target[0];
    if (t >= pts[pts.length - 1].t) return target[target.length - 1];
    let j = 0;
    while (j < pts.length - 2 && pts[j + 1].t < t) j++;
    const [p, q] = [pts[j], pts[j + 1]];
    if (q.t - p.t > FRAMING.maxGapS) return t - p.t < q.t - t ? target[j] : target[j + 1]; // visage perdu : on tient la dernière position
    return target[j] + ((target[j + 1] - target[j]) * (t - p.t)) / (q.t - p.t);
  };

  const dead = FRAMING.deadWin * k;
  const vmax = FRAMING.vmaxWin * k;
  const amax = FRAMING.amaxWin * k;
  // au début d'un extrait on est déjà sur le visage ; après une fausse coupe (même plan), on garde la position pour ne pas sauter
  let pos = startX !== null && Math.abs(at(fromS) - startX) <= dead ? startX : at(fromS);
  const keys = [{ t: 0, x: pos }];
  let busyUntil = 0;
  for (let n = 1; n * FRAMING.stepS <= dur + 1e-9; n++) {
    const t = n * FRAMING.stepS;
    if (t < busyUntil) continue; // un déplacement est en cours : on le laisse finir
    const err = at(fromS + t) - pos;
    if (Math.abs(err) <= dead) continue;
    // durée du déplacement selon la distance : vitesse de pointe de la courbe douce = 1,5 × d / durée, accélération = 6 × d / durée²
    const lengthFor = (d) => Math.max(FRAMING.minMoveS, (1.5 * d) / vmax, Math.sqrt((6 * d) / amax));
    const where = (u) => at(fromS + Math.min(dur, u));
    let len = lengthFor(Math.abs(err));
    let dest = where(t + len); // on vise l'endroit où sera le visage à la fin du déplacement
    len = lengthFor(Math.abs(dest - pos));
    dest = where(t + len);
    const drift = dest - where(t);
    if (Math.abs(drift) > dead * 0.5) dest += Math.sign(drift) * dead * 0.8; // visage en marche : on prend de l'avance pour ne pas repartir aussitôt
    dest = clamp(dest, 0, 1);
    len = lengthFor(Math.abs(dest - pos));
    if (keys[keys.length - 1].t < t) keys.push({ t, x: pos });
    keys.push({ t: t + len, x: dest });
    pos = dest;
    busyUntil = t + len;
  }
  if (keys[keys.length - 1].t < dur) keys.push({ t: dur, x: pos });
  return keys.map((p) => ({ t: round(p.t, 3), x: round(p.x, 4) }));
}

/** Découpe [fromS, toS] aux changements de plan (cuts, en secondes) ; on ignore ceux qui laisseraient un plan de moins de 0,4 s. */
export function splitShots(fromS, toS, cuts = []) {
  const inside = cuts.filter((c) => c > fromS + 0.4 && c < toS - 0.4).sort((a, b) => a - b);
  const bounds = [fromS];
  for (const c of inside) if (c - bounds[bounds.length - 1] >= 0.4) bounds.push(c);
  bounds.push(toS);
  return bounds.slice(1).map((end, i) => ({ from: bounds[i], to: end }));
}

/** Points-clés d'un extrait à partir de ceux de ses plans (chacun relatif au début du plan) : une seule suite, sans doublon. */
function joinKeys(parts, fromS) {
  const keys = [];
  for (const p of parts) {
    const off = p.from - fromS;
    for (const k of p.keys) {
      const point = { t: round(off + k.t, 3), x: k.x };
      const prev = keys[keys.length - 1];
      if (prev && point.t === prev.t && point.x === prev.x) continue;
      keys.push(point);
    }
  }
  return keys;
}

/**
 * Cadrage d'un extrait : { keys, faces, coverage, plan, splitShare } (coverage : part de l'extrait où le visage suivi a été détecté),
 * ou null si aucun visage n'a été trouvé. Chaque plan de l'interview (entre deux coupes de montage) est cadré séparément ;
 * à la coupe le cadre saute directement sur le visage du nouveau plan, comme le fait la coupe elle-même.
 *
 * Deux panneaux : dans un plan où le visage suivi n'est pas repéré partout (moins de `splitBelow`) mais où une deuxième personne est
 * là, le cadre risquerait de se retrouver dans le vide. `plan` décrit alors l'écran coupé en deux, pour ces plans seulement :
 * `{ windows: [[de, à], …] (secondes depuis le début de l'extrait), top, bottom }` ; chaque panneau a sa fenêtre
 * (`fw`, `fh`, `cy`, voir panelWindow) et sa trajectoire `keys` sur tout l'extrait (elle reste immobile hors des plans coupés en deux).
 * La personne suivie est en haut, l'autre en bas. `plan` vaut null s'il n'y en a pas.
 */
export function framingForExtract({ frames, fps, aspect, startMs, endMs, subject = 'auto', cuts = [], ident = null }) {
  const [fromS, toS] = [startMs / 1000, endMs / 1000];
  const shots = splitShots(fromS, toS, cuts).map((sh) => {
    const tracks = faceTracks(frames, fps, aspect, sh.from, sh.to, ident, shotBounds(sh.from, sh.to, cuts, frames.length / fps));
    const pair = pickPair(tracks, subject);
    const expected = Math.max(1, Math.round((sh.to - sh.from) * fps));
    // un panneau ne doit jamais montrer l'autre personne : sa fenêtre s'arrête avant le visage de l'autre ; si les deux sont trop proches, pas de deux panneaux
    const capTop = pair?.bottom ? 2 * (pair.gap - pair.wBottom / 2 - FRAMING.splitEdge) : 0;
    const capBottom = pair?.bottom ? 2 * (pair.gap - pair.wTop / 2 - FRAMING.splitEdge) : 0;
    const apart = Math.min(capTop, capBottom) >= FRAMING.splitHardMinW;
    const split = Boolean(pair?.bottom) && apart && pair.top.count / expected < FRAMING.splitBelow && sh.to - sh.from >= FRAMING.splitMinShotS;
    return { ...sh, tracks, track: pair?.top ?? null, other: pair?.bottom ?? null, expected, split, capTop, capBottom };
  });
  if (!shots.some((sh) => sh.track)) return null;
  if (shots.filter((sh) => sh.split).length > FRAMING.maxSplitWindows) for (const sh of shots) sh.split = false;
  let detected = 0;
  let faces = 0;
  let prevEnd = null;
  // plans à plusieurs visages : combien ont été tranchés grâce à la reconnaissance de la personne de référence
  let crowded = 0;
  let recognized = 0;
  let identBest = null;
  const widths = [];
  const parts = shots.map((sh) => {
    if (!sh.track) return { ...sh, keys: null };
    detected += sh.split ? sh.expected : sh.track.count; // en deux panneaux, les deux personnes sont à l'écran : rien n'est « perdu »
    for (const p of sh.track.pts) widths.push(p.w);
    faces = Math.max(faces, faceCount(sh.tracks));
    if (faceCount(sh.tracks) > 1) {
      crowded++;
      if (sh.track.recognized) recognized++;
      for (const t of sh.tracks) if (t.ident !== null && (identBest === null || t.ident > identBest)) identBest = t.ident; // meilleure ressemblance relevée (pour expliquer un échec)
    }
    const keys = framingPath(sh.track, sh.from, sh.to, aspect, prevEnd);
    prevEnd = keys.at(-1).x;
    return { ...sh, keys };
  });
  // plan sans visage : on garde la position du plan précédent (ou, au début, celle du premier plan avec un visage)
  const holdKeys = (list) => {
    let hold = list.find((p) => p.keys).keys[0].x;
    return list.map((p) => {
      if (p.keys) {
        hold = p.keys.at(-1).x;
        return p;
      }
      return { ...p, keys: [{ t: 0, x: hold }, { t: round(p.to - p.from, 3), x: hold }] };
    });
  };
  const keys = joinKeys(holdKeys(parts), fromS);
  let plan = null;
  const splitParts = parts.filter((p) => p.split);
  if (splitParts.length) {
    const panel = (pick, capKey) => {
      const geo = panelWindow(splitParts.map(pick), aspect, Math.min(...splitParts.map((p) => p[capKey])));
      let end = null;
      const perShot = parts.map((p) => {
        if (!p.split) return { from: p.from, to: p.to, keys: null };
        const k = framingPath(pick(p), p.from, p.to, aspect, end, geo.fw);
        end = k.at(-1).x;
        return { from: p.from, to: p.to, keys: k };
      });
      return { ...geo, keys: joinKeys(holdKeys(perShot), fromS) };
    };
    plan = { windows: splitParts.map((p) => [round(p.from - fromS, 3), round(p.to - fromS, 3)]), top: panel((p) => p.track, 'capTop'), bottom: panel((p) => p.other, 'capBottom') };
  }
  const expected = Math.max(1, Math.round((toS - fromS) * fps));
  widths.sort((a, b) => a - b);
  const splitShare = plan ? round(plan.windows.reduce((n, [a, b]) => n + (b - a), 0) / (toS - fromS), 2) : 0;
  return { keys, faces, coverage: round(Math.min(1, detected / expected), 2), faceW: widths.length ? widths[Math.floor(widths.length / 2)] : 0, crowded, recognized, identBest, plan, splitShare };
}

/**
 * Cadrage de tout le clip : un segment par extrait, sur la ligne de temps du clip (t0, t1 en secondes ; les points-clés restent
 * relatifs à t0). `keys` vaut null quand aucun visage n'a été trouvé : le cadre manuel s'applique alors à ce segment.
 * `plan` : écran coupé en deux dans certains plans du segment (voir framingForExtract), sinon null ; `split` : part du clip ainsi coupée.
 */
export function framingForClip({ frames, fps, aspect, extracts, subject = 'auto', cuts = [], ident = null }) {
  let t0 = 0;
  let faces = 0;
  let covered = 0;
  let crowded = 0;
  let recognized = 0;
  let identBest = null;
  let splitTime = 0;
  const off = { none: 0, small: 0, rare: 0 }; // extraits sans cadrage automatique, selon la raison
  const segments = extracts.map((e) => {
    const dur = (e.end_ms - e.start_ms) / 1000;
    let r = framingForExtract({ frames, fps, aspect, startMs: e.start_ms, endMs: e.end_ms, subject, cuts, ident });
    // visage trop petit ou trop peu visible : mieux vaut le cadre manuel qu'un suivi qui se perd
    if (!r) off.none++;
    else if (r.faceW < FRAMING.minFaceWidth) {
      off.small++;
      r = null;
    } else if (r.coverage < FRAMING.minCoverage) {
      off.rare++;
      r = null;
    }
    const seg = { t0: round(t0, 3), t1: round(t0 + dur, 3), keys: r ? r.keys : null, plan: r?.plan ?? null };
    t0 += dur;
    if (r) {
      splitTime += r.splitShare * dur;
      faces = Math.max(faces, r.faces);
      covered += r.coverage * dur;
      crowded += r.crowded;
      recognized += r.recognized;
      if (r.identBest !== null && (identBest === null || r.identBest > identBest)) identBest = r.identBest;
    }
    return seg;
  });
  const missing = off.none + off.small + off.rare;
  // pourquoi le cadrage automatique manque (le plus fréquent) : « small », « rare » ou « none » (aucun visage)
  const reason = missing ? Object.entries(off).sort((x, y) => y[1] - x[1])[0][0] : null;
  return { segments, faces, coverage: t0 ? round(covered / t0, 2) : 0, split: t0 ? round(splitTime / t0, 2) : 0, crowded, recognized, identBest: identBest === null ? null : round(identBest, 2), reason, missing };
}

/** Position du cadre à l'instant t (secondes depuis le début du segment). */
export function cropXAt(keys, t) {
  if (t <= keys[0].t) return keys[0].x;
  for (let i = 1; i < keys.length; i++) {
    if (t < keys[i].t) return keys[i - 1].x + (keys[i].x - keys[i - 1].x) * ease((t - keys[i - 1].t) / (keys[i].t - keys[i - 1].t)); // deux points au même instant : saut (coupe)
  }
  return keys[keys.length - 1].x;
}

/**
 * Panneaux à l'instant t du clip (secondes) si l'écran est coupé en deux à cet instant : { top, bottom } avec, pour chacun, la fenêtre
 * (`fw`, `fh`, `cy`) et la position `x` du cadre (même convention que cropX). null sinon.
 */
export function splitAtClip(segments, t) {
  const seg = segments?.find((s) => t >= s.t0 && t < s.t1);
  if (!seg?.plan) return null;
  const rel = t - seg.t0;
  if (!seg.plan.windows.some(([a, b]) => rel >= a && rel < b)) return null;
  const at = (p) => ({ fw: p.fw, fh: p.fh, cy: p.cy, x: cropXAt(p.keys, rel) });
  return { top: at(seg.plan.top), bottom: at(seg.plan.bottom) };
}

/** Position du cadre à l'instant t du clip (secondes), fond de repli `fallback` si le segment n'a pas de visage. */
export function cropXAtClip(segments, t, fallback = 0.5) {
  const seg = segments.find((s) => t >= s.t0 && t < s.t1) ?? segments[segments.length - 1];
  return seg?.keys ? cropXAt(seg.keys, t - seg.t0) : fallback;
}

/** Même courbe sous forme d'expression ffmpeg (variable `t` = secondes depuis le début de l'extrait). */
export function cropXExpr(keys) {
  const n = (v) => String(round(v, 4));
  if (keys.length < 2 || keys.every((p) => p.x === keys[0].x)) return n(keys[0].x);
  let expr = n(keys[keys.length - 1].x);
  for (let i = keys.length - 1; i >= 1; i--) {
    const [a, b] = [keys[i - 1], keys[i]];
    if (b.t - a.t < 1e-6) continue; // saut : la condition du segment suivant s'en charge
    const u = `((t-${n(a.t)})/${n(b.t - a.t)})`;
    const seg = a.x === b.x ? n(a.x) : `${n(a.x)}+(${n(b.x - a.x)})*${u}*${u}*(3-2*${u})`;
    expr = `if(lt(t,${n(b.t)}),${seg},${expr})`;
  }
  return expr;
}
