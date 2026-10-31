// Cœur du studio (partagé entre l'aperçu du navigateur et le rendu serveur) : horaires des mots, groupes, styles, ASS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStopWord } from '../public/js/stopwords.js';
import {
  BEGINNER_DEFAULTS,
  DEFAULT_STYLE,
  FLOW,
  LEVELS,
  PRESETS,
  sanitizeLevel,
  stepLabels,
  stepsFor,
  activeAt,
  assColor,
  assEscape,
  assTime,
  BROLL,
  ZOOM,
  boxPath,
  brollOpacity,
  kenBurnsAt,
  kenBurnsFilter,
  sanitizeZoom,
  suggestZoomPoints,
  wordNear,
  zoomAt,
  zoomFilter,
  zoomOrigin,
  zoomPlan,
  zoomRect,
  zoomWindows,
  sourceText,
  fitDescription,
  descriptionFooter,
  draftFromClip,
  sanitizeEndCard,
  sanitizeLogo,
  modelFromState,
  sanitizeModel,
  parseModels,
  endCardSettings,
  endCardContent,
  DESCRIPTION_MAX,
  buildAss,
  fitScale,
  usableWidth,
  groupWords,
  lineSimilarity,
  SIMILARITY_WARNING,
  sanitizeStyle,
  wordsForExtracts,
} from '../public/js/studio-core.js';

const FONTS = ['anton', 'montserrat', 'inter'];
const lines = [
  { start_ms: 0, end_ms: 4000, text: 'Un deux trois quatre cinq six sept huit neuf dix.' },
  { start_ms: 4000, end_ms: 6000, text: 'Et puis, voilà' },
  { start_ms: 10000, end_ms: 13000, text: 'Une autre phrase plus loin' },
];
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('style : valeurs bornées, couleurs et police validées, retour aux valeurs du style choisi', () => {
  const s = sanitizeStyle({ preset: 'karaoke', size: 9999, outline: -5, color: 'rouge', highlight: '#abcdef', font: 'inconnue', x: 7, y: -1, boxOpacity: 3, mode: 'bizarre', wordsPerGroup: 50 }, FONTS);
  assert.deepEqual([s.preset, s.mode, s.size, s.outline, s.color, s.highlight, s.font], ['karaoke', 'karaoke', 220, 0, PRESETS.karaoke.style.color, '#ABCDEF', 'anton']); // police inconnue, et celle du style absente de la liste : première police
  assert.deepEqual([s.x, s.y, s.boxOpacity, s.wordsPerGroup], [0.9, 0.1, 1, 10]);
  assert.equal(sanitizeStyle(undefined, FONTS).preset, DEFAULT_STYLE.preset);
  assert.equal(sanitizeStyle({ preset: 'un-mot', wordsPerGroup: 4 }, FONTS).wordsPerGroup, 1); // « un mot » = un seul mot
  assert.equal(sanitizeStyle({ preset: 'inexistant' }, FONTS).preset, 'hormozi');
  assert.equal(sanitizeStyle({ font: 'x' }, []).font, 'anton'); // aucune police connue : valeur du style
  assert.equal(sanitizeStyle({ preset: 'boite' }, FONTS).box, true);
});

test('mots : durée d\'une ligne répartie selon la longueur des mots, pause après la ponctuation', () => {
  const { words, duration } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  assert.equal(duration, 6);
  assert.equal(words.length, 10 + 3);
  // monotone, sans chevauchement, borné à la ligne
  words.forEach((w, i) => {
    assert.ok(w.end > w.start);
    if (i) assert.ok(w.start >= words[i - 1].end - 1e-9);
  });
  close(words[0].start, 0);
  close(words[9].end, 4);
  close(words[10].start, 4);
  close(words.at(-1).end, 6);
  assert.ok(words[9].end - words[9].start > words[0].end - words[0].start, 'le mot suivi d\'un point dure plus longtemps (pause)');
  // « puis, » avec sa virgule a un poids supérieur à « Et »
  assert.ok(words[11].end - words[11].start > words[10].end - words[10].start);
});

test('mots : plusieurs extraits bout à bout, lignes coupées aux bornes', () => {
  const { words, duration, segments } = wordsForExtracts(lines, [{ start_ms: 4000, end_ms: 6000 }, { start_ms: 10000, end_ms: 12000 }]);
  assert.equal(duration, 4);
  assert.deepEqual(segments, [{ offset: 0, length: 2 }, { offset: 2, length: 2 }]);
  close(words[0].start, 0);
  close(words[2].end, 2);
  close(words[3].start, 2); // le 2e extrait commence là où finit le 1er
  // la ligne de 3 s (5 mots) est coupée à 2 s : seuls les mots dits avant la coupure restent, à leur horaire d'origine (pas comprimés)
  const second = words.slice(3);
  assert.ok(second.length >= 3 && second.length < 5, `${second.length} mots gardés`);
  assert.ok(second.at(-1).end <= 4 + 1e-9);
  assert.deepEqual(words.map((w) => w.line), [0, 0, 0, ...second.map(() => 1)]);
});

