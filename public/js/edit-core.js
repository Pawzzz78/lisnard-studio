/**
 * Section « Edit » : montages rythmés sur un son. Module pur, partagé par le serveur (rendu) et le navigateur (aperçu de la chronologie).
 *
 * Un modèle (créé par l'admin) = un son de la bibliothèque, un passage de ce son (début, nombre de temps) et une « recette » :
 * des sections qui disent tous les combien de temps on coupe, quels effets on met à chaque coupe et quelle part de photos on montre.
 * `planEdit` transforme modèle + temps forts du son + médias choisis en chronologie : une case par coupe, calée sur les temps.
 */
import { assEscape } from './studio-core.js';

export const EDIT = {
  minBeats: 8,
  maxBeats: 128,
  minDurationS: 4,
  maxDurationS: 30,
  maxSlots: 40,
  minSlotS: 0.2,
  maxSections: 6,
  maxTexts: 3,
  maxTextLen: 60,
  maxNameLen: 60,
  cutEvery: [0.5, 1, 2, 4, 8], // en temps
  clipGapS: 1.5, // écart entre deux morceaux pris dans le même extrait : on montre des moments différents
  textBeats: 4, // durée d'un texte, en temps (au plus jusqu'au texte suivant)
};

/** Effets posés à chaque coupe. */
export const EFFECTS = {
  punch: 'Zoom punch',
  flash: 'Flash blanc',
  shake: 'Secousse',
  bw: 'Noir et blanc',
  rgb: 'Décalage des couleurs',
  slowzoom: 'Zoom lent',
  none: 'Sans effet',
};

/** Étalonnage de tout le montage. */
export const GRADES = {
  none: 'Couleurs d’origine',
  contrast: 'Contrasté',
  warm: 'Chaud',
  cold: 'Froid',
  bw: 'Noir et blanc',
};

/** Recettes de départ (l'admin part de l'une d'elles, puis règle). `beats: 0` : jusqu'à la fin du passage. */
export const RECIPES = {
  punch: {
    label: 'Punch',
    hint: 'Une intro posée, puis des coupes sèches et des zooms qui claquent sur chaque temps.',
    grade: 'contrast',
    sections: [
      { beats: 8, cut_every: 2, effects: ['slowzoom'], photo_share: 0.5 },
      { beats: 0, cut_every: 1, effects: ['punch', 'flash', 'punch', 'shake'], photo_share: 0.25 },
    ],
  },
  cinematique: {
    label: 'Cinématique',
    hint: 'Des plans plus longs, des zooms lents, une image froide et élégante.',
    grade: 'cold',
    sections: [{ beats: 0, cut_every: 4, effects: ['slowzoom', 'bw', 'slowzoom'], photo_share: 0.5 }],
  },
  hype: {
    label: 'Hype',
    hint: 'Un montage très rapide, avec secousses et effets de couleurs.',
    grade: 'contrast',
    sections: [
      { beats: 4, cut_every: 2, effects: ['punch'], photo_share: 0.3 },
      { beats: 0, cut_every: 0.5, effects: ['shake', 'rgb', 'punch', 'flash'], photo_share: 0.2 },
    ],
  },
  nostalgie: {
    label: 'Nostalgie',
    hint: 'Surtout des photos, un rythme posé et des couleurs chaudes.',
    grade: 'warm',
    sections: [{ beats: 0, cut_every: 2, effects: ['slowzoom'], photo_share: 0.7 }],
  },
};

export class EditError extends Error {}
const fail = (msg) => {
  throw new EditError(msg);
};
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * Valide un modèle envoyé par l'admin. `trackIds` / `fontIds` : identifiants permis (vérifiés seulement s'ils sont donnés).
 * Lève une EditError au message clair.
 */
