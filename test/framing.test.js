// Cadrage automatique : trajectoire du cadre à partir des visages détectés (module pur).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRAMING, cropXAt, cropXAtClip, cropXExpr, faceTracks, framingForClip, framingForExtract, framingPath, panelWindow, pickPair, pickTrack, splitAtClip, splitShots, windowWidth } from '../public/js/framing.js';

const ASPECT = 16 / 9;
const CW = windowWidth(ASPECT);
const toX = (cx) => (cx - CW / 2) / (1 - CW); // position du cadre qui centre un visage en cx
/** Image par seconde, un visage de largeur 0.06 (en fraction de l'image) centré en cx(t). */
const video = (seconds, cxs, { fps = 1, size = 0.06, y = 0.3 } = {}) =>
  Array.from({ length: Math.ceil(seconds * fps) + 1 }, (_, i) => {
    const out = [];
    for (const [cx, s] of [].concat(cxs(i / fps))) if (cx != null) out.push([cx - (s ?? size) / 2, y, s ?? size, (s ?? size) * ASPECT * 1.2, 0.9]);
    return out;
  });
const range = (frames, startMs, endMs, subject = 'auto', cuts = []) => framingForExtract({ frames, fps: 1, aspect: ASPECT, startMs, endMs, subject, cuts });
const evalExpr = (expr, t) => new Function('t', 'lt', 'iff', `return ${expr.replace(/\bif\(/g, 'iff(')}`)(t, (a, b) => a < b, (c, a, b) => (c ? a : b));

test('fenêtre 9:16 : un tiers de la largeur pour une source 16:9', () => {
  assert.ok(Math.abs(CW - 0.3164) < 1e-3);
  assert.equal(windowWidth(9 / 16), 1);
});

test('visage immobile : cadre fixe, centré sur le visage', () => {
  const r = range(video(30, () => [[0.3]]), 0, 30000);
  assert.equal(r.keys.length, 2);
  assert.ok(Math.abs(r.keys[0].x - toX(0.3)) < 1e-3, JSON.stringify(r.keys));
  assert.equal(r.keys[0].x, r.keys[1].x);
  assert.deepEqual([r.faces, r.coverage], [1, 1]);
});

test('petits mouvements dans la zone morte : le cadre ne bouge pas', () => {
  const r = range(video(30, (t) => [[0.5 + 0.015 * Math.sin(t)]]), 0, 30000);
  assert.equal(r.keys.length, 2);
  assert.equal(r.keys[0].x, r.keys[1].x);
});

test('détection bruitée : pas de tremblement', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const frames = video(40, () => [[0.4 + 0.02 * rnd()]], { fps: 2 });
  const r = framingForExtract({ frames, fps: 2, aspect: ASPECT, startMs: 0, endMs: 40000 });
  const xs = Array.from({ length: 1200 }, (_, i) => cropXAt(r.keys, i / 30));
  const variation = xs.slice(1).reduce((a, x, i) => a + Math.abs(x - xs[i]), 0);
  assert.ok(variation < 0.05, `variation totale ${variation}`);
});

test('le visage se déplace : le cadre le rejoint en douceur, sans saut ni dépassement', () => {
  const frames = video(30, (t) => [[0.3 + 0.4 * Math.min(1, Math.max(0, (t - 10) / 8))]]); // glisse de 0,3 à 0,7 entre 10 s et 18 s
  const r = range(frames, 0, 30000);
  assert.ok(r.keys.length >= 3 && r.keys.length <= 12, String(r.keys.length));
  const xs = Array.from({ length: 900 }, (_, i) => cropXAt(r.keys, i / 30));
  const k = CW / (1 - CW);
  const maxStep = Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));
  assert.ok(maxStep <= (FRAMING.vmaxWin * k) / 30 * 1.05, `pas max ${maxStep}`);
  // monotone : jamais de retour en arrière ni de dépassement de la cible
  assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1] - 1e-4));
  assert.ok(Math.max(...xs) <= toX(0.7) + FRAMING.deadWin * k + 1e-3); // au plus l'avance prise sur un visage en marche, qui reste dans la zone morte
  assert.ok(Math.abs(xs[0] - toX(0.3)) < 1e-3, 'le cadre démarre déjà sur le visage');
  assert.ok(Math.abs(xs.at(-1) - toX(0.7)) <= FRAMING.deadWin * k + 1e-3, 'et finit près du visage');
  // accélération bornée (pas de démarrage brusque) et vitesse continue
  const v = xs.slice(1).map((x, i) => (x - xs[i]) * 30);
  const maxAcc = Math.max(...v.slice(1).map((s, i) => Math.abs(s - v[i]) * 30));
  assert.ok(maxAcc <= FRAMING.amaxWin * k * 1.3, `accélération ${maxAcc}`);
});

