// Choix des extraits par le LLM : horaires issus de la transcription, durées contrôlées, aucune invention
// (la partie base de données nécessite Postgres via DATABASE_URL, sinon ignorée).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CLIP_LIMITS, buildCaption, buildClip, mergeClips, parseClipJson, prepareSegments, refineSegments, suggestClipsFor, windowsFor } from '../src/clip-suggestions.js';
import { LlmError } from '../src/openrouter.js';

/** Texte qui a du fond (sinon le filtre de qualité écarte l'extrait comme creux). */
const SUBSTANCE = 'la dépense publique explose, les communes paient la facture et les impôts augmentent partout';

/** n segments de `step` secondes, texte « phrase i ». */
const rows = (n, step = 5, extra = '') => Array.from({ length: n }, (_, i) => ({ start_ms: i * step * 1000, duration_ms: step * 1000, text: `phrase ${i} ${extra}`.trim() }));

test('segments : fins estimées sans chevauchement, longues pauses écartées', () => {
  const segs = prepareSegments([
    { start_ms: 0, duration_ms: 6000, text: 'a' }, // empiéterait sur la suivante (à 4 s)
    { start_ms: 4000, duration_ms: 1000, text: ' b ' },
    { start_ms: 40000, text: 'c' }, // sans durée, suivie d'une longue pause : elle s'arrête 8 s après son début
    { start_ms: 41000, text: '   ' }, // vide : ignorée
    { start_ms: 50000, text: 'd' }, // dernière : durée par défaut
  ]);
  assert.deepEqual(segs.map((s) => [s.start_ms, s.end_ms, s.text]), [[0, 4000, 'a'], [4000, 5000, 'b'], [40000, 48000, 'c'], [50000, 54000, 'd']]);
});

test('tranches : une seule pour une transcription courte, chevauchement pour une longue', () => {
  const segs = prepareSegments(rows(50));
  assert.deepEqual(windowsFor(segs), [[0, 49]]);
  const w = windowsFor(prepareSegments(rows(400, 5, 'x'.repeat(180))), 20_000);
  assert.ok(w.length >= 4);
  assert.equal(w[0][0], 0);
  assert.equal(w.at(-1)[1], 399);
  for (let i = 1; i < w.length; i++) assert.ok(w[i][0] <= w[i - 1][1] && w[i][0] > w[i - 1][0], 'les tranches se chevauchent et avancent');
});

test('réponse du modèle : JSON tolérant, erreur claire sinon', () => {
  assert.equal(parseClipJson('```json\n{"clips":[{"start":1,"end":5}]}\n```').length, 1);
  assert.equal(parseClipJson('Voici : {"clips":[]} merci').length, 0);
  assert.equal(parseClipJson('{"autre":1}').length, 0);
  for (const bad of ['', 'pas de json', '{"clips": [oups}']) assert.throws(() => parseClipJson(bad), LlmError);
});

test('extrait : horaires de la transcription, durée contrôlée, titre nettoyé', () => {
  const segs = prepareSegments(rows(60)); // 60 lignes de 5 s
  const win = [0, 59];
  const ok = buildClip({ start: 4, end: 11, title: '  <b>Il parle de la dette</b> !!  ', why: 'Une idée complète', score: 14 }, segs, win);
  assert.deepEqual([ok.start_ms, ok.end_ms, ok.duration_s, ok.title, ok.score], [20000, 60000, 40, 'Il parle de la dette', 10]);
  assert.equal(ok.text.split(' phrase ').length > 1, true);
  assert.equal(buildClip({ start: 11, end: 4, title: 'x' }, segs, win).start_ms, 20000); // bornes inversées : remises dans l'ordre
  assert.equal(buildClip({ start: 4, end: 11, title: '!!!' }, segs, win), null); // pas de titre
  assert.equal(buildClip({ start: 'a', end: 3, title: 'x' }, segs, win), null);
  assert.equal(buildClip({ start: 0, end: 70, title: 'x' }, segs, win), null); // hors transcription
  assert.equal(buildClip({ start: 2, end: 9, title: 'x' }, segs, [5, 20]), null); // hors de la tranche envoyée
  // trop long : écarté plutôt que coupé n'importe où
  assert.equal(buildClip({ start: 0, end: 30, title: 'trop long' }, segs, win), null);
  // légèrement trop court : prolongé jusqu'à la durée minimale
  const short = buildClip({ start: 10, end: 12, title: 'court' }, segs, win);
  assert.ok(short.duration_s >= CLIP_LIMITS.minS && short.duration_s <= CLIP_LIMITS.maxS);
  assert.equal(short.start_ms, 50000);
  // beaucoup trop court et rien à prolonger : écarté
  assert.equal(buildClip({ start: 59, end: 59, title: 'fin' }, segs, win), null); // 5 s : sous le minimum toléré (minS − 5)
  assert.equal(buildClip({ start: 58, end: 59, title: 'fin' }, segs, win).duration_s, 10); // 10 s : encore accepté (minimum 15 s, 5 s de tolérance)
});