export function sanitizeTemplate(input, { trackIds = null, fontIds = null } = {}) {
  const x = input && typeof input === 'object' ? input : {};
  const name = clean(x.name, EDIT.maxNameLen);
  if (!name) fail('Donne un nom au modèle.');
  const track_id = clean(x.track_id, 80);
  if (!track_id || (trackIds && !trackIds.includes(track_id))) fail('Choisis un son de la bibliothèque.');
  const start_s = num(x.start_s ?? 0);
  if (!Number.isFinite(start_s) || start_s < 0 || start_s > 600) fail('Début du son invalide.');
  const length_beats = num(x.length_beats);
  if (!Number.isInteger(length_beats) || length_beats < EDIT.minBeats || length_beats > EDIT.maxBeats) fail(`Le passage doit durer entre ${EDIT.minBeats} et ${EDIT.maxBeats} temps.`);
  // Optional manual tempo, for sounds whose beat the analysis could not find
  let bpm = null;
  if (x.bpm !== null && x.bpm !== undefined && x.bpm !== '') {
    bpm = num(x.bpm);
    if (!Number.isFinite(bpm) || bpm < 50 || bpm > 220) fail('Tempo invalide (50 à 220 BPM).');
    bpm = Math.round(bpm * 10) / 10;
  }
  const r = x.recipe && typeof x.recipe === 'object' ? x.recipe : {};
  const grade = Object.hasOwn(GRADES, r.grade) ? r.grade : 'none';
  const list = Array.isArray(r.sections) ? r.sections : [];
  if (!list.length || list.length > EDIT.maxSections) fail(`Une recette compte de 1 à ${EDIT.maxSections} sections.`);
  const sections = list.map((sec, i) => {
    const beats = num(sec?.beats ?? 0);
    if (!Number.isInteger(beats) || beats < 0 || beats > EDIT.maxBeats) fail(`Section ${i + 1} : nombre de temps invalide.`);
    if (beats === 0 && i !== list.length - 1) fail('Seule la dernière section peut aller « jusqu’à la fin ».');
    const cut_every = num(sec?.cut_every);
    if (!EDIT.cutEvery.includes(cut_every)) fail(`Section ${i + 1} : rythme des coupes invalide.`);
    const effects = (Array.isArray(sec?.effects) ? sec.effects : []).filter((e) => Object.hasOwn(EFFECTS, e)).slice(0, 8);
    if (!effects.length) fail(`Section ${i + 1} : choisis au moins un effet.`);
    const share = num(sec?.photo_share ?? 0);
    if (!Number.isFinite(share) || share < 0 || share > 1) fail(`Section ${i + 1} : part de photos invalide.`);
    return { beats, cut_every, effects, photo_share: Math.round(share * 100) / 100 };
  });
  const texts = (Array.isArray(x.texts) ? x.texts : []).slice(0, EDIT.maxTexts + 1);
  if (texts.length > EDIT.maxTexts) fail(`${EDIT.maxTexts} textes au maximum.`);
  const cleanTexts = texts
    .map((t) => ({ text: clean(t?.text, EDIT.maxTextLen), beat: num(t?.beat) }))
    .filter((t) => t.text)
    .map((t) => {
      if (!Number.isInteger(t.beat) || t.beat < 0 || t.beat >= length_beats) fail('Un texte doit tomber pendant le passage.');
      return t;
    })
    .sort((a, b) => a.beat - b.beat);
  const font = clean(x.font, 40) || 'anton';
  if (fontIds && !fontIds.includes(font)) fail('Police inconnue.');
  return { name, track_id, start_s: Math.round(start_s * 1000) / 1000, length_beats, bpm, recipe: { grade, sections }, texts: cleanTexts, font };
}

/** Modèle tout prêt à partir d'une recette de départ. */
export function templateFromRecipe(recipeId, { name, track_id, start_s = 0, length_beats = 32, texts = [], font = 'anton' } = {}) {
  const r = RECIPES[recipeId] ?? fail('Recette inconnue.');
  return { name: name ?? r.label, track_id, start_s, length_beats, bpm: null, recipe: { grade: r.grade, sections: r.sections.map((s) => ({ ...s, effects: [...s.effects] })) }, texts, font };
}

/**
 * Temps du passage choisi : { t0 (s, dans le son), times (s, depuis t0 ; length + 1 valeurs, la dernière = fin), strong (indices), drops }.
 * `beats` : résultat de l'analyse du son ({ bpm, beats, strong, drops }). Avec un tempo imposé (`template.bpm`), grille régulière
 * qui commence au début choisi. Le passage est raccourci (en temps entiers) s'il dépasse la durée maximale.
 */