test('changement de plan : le cadre saute sur le visage du nouveau plan, sans glisser', () => {
  const frames = video(40, (t) => [[t < 20 ? 0.3 : 0.7]]);
  const r = range(frames, 5000, 35000, 'auto', [19.6]); // la coupe est à 19,6 s ; l'image de 20 s est déjà dans le plan suivant
  assert.ok(Math.abs(cropXAt(r.keys, 19.5 - 5) - toX(0.3)) < 1e-3);
  assert.ok(Math.abs(cropXAt(r.keys, 19.7 - 5) - toX(0.7)) < 1e-3, `juste après la coupe : ${cropXAt(r.keys, 14.7)}`);
  assert.ok(r.keys.some((p, i) => i && p.t === r.keys[i - 1].t && p.x !== r.keys[i - 1].x), 'saut = deux points au même instant');
  for (let t = 0; t <= 30; t += 0.21) assert.ok(Math.abs(evalExpr(cropXExpr(r.keys), t) - cropXAt(r.keys, t)) < 1e-6, `t=${t}`);
  // sans l'information de coupe, le suivi par identité garderait le visage le plus présent pendant tout l'extrait
  assert.deepEqual(splitShots(5, 35, [19.6, 5.2, 34.9, 19.7]), [{ from: 5, to: 19.6 }, { from: 19.6, to: 35 }]);
});

test('fausse coupe (même plan, visage presque au même endroit) : le cadre ne saute pas', () => {
  const frames = video(40, (t) => [[t < 20 ? 0.4 : 0.42]]); // 0,02 de déplacement : dans la zone morte
  const r = range(frames, 0, 40000, 'auto', [19.6]);
  const xs = Array.from({ length: 1200 }, (_, i) => cropXAt(r.keys, i / 30));
  const biggest = Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));
  assert.ok(biggest < 0.002, `saut de ${biggest}`);
});

test('plan sans visage au milieu : la position du plan précédent est tenue', () => {
  const frames = video(40, (t) => (t >= 10 && t < 20 ? [] : [[t < 10 ? 0.3 : 0.6]]));
  const r = range(frames, 0, 40000, 'auto', [10, 20]);
  assert.ok(Math.abs(cropXAt(r.keys, 15) - toX(0.3)) < 1e-3);
  assert.ok(Math.abs(cropXAt(r.keys, 25) - toX(0.6)) < 1e-3);
});

test('plusieurs visages : le plus gros par défaut, ou celui de gauche / de droite au choix', () => {
  const frames = video(20, () => [[0.25, 0.04], [0.75, 0.09]]);
  const at = (subject) => range(frames, 0, 20000, subject);
  assert.ok(Math.abs(at('auto').keys[0].x - toX(0.75)) < 1e-3);
  assert.ok(Math.abs(at('right').keys[0].x - toX(0.75)) < 1e-3);
  assert.ok(Math.abs(at('left').keys[0].x - toX(0.25)) < 1e-3);
  assert.equal(at('auto').faces, 2);
  // un seul visage : tous les choix donnent le même cadre
  const solo = video(20, () => [[0.6]]);
  assert.equal(range(solo, 0, 20000, 'left').keys[0].x, range(solo, 0, 20000, 'right').keys[0].x);
});