test('extrait coupé au milieu des lignes : bornes à la milliseconde, mots gardés selon leur horaire, ni trou ni décalage', () => {
  const full = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]).words; // références : horaires dans l'extrait complet
  // 1 500 → 4 700 : coupe la 1re ligne (0–4 s) au début et la 2e (4–6 s) à la fin
  const cut = wordsForExtracts(lines, [{ start_ms: 1500, end_ms: 4700 }]);
  close(cut.duration, 3.2);
  assert.ok(cut.words.length > 0 && cut.words.length < full.length);
  for (const w of cut.words) {
    assert.ok(w.start >= 0 && w.end <= 3.2 + 1e-9 && w.end > w.start, JSON.stringify(w));
    const ref = full.find((f) => f.text === w.text && Math.abs(f.start - 1.5 - w.start) < 1e-6 + (w.start === 0 ? 1.5 : 0)); // même mot, même instant (décalé de l'entrée)
    assert.ok(ref, `${w.text} garde son horaire d'origine`);
  }
  // le 1er mot gardé de la 1re ligne n'est pas « UN » (dit avant 1,5 s)
  assert.notEqual(cut.words[0].text, 'Un');
  // décaler le début de 0,5 s ne change ni l'horaire ni le texte des mots gardés des deux côtés
  const a = wordsForExtracts(lines, [{ start_ms: 1500, end_ms: 4700 }]).words;
  const b = wordsForExtracts(lines, [{ start_ms: 2000, end_ms: 4700 }]).words;
  for (const w of b) {
    const same = a.find((x) => x.text === w.text && Math.abs(x.start - 0.5 - w.start) < 1e-6);
    assert.ok(same || w.start === 0, `${w.text} décalé de 0,5 s`);
  }
  // une ligne qui ne fait que « toucher » l'extrait n'en fait pas partie
  assert.equal(wordsForExtracts(lines, [{ start_ms: 6000, end_ms: 9000 }]).words.length, 0);
});

test('groupes : par mots, un mot, ou phrase découpée de façon équilibrée', () => {
  const { words } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  const three = groupWords(words, { mode: 'words', wordsPerGroup: 3 });
  assert.deepEqual(three.map((g) => g.words.length), [3, 3, 3, 1, 3]); // la phrase finit au point ; la 2e ligne repart à zéro
  assert.equal(groupWords(words, { mode: 'one', wordsPerGroup: 9 }).length, words.length);
  const phrase = groupWords(words, { mode: 'phrase', wordsPerGroup: 7 });
  assert.deepEqual(phrase.map((g) => g.words.length), [5, 5, 3]); // 10 mots, 7 max -> 5 + 5, équilibrés
  const kara = groupWords(words, { mode: 'karaoke', wordsPerGroup: 10 });
  assert.deepEqual(kara.map((g) => g.words.length), [10, 3]);
  // un groupe reste affiché jusqu'au suivant (pas de clignotement), pas plus de 0,35 s après sa fin naturelle
  for (let i = 0; i < phrase.length - 1; i++) assert.ok(phrase[i].end <= phrase[i + 1].start + 1e-9 && phrase[i].end >= phrase[i].words.at(-1).end);
  const gap = groupWords(wordsForExtracts(lines, [{ start_ms: 4000, end_ms: 6000 }, { start_ms: 10000, end_ms: 13000 }]).words, { mode: 'phrase', wordsPerGroup: 7 });
  close(gap[0].end, gap[0].words.at(-1).end); // le groupe suivant démarre exactement à la fin : aucune pause à combler
});

test('instant donné : groupe et mot actif', () => {
  const { words } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  const groups = groupWords(words, { mode: 'words', wordsPerGroup: 3 });
  const at = activeAt(groups, words[4].start + 0.001);
  assert.equal(at.group.words.length, 3);
  assert.equal(at.group.words[at.active].text, 'cinq');
  assert.equal(activeAt(groups, -1), null);
  assert.equal(activeAt(groups, 99), null);
});

test('couleurs et temps ASS', () => {
  assert.equal(assColor('#FFE600'), '&H0000E6FF');
  assert.equal(assColor('#102030', 128), '&H80302010');
  assert.equal(assColor('pas une couleur'), '&H00FFFFFF');
  assert.equal(assTime(0), '0:00:00.00');
  assert.equal(assTime(3725.678), '1:02:05.68');
  assert.equal(assEscape('a {b} \\c\nd'), 'a b /c d');
});

test('source à citer : titre tronqué et date en français', () => {
  assert.equal(sourceText('Mon interview', '2025-03-01'), 'Source : Mon interview · 1 mars 2025');
  assert.equal(sourceText('x'.repeat(100), '2025-12-25'), `Source : ${'x'.repeat(100)} · 25 décembre 2025`);
  assert.equal(sourceText('David Lisnard face à Apolline de Malherbe mardi 13 octobre', '2026-10-13'), 'Source : David Lisnard face à Apolline de Malherbe mardi 13 octobre');
  assert.equal(sourceText('Interview du 1er octobre', '2026-10-01'), 'Source : Interview du 1er octobre');
  assert.equal(sourceText('Le plan pour couper 200 milliards', '2026-10-11'), 'Source : Le plan pour couper 200 milliards · 11 octobre 2026');
  assert.equal(sourceText('Bilan du 113 octobre', '2026-10-13'), 'Source : Bilan du 113 octobre · 13 octobre 2026');
  const src = sourceText('Titre', '2026-10-11');
  const long = fitDescription('a'.repeat(3000), src);
  assert.equal(long.length, DESCRIPTION_MAX);
  assert.ok(long.endsWith(src) && long.includes('…'));
  assert.equal(fitDescription('Accroche #tag', src), `Accroche #tag\n\n${src}`);
  assert.equal(fitDescription('', src), src);
  assert.equal(descriptionFooter(null), 'Discord : https://discord.gg/lisnard2027');
  assert.equal(descriptionFooter({ title: 'Titre', credit: 'Artiste' }), 'Discord : https://discord.gg/lisnard2027\nMusique : Titre — Artiste');
  assert.equal(fitDescription('Accroche', descriptionFooter(null)), 'Accroche\n\nDiscord : https://discord.gg/lisnard2027');
  assert.equal(fitDescription('Accroche #tag', ''), 'Accroche #tag', 'sans source : la légende seule, sans lignes vides');
  assert.equal(fitDescription('a'.repeat(3000), '').length, DESCRIPTION_MAX);
  assert.equal(sourceText('', null), 'Source : interview');
});