export function beatWindow(template, beats) {
  const want = template.length_beats;
  let t0 = template.start_s;
  let abs = [];
  let strongAbs = new Set();
  let dropsAbs = new Set();
  if (!template.bpm && beats?.beats?.length) {
    const i0 = beats.beats.findIndex((b) => b >= template.start_s - 0.02);
    if (i0 >= 0) {
      abs = beats.beats.slice(i0, i0 + want + 1);
      t0 = abs[0];
      strongAbs = new Set((beats.strong ?? []).filter((i) => i >= i0).map((i) => i - i0));
      dropsAbs = new Set((beats.drops ?? []).filter((i) => i >= i0).map((i) => i - i0));
    }
  }
  const bpm = template.bpm ?? beats?.bpm ?? 120;
  const period = 60 / bpm;
  if (!abs.length) abs = [t0];
  // Too few detected beats (end of the sound, or manual tempo): continue on a regular grid
  while (abs.length < want + 1) abs.push(abs[abs.length - 1] + period);
  if (template.bpm) for (let i = 0; i <= want; i += 4) strongAbs.add(i);
  let times = abs.map((t) => Math.round((t - t0) * 1000) / 1000);
  let n = want;
  while (n > EDIT.minBeats && times[n] > EDIT.maxDurationS) n--;
  times = times.slice(0, n + 1);
  return { t0: Math.round(t0 * 1000) / 1000, times, length: n, strong: [...strongAbs].filter((i) => i < n).sort((a, b) => a - b), drops: [...dropsAbs].filter((i) => i < n).sort((a, b) => a - b) };
}

/** Instant (s depuis t0) d'une position en temps, éventuellement fractionnaire (demi-temps). */
const timeAt = (times, beat) => {
  const i = Math.floor(beat);
  if (i >= times.length - 1) return times[times.length - 1];
  return times[i] + (times[i + 1] - times[i]) * (beat - i);
};

/**
 * Chronologie du montage. `media` : { clips: [{ youtube_id, start_ms, end_ms, crop_x? }], photos: [id] }.
 * Renvoie { duration, music: { track_id, start_s, duration }, grade, font, slots, texts } ; chaque case :
 * { start, dur, kind: 'video' | 'photo', youtube_id?, from_s?, crop_x?, photo?, effects: [...] } (secondes).
 * Déterministe : le navigateur et le serveur obtiennent la même chronologie.
 */