test('un faux visage de passage (quelques secondes) n\'est pas suivi', () => {
  const frames = video(30, (t) => [[0.3, 0.07], ...(t > 12 && t < 15 ? [[0.8, 0.09]] : [])]);
  const r = range(frames, 0, 30000, 'auto');
  assert.ok(Math.abs(r.keys[0].x - toX(0.3)) < 1e-3 || r.keys.every((p) => p.x < toX(0.8)), JSON.stringify(r.keys));
  assert.equal(range(frames, 0, 30000, 'right').faces, 1); // le passant ne compte pas comme un visage de l'interview
});

test('visage perdu un moment : la dernière position est tenue, sans balayage', () => {
  const frames = video(40, (t) => (t > 10 && t < 25 ? [] : [[0.5]]));
  const r = range(frames, 0, 40000);
  assert.equal(r.keys.length, 2);
  assert.ok(r.coverage < 0.6);
});

test('aucun visage : pas de cadrage automatique, repli sur le cadre manuel', () => {
  assert.equal(range(video(20, () => []), 0, 20000), null);
  const clip = framingForClip({ frames: video(20, () => []), fps: 1, aspect: ASPECT, extracts: [{ start_ms: 0, end_ms: 10000 }, { start_ms: 10000, end_ms: 20000 }] });
  assert.deepEqual(clip.segments.map((s) => s.keys), [null, null]);
  assert.equal(cropXAtClip(clip.segments, 5, 0.37), 0.37);
});

test('clip de plusieurs extraits : un segment par extrait, calculé séparément', () => {
  const frames = video(60, (t) => [[t < 30 ? 0.3 : 0.7]]);
  const clip = framingForClip({ frames, fps: 1, aspect: ASPECT, extracts: [{ start_ms: 5000, end_ms: 15000 }, { start_ms: 40000, end_ms: 52000 }] });
  assert.deepEqual(clip.segments.map((s) => [s.t0, s.t1]), [[0, 10], [10, 22]]);
  assert.ok(Math.abs(cropXAtClip(clip.segments, 2) - toX(0.3)) < 1e-3);
  assert.ok(Math.abs(cropXAtClip(clip.segments, 15) - toX(0.7)) < 1e-3); // coupure sèche entre extraits : pas de glissement
  assert.equal(clip.faces, 1);
});

test('source plus étroite que l\'écran : cadre centré', () => {
  const frames = video(10, () => [[0.2]]);
  const r = framingForExtract({ frames, fps: 1, aspect: 9 / 16, startMs: 0, endMs: 10000 });
  assert.deepEqual(r.keys.map((p) => p.x), [0.5, 0.5]);
});

test('expression ffmpeg : même courbe que le calcul', () => {
  const r = range(video(40, (t) => [[t < 12 ? 0.25 : t < 24 ? 0.55 : 0.8]]), 0, 40000);
  for (let t = 0; t <= 40; t += 0.37) assert.ok(Math.abs(evalExpr(cropXExpr(r.keys), t) - cropXAt(r.keys, t)) < 1e-6, `t=${t}`);
  assert.equal(cropXExpr([{ t: 0, x: 0.3 }, { t: 5, x: 0.3 }]), '0.3');
  assert.ok(cropXExpr(r.keys).length < 4000);
});