const font = { ass_name: 'Anton Regular' };
const build = (style, extracts = [{ start_ms: 0, end_ms: 6000 }]) => {
  const st = sanitizeStyle(style, FONTS);
  const { words, duration } = wordsForExtracts(lines, extracts);
  return { st, ass: buildAss({ groups: groupWords(words, st), style: st, font }), words, duration };
};
const events = (ass) => ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,')); // texte (couche 1) ; le fond est sur la couche 0

test('ASS « mots en surbrillance » : un événement par mot, mot actif coloré, pop au début du groupe seulement', () => {
  const { ass, words } = build({ preset: 'hormozi', color: '#FFFFFF', highlight: '#FFE600', size: 90, outline: 11, outlineColor: '#112233' });
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Style: Main,Anton Regular,90,&H00FFFFFF,&H00FFFFFF,&H00332211,/);
  const ev = events(ass);
  assert.equal(ev.length, words.length);
  assert.match(ev[0], /\{\\an5\\pos\(540,1190\)\\fscx72/); // y = 0,62 × 1920 ; pop sur le 1er mot du groupe
  assert.match(ev[0], /\{\\1c&H00E6FF&\}UN\{\\1c&HFFFFFF&\} DEUX TROIS$/); // texte en majuscules, mot actif en jaune
  assert.doesNotMatch(ev[1], /fscx72/); // pas de pop sur les mots suivants du même groupe
  assert.match(ev[1], /UN \{\\1c&H00E6FF&\}DEUX\{/);
  assert.doesNotMatch(ass, /Banner|Source :/); // plus de bandeau de source dans la vidéo
});

test('ASS karaoké : un événement par phrase, durées \\k en centisecondes qui couvrent tout le groupe', () => {
  const { ass } = build({ preset: 'karaoke', wordsPerGroup: 10, uppercase: false, color: '#FFFFFF', highlight: '#25F4EE' });
  assert.match(ass, /Style: Main,[^,]+,66,&H00EEF425,&H00FFFFFF,/); // rempli = accent, avant = couleur du texte
  const ev = events(ass);
  assert.equal(ev.length, 2);
  const ks = [...ev[0].matchAll(/\\k(\d+)\}/g)].map((m) => Number(m[1]));
  assert.equal(ks.length, 10);
  const total = ks.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 400 - 35) <= 40 && total >= 395, `somme des \\k : ${total}`); // 4 s de parole + maintien éventuel
  assert.match(ev[0], /\{\\k\d+\}Un \{\\k\d+\}deux/);
});

test('ASS fond sombre et position : fond rectangulaire sans mesure, largeur adaptée au bord', () => {
  const { ass } = build({ preset: 'boite', boxColor: '#000000', boxOpacity: 0.5, size: 60, x: 0.2, y: 0.9 });
  assert.match(ass, /,&H80000000,&H5A000000,0,0,0,0,100,100,0,0,3,17,0,5,324,324,0,1/); // BorderStyle 3, marge de 324 = (1080 − 0,4 × 1080) / 2
  assert.match(events(ass)[0], /\\pos\(216,1728\)/);
  const centered = build({ preset: 'classique' }).ass;
  assert.match(centered, /,0,0,0,0,100,100,0,0,1,8,2,5,76,76,0,1/); // contour simple, largeur 86 % : marges de 76 px
});