export function planEdit({ template, beats, media }) {
  const clips = (media?.clips ?? []).filter((c) => c && c.end_ms > c.start_ms);
  const photos = [...new Set(media?.photos ?? [])];
  if (!clips.length && !photos.length) fail('Choisis au moins un extrait ou une photo.');
  const win = beatWindow(template, beats);
  const duration = win.times[win.length];
  if (duration < EDIT.minDurationS) fail(`Le passage du son est trop court (${EDIT.minDurationS} secondes au minimum).`);
  const strong = new Set(win.strong);
  const drops = new Set(win.drops);

  // Cut points (in beats), section after section
  const cuts = [];
  let pos = 0;
  template.recipe.sections.forEach((sec, si) => {
    const end = sec.beats === 0 ? win.length : Math.min(win.length, pos + sec.beats);
    for (let b = pos; b < end - 1e-9; b += sec.cut_every) cuts.push({ beat: b, section: si });
    pos = end;
  });
  // A recipe shorter than the passage: its last section goes on to the end
  if (pos < win.length) {
    const last = template.recipe.sections.length - 1;
    for (let b = pos; b < win.length - 1e-9; b += template.recipe.sections[last].cut_every) cuts.push({ beat: b, section: last });
  }
  let slots = cuts.map((c, i) => {
    const start = timeAt(win.times, c.beat);
    const end = i + 1 < cuts.length ? timeAt(win.times, cuts[i + 1].beat) : duration;
    return { beat: c.beat, section: c.section, start, end };
  });
  // Too short slots join the next one; too many slots: merge pairs from the end
  slots = slots.reduce((acc, s) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.end - prev.start < EDIT.minSlotS) prev.end = s.end;
    else acc.push({ ...s });
    return acc;
  }, []);
  while (slots.length > EDIT.maxSlots) {
    const merged = [];
    for (let i = 0; i < slots.length; i += 2) merged.push(i + 1 < slots.length ? { ...slots[i], end: slots[i + 1].end } : slots[i]);
    slots = merged;
  }

  // Media: photo or interview piece for each slot, effects at each cut
  // One reading position per extract; video slots take the extracts in turn, so every chosen moment shows up
  const cursors = clips.map((c) => c.start_ms / 1000);
  let clipIdx = 0;
  let photoIdx = 0;
  const perSection = new Map();
  let lastPhoto = null;
  const out = slots.map((s) => {
    const sec = template.recipe.sections[s.section];
    const k = perSection.get(s.section) ?? 0;
    perSection.set(s.section, k + 1);
    const dur = Math.round((s.end - s.start) * 1000) / 1000;
    // Photos spread evenly in the section: slot k is a photo when the running share crosses a whole number
    const wantPhoto = photos.length && (!clips.length || Math.floor((k + 1) * sec.photo_share) > Math.floor(k * sec.photo_share));
    const main = sec.effects[k % sec.effects.length];
    const onStrong = Number.isInteger(s.beat) && (strong.has(s.beat) || drops.has(s.beat));
    const effects = [main];
    if (onStrong && sec.effects.includes('flash') && main !== 'flash') effects.push('flash');
    const slot = { start: Math.round(s.start * 1000) / 1000, dur, effects: effects.filter((e) => e !== 'none') };
    if (wantPhoto) {
      let p = photos[photoIdx % photos.length];
      if (p === lastPhoto && photos.length > 1) p = photos[++photoIdx % photos.length];
      photoIdx++;
      lastPhoto = p;
      return { ...slot, kind: 'photo', photo: p };
    }
    lastPhoto = null;
    // Next piece of footage: the next extract in turn, from where it was left; a used-up extract starts over
    const i = clipIdx;
    clipIdx = (clipIdx + 1) % clips.length;
    const c = clips[i];
    if (cursors[i] + dur > c.end_ms / 1000 + 1e-6) cursors[i] = c.start_ms / 1000;
    const from = cursors[i]; // an extract shorter than the slot: from its start (the cut runs a little past its end)
    cursors[i] = from + dur + EDIT.clipGapS;
    const piece = { ...slot, kind: 'video', youtube_id: c.youtube_id, from_s: Math.round(from * 1000) / 1000 };
    if (Number.isFinite(c.crop_x)) piece.crop_x = Math.min(1, Math.max(0, c.crop_x));
    return piece;
  });

  const texts = (template.texts ?? []).filter((t) => t.beat < win.length).map((t, i, all) => {
    const start = win.times[t.beat];
    const next = i + 1 < all.length ? win.times[all[i + 1].beat] : duration;
    const end = Math.min(next, timeAt(win.times, t.beat + EDIT.textBeats), duration);
    return { text: t.text, start: Math.round(start * 1000) / 1000, dur: Math.round(Math.max(0.4, end - start) * 1000) / 1000 };
  });
  return {
    duration: Math.round(duration * 1000) / 1000,
    music: { track_id: template.track_id, start_s: win.t0, duration: Math.round(duration * 1000) / 1000 },
    grade: template.recipe.grade,
    font: template.font ?? 'anton',
    slots: out,
    texts,
  };
}

// --- textes du montage (sous-titres ASS) -------------------------------------------------------------

const assTime = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/**
 * Fichier ASS des textes : grands, en capitales, centrés un peu au-dessus du milieu, avec un effet « pop » à l'apparition.
 * `font` : entrée de fonts.json ({ ass_name }).
 */
export function editAss({ texts, size, font }) {
  const fs = Math.round(size.h * 0.085);
  const outline = Math.max(2, Math.round(size.h * 0.004));
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${size.w}`,
    `PlayResY: ${size.h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Edit,${font?.ass_name ?? 'Anton Regular'},${fs},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${outline},${Math.round(outline / 2)},5,${Math.round(size.w * 0.08)},${Math.round(size.w * 0.08)},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const y = Math.round(size.h * 0.42);
  const lines = (texts ?? []).map(
    (t) => `Dialogue: 0,${assTime(t.start)},${assTime(t.start + t.dur)},Edit,,0,0,0,,{\\an5\\pos(${Math.round(size.w / 2)},${y})\\fad(40,120)\\fscx135\\fscy135\\t(0,140,\\fscx100\\fscy100)}${assEscape(String(t.text).toUpperCase())}`,
  );
  return `${[...head, ...lines].join('\n')}\n`;
}