test('reconnaissance : « lisnard » suit la personne de référence, même plus petite ; sans elle, le plus gros', () => {
  // deux visages : A (gros, à gauche) en position 0 de chaque image, B (petit, à droite) en position 1
  const frames = video(20, () => [[0.25, 0.09], [0.75, 0.05]]);
  const identMap = (a, b) => new Map(frames.flatMap((_, fi) => [[`${fi}:0`, a], [`${fi}:1`, b]]));
  const at = (subject, ident) => framingForExtract({ frames, fps: 1, aspect: ASPECT, startMs: 0, endMs: 20000, subject, ident });
  const sameB = at('lisnard', identMap(0.1, 0.9));
  assert.ok(Math.abs(sameB.keys[0].x - toX(0.75)) < 1e-3, 'B reconnu : le cadre est sur lui');
  assert.deepEqual([sameB.crowded, sameB.recognized], [1, 1]);
  assert.ok(Math.abs(at('auto', identMap(0.1, 0.9)).keys[0].x - toX(0.25)) < 1e-3, 'auto ignore la reconnaissance');
  const sameA = at('lisnard', identMap(0.8, 0.2));
  assert.ok(Math.abs(sameA.keys[0].x - toX(0.25)) < 1e-3);
  // personne reconnue (tout sous le seuil), ou pas de reconnaissance : repli sur le plus gros visage
  for (const ident of [identMap(0.1, 0.2), null]) {
    const r = at('lisnard', ident);
    assert.ok(Math.abs(r.keys[0].x - toX(0.25)) < 1e-3);
    assert.equal(r.recognized, 0);
  }
  // les deux ressemblent : la meilleure ressemblance l'emporte
  assert.ok(Math.abs(at('lisnard', identMap(0.5, 0.7)).keys[0].x - toX(0.75)) < 1e-3);
});

test('reconnaissance : l\'identité vaut pour tout le plan, même si les comparaisons sont loin de l\'extrait choisi', () => {
  // plan de 3 minutes à deux visages (A gros à gauche, B petit à droite) ; B a été comparé seulement dans les 10 premières secondes
  const frames = video(180, () => [[0.25, 0.09], [0.75, 0.05]], { fps: 5 });
  const ident = new Map();
  for (let fi = 0; fi < 50; fi += 10) { ident.set(`${fi}:0`, 0.08); ident.set(`${fi}:1`, 0.62); }
  const r = framingForExtract({ frames, fps: 5, aspect: ASPECT, startMs: 100000, endMs: 130000, subject: 'lisnard', ident });
  assert.ok(Math.abs(r.keys[0].x - toX(0.75)) < 1e-3, `le cadre est sur B (reconnu ailleurs dans le plan) : ${r.keys[0].x}`);
  assert.deepEqual([r.crowded, r.recognized], [1, 1]);
  // une coupe entre les comparaisons et l'extrait : l'identité d'un autre plan ne compte pas
  const cut = framingForExtract({ frames, fps: 5, aspect: ASPECT, startMs: 100000, endMs: 130000, subject: 'lisnard', ident, cuts: [60] });
  assert.equal(cut.recognized, 0);
  assert.ok(Math.abs(cut.keys[0].x - toX(0.25)) < 1e-3, 'repli sur le plus gros visage');
});

test('orateur qui bouge naturellement (hochements, gestes, penché en avant) : le cadre reste immobile', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  // 90 s à 5 images par seconde : balancement de ±0,04 de la largeur de l'image, tremblement de détection, un penché de 0,05 pendant 6 s
  const frames = video(90, (t) => [[0.5 + 0.04 * Math.sin((2 * Math.PI * t) / 4) + 0.008 * rnd() + (t > 40 && t < 46 ? 0.05 : 0)]], { fps: 5 });
  const r = framingForExtract({ frames, fps: 5, aspect: ASPECT, startMs: 0, endMs: 90000 });
  assert.equal(r.keys.length, 2, `le cadre bouge ${r.keys.length - 1} fois : ${JSON.stringify(r.keys)}`);
});

test('un second visage qui apparaît et disparaît à côté ne fait pas sauter le cadre d\'une personne à l\'autre', () => {
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // A (gros) toujours là en 0,45 ; B (plus petit) juste à côté en 0,58, détecté une image sur deux seulement
  const frames = video(30, () => [[0.45, 0.1], ...(rnd() < 0.5 ? [[0.58, 0.07]] : [])], { fps: 5 });
  const r = framingForExtract({ frames, fps: 5, aspect: ASPECT, startMs: 0, endMs: 30000 });
  assert.equal(r.keys.length, 2, JSON.stringify(r.keys));
  assert.ok(Math.abs(r.keys[0].x - toX(0.45)) < 1e-3);
});