/** Gros morceaux : `n` segments de `step` secondes, chacun un long paragraphe de phrases (≈ 14 caractères parlés par seconde). */
const bigRows = (n, step = 90, withDuration = true) =>
  Array.from({ length: n }, (_, i) => {
    const sentences = [];
    for (let len = 0, k = 0; len < step * 14; k++) {
      const sentence = `Voici l'idée numéro ${i}-${k} que je défends, parce que les Français attendent des réponses claires et concrètes.`;
      sentences.push(sentence);
      len += sentence.length + 1;
    }
    return { start_ms: i * step * 1000, ...(withDuration ? { duration_ms: step * 1000 } : {}), text: sentences.join(' ') };
  });

/** Faux modèle : propose, dans la tranche reçue, des extraits de 3 lignes consécutives toutes les 10 lignes. */
const pickEvery10 = async (req) => {
  const nums = [...req.user.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
  const clips = [];
  for (let k = 0; k + 3 < nums.length; k += 10) clips.push({ start: nums[k], end: nums[k + 2], title: `Extrait ${nums[k]}`, why: 'fort', description: 'à voir', hashtags: ['#a', '#b'], score: 7 });
  return JSON.stringify({ clips });
};

test('gros morceaux : une ligne trop longue est découpée en phrases aux horaires estimés', () => {
  const segs = prepareSegments(bigRows(3));
  const fine = refineSegments(segs);
  assert.ok(fine.length > segs.length * 5, 'chaque gros morceau donne plusieurs lignes');
  assert.equal(fine[0].start_ms, 0);
  assert.equal(fine.at(-1).end_ms, segs.at(-1).end_ms);
  for (let i = 0; i < fine.length; i++) {
    assert.ok(fine[i].end_ms > fine[i].start_ms, 'durée positive');
    assert.ok((fine[i].end_ms - fine[i].start_ms) / 1000 <= 16, 'lignes de 16 s au plus');
    if (i) assert.equal(fine[i].start_ms, fine[i - 1].end_ms, 'sans trou ni chevauchement');
  }
  // les phrases se terminent par un point : on coupe aux fins de phrases
  assert.ok(fine.filter((l) => /[.!?]$/.test(l.text)).length >= fine.length - 1);
  // le texte n'est ni perdu ni modifié
  assert.equal(fine.map((l) => l.text).join(' '), segs.map((s) => s.text).join(' '));
  // des lignes déjà courtes restent telles quelles
  const short = prepareSegments(rows(10));
  assert.deepEqual(refineSegments(short), short);
});

test('gros morceaux : des extraits utilisables sont proposés même quand chaque morceau dure plus que la durée maximale', async () => {
  for (const withDuration of [true, false]) {
    const clips = await suggestClipsFor(bigRows(14, 90, withDuration), { complete: pickEvery10, model: 'faux' });
    assert.ok(clips.length >= 3, `des extraits sont trouvés (durées connues : ${withDuration})`);
    for (const c of clips) {
      assert.ok(c.duration_s >= CLIP_LIMITS.minS - 5 && c.duration_s <= CLIP_LIMITS.maxS + 15, `durée ${c.duration_s} s dans les limites`);
      assert.ok(c.start_ms >= 0 && c.end_ms <= 14 * 90_000 + 1000);
      assert.match(c.text, /Voici l'idée/);
    }
  }
});

test('segments : sans durée, un long texte garde le temps de parole qu\'il demande', () => {
  const text = 'mot '.repeat(250).trim(); // ≈ 1 000 caractères : environ 70 s de parole
  const [seg] = prepareSegments([{ start_ms: 0, text }, { start_ms: 120_000, text: 'suite' }]);
  assert.ok(seg.end_ms >= 60_000 && seg.end_ms <= 120_000, `fin estimée à ${seg.end_ms} ms`);
});

test('fusion : meilleure note d\'abord, pas de chevauchement, nombre borné', () => {
  const c = (start_ms, end_ms, score) => ({ start_ms, end_ms, score });
  const merged = mergeClips([c(0, 30000, 6), c(20000, 50000, 9), c(60000, 90000, 5), c(100000, 130000, 7)]);
  assert.deepEqual(merged.map((m) => m.score), [9, 7, 5]);
  assert.equal(mergeClips(Array.from({ length: 20 }, (_, i) => c(i * 100000, i * 100000 + 30000, 5))).length, CLIP_LIMITS.maxSuggestions);
});

// --- avec la base de données ----------------------------------------------------------

const enabled = Boolean(process.env.DATABASE_URL);
const YT = 'CSGtest_001';
let db;
let svc;
let videoId;

before(async () => {
  if (!enabled) return;
  db = await import('../src/db.js');
  svc = await import('../src/clip-suggestions.js');
  await db.initDb();
  await db.pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  const r = await db.pool.query(`INSERT INTO videos (youtube_id, title, source, lang) VALUES ($1, 'Vidéo test', 'manual', 'fr') RETURNING id`, [YT]);
  videoId = r.rows[0].id;
});
after(async () => {
  if (!enabled) return;
  await db.pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  await db.pool.end();
});
const setSegments = (data) => db.withTransaction((c) => db.replaceSegments(c, videoId, data));

test('génération : extraits stockés avec les horaires de la transcription, consignes éditoriales envoyées', { skip: !enabled }, async () => {
  await setSegments(rows(60, 5, SUBSTANCE));
  let seen;
  const complete = async (req) => {
    seen = req;
    return '{"clips":[{"start":4,"end":11,"title":"Sa position sur la dette","why":"Argument complet","score":9},{"start":20,"end":27,"title":"Les communes","why":"Exemple concret","score":10},{"start":22,"end":29,"title":"Chevauche le précédent","why":"x","score":3}]}';
  };
  const out = await svc.generateClipSuggestions(videoId, { complete, model: 'faux-modèle' });
  assert.deepEqual(out.clips.map((c) => [c.title, c.start_ms, c.end_ms]), [['Les communes', 100000, 140000], ['Sa position sur la dette', 20000, 60000]]);
  assert.match(seen.system, /David Lisnard/);
  // consigne virale : TikTok, accroche, moments forts, potentiel viral ; garde-fou de fidélité conservé
  assert.match(seen.system, /TikTok/);
  assert.match(seen.system, /viral/);
  assert.match(seen.system, /accroche immédiate/);
  assert.match(seen.system, /punchline/);
  assert.doesNotMatch(seen.system, /au moins un extrait toutes les 2 à 3 minutes/); // plus de quota : mieux vaut peu d'extraits excellents
  assert.match(seen.system, /Mieux vaut 3 extraits excellents que 15 moyens/);
  assert.match(seen.system, /\{"clips":\[\]\}/);
  assert.match(seen.system, /Ne propose JAMAIS/);
  assert.match(seen.system, /salutations et l'accueil/);
  assert.match(seen.system, /remerciements, les au revoir/);
  assert.match(seen.system, /questions, relances et commentaires de l'intervieweur/);
  // légende TikTok générée avec les extraits, une fois : accroche + 2 à 4 hashtags
  assert.match(seen.system, /"description" : la légende TikTok/);
  assert.match(seen.system, /de 2 à 4 hashtags/);
  assert.match(seen.system, /"hashtags":\[/);
  assert.match(seen.system, /ne coupe jamais avant un « mais », une nuance, une réserve ou une condition/);
  assert.doesNotMatch(seen.system, /pas pour le caractère polémique/);
  assert.match(seen.system, /ne modifie aucun mot/);
  assert.match(seen.user, /^\[0\] 00:00 phrase 0/); // lignes numérotées avec repère de temps
  const stored = await svc.getClipSuggestions(videoId);
  assert.deepEqual([stored.clips.length, stored.model, stored.outdated], [2, 'faux-modèle', false]);

  // la transcription change : les extraits sont signalés comme périmés
  await setSegments(rows(60, 5, `${SUBSTANCE} corrigé`));
  assert.equal((await svc.getClipSuggestions(videoId)).outdated, true);
});

test('génération : tranches multiples pour une longue transcription, erreurs claires', { skip: !enabled }, async () => {
  await setSegments(rows(500, 5, `${SUBSTANCE} `.repeat(6))); // environ 120 000 caractères : plusieurs tranches
  const calls = [];
  const complete = async (req) => {
    const first = Number(req.user.match(/^\[(\d+)\]/)[1]);
    calls.push(first);
    return JSON.stringify({ clips: [{ start: first + 2, end: first + 9, title: `Extrait ${first}`, why: 'ok', score: 9 }] });
  };
  const out = await svc.generateClipSuggestions(videoId, { complete });
  assert.ok(calls.length >= 3, `${calls.length} appels`);
  assert.ok(out.clips.length >= 3);
  assert.ok(out.clips.every((c, i, a) => a.every((d, j) => i === j || c.end_ms <= d.start_ms || d.end_ms <= c.start_ms)));

  await assert.rejects(svc.generateClipSuggestions(videoId, { complete: async () => 'rien de lisible' }), LlmError);
  await assert.rejects(svc.generateClipSuggestions(videoId, { complete: async () => '{"clips":[{"start":499,"end":499,"title":"trop court"}]}' }), /aucun extrait utilisable/);
  await assert.rejects(svc.generateClipSuggestions(999999999, { complete }), (e) => e.status === 404);
  await setSegments([]);
  await assert.rejects(svc.generateClipSuggestions(videoId, { complete }), (e) => e.status === 409);
  await setSegments(rows(2));
  await assert.rejects(svc.suggestClipsFor(rows(2), { complete }), (e) => e.status === 409); // transcription trop courte
});

test('modèle des extraits : propre aux extraits, jamais celui des résumés / traductions', async () => {
  const { clipModel, DEFAULT_CLIP_MODEL } = await import('../src/clip-suggestions.js');
  const keep = { clip: process.env.CLIP_MODEL, translate: process.env.TRANSLATE_MODEL, summary: process.env.SUMMARY_MODEL };
  try {
    process.env.TRANSLATE_MODEL = 'deepseek/deepseek-v4.1-flash';
    process.env.SUMMARY_MODEL = 'deepseek/deepseek-v4.1-flash';
    delete process.env.CLIP_MODEL;
    assert.equal(clipModel(), DEFAULT_CLIP_MODEL);
    assert.doesNotMatch(clipModel(), /deepseek/);
    process.env.CLIP_MODEL = 'google/gemini-2.5-flash-lite';
    assert.equal(clipModel(), 'google/gemini-2.5-flash-lite');
    process.env.CLIP_MODEL = '';
    assert.equal(clipModel(), DEFAULT_CLIP_MODEL); // variable vide : modèle par défaut
  } finally {
    for (const [k, v] of Object.entries({ CLIP_MODEL: keep.clip, TRANSLATE_MODEL: keep.translate, SUMMARY_MODEL: keep.summary })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('le modèle est invité à proposer jusqu\'à 20 extraits par tranche', async () => {
  const { suggestClipsFor } = await import('../src/clip-suggestions.js');
  assert.equal(CLIP_LIMITS.maxSuggestions, 20);
  assert.equal(CLIP_LIMITS.minS, 15);
  const seen = [];
  const complete = async ({ system }) => {
    seen.push(Number(/jusqu'à (\d+) extraits/.exec(system)[1]));
    return '{"clips":[]}';
  };
  await suggestClipsFor(rows(240, 5), { complete, model: 'x' });
  assert.deepEqual(seen, [20]);
});

test('légende TikTok : texte court, 2 à 4 hashtags valides sans doublon, entrées du modèle nettoyées', () => {
  const tags = (c) => c.hashtags;
  const a = buildCaption('Pourquoi la dette freine-t-elle les communes ? 🤔', ['#Dette', 'communes', '#pourtoi', '#Dette'], 'Titre');
  assert.equal(a.text, 'Pourquoi la dette freine-t-elle les communes ? 🤔'); // l'espace avant « ? » est conservé (typographie française)
  assert.deepEqual(tags(a), ['#Dette', '#communes', '#pourtoi']);
  assert.equal(a.caption, 'Pourquoi la dette freine-t-elle les communes ? 🤔\n\n#Dette #communes #pourtoi');
  // au plus 4 hashtags, ceux du texte comptent aussi, pas de doublon à la casse près
  const b = buildCaption('Un texte #un #deux', ['#trois', '#quatre', '#cinq', '#UN'], 'T');
  assert.deepEqual(tags(b), ['#trois', '#quatre', '#cinq', '#UN']); // les hashtags du texte (#un, #deux) passent après ceux de la liste ; 4 au plus, doublon à la casse près écarté
  assert.equal(b.text, 'Un texte');
  // hashtags invalides écartés (trop courts, symboles), complétés jusqu'à 2 avec des valeurs par défaut
  assert.deepEqual(tags(buildCaption('x', ['#a', '#!!!', ''], 'T')), ['#lisnard', '#politique']);
  assert.deepEqual(tags(buildCaption('x', ['#dette'], 'T')), ['#dette', '#lisnard']);
  assert.deepEqual(tags(buildCaption('x', ['#lisnard'], 'T')), ['#lisnard', '#politique']);
  // HTML, liens et retours à la ligne retirés ; texte vide : le titre sert de légende ; jamais plus de 200 caractères de texte
  const c = buildCaption('<b>Il explique</b>\nla dette https://exemple.test/x ici', [], 'Titre');
  assert.equal(c.text, 'Il explique la dette ici');
  assert.equal(buildCaption('', null, 'Un titre').text, 'Un titre');
  assert.ok(buildCaption('x'.repeat(500), [], 'T').text.length <= 200);
  assert.doesNotMatch(buildCaption('a #b\n#c', [], 'T').text, /#/);
  // le texte du modèle ne peut pas injecter de saut de ligne dans les hashtags
  assert.ok(buildCaption('x', ['#a b\n#c'], 'T').hashtags.every((t) => /^#[\p{L}\p{N}_]+$/u.test(t)));
});

test('légende TikTok : stockée avec chaque extrait, générée une seule fois', { skip: !enabled }, async () => {
  await setSegments(rows(60, 5, SUBSTANCE));
  let calls = 0;
  const complete = async () => {
    calls++;
    return '{"clips":[{"start":4,"end":11,"title":"Sa position sur la dette","why":"Argument complet","description":"La dette publique, expliquée simplement par David Lisnard.","hashtags":["#dette","#communes","#lisnard"],"score":9}]}';
  };
  const out = await svc.generateClipSuggestions(videoId, { complete, model: 'faux-modèle' });
  assert.equal(out.clips[0].description, 'La dette publique, expliquée simplement par David Lisnard.\n\n#dette #communes #lisnard');
  const stored = await svc.getClipSuggestions(videoId);
  assert.equal(stored.clips[0].description, out.clips[0].description); // relue telle quelle, sans nouvel appel au modèle
  assert.equal(calls, 1);
  // réponse sans légende (ancien format ou oubli du modèle) : légende de repli à partir du titre, hashtags par défaut
  const bare = async () => '{"clips":[{"start":4,"end":11,"title":"Sa position","why":"x","score":9}]}';
  const out2 = await svc.generateClipSuggestions(videoId, { complete: bare, model: 'faux-modèle' });
  assert.equal(out2.clips[0].description, 'Sa position\n\n#lisnard #politique');
});

// --- qualité : ce qui est creux est écarté ---------------------------------------------

test('qualité : accueil, remerciements, creux, questions et bords de l\'interview sont écartés, le fond est gardé', async () => {
  const { junkReason, contentWords, QUALITY } = await import('../src/clip-quality.js');
  const bounds = { start_ms: 0, end_ms: 3_600_000 };
  const clip = (text, over = {}) => ({ start_ms: 600_000, end_ms: 640_000, score: 8, text, ...over });
  const fond = 'La dépense publique en France atteint cinquante-sept pour cent du produit intérieur brut. C\'est un record parmi les pays développés, et pourtant nos hôpitaux, nos écoles et nos routes se dégradent. Il faut oser baisser la dépense pour retrouver de la liberté.';
  assert.equal(junkReason(clip(fond), bounds), null);
  assert.equal(junkReason(clip('Quand j\'étais maire de Cannes, nous avons supprimé trois cents normes inutiles pour les commerçants. Résultat : les ouvertures de commerces ont augmenté, parce que la confiance libère l\'initiative locale.'), bounds), null);
  // accueil
  assert.equal(junkReason(clip('Bonjour David Lisnard, merci d\'être avec nous ce matin. Je suis ravi de vous recevoir dans cette émission, on va parler de l\'actualité.'), bounds), 'accueil ou salutations');
  assert.equal(junkReason(clip('Bienvenue dans notre émission. Notre invité aujourd\'hui est maire de Cannes et président de l\'association des maires de France.'), bounds), 'accueil ou salutations');
  assert.equal(junkReason(clip(`Bonjour à tous. ${fond}`), bounds), 'accueil ou salutations'); // salue dans ses premiers mots
  // remerciements, au revoir
  assert.equal(junkReason(clip('Merci beaucoup David Lisnard d\'avoir répondu à nos questions, ce fut un plaisir de vous recevoir. Merci à vous et bonne journée à tous.'), bounds), 'remerciements ou au revoir');
  assert.equal(junkReason(clip(`${fond} Merci beaucoup, à bientôt !`), bounds), 'remerciements ou au revoir');
  // un « merci » ou un « bonjour » au milieu d'un vrai propos ne suffit pas à l'écarter
  assert.equal(junkReason(clip(`${fond} Je remercie d'ailleurs les maires qui se battent chaque jour, et je le dis aux Français qui nous écoutent.`), bounds), null);
  // creux : pas de fond
  assert.equal(junkReason(clip('Oui alors, effectivement, comme on dit, c\'est un sujet important, on en a déjà parlé, voilà, et puis c\'est comme ça, il faut voir, on verra bien.'), bounds), 'trop peu de contenu');
  assert.ok(contentWords('Oui oui, voilà, bon, c\'est comme ça.') < QUALITY.minContentWords);
  assert.ok(contentWords(fond) >= QUALITY.minContentWords);
  // questions de l'intervieweur (transcription ponctuée)
  assert.equal(junkReason(clip('Pourquoi les impôts augmentent-ils ? Est-ce que l\'État dépense trop ? Qui va payer la dette ? Et les communes dans tout ça ?'), bounds), 'questions de l\'intervieweur');
  assert.equal(junkReason(clip(`Qui paie la dette ? Les Français. ${fond}`), bounds), null); // une question rhétorique suivie d'une réponse reste un extrait
  // note
  assert.equal(junkReason(clip(fond, { score: 6 }), bounds), 'note trop basse');
  assert.equal(junkReason(clip(fond, { score: 7 }), bounds), null);
  // 60 premières / dernières secondes : seulement une note de 9 ou plus
  assert.equal(junkReason(clip(fond, { start_ms: 30_000, end_ms: 70_000 }), bounds), 'début de l\'interview');
  assert.equal(junkReason(clip(fond, { start_ms: 30_000, end_ms: 70_000, score: 9 }), bounds), null);
  assert.equal(junkReason(clip(fond, { start_ms: 3_540_000, end_ms: 3_590_000 }), bounds), 'fin de l\'interview');
  assert.equal(junkReason(clip(fond, { start_ms: 60_000, end_ms: 100_000 }), bounds), null); // juste après la zone
  // interview courte : pas d'« accueil » ni de « conclusion » à écarter
  assert.equal(junkReason(clip(fond, { start_ms: 10_000, end_ms: 50_000 }), { start_ms: 0, end_ms: 120_000 }), null);
  // seuil réglable
  assert.equal(junkReason(clip(fond, { score: 3 }), bounds, { ...QUALITY, minScore: 1 }), null);
});

test('qualité : des extraits creux proposés par le modèle ne sont jamais renvoyés, même bien notés', async () => {
  const fond = 'La dépense publique explose, les communes paient la facture et les impôts augmentent partout en France.';
  // 80 lignes de 5 s (400 s) : l'accueil (lignes 0-3), du fond (le reste), des remerciements (dernières lignes)
  const texts = Array.from({ length: 80 }, (_, i) => (i < 4 ? 'Bonjour à tous et bienvenue, merci de nous recevoir ce matin.' : i >= 77 ? 'Merci beaucoup, au revoir et bonne journée à tous.' : `${fond} ${i}`));
  const data = texts.map((text, i) => ({ start_ms: i * 5000, duration_ms: 5000, text }));
  const stats = {};
  const complete = async () => JSON.stringify({ clips: [
    { start: 0, end: 4, title: 'Accueil chaleureux', why: 'x', score: 9 },
    { start: 30, end: 36, title: 'La dépense publique explose', why: 'x', score: 8 },
    { start: 50, end: 56, title: 'Un passage faible', why: 'x', score: 5 },
    { start: 74, end: 79, title: 'Les remerciements', why: 'x', score: 10 },
  ] });
  const clips = await suggestClipsFor(data, { complete, model: 'faux', stats });
  assert.deepEqual(clips.map((c) => c.title), ['La dépense publique explose']);
  assert.deepEqual([stats.proposed, stats.valid, stats.junk], [4, 4, 3]);
});

test('qualité : rien de fort dans l\'interview donne une liste vide conservée, pas une erreur', { skip: !enabled }, async () => {
  await setSegments(rows(60, 5, SUBSTANCE));
  let calls = 0;
  const empty = async () => {
    calls++;
    return '{"clips":[]}';
  };
  const out = await svc.generateClipSuggestions(videoId, { complete: empty, model: 'faux' });
  assert.deepEqual(out.clips, []);
  const stored = await svc.getClipSuggestions(videoId);
  assert.deepEqual([stored.clips.length, stored.outdated], [0, false]); // « déjà fait » : le modèle n'est pas relancé tout seul
  // tout est écarté comme creux : liste vide aussi
  const weak = async () => '{"clips":[{"start":4,"end":11,"title":"Faible","why":"x","score":4}]}';
  assert.deepEqual((await svc.generateClipSuggestions(videoId, { complete: weak, model: 'faux' })).clips, []);
  // en revanche, des propositions sans horaires valides restent une erreur à réessayer
  const broken = async () => '{"clips":[{"start":499,"end":499,"title":"trop court"}]}';
  await assert.rejects(svc.generateClipSuggestions(videoId, { complete: broken, model: 'faux' }), /aucun extrait utilisable/);
  assert.equal(calls, 1);
});

test('consigne : version du prompt, note minimale et filtres décrits', async () => {
  const { PROMPT_VERSION } = await import('../src/clip-suggestions.js');
  const { QUALITY } = await import('../src/clip-quality.js');
  assert.equal(PROMPT_VERSION, 'c5');
  assert.equal(QUALITY.minScore, 7);
  assert.equal(QUALITY.edgeMs, 60_000);
});