test('ASS : texte sans accolades ni antislash, majuscules facultatives', () => {
  const evil = [{ start_ms: 0, end_ms: 3000, text: 'Un {\\fs500} mot\\Nsuite' }];
  const st = sanitizeStyle({ preset: 'classique', uppercase: false }, FONTS);
  const { words, duration } = wordsForExtracts(evil, [{ start_ms: 0, end_ms: 3000 }]);
  const ass = buildAss({ groups: groupWords(words, st), style: st, font });
  const ev = events(ass)[0];
  assert.equal((ev.match(/\{/g) ?? []).length, 1, 'une seule balise de style : celle du programme'); // aucune balise injectée par le texte
  assert.doesNotMatch(ass, /\{\\fs500/);
  assert.match(ev, /Un \/fs500 mot\/Nsuite/);
});

test('taille : la taille de l\'éditeur est une taille d\'em, convertie en taille ASS selon la police', () => {
  const st = sanitizeStyle({ preset: 'classique', size: 60 }, FONTS);
  const { words, duration } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  const ass = (f) => buildAss({ groups: groupWords(words, st), style: st, font: f });
  assert.match(ass({ ass_name: 'F', em_ratio: 0.5 }), /Style: Main,F,120,/); // em de 60 px avec un rapport de 0,5 : taille ASS 120
  assert.match(ass({ ass_name: 'F', em_ratio: 1 }), /Style: Main,F,60,/);
  assert.match(ass({ ass_name: 'F' }), /Style: Main,F,60,/); // police sans rapport connu : pas de conversion
});

test('mot trop long : réduit pour ne jamais déborder de l\'écran, aperçu et rendu identiques', () => {
  const font = { cap_em: 0.8 };
  const st = sanitizeStyle({ preset: 'un-mot', size: 128 }, FONTS); // majuscules, 86 % de 1080 = 929 px utilisables
  assert.equal(usableWidth(st), 0.86 * 1080);
  assert.equal(fitScale(['MOT'], st, font), 1);
  const k = fitScale(['DÉCENTRALISATION'], st, font);
  assert.ok(k < 0.7 && k >= 0.45, `k = ${k}`);
  const estimate = 16 * 128 * 0.8 * 0.98 * k + st.outline * 2;
  assert.ok(estimate <= usableWidth(st) + 1, 'le mot réduit tient dans la largeur');
  assert.equal(fitScale(['x'.repeat(200)], st, font), 0.45); // plancher
  // près d'un bord, la largeur utilisable diminue
  assert.ok(usableWidth(sanitizeStyle({ preset: 'un-mot', x: 0.15 }, FONTS)) < usableWidth(st));
  // dans le fichier ASS : \fscx/\fscy réduits, et le « pop » part de 72 % de la taille réduite
  const g = [{ start: 0, end: 1, words: [{ text: 'décentralisation', start: 0, end: 1, line: 0 }] }];
  const ass = buildAss({ groups: g, style: st, font: { ass_name: 'F', cap_em: 0.8 } });
  const m = events(ass)[0].match(/\\fscx(\d+)\\fscy\d+\\t\(0,90,\\fscx(\d+)\\fscy\d+\)\\t\(90,170,\\fscx(\d+)/);
  assert.ok(m, events(ass)[0]);
  assert.deepEqual([Number(m[1]), Number(m[3])], [Math.round(72 * k), Math.round(100 * k)]);
  const short = buildAss({ groups: [{ start: 0, end: 1, words: [{ text: 'oui', start: 0, end: 1, line: 0 }] }], style: sanitizeStyle({ preset: 'classique' }, FONTS), font: { ass_name: 'F', cap_em: 0.8 } });
  assert.doesNotMatch(events(short)[0], /fscx/); // mot court : aucune réduction
});

test('fidélité : la similarité d\'une ligne corrigée ignore casse, accents et ponctuation', () => {
  const o = 'Il faut baisser la dépense publique, maintenant.';
  assert.equal(lineSimilarity(o, 'IL FAUT BAISSER LA DEPENSE PUBLIQUE MAINTENANT'), 1);
  assert.ok(lineSimilarity(o, 'Il faut baisser la dépense publique maintenant mais') > SIMILARITY_WARNING); // un mot ajouté : pas d\'alerte
  assert.ok(lineSimilarity(o, 'Il faut baisser les dépenses publiques maintenant') > SIMILARITY_WARNING); // quelques mots corrigés : pas d\'alerte
  assert.ok(lineSimilarity(o, 'Je suis contre toute réforme') < SIMILARITY_WARNING); // un autre propos : alerte
  assert.equal(lineSimilarity('', ''), 1);
  assert.equal(lineSimilarity(o, ''), 0);
  assert.equal(lineSimilarity('', o), 0);
});

test('texte corrigé : les mots gardent l\'horodatage de la ligne, quel que soit leur nombre', () => {
  for (const text of ['Oui', 'Un deux trois quatre cinq six sept huit neuf dix onze douze treize']) {
    const edited = lines.map((l, i) => (i === 0 ? { ...l, text } : l));
    const { words } = wordsForExtracts(edited, [{ start_ms: 0, end_ms: 4000 }]);
    assert.equal(words.length, text.split(' ').length);
    close(words[0].start, 0);
    close(words.at(-1).end, 4);
    for (let i = 1; i < words.length; i++) close(words[i].start, words[i - 1].end); // sans trou ni chevauchement
  }
});

test('arrondi du fond : borné de 0 à 1, valeur du style par défaut sinon', () => {
  assert.equal(sanitizeStyle({ preset: 'boite', boxRadius: 5 }, FONTS).boxRadius, 1);
  assert.equal(sanitizeStyle({ preset: 'boite', boxRadius: -1 }, FONTS).boxRadius, 0);
  assert.equal(sanitizeStyle({ preset: 'boite', boxRadius: 0.456 }, FONTS).boxRadius, 0.46);
  assert.equal(sanitizeStyle({ preset: 'boite', boxRadius: 'x' }, FONTS).boxRadius, DEFAULT_STYLE.boxRadius);
  assert.equal(sanitizeStyle({ preset: 'boite' }, FONTS).boxRadius, DEFAULT_STYLE.boxRadius);
});

test('tracé du fond : coins arrondis selon le curseur, une seule forme pour toutes les lignes', () => {
  const rects = [{ x0: -100, y0: -40, x1: 100, y1: 40 }, { x0: -60, y0: 40, x1: 60, y1: 120 }];
  const sharp = boxPath(rects, 0);
  assert.doesNotMatch(sharp, /NaN/);
  assert.match(sharp, /^m -100 -40 l 100 -40 b 100 -40 100 -40 100 -40 l 100 40/); // rayon nul : les courbes se réduisent à un point
  assert.equal((boxPath(rects, 0.5).match(/m /g) ?? []).length, 2); // un sous-tracé par ligne, dans un seul tracé
  // curseur au maximum : rayon = moitié de la hauteur de la ligne (80 / 2 = 40)
  assert.match(boxPath(rects, 1), /^m -60 -40 l 60 -40 b 82\.1 -40 100 -22\.1 100 0/);
  assert.match(boxPath(rects, 0.5), /^m -80 -40 l 80 -40 b /); // moitié : rayon de 20
  // jamais plus rond qu'un demi-cercle, même pour un rectangle étroit
  assert.doesNotMatch(boxPath([{ x0: 0, y0: 0, x1: 10, y1: 100 }], 1), /NaN|-\d/);
  // même forme pour l'aperçu (SVG)
  const svg = boxPath(rects, 0.5, 'svg');
  assert.match(svg, /^M -80 -40 L 80 -40 C /);
  assert.equal((svg.match(/ Z/g) ?? []).length, 2);
});

test('ASS fond arrondi : forme dessinée sous le texte, même pop, plus de rectangle libass', () => {
  const st = sanitizeStyle({ preset: 'boite', boxColor: '#102030', boxOpacity: 0.5, boxRadius: 0.4, size: 60, animation: 'pop' }, FONTS);
  const { words } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  const groups = groupWords(words, st);
  const boxes = groups.map(() => [{ x0: -200, y0: -50, x1: 200, y1: 50 }]);
  const ass = buildAss({ groups, style: st, font, boxes });
  assert.match(ass, /,0,0,0,0,100,100,0,0,1,0,0,5,/); // BorderStyle 1, sans contour ni ombre : le fond est dessiné
  const all = ass.split('\n').filter((l) => l.startsWith('Dialogue'));
  assert.equal(all.length, groups.length * 2);
  assert.ok(all[0].startsWith('Dialogue: 0,'));
  assert.ok(all[0].includes('{\\an7\\pos(540,1344)\\bord0\\shad0\\1c&H302010&\\1a&H80&\\fscx72\\fscy72\\t(0,90,\\fscx106\\fscy106)\\t(90,170,\\fscx100\\fscy100)\\p1}m '), all[0]);
  assert.match(all[1], /^Dialogue: 1,/); // le texte est au-dessus du fond
  // fond d'un groupe : même durée que le groupe
  assert.equal(all[0].split(',').slice(1, 3).join(), all[1].split(',').slice(1, 3).join());
  // sans mesure : repli sur le rectangle de libass
  assert.match(buildAss({ groups, style: st, font }), /,0,0,0,0,100,100,0,0,3,17,0,5,/);
  // pas de fond : aucun événement de fond
  const plain = build({ preset: 'classique' }).ass;
  assert.equal(plain.split('\n').filter((l) => l.startsWith('Dialogue: 0,')).length, 0);
});

// --- zooms et b-roll -------------------------------------------------------------------------------------------------------

test('zooms : réglages bornés, événements triés, écart minimal, entrées invalides écartées', () => {
  const z = sanitizeZoom({ strength: 9, focus: { x: -1, y: 5 }, events: [{ t: 4, kind: 'out' }, { t: 1, kind: 'in' }, { t: 1.2, kind: 'in' }, { t: -3, kind: 'in' }, { t: 99, kind: 'in' }, { t: 2, kind: 'saut' }, null, { t: 'x', kind: 'in' }] }, 10);
  assert.equal(z.strength, 1.5);
  assert.deepEqual(z.focus, { x: 0.1, y: 0.9 });
  assert.deepEqual(z.events, [{ t: 1, kind: 'in' }, { t: 4, kind: 'out' }]); // trié ; 1,2 trop près de 1 ; hors clip, type inconnu et valeurs illisibles écartés
  assert.equal(sanitizeZoom({ strength: 1.01 }).strength, 1.05);
  assert.deepEqual(sanitizeZoom(undefined).events, []);
  assert.equal(sanitizeZoom({ events: Array.from({ length: 80 }, (_, i) => ({ t: i, kind: i % 2 ? 'out' : 'in' })) }).events.length, ZOOM.maxEvents);
});

test('zoom : mouvement en S, continu, vitesse nulle au départ et à l\'arrivée, même en enchaînant', () => {
  const ev = [{ t: 1, kind: 'in' }, { t: 2.6, kind: 'out' }, { t: 3.1, kind: 'in' }, { t: 4.4, kind: 'out' }]; // un zoom commence avant la fin du retour précédent
  const plan = zoomPlan(ev, 1.25);
  assert.equal(zoomAt(plan, 0), 1);
  assert.equal(zoomAt(plan, 0.99), 1);
  close(zoomAt(plan, 1 + ZOOM.rampIn), 1.25);
  close(zoomAt(plan, 2.5), 1.25); // maintenu
  close(zoomAt(zoomPlan(ev.slice(0, 2), 1.25), 2.6 + ZOOM.rampOut), 1); // le retour aboutit à 1
  // continuité : aucune marche entre deux images à 30 i/s, et jamais de zoom négatif ou excessif
  let prev = zoomAt(plan, 0);
  let maxStep = 0;
  for (let n = 1; n <= 30 * 6; n++) {
    const z = zoomAt(plan, n / 30);
    maxStep = Math.max(maxStep, Math.abs(z - prev));
    assert.ok(z >= 1 - 1e-12 && z <= 1.25 + 1e-12, `z = ${z}`);
    prev = z;
  }
  // pente maximale d'une courbe en S : 1,5 × (écart / durée) ; ici 0,25 sur 0,5 s, soit 0,025 par image à 30 i/s
  assert.ok(maxStep < 1.6 * (0.25 / ZOOM.rampIn) / 30, `pas maximal ${maxStep}`);
  // vitesse nulle au départ : le mouvement démarre en douceur (pas d'à-coup)
  assert.ok(zoomAt(plan, 1 + 1 / 30) - 1 < 0.005);
  // un zoom commencé en cours de route part du niveau atteint, sans saut
  const mid = zoomAt(plan, 3.1);
  assert.ok(mid > 1 && mid < 1.25, `niveau au départ du 3e événement : ${mid}`);
  close(zoomAt(plan, 3.1 + 1e-9), mid, 1e-6);
});

test('zoom : périodes actives (le reste du clip n\'est pas retraité) et fenêtre source', () => {
  const plan = zoomPlan([{ t: 1, kind: 'in' }, { t: 3, kind: 'out' }, { t: 6, kind: 'in' }], 1.2);
  const w = zoomWindows(plan, 10);
  assert.equal(w.length, 2);
  close(w[0][0], 1);
  close(w[0][1], 3 + ZOOM.rampOut); // jusqu'au retour à 1
  close(w[1][0], 6);
  close(w[1][1], 10); // jamais revenu : jusqu'à la fin
  assert.deepEqual(zoomWindows([], 10), []);
  // fenêtre source : taille 1/z, point de zoom suivi, jamais hors de l'image
  const r = zoomRect(1.25, { x: 0.5, y: 0.5 });
  close(r.x1 - r.x0, 0.8);
  close((r.x0 + r.x1) / 2, 0.5);
  const edge = zoomRect(1.25, { x: 0.9, y: 0.1 });
  assert.ok(edge.x1 <= 1 + 1e-12 && edge.y0 >= -1e-12);
  // origine CSS : la fenêtre source remplit l'écran (bords gauche et droit de la fenêtre -> 0 et 1)
  for (const [z, f] of [[1.2, { x: 0.5, y: 0.42 }], [1.32, { x: 0.8, y: 0.3 }], [1.1, { x: 0.12, y: 0.9 }]]) {
    const o = zoomOrigin(z, f);
    const rect = zoomRect(z, f);
    close(o.x + z * (rect.x0 - o.x), 0, 1e-9);
    close(o.x + z * (rect.x1 - o.x), 1, 1e-9);
    close(o.y + z * (rect.y0 - o.y), 0, 1e-9);
    close(o.y + z * (rect.y1 - o.y), 1, 1e-9);
  }
  assert.deepEqual(zoomOrigin(1, { x: 0.2, y: 0.2 }), { x: 0.5, y: 0.5 });
});

test('filtre de zoom : perspective à coins décimaux (pas zoompan), actif seulement pendant les zooms', () => {
  const plan = zoomPlan([{ t: 1, kind: 'in' }, { t: 3, kind: 'out' }], 1.2);
  const f = zoomFilter(plan, { x: 0.5, y: 0.42 }, 10);
  assert.match(f, /^perspective=x0='/);
  assert.match(f, /eval=frame/);
  assert.match(f, /interpolation=linear/);
  assert.doesNotMatch(f, /zoompan/);
  assert.ok(f.includes(`enable='gt(between(t,1,${3 + ZOOM.rampOut}),0)'`), f.slice(-120));
  assert.match(f, /\(in-1\)\/30/); // le temps vient du compteur d'images : aucune dérive
  assert.equal(zoomFilter([], { x: 0.5, y: 0.5 }, 10), '');
  assert.ok(f.length < 6000);
  // quarante événements : la commande reste raisonnable
  const many = zoomPlan(Array.from({ length: 40 }, (_, i) => ({ t: i * 1.5, kind: i % 2 ? 'out' : 'in' })), 1.2);
  assert.ok(zoomFilter(many, { x: 0.5, y: 0.5 }, 100).length < 60_000);
  // zoom lent des images b-roll
  assert.match(kenBurnsFilter(2.5), /^perspective=x0='.*eval=frame/);
  assert.ok(kenBurnsAt(0) === 1 && Math.abs(kenBurnsAt(1) - (1 + BROLL.kenBurns)) < 1e-12 && kenBurnsAt(0.5) > 1);
});

test('b-roll : fondu à l\'entrée et à la sortie, rien en dehors', () => {
  const item = { start: 2, dur: 2 };
  assert.equal(brollOpacity(item, 1.99), 0);
  assert.equal(brollOpacity(item, 4.01), 0);
  assert.equal(brollOpacity(item, 2), 0);
  assert.ok(brollOpacity(item, 2 + BROLL.fade / 2) > 0.4 && brollOpacity(item, 2 + BROLL.fade / 2) < 0.6);
  assert.equal(brollOpacity(item, 3), 1);
  assert.ok(brollOpacity(item, 4 - BROLL.fade / 2) < 0.6);
});

test('zooms automatiques : mots importants, espacés, retour avant la fin, rien pour du blabla', () => {
  const text = [
    { start_ms: 0, end_ms: 5000, text: 'Nous devons réduire la dépense publique de trois milliards d’euros, jamais sans réforme.' },
    { start_ms: 5000, end_ms: 10000, text: 'La décentralisation est la réponse, avec des moyens et de la confiance pour les communes.' },
    { start_ms: 10000, end_ms: 16000, text: 'Sans transfert de charges, évidemment, les maires ne peuvent pas tout porter, la dette augmente.' },
  ];
  const { words, duration } = wordsForExtracts(text, [{ start_ms: 0, end_ms: 16000 }]);
  const r = suggestZoomPoints(words, duration);
  assert.deepEqual(r, suggestZoomPoints(words, duration)); // déterministe
  assert.ok(r.hints.length >= 1 && r.hints.length <= 2); // au plus un zoom tous les 6 s
  assert.equal(r.events.length, r.hints.length * 2);
  assert.ok(r.hints.some((h) => /milliards|communes|décentralisation|dette/.test(h.word)), JSON.stringify(r.hints));
  for (let i = 0; i < r.events.length; i += 2) {
    assert.equal(r.events[i].kind, 'in');
    assert.equal(r.events[i + 1].kind, 'out');
    assert.ok(r.events[i + 1].t - r.events[i].t >= ZOOM.rampIn + ZOOM.holdAuto - 1e-9);
    assert.ok(r.events[i + 1].t <= duration - 0.2);
    if (i) assert.ok(r.events[i].t - r.events[i - 1].t >= ZOOM.minGap); // le zoom d'après commence après le retour
  }
  assert.deepEqual(sanitizeZoom({ events: r.events }, duration).events, r.events); // toujours valable pour le rendu
  // un chiffre est toujours retenu ; les mots creux jamais
  const num = wordsForExtracts([{ start_ms: 0, end_ms: 8000, text: 'Alors donc voilà en 2025 nous avons vraiment beaucoup de choses' }], [{ start_ms: 0, end_ms: 8000 }]);
  assert.deepEqual(suggestZoomPoints(num.words, num.duration).hints.map((h) => h.word), ['2025']);
  const blabla = wordsForExtracts([{ start_ms: 0, end_ms: 8000, text: 'Alors donc voilà comme on dit eh bien on va voir' }], [{ start_ms: 0, end_ms: 8000 }]);
  assert.deepEqual(suggestZoomPoints(blabla.words, blabla.duration).events, []);
  assert.deepEqual(suggestZoomPoints([], 10).events, []);
  // rappel du mot sur lequel porte un zoom
  assert.match(wordNear(words, r.hints[0].t + 0.15), /\p{L}/u);
  assert.equal(wordNear(words, 500), '');
});

test('mots creux : écartés du palmarès, mots de fond conservés', () => {
  for (const w of ['cetera', 'ailleurs', 'aujourd', 'passe', 'parle', 'pense', 'compte', 'grand', 'grandes', 'heure', 'heures', 'question', 'questions', 'toujours', 'faudrait']) {
    assert.ok(isStopWord(w), `${w} doit être écarté`);
  }
  for (const w of ['politique', 'energie', 'liberte', 'ecole', 'impots', 'milliards', 'securite', 'immigration', 'maire', 'france', 'francais', 'droite', 'gauche', 'entreprises', 'depense']) {
    assert.ok(!isStopWord(w), `${w} doit rester`);
  }
});

test('draftFromClip : réglages d’un clip de la bibliothèque -> brouillon de l’éditeur', () => {
  const req = {
    extracts: [{ start_ms: 1000, end_ms: 5000 }],
    layout: { fit: 'crop', cropX: 0.3, quality: 'fast', mirror: true, follow: { on: true, subject: 'lisnard' } },
    style: { preset: 'hormozi' },
    music: { id: 'lofi-doux', volume: 0.3 },
    voice: 1.2,
    zoom: { strength: 1.2, focus: { x: 0.5, y: 0.4 }, events: [{ t: 1, kind: 'in' }] },
    broll: [{ id: '123', start: 0.5, dur: 2 }],
    edits: { 1000: 'Corrigé' },
  };
  const d = draftFromClip(req, 'a'.repeat(24));
  assert.equal(d.v, 1);
  assert.deepEqual(d.extracts, [{ start_ms: 1000, end_ms: 5000, title: null, from: null, caption: null }]);
  assert.deepEqual(d.layout, req.layout);
  assert.deepEqual(d.music, { id: 'lofi-doux', volume: 0.3 });
  assert.equal(d.zoom.on, true);
  assert.equal(d.broll[0].thumb, '/api/studio/stock/image/123');
  assert.deepEqual(d.edits, { 1000: 'Corrigé' });
  assert.equal(d.remixOf, 'a'.repeat(24));
  assert.deepEqual([d.jobId, d.delivered], [null, false]);
  assert.equal(draftFromClip({ extracts: [] }).endCard.on, false, 'un clip sans écran de fin n’en hérite pas');
  const empty = draftFromClip(null);
  assert.deepEqual([empty.extracts, empty.music, empty.zoom.on, empty.edits], [[], { id: null }, false, {}]);
});

test('écran de fin : validation, contenu et événements ASS', () => {
  assert.equal(sanitizeEndCard(null), null);
  assert.equal(sanitizeEndCard({ on: false, text: 'x' }), null);
  assert.equal(sanitizeEndCard({ on: true, source: false, text: '   ' }), null);
  assert.deepEqual(sanitizeEndCard({ on: true }), { on: true, source: true, text: '', dur: 3 });
  const c = sanitizeEndCard({ on: true, source: false, text: `a\nb${'x'.repeat(200)}`, dur: 9 });
  assert.equal(c.dur, 5);
  assert.equal(c.text.length, 120);
  assert.ok(!c.text.includes('\n'));
  assert.equal(sanitizeEndCard({ on: true, dur: 1 }).dur, 2);
  assert.deepEqual(endCardContent({ source: true, text: 'Adhère' }, 'Source : X'), { title: 'Adhère', foot: 'Source : X' });
  assert.deepEqual(endCardContent({ source: true, text: '' }, 'Source : X'), { title: 'Source : X', foot: '', small: true });
  const style = sanitizeStyle({ preset: 'hormozi' }, ['anton']);
  const ass = buildAss({ groups: [{ start: 0, end: 4, words: [{ start: 0, end: 4, text: 'bonjour' }] }], style, font: { ass_name: 'Anton', em_ratio: 1, cap_em: 0.7 },
    endCard: { start: 4, end: 7, title: 'Adhère {vite}', foot: 'Source : X', font: { ass_name: 'Montserrat' } } });
  assert.match(ass, /Style: EndTitle,Montserrat,/);
  assert.match(ass, /Dialogue: 3,0:00:04\.00,0:00:07\.00,EndTitle,.*ADHÈRE VITE$/m);
  assert.match(ass, /Dialogue: 3,0:00:04\.00,0:00:07\.00,EndFoot,.*Source : X$/m);
  assert.ok(ass.indexOf('Style: EndFoot') < ass.indexOf('[Events]'));
  assert.ok(!buildAss({ groups: [], style, font: { ass_name: 'Anton', em_ratio: 1, cap_em: 0.7 } }).includes('EndTitle'));
});

test('modèles : réglages sans l’interview, validés à l’application, liste du navigateur', () => {
  const S = {
    style: sanitizeStyle({ preset: 'hormozi' }, ['anton']), music: { id: 'lofi-doux', volume: 0.4 }, voice: 1.2,
    layout: { fit: 'crop', cropX: 0.2, quality: 'fast', mirror: true, follow: { on: true, subject: 'lisnard' } },
    zoom: { on: true, auto: false, strength: 1.3, focus: { x: 0.5, y: 0.4 }, events: [{ t: 1, kind: 'in' }] },
    endCard: { on: true, dur: 4, design: { template: 'headline', values: { title: 'Adhère' }, source: false }, image: 'c'.repeat(40) },
    extracts: [{ start_ms: 0, end_ms: 5000 }], broll: [{ id: '1' }], edits: new Map([[0, { text: 'x' }]]),
  };
  const m = modelFromState(S);
  assert.deepEqual(Object.keys(m).sort(), ['endCard', 'layout', 'music', 'style', 'voice', 'zoom']);
  assert.equal(m.layout.cropX, undefined, 'la position du cadrage dépend de la vidéo');
  assert.equal(m.zoom.events, undefined);
  const ok = sanitizeModel(JSON.parse(JSON.stringify(m)), { fontIds: ['anton'], musicIds: ['lofi-doux'], framingReady: true, identified: true });
  assert.deepEqual([ok.music, ok.voice, ok.layout.follow, ok.zoom.strength], [{ id: 'lofi-doux', volume: 0.4 }, 1.2, { on: true, subject: 'lisnard' }, 1.3]);
  assert.deepEqual([ok.endCard.on, ok.endCard.dur, ok.endCard.design.template, ok.endCard.design.values, ok.endCard.design.source], [true, 4, 'headline', { title: 'Adhère' }, false], 'visuel repris, sans l’image propre au clip');
  assert.equal(m.endCard.image, undefined);
  const elsewhere = sanitizeModel(m, { fontIds: ['bebas-neue'], musicIds: [], framingReady: false, identified: false });
  assert.deepEqual([elsewhere.music.id, elsewhere.layout.follow, elsewhere.style.font], [null, { on: false, subject: 'auto' }, 'bebas-neue']);
  const kept = endCardSettings({ on: false, text: 'garde', dur: 9 });
  assert.deepEqual([kept.on, kept.dur, kept.design.values.title], [false, 5, 'garde']);
  const fromLib = endCardSettings({ on: true, image: 'a'.repeat(40), fromClip: 'b'.repeat(24), design: { template: 'stat', palette: 'khaki', values: { number: '12' } } });
  assert.deepEqual([fromLib.image, fromLib.fromClip, fromLib.design.palette, fromLib.dirty], ['a'.repeat(40), 'b'.repeat(24), 'khaki', false]);
  assert.deepEqual([sanitizeModel(null).endCard.on, sanitizeModel(null).endCard.dur, sanitizeModel(null).endCard.design.template], [false, 3, 'headline']);
  assert.deepEqual(parseModels('pas du json'), []);
  assert.deepEqual(parseModels('{"a":1}'), []);
  const list = parseModels(JSON.stringify([{ id: 'b', name: 'Zèbre', settings: {} }, { id: 'a', name: '  Alpha ', settings: {} }, { id: 'x', name: 'sans réglages' }]));
  assert.deepEqual(list.map((x) => x.name), ['Alpha', 'Zèbre']);
});

test('visuel de fin : réglages validés, champs propres à chaque modèle, date de l’événement', async () => {
  const { sanitizeDesign, needsPhoto, eventDateText, wrapText } = await import('../public/js/endcard.js');
  const d = sanitizeDesign({ template: 'event', palette: 'pink', align: 'center', values: { title: 'Réunion', date: '2026-11-05', time: '18:30', number: 'x', location: 'Cannes' } });
  assert.deepEqual([d.template, d.palette, d.align, d.upper, d.logo, d.source], ['event', 'navy', 'center', true, true, true]);
  assert.deepEqual(d.values, { title: 'Réunion', date: '2026-11-05', time: '18:30', location: 'Cannes' });
  assert.equal(sanitizeDesign({ template: 'event', values: { date: '05/11', time: '25:00' } }).values.date, undefined);
  assert.equal(sanitizeDesign({ template: 'nope' }).template, 'headline');
  assert.equal(sanitizeDesign({ values: { title: 'x'.repeat(500) } }).values.title.length, 110);
  assert.equal(needsPhoto({ template: 'photo' }), true);
  assert.equal(needsPhoto({ template: 'quote', photoBg: true }), true);
  assert.equal(needsPhoto({ template: 'quote' }), false);
  assert.match(eventDateText('2026-11-05', '18:30'), /5 novembre · 18 h 30$/);
  assert.deepEqual(wrapText('un deux trois', 7, (s) => s.length), ['un deux', 'trois']);
});

test('logo du compte : réglages validés et bornés', () => {
  assert.equal(sanitizeLogo(null), null);
  assert.equal(sanitizeLogo({ image: 'abc' }), null);
  assert.deepEqual(sanitizeLogo({ image: 'a'.repeat(40) }), { image: 'a'.repeat(40), pos: 'tr', size: 0.18, opacity: 1 });
  assert.deepEqual(sanitizeLogo({ image: 'a'.repeat(40), pos: 'bc', size: 0.01, opacity: 0 }), { image: 'a'.repeat(40), pos: 'bc', size: 0.08, opacity: 0.3 });
});

// --- niveaux ---------------------------------------------------------------------------------------------

test('niveaux : le parcours débutant est plus court, l\'avancé garde l\'écran de fin', () => {
  assert.deepEqual(LEVELS, ['debutant', 'avance']);
  assert.deepEqual(stepsFor('avance').map((s) => s.id), ['niveau', 'extraits', 'style', 'musique', 'cadrage', 'fin', 'creer']);
  assert.deepEqual(stepsFor('debutant').map((s) => s.id), ['niveau', 'extraits', 'style', 'musique', 'cadrage', 'creer']);
  // niveau pas encore choisi : le parcours simple
  assert.deepEqual(stepsFor(null), stepsFor('debutant'));
  assert.deepEqual(stepLabels('debutant'), ['Interview', 'Niveau', 'Extrait', 'Sous-titres', 'Musique', 'Format', 'Créer']);
  assert.equal(stepLabels('avance').length, 8);
  assert.equal(stepLabels('avance')[6], 'Écran de fin');
  // le parcours avancé est le parcours complet : chaque étape y figure
  assert.deepEqual(stepsFor('avance'), FLOW);
});

test('niveaux : valeur lue du navigateur nettoyée, réglages simples du débutant', () => {
  assert.equal(sanitizeLevel('debutant'), 'debutant');
  assert.equal(sanitizeLevel('avance'), 'avance');
  for (const bad of [null, undefined, '', 'expert', 'AVANCE', 3, {}]) assert.equal(sanitizeLevel(bad), null);
  // en débutant : ni miroir, ni logo, ni écran de fin, qualité HD, volumes par défaut
  assert.deepEqual(BEGINNER_DEFAULTS, { mirror: false, logoOn: false, endCardOn: false, quality: 'hd', musicVolume: 0.25, voice: 1 });
});