test('visage perdu quelques secondes puis retrouvé au même endroit : même personne, pas un second visage', () => {
  const frames = video(40, (t) => (t > 15 && t < 20.5 ? [] : [[0.4]]), { fps: 5 });
  const tracks = faceTracks(frames, 5, ASPECT, 0, 40);
  assert.equal(tracks.length, 1);
});

test('vidéo longue (une image toutes les 2 s) : même résultat', () => {
  const frames = Array.from({ length: 31 }, (_, i) => [[0.5 - 0.03, 0.3, 0.06, 0.1, 0.9]]); // 62 s à 0,5 image par seconde
  const r = framingForExtract({ frames, fps: 0.5, aspect: ASPECT, startMs: 10000, endMs: 40000 });
  assert.ok(Math.abs(r.keys[0].x - 0.5) < 1e-3 && r.keys.length === 2);
  assert.ok(r.coverage > 0.9, String(r.coverage));
});

test('clip : visage trop petit ou trop peu visible = pas de cadrage automatique pour ces extraits, avec la raison', () => {
  const clip = (frames, extracts) => framingForClip({ frames, fps: 1, aspect: ASPECT, extracts });
  const both = [{ start_ms: 0, end_ms: 20000 }, { start_ms: 20000, end_ms: 40000 }];
  // visage de 3 % de la largeur de l'image : trop petit
  const small = clip(video(40, () => [[0.5, 0.03]]), both);
  assert.deepEqual([small.segments.map((s) => s.keys), small.reason, small.missing], [[null, null], 'small', 2]);
  // visage vu une image sur trois : trop peu visible
  const rare = clip(Array.from({ length: 41 }, (_, i) => (i % 3 === 0 ? [[0.47, 0.3, 0.06, 0.1, 0.9]] : [])), both);
  assert.deepEqual([rare.segments.map((s) => s.keys), rare.reason, rare.missing], [[null, null], 'rare', 2]);
  // aucun visage
  assert.deepEqual([clip(video(40, () => []), both).reason, clip(video(40, () => []), both).missing], ['none', 2]);
  // un extrait bon, un mauvais : le bon est suivi, l'autre garde le cadre manuel, et on le signale
  const frames = video(40, (t) => (t < 20 ? [[0.3]] : [[0.5, 0.025]]));
  const mixed = clip(frames, both);
  assert.ok(mixed.segments[0].keys && mixed.segments[1].keys === null);
  assert.deepEqual([mixed.reason, mixed.missing], ['small', 1]);
  assert.equal(cropXAtClip(mixed.segments, 30, 0.37), 0.37);
  // tout va bien : aucune raison
  const fine = clip(video(40, () => [[0.4]]), both);
  assert.deepEqual([fine.reason, fine.missing], [null, 0]);
});

test('suivi des visages : un visage qui passe derrière un autre garde son identité', () => {
  const frames = video(20, (t) => [[0.3 + t * 0.01], [0.8]]);
  const tracks = faceTracks(frames, 1, ASPECT, 0, 20);
  assert.equal(tracks.length, 2);
  assert.ok(pickTrack(tracks, 'left').meanX < 0.5 && pickTrack(tracks, 'right').meanX > 0.5);
  assert.equal(framingPath(pickTrack(tracks, 'left'), 0, 20, ASPECT).at(-1).t, 20);
});

// --- deux panneaux : la personne suivie en haut, l'autre en bas, quand le visage suivi n'est pas repéré partout ---------------------

/** Deux personnes assises côte à côte (gauche : cxL, droite : cxR) ; `lost(t)` : l'instant où la personne de droite n'est pas repérée. */
const twoShot = (seconds, { lost = () => false, lostLeft = () => false, sizeR = 0.09, sizeL = 0.07, cxL = 0.3, cxR = 0.7 } = {}) =>
  video(seconds, (t) => [lostLeft(t) ? [null] : [cxL, sizeL], lost(t) ? [null] : [cxR, sizeR]]);

test('deux panneaux : visage suivi repéré partout = cadrage simple, rien de plus', () => {
  const r = range(twoShot(30), 0, 30000);
  assert.equal(r.plan, null);
  assert.equal(r.splitShare, 0);
  assert.equal(r.coverage, 1);
});

test('deux panneaux : visage suivi perdu par moments + une deuxième personne = écran coupé en deux, la personne suivie en haut', () => {
  const lost = (t) => t % 10 >= 7; // perdue 3 s sur 10
  const frames = twoShot(30, { lost });
  const r = range(frames, 0, 30000);
  assert.ok(r.plan, 'un plan à deux panneaux');
  assert.deepEqual(r.plan.windows, [[0, 30]]);
  assert.equal(r.splitShare, 1);
  // la personne suivie (la plus grosse : celle de droite) en haut, l'autre (à gauche) en bas
  const xTop = cropXAt(r.plan.top.keys, 15);
  const xBottom = cropXAt(r.plan.bottom.keys, 15);
  assert.ok(xTop > xBottom, `haut ${xTop}, bas ${xBottom}`);
  const near = (panel, cx) => Math.abs(panel.x - (cx - panel.fw / 2) / (1 - panel.fw)) < 0.03;
  assert.ok(near({ x: xTop, fw: r.plan.top.fw }, 0.7), `le haut est centré sur la personne de droite (${xTop})`);
  assert.ok(near({ x: xBottom, fw: r.plan.bottom.fw }, 0.3), `le bas est centré sur la personne de gauche (${xBottom})`);
  // une fenêtre 9:8 qui tient dans la source : largeur et hauteur en fractions, entre les bornes
  for (const p of [r.plan.top, r.plan.bottom]) {
    assert.ok(p.fw >= FRAMING.splitMinW - 1e-9 && p.fh <= 1 + 1e-9 && p.cy - p.fh / 2 >= -1e-9 && p.cy + p.fh / 2 <= 1 + 1e-9, JSON.stringify(p));
    assert.ok(Math.abs((p.fw * ASPECT) / p.fh - 9 / 8) < 0.01, 'format 9:8');
  }
  // « repéré à 100 % » : en deux panneaux, rien n'est perdu
  assert.equal(r.coverage, 1);
  // les points-clés restent dans le segment ; l'expression ffmpeg est calculable
  assert.ok(r.plan.top.keys.every((k) => k.x >= 0 && k.x <= 1));
  assert.ok(Math.abs(evalExpr(cropXExpr(r.plan.top.keys), 15) - xTop) < 1e-3);
});

test('deux panneaux : sans deuxième personne, le cadrage simple reste (rien à mettre en bas)', () => {
  const r = range(video(30, (t) => [t % 10 >= 7 ? [null] : [0.7]]), 0, 30000);
  assert.equal(r.plan, null);
  assert.ok(r.coverage < 0.95);
});

test('deux panneaux : un second visage qui n\'est jamais vu avec le premier n\'est pas « une autre personne »', () => {
  // la même personne perdue puis retrouvée ailleurs (plus de 6 s plus tard) : deux pistes, mais jamais ensemble
  const frames = video(40, (t) => (t < 14 ? [[0.3]] : t < 22 ? [[null]] : [[0.6]]));
  const r = range(frames, 0, 40000);
  assert.equal(r.plan, null);
});

test('deux panneaux : seuls les plans concernés sont coupés en deux, les autres gardent le cadre simple', () => {
  // plan 1 (0–15 s) : deux personnes, la personne suivie souvent perdue ; coupe à 15 s ; plan 2 : la personne seule, bien repérée
  const frames = video(30, (t) => (t < 15 ? [t % 6 >= 4 ? [null] : [0.7, 0.09], [0.3, 0.07]] : [[0.5, 0.09]]));
  const r = range(frames, 0, 30000, 'auto', [15]);
  assert.deepEqual(r.plan.windows, [[0, 15]]);
  assert.equal(r.splitShare, 0.5);
  // hors du plan coupé en deux, le cadre des panneaux est tenu immobile
  assert.equal(cropXAt(r.plan.top.keys, 20), cropXAt(r.plan.top.keys, 28));
  // et le cadrage simple suit la personne du plan 2
  assert.ok(Math.abs(cropXAt(r.keys, 25) - toX(0.5)) < 0.02);
});

test('deux panneaux : l\'instant et les panneaux du clip (aperçu et rendu lisent la même chose)', () => {
  const frames = twoShot(30, { lost: (t) => t % 10 >= 7 });
  const clip = framingForClip({ frames, fps: 1, aspect: ASPECT, extracts: [{ start_ms: 0, end_ms: 20000 }, { start_ms: 5000, end_ms: 15000 }] });
  assert.equal(clip.split, 1);
  assert.equal(clip.missing, 0);
  const at = splitAtClip(clip.segments, 25); // deuxième extrait, 5 s après son début
  assert.ok(at && at.top.x > at.bottom.x);
  assert.deepEqual(Object.keys(at.top).sort(), ['cy', 'fh', 'fw', 'x']);
  assert.equal(splitAtClip(null, 3), null);
});

test('deux panneaux : visage suivi vu la moitié du temps seulement : seul il est mal cadré, avec une deuxième personne il est complété', () => {
  const lost = (t) => t % 10 >= 5; // la personne suivie (celle de droite) n'est repérée que la moitié du temps
  const extracts = [{ start_ms: 0, end_ms: 30000 }];
  const alone = framingForClip({ frames: video(40, (t) => [lost(t) ? [null] : [0.7, 0.09]]), fps: 1, aspect: ASPECT, extracts, subject: 'right' });
  assert.deepEqual([alone.segments[0].plan, alone.coverage < 0.6], [null, true]);
  const clip = framingForClip({ frames: twoShot(40, { lost }), fps: 1, aspect: ASPECT, extracts, subject: 'right' });
  assert.ok(clip.segments[0].plan, 'écran coupé en deux');
  assert.deepEqual([clip.missing, clip.coverage, clip.split], [0, 1, 1]);
});

test('fenêtre d\'un panneau : plus le visage est petit, plus on zoome, dans les bornes ; format 9:8 ; jamais hors de l\'image', () => {
  const tr = (w, cy) => ({ pts: Array.from({ length: 5 }, (_, i) => ({ t: i, cx: 0.5, cy, h: w * ASPECT, s: 0.9, w, fi: i, di: 0 })) });
  const big = panelWindow([tr(0.3, 0.4)], ASPECT);
  const small = panelWindow([tr(0.05, 0.4)], ASPECT);
  assert.ok(big.fw > small.fw);
  assert.equal(small.fw, FRAMING.splitMinW);
  assert.ok(big.fw <= FRAMING.splitMaxW);
  // un visage tout en haut : la fenêtre reste dans l'image
  const top = panelWindow([tr(0.08, 0.02)], ASPECT);
  assert.ok(top.cy - top.fh / 2 >= -1e-9);
  // source plus carrée (4:3) : la fenêtre 9:8 peut être plus large sans dépasser la hauteur
  const square = panelWindow([tr(0.5, 0.5)], 4 / 3);
  assert.ok(square.fh <= 1 + 1e-9 && Math.abs((square.fw * (4 / 3)) / square.fh - 9 / 8) < 0.01);
});

test('paire de personnes : « lisnard » en haut quand il est reconnu, l\'autre en bas', () => {
  const frames = twoShot(30);
  const ident = new Map();
  for (let i = 0; i <= 30; i++) {
    ident.set(`${i}:0`, 0.1); // première détection de chaque image : celle de gauche (triée par taille décroissante : la droite est plus grosse…)
    ident.set(`${i}:1`, 0.1);
  }
  const tracks = faceTracks(frames, 1, ASPECT, 0, 30, null);
  const pair = pickPair(tracks, 'auto');
  assert.ok(pair.top.meanX > pair.bottom.meanX, 'sans reconnaissance, le plus gros en haut');
  const left = pickPair(tracks, 'left');
  assert.ok(left.top.meanX < left.bottom.meanX, 'à gauche choisi : la personne de gauche en haut');
});
