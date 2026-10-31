// Cœur du studio de clips, sans dépendance au navigateur ni à Node : il est utilisé par l'éditeur (aperçu en direct) ET par le
// serveur (rendu ffmpeg). Une seule source de vérité pour les horaires des mots, le découpage en groupes et les styles :
// ce qu'on voit dans l'aperçu est ce qui est incrusté dans la vidéo.
//
// Vocabulaire : « lignes » = segments de la transcription ({ start_ms, end_ms, text }), « extraits » = plages de lignes choisies
// ({ start_ms, end_ms }), « mots » = mots horodatés de la ligne du clip final (en secondes, sur la durée du clip).

// Repère unique des tailles (police, contour, position) : 1080 × 1920, quelle que soit la qualité de sortie.
// La « taille » d'un style est la taille d'em du texte, comme une font-size CSS : libass, lui, dessine un texte de taille ASS N avec
// une em de N × em_ratio (propre à chaque police, mesuré) : buildAss convertit, ce qui rend l'aperçu fidèle à la vidéo.
import { sanitizeDesign } from './endcard.js';
import { isStopWord } from './stopwords.js';

export const OUT = { w: 1080, h: 1920 };
export const LIMITS = { maxExtracts: 4, minExtractS: 3, maxTotalS: 90 };
export const MODES = ['words', 'one', 'phrase', 'karaoke'];

// --- niveaux : le parcours du studio selon l'aisance de la personne ------------------------------------------------------------------
// « avance » est le parcours complet ; « debutant » garde l'essentiel (extraits proposés par l'IA, style des sous-titres, musique, format)
// et retire les outils fins (passage libre, durée, polices, volumes, logo, miroir, écran de fin…).
export const LEVELS = ['debutant', 'avance'];
export const sanitizeLevel = (v) => (LEVELS.includes(v) ? v : null);

/** Étapes de l'éditeur, dans l'ordre (l'étape 1, le choix de l'interview, précède : c'est la page d'accueil du studio). `adv` : réservée au niveau avancé. */
export const FLOW = [
  { id: 'niveau', label: 'Niveau' },
  { id: 'extraits', label: 'Extrait' },
  { id: 'style', label: 'Sous-titres' },
  { id: 'musique', label: 'Musique' },
  { id: 'cadrage', label: 'Format' },
  { id: 'fin', label: 'Écran de fin', adv: true },
  { id: 'creer', label: 'Créer' },
];
/** Étapes de l'éditeur pour un niveau (niveau inconnu : le parcours simple, plus court). */
export const stepsFor = (level) => FLOW.filter((st) => !st.adv || level === 'avance');
/** Libellés de la barre des étapes, interview comprise : « Interview », « Niveau », « Extrait »… */
export const stepLabels = (level) => ['Interview', ...stepsFor(level).map((st) => st.label)];

/**
 * Réglages d'habillage que le parcours débutant masque : ils sont remis à des valeurs simples pendant qu'il est actif (la
 * personne ne peut ni les voir ni les changer), puis rétablis si elle repasse en avancé.
 */
export const BEGINNER_DEFAULTS = { mirror: false, logoOn: false, endCardOn: false, quality: 'hd', musicVolume: 0.25, voice: 1 };

/** Styles « classiques TikTok » : chacun fixe le comportement (mode) et des valeurs de départ, toutes modifiables ensuite. */
export const PRESETS = {
  hormozi: {
    label: 'Mots en surbrillance',
    hint: 'Quelques mots à la fois, le mot prononcé s’allume',
    style: { mode: 'words', wordsPerGroup: 3, font: 'anton', size: 100, color: '#FFFFFF', highlight: '#FFE600', outline: 10, outlineColor: '#000000', shadow: 0, box: false, uppercase: true, animation: 'pop', y: 0.62 },
  },
  'un-mot': {
    label: 'Un mot à la fois',
    hint: 'Un seul mot à la fois, très rythmé',
    style: { mode: 'one', wordsPerGroup: 1, font: 'montserrat', size: 128, color: '#FFFFFF', highlight: '#FFFFFF', outline: 12, outlineColor: '#000000', shadow: 0, box: false, uppercase: true, animation: 'pop', y: 0.6 },
  },
  karaoke: {
    label: 'Karaoké',
    hint: 'La phrase se remplit au rythme de la voix',
    style: { mode: 'karaoke', wordsPerGroup: 6, font: 'poppins', size: 66, color: '#FFFFFF', highlight: '#25F4EE', outline: 8, outlineColor: '#000000', shadow: 0, box: false, uppercase: false, animation: 'none', y: 0.66 },
  },
  classique: {
    label: 'Classique',
    hint: 'Blanc cerné de noir, phrase par phrase',
    style: { mode: 'phrase', wordsPerGroup: 7, font: 'montserrat', size: 62, color: '#FFFFFF', highlight: '#FFFFFF', outline: 8, outlineColor: '#000000', shadow: 2, box: false, uppercase: false, animation: 'none', y: 0.68 },
  },
  boite: {
    label: 'Sur fond sombre',
    hint: 'Texte sur un bandeau semi-transparent',
    style: { mode: 'phrase', wordsPerGroup: 7, font: 'inter', size: 56, color: '#FFFFFF', highlight: '#FFFFFF', outline: 0, outlineColor: '#000000', shadow: 0, box: true, boxColor: '#000000', boxOpacity: 0.62, uppercase: false, animation: 'none', y: 0.7 },
  },
};

export const DEFAULT_PRESET = 'hormozi';
export const DEFAULT_STYLE = {
  preset: DEFAULT_PRESET,
  ...PRESETS[DEFAULT_PRESET].style,
  boxColor: '#000000',
  boxOpacity: 0.62,
  boxRadius: 0.35, // arrondi du fond : 0 = angles droits, 1 = bords entièrement ronds (moitié de la hauteur d'une ligne)
  x: 0.5,
  maxWidth: 0.86,
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const color = (v, dflt) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : dflt);

/**
 * Style complet et sûr à partir d'une saisie quelconque : valeurs bornées, couleurs valides, police connue.
 * `fontIds` : identifiants de polices autorisés (la première sert de repli).
 */
export function sanitizeStyle(input = {}, fontIds = []) {
  const s = input && typeof input === 'object' ? input : {};
  const preset = PRESETS[s.preset] ? s.preset : DEFAULT_PRESET;
  const base = { ...DEFAULT_STYLE, ...PRESETS[preset].style };
  const mode = MODES.includes(s.mode) ? s.mode : base.mode;
  return {
    preset,
    mode,
    font: fontIds.includes(s.font) ? s.font : fontIds.includes(base.font) ? base.font : (fontIds[0] ?? base.font),
    size: Math.round(clamp(s.size, 30, 220, base.size)),
    color: color(s.color, base.color),
    highlight: color(s.highlight, base.highlight),
    outline: Math.round(clamp(s.outline, 0, 24, base.outline) * 10) / 10,
    outlineColor: color(s.outlineColor, base.outlineColor),
    shadow: Math.round(clamp(s.shadow, 0, 12, base.shadow) * 10) / 10,
    box: typeof s.box === 'boolean' ? s.box : base.box,
    boxColor: color(s.boxColor, base.boxColor),
    boxOpacity: Math.round(clamp(s.boxOpacity, 0, 1, base.boxOpacity) * 100) / 100,
    boxRadius: Math.round(clamp(s.boxRadius, 0, 1, base.boxRadius) * 100) / 100,
    uppercase: typeof s.uppercase === 'boolean' ? s.uppercase : base.uppercase,
    wordsPerGroup: mode === 'one' ? 1 : Math.round(clamp(s.wordsPerGroup, 1, 10, base.wordsPerGroup)),
    animation: s.animation === 'pop' || s.animation === 'none' ? s.animation : base.animation,
    x: Math.round(clamp(s.x, 0.1, 0.9, 0.5) * 1000) / 1000,
    y: Math.round(clamp(s.y, 0.1, 0.9, base.y) * 1000) / 1000,
    maxWidth: Math.round(clamp(s.maxWidth, 0.4, 0.96, 0.86) * 100) / 100,
  };
}

// --- mots horodatés --------------------------------------------------------------------------

const SENTENCE_END = /[.!?…]["»”')\]]*$/;
const PAUSE = /[,;:]["»”')\]]*$/;

/** Poids d'un mot pour répartir la durée d'une ligne : sa longueur (la parole est à peu près proportionnelle), plus une pause après la ponctuation. */
function weight(token) {
  const letters = token.replace(/[^\p{L}\p{N}]/gu, '').length;
  return Math.max(2, letters) + (SENTENCE_END.test(token) ? 3 : PAUSE.test(token) ? 1.5 : 0);
}

/**
 * Mots horodatés du clip final. `lines` : [{ start_ms, end_ms, text }] ; `extracts` : [{ start_ms, end_ms }] (bornes au millième de
 * seconde, pas forcément alignées sur les lignes). Les extraits sont mis bout à bout. Renvoie
 * { words: [{ text, start, end, line }], duration, segments: [{ offset, length }] } (secondes, sur la durée du clip final ;
 * `line` numérote les lignes d'origine).
 * Les mots d'une ligne sont répartis sur toute la durée de la ligne, puis on ne garde que ceux qui tombent dans l'extrait : une ligne
 * coupée au milieu ne montre que les mots réellement dits dans la partie conservée, sans que le reste soit comprimé.
 */
export function wordsForExtracts(lines, extracts) {
  const words = [];
  const segments = [];
  let offset = 0;
  let lineNo = 0;
  for (const ex of extracts) {
    const length = (ex.end_ms - ex.start_ms) / 1000;
    segments.push({ offset, length });
    const from = ex.start_ms / 1000;
    const to = ex.end_ms / 1000;
    for (const ln of lines) {
      if (ln.end_ms <= ex.start_ms || ln.start_ms >= ex.end_ms) continue;
      const tokens = String(ln.text ?? '').split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const s = ln.start_ms / 1000;
      const e = ln.end_ms / 1000;
      const ws = tokens.map(weight);
      const total = ws.reduce((a, b) => a + b, 0);
      let acc = 0;
      let kept = 0;
      tokens.forEach((text, i) => {
        const a = s + ((e - s) * acc) / total;
        acc += ws[i];
        const b = s + ((e - s) * acc) / total;
        if ((a + b) / 2 < from || (a + b) / 2 >= to) return; // mot dit hors de l'extrait
        words.push({ text, start: offset + (Math.max(a, from) - from), end: offset + (Math.min(b, to) - from), line: lineNo });
        kept++;
      });
      if (kept) lineNo++;
    }
    offset += length;
  }
  return { words, duration: offset, segments };
}

/** Découpe un tableau en `parts` morceaux de tailles proches. */
function balanced(arr, max) {
  const parts = Math.ceil(arr.length / max);
  const size = Math.ceil(arr.length / parts);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Groupes de mots affichés ensemble : { start, end, words }. Selon le mode : N mots (« words »), un mot (« one »), ou une phrase
 * découpée en blocs d'au plus N mots (« phrase », « karaoke »). Un groupe ne chevauche jamais deux lignes d'origine ni une fin de phrase.
 */
export function groupWords(words, style) {
  const n = style.mode === 'one' ? 1 : Math.max(1, style.wordsPerGroup);
  const groups = [];
  if (style.mode === 'words' || style.mode === 'one') {
    let cur = [];
    const flush = () => {
      if (cur.length) groups.push(cur);
      cur = [];
    };
    words.forEach((w, i) => {
      if (cur.length && (cur.length >= n || cur[0].line !== w.line)) flush();
      cur.push(w);
      if (SENTENCE_END.test(w.text) || i === words.length - 1) flush();
    });
    flush();
  } else {
    const byLine = new Map();
    for (const w of words) byLine.set(w.line, [...(byLine.get(w.line) ?? []), w]);
    for (const lineWords of byLine.values()) groups.push(...balanced(lineWords, n));
  }
  // un groupe reste affiché jusqu'au suivant s'il n'y a qu'une courte pause (pas de clignotement), au plus 0,35 s sinon
  return groups.map((ws, i) => {
    const start = ws[0].start;
    const natural = ws.at(-1).end;
    const next = groups[i + 1]?.[0].start;
    const end = next != null ? Math.min(next, natural + 0.35) : natural + 0.2;
    return { start, end: Math.max(end, natural), words: ws };
  });
}

/** Groupe (et mot actif) à l'instant t, pour l'aperçu. */
export function activeAt(groups, t) {
  const g = groups.find((x) => t >= x.start && t < x.end);
  if (!g) return null;
  let active = -1;
  g.words.forEach((w, i) => {
    if (t >= w.start) active = i;
  });
  return { group: g, active };
}

/** Mots d'un texte, comparables : minuscules, sans accents, ponctuation ni pluriel (« dépense » = « dépenses »). */
const comparable = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 ? w.replace(/[sx]$/, '') : w));

/**
 * Ressemblance (0 à 1) entre une ligne de la transcription et sa version corrigée : part des mots conservés dans l'ordre
 * (plus longue sous-suite commune / nombre de mots du plus long des deux). Sert à signaler une correction qui s'éloigne
 * beaucoup de ce qui est dit ; 1 = identique (à la casse, aux accents et à la ponctuation près).
 */
export function lineSimilarity(original, edited) {
  const a = comparable(original);
  const b = comparable(edited);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length] / Math.max(a.length, b.length);
}

/** Seuil en dessous duquel une ligne corrigée est signalée comme s'écartant de la transcription. */
export const SIMILARITY_WARNING = 0.6;

export const displayText = (text, style) => (style.uppercase ? text.toLocaleUpperCase('fr-FR') : text);

/** Largeur utilisable du texte (en px du repère 1080) : jamais au-delà de l'écran, même déplacé vers un bord. */
export const usableWidth = (style) => Math.min(style.maxWidth, 2 * Math.min(style.x, 1 - style.x)) * OUT.w;

/** Marge entre le texte et le bord du fond (px du repère 1080). */
export const boxPad = (style) => Math.round(style.size * 0.28);

/**
 * Facteur de réduction (≤ 1) d'un groupe de mots : un seul mot trop long ne peut pas passer à la ligne et déborderait de l'écran.
 * Estimation avec la largeur d'une capitale de la police (`cap_em`, mesurée avec libass) ; identique pour l'aperçu et le rendu.
 */
export function fitScale(texts, style, font) {
  const longest = Math.max(1, ...texts.map((t) => [...t].length));
  const pad = style.box ? boxPad(style) * 2 : style.outline * 2;
  const text = longest * style.size * (font?.cap_em ?? 0.62) * (style.uppercase ? 0.98 : 0.85);
  const usable = usableWidth(style);
  // le contour (ou les marges du fond) ne rétrécit pas avec le texte : on ne réduit que la part « texte »
  return text + pad > usable ? Math.max(0.45, (usable - pad) / text) : 1;
}

// --- sous-titres ASS ----------------------------------------------------------------------------

const hex2 = (n) => Math.round(n).toString(16).toUpperCase().padStart(2, '0');
/** « #RRGGBB » -> « &HAABBGGRR » (alpha 00 = opaque). */
export function assColor(hex, alpha = 0) {
  const h = HEX.test(hex) ? hex : '#FFFFFF';
  return `&H${hex2(alpha)}${h.slice(5, 7)}${h.slice(3, 5)}${h.slice(1, 3)}`.toUpperCase();
}
const assTag = (hex) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();

export function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Texte sûr pour ASS : pas d'accolades ni de retours à la ligne ni d'antislash. */
export const assEscape = (t) => String(t).replace(/\\/g, '/').replace(/[{}]/g, '').replace(/[\r\n]+/g, ' ');

// Strictest caption limit among TikTok's posting API and Instagram Reels
export const DESCRIPTION_MAX = 2200;

// Lien ajouté à la fin de chaque description de vidéo
export const DISCORD_URL = 'https://discord.gg/lisnard2027';

/** Pied de la description : le lien du Discord, puis le crédit de la musique quand sa licence en demande un. */
export const descriptionFooter = (song) => [`Rejoins-nous sur Discord : ${DISCORD_URL}`, song?.credit ? `Musique : ${song.title} — ${song.credit}` : ''].filter(Boolean).join('\n');

const foldText = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Ligne de source à citer dans la description de la vidéo : titre et date de l'interview d'origine. */
export function sourceText(title, publishedAt) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  let date = '';
  if (publishedAt) {
    const [y, m, d] = String(publishedAt).slice(0, 10).split('-').map(Number);
    date = y ? new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  }
  // Skip the date when the title already contains it
  const dayMonth = date.split(' ').slice(0, 2).join(' ');
  if (dayMonth && new RegExp(`(^|\\D)${foldText(dayMonth)}`).test(foldText(t).replace(/\b1er\b/g, '1'))) date = '';
  return `Source : ${t || 'interview'}${date ? ` · ${date}` : ''}`;
}

// End card palette and layout borrowed from the PostLisnard visuals (navy background, khaki rules)
export const END_CARD = { minS: 2, maxS: 5, defaultS: 3, maxText: 120, bg: '#032F67', accent: '#A0A37E', pad: 110 };

export function sanitizeEndCard(input) {
  const c = input && typeof input === 'object' ? input : null;
  if (!c || c.on !== true) return null;
  const text = String(c.text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, END_CARD.maxText);
  const source = c.source !== false;
  const image = typeof c.image === 'string' && /^[0-9a-f]{40}$/.test(c.image) ? c.image : null;
  if (!text && !source && !image) return null;
  const d = Math.round(Number(c.dur));
  const card = { on: true, source, text, dur: Number.isFinite(d) ? Math.min(END_CARD.maxS, Math.max(END_CARD.minS, d)) : END_CARD.defaultS };
  // A visual drawn in the browser: the image is rendered as is, its settings are kept for « Modifier »
  if (image) Object.assign(card, { image, design: c.design ? sanitizeDesign(c.design) : null });
  return card;
}

// Without a custom message the source line becomes the main text
export function endCardContent(card, sourceLine) {
  if (!card) return null;
  const src = card.source ? String(sourceLine ?? '').trim() : '';
  return card.text ? { title: card.text, foot: src } : { title: src, foot: '', small: true };
}

export function fitDescription(caption, source, max = DESCRIPTION_MAX) {
  const cap = String(caption ?? '').trim();
  const src = String(source ?? '').trim();
  if (!cap) return src.slice(0, max);
  if (!src) return cap.length > max ? `${cap.slice(0, max - 1).trimEnd()}…` : cap;
  const room = max - src.length - 2;
  if (room <= 1) return src.slice(0, max);
  const fitted = cap.length > room ? `${cap.slice(0, room - 1).trimEnd()}…` : cap;
  return `${fitted}\n\n${src}`;
}

const ASS_HEAD = (W, H) => [
  '[Script Info]',
  'ScriptType: v4.00+',
  `PlayResX: ${W}`,
  `PlayResY: ${H}`,
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
];
const ASS_EVENTS = ['', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];

/** Le fond (coins droits ou arrondis) est dessiné par nos soins, d'un seul tenant : pas de double teinte là où deux lignes se chevauchent. */
export const roundedBox = (style) => Boolean(style.box);

/**
 * Tracé du fond : un rectangle aux coins arrondis par ligne de texte, en un seul tracé (les lignes qui se chevauchent forment une seule
 * forme, remplie d'une seule teinte). `radius` : 0 (angles droits) à 1 (bords entièrement ronds = moitié de la hauteur de la ligne).
 * Même tracé pour ASS (`kind` 'ass') et pour l'aperçu SVG (`kind` 'svg').
 */
export function boxPath(rects, radius, kind = 'ass') {
  const f = (n) => Math.round(n * 10) / 10;
  const [M, L, C, Z] = kind === 'svg' ? ['M', 'L', 'C', ' Z'] : ['m', 'l', 'b', ''];
  return rects
    .map(({ x0, y0, x1, y1 }) => {
      const r = Math.max(0, Math.min(radius * ((y1 - y0) / 2), (x1 - x0) / 2, (y1 - y0) / 2));
      const c = 0.5523 * r;
      return [
        `${M} ${f(x0 + r)} ${f(y0)} ${L} ${f(x1 - r)} ${f(y0)}`,
        `${C} ${f(x1 - r + c)} ${f(y0)} ${f(x1)} ${f(y0 + r - c)} ${f(x1)} ${f(y0 + r)} ${L} ${f(x1)} ${f(y1 - r)}`,
        `${C} ${f(x1)} ${f(y1 - r + c)} ${f(x1 - r + c)} ${f(y1)} ${f(x1 - r)} ${f(y1)} ${L} ${f(x0 + r)} ${f(y1)}`,
        `${C} ${f(x0 + r - c)} ${f(y1)} ${f(x0)} ${f(y1 - r + c)} ${f(x0)} ${f(y1 - r)} ${L} ${f(x0)} ${f(y0 + r)}`,
        `${C} ${f(x0)} ${f(y0 + r - c)} ${f(x0 + r - c)} ${f(y0)} ${f(x0 + r)} ${f(y0)}${Z}`,
      ].join(' ');
    })
    .join(' ');
}

/** Position horizontale/verticale du bloc et marge latérale (largeur maximale du texte, sans jamais dépasser de l'écran). */
const placement = (style) => ({
  cx: Math.round(style.x * OUT.w),
  cy: Math.round(style.y * OUT.h),
  margin: Math.max(0, Math.round((OUT.w - usableWidth(style)) / 2)),
});
const fontSizeFor = (style, f) => Math.round(style.size / (f?.em_ratio ?? 1)); // taille d'em -> taille ASS

/** Réduction d'un mot trop long : le « pop » (grossit puis se pose) part de 72 % et finit à la taille normale réduite de k. */
const scaleTags = (k, popped) => {
  const pc = (v) => Math.round(v * k);
  if (popped) return `\\fscx${pc(72)}\\fscy${pc(72)}\\t(0,90,\\fscx${pc(106)}\\fscy${pc(106)})\\t(90,170,\\fscx${pc(100)}\\fscy${pc(100)})`;
  return k < 1 ? `\\fscx${pc(100)}\\fscy${pc(100)}` : '';
};

/** Mesure du fond arrondi : le bloc est écrit au centre de l'image ; seule une bande centrale est relue (toute l'image pour de très grands textes). */
export const PROBE = { y: OUT.h / 2 };
export const probeBand = (style) => (style.size > 120 ? OUT.h : 1400);

/**
 * Fichier ASS « de mesure » : chaque groupe (une image par seconde, dans l'ordre) est écrit exactement comme dans le clip, avec un
 * fond rectangulaire de 1 px de marge. Rendu par libass, il donne la position exacte de chaque ligne (retours à la ligne compris),
 * dont on tire les rectangles du fond arrondi. Aucun calcul de largeur de texte « à la main » : c'est libass qui mesure.
 */
export function buildProbeAss({ groups, style, font }) {
  const { cx, margin } = placement(style);
  const out = [...ASS_HEAD(OUT.w, OUT.h)];
  out.push(`Style: Probe,${font.ass_name},${fontSizeFor(style, font)},&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,3,1,0,5,${margin},${margin},0,1`, ...ASS_EVENTS);
  groups.forEach((g, i) => {
    const texts = g.words.map((w) => assEscape(displayText(w.text, style)));
    const k = fitScale(texts, style, font);
    out.push(`Dialogue: 0,${assTime(i)},${assTime(i + 1)},Probe,,0,0,0,,{\\an5\\pos(${cx},${PROBE.y})${scaleTags(k, false)}}${texts.join(' ')}`);
  });
  return `${out.join('\n')}\n`;
}

/**
 * Fichier ASS complet. `font` : { ass_name, em_ratio, cap_em } de la police choisie.
 * `boxes` : pour le fond, les rectangles de chaque groupe (mesurés par libass, relatifs au centre du bloc) ; sans eux, le fond est
 * le rectangle de libass (angles droits). Les positions et tailles sont exprimées dans le repère 1080 × 1920 : libass les adapte à la
 * définition de sortie.
 */
const endCardStyles = (font) => [
  `Style: EndTitle,${font.ass_name},108,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,${END_CARD.pad},${END_CARD.pad},0,1`,
  `Style: EndSmall,${font.ass_name},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,${END_CARD.pad},${END_CARD.pad},0,1`,
  `Style: EndFoot,${font.ass_name},42,${assColor('#FFFFFF', 40)},&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,${END_CARD.pad},${END_CARD.pad},0,1`,
];

// Plain background comes from ffmpeg; libass draws the rules and the text
function endCardEvents({ start, end, title, foot, small }) {
  const t0 = assTime(start);
  const t1 = assTime(end);
  const rule = (y, w) => `Dialogue: 2,${t0},${t1},EndTitle,,0,0,0,,{\\an7\\pos(${END_CARD.pad},${y})\\1c${assTag(END_CARD.accent)}\\bord0\\shad0\\fad(250,0)\\p1}m 0 0 l ${w} 0 l ${w} 12 l 0 12`;
  const ev = [rule(560, 170)];
  if (title) ev.push(`Dialogue: 3,${t0},${t1},${small ? 'EndSmall' : 'EndTitle'},,0,0,0,,{\\an7\\pos(${END_CARD.pad},620)\\fad(250,0)}${assEscape(small ? title : title.toLocaleUpperCase('fr-FR'))}`);
  if (foot) {
    ev.push(rule(1480, 110));
    ev.push(`Dialogue: 3,${t0},${t1},EndFoot,,0,0,0,,{\\an1\\pos(${END_CARD.pad},${OUT.h - 240})\\fad(250,0)}${assEscape(foot)}`);
  }
  return ev;
}

export function buildAss({ groups, style, font, boxes, endCard = null }) {
  const { cx, cy, margin } = placement(style);
  const boxed = style.box;
  const drawn = roundedBox(style) && Array.isArray(boxes); // fond dessiné d'après la mesure de libass, plutôt que le rectangle (par ligne) de libass
  const outline = boxed ? boxPad(style) : style.outline;
  const outlineCol = boxed ? assColor(style.boxColor, (1 - style.boxOpacity) * 255) : assColor(style.outlineColor);
  const primary = style.mode === 'karaoke' ? style.highlight : style.color; // karaoké : « rempli » = couleur d'accent
  const secondary = style.color;
  const shadowCol = assColor('#000000', 90);

  const out = [...ASS_HEAD(OUT.w, OUT.h)];
  out.push(
    `Style: Main,${font.ass_name},${fontSizeFor(style, font)},${assColor(primary)},${assColor(secondary)},${outlineCol},${shadowCol},0,0,0,0,100,100,0,0,${boxed && !drawn ? 3 : 1},${drawn ? 0 : outline},${boxed ? 0 : style.shadow},5,${margin},${margin},0,1`,
  );
  if (endCard) out.push(...endCardStyles(endCard.font));
  out.push(...ASS_EVENTS);
  const pos = `{\\an5\\pos(${cx},${cy})`;
  // fond (couche 0) sous le texte (couche 1)
  const dlg = (start, end, text, first, k) =>
    out.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Main,,0,0,0,,${pos}${scaleTags(k, first && style.animation === 'pop')}}${text}`);
  const boxFill = `\\1c${assTag(style.boxColor)}\\1a&H${hex2((1 - style.boxOpacity) * 255)}&`;

  groups.forEach((g, gi) => {
    const texts = g.words.map((w) => assEscape(displayText(w.text, style)));
    const k = fitScale(texts, style, font);
    const rects = drawn ? boxes[gi] : null;
    if (rects?.length) {
      // coordonnées relatives au centre du bloc : l'échelle du « pop » s'applique autour de ce centre, comme pour le texte
      const pop = style.animation === 'pop' ? scaleTags(1, true) : '';
      out.push(`Dialogue: 0,${assTime(g.start)},${assTime(g.end)},Main,,0,0,0,,{\\an7\\pos(${cx},${cy})\\bord0\\shad0${boxFill}${pop}\\p1}${boxPath(rects, style.boxRadius)}`);
    }
    if (style.mode === 'phrase') {
      dlg(g.start, g.end, texts.join(' '), true, k);
    } else if (style.mode === 'karaoke') {
      // \k : durée (centisecondes) de remplissage de chaque mot ; le dernier va jusqu'à la fin du groupe
      const parts = g.words.map((w, i) => {
        const until = i + 1 < g.words.length ? g.words[i + 1].start : g.end;
        return `{\\k${Math.max(1, Math.round((until - w.start) * 100))}}${texts[i]}`;
      });
      dlg(g.start, g.end, parts.join(' '), true, k);
    } else {
      // mots / un mot : un événement par mot ; le mot actif prend la couleur d'accent
      g.words.forEach((w, i) => {
        const start = i === 0 ? g.start : w.start;
        const end = i + 1 < g.words.length ? g.words[i + 1].start : g.end;
        const text = texts.map((t, j) => (j === i && style.mode === 'words' ? `{\\1c${assTag(style.highlight)}}${t}{\\1c${assTag(style.color)}}` : t)).join(' ');
        dlg(start, Math.max(end, start + 0.04), text, i === 0, k);
      });
    }
  });
  if (endCard) out.push(...endCardEvents(endCard));
  return `${out.join('\n')}\n`;
}

// --- effets : zooms et images ---------------------------------------------------------------------------------------------
//
// Les zooms sont décrits par des événements « zoom avant » / « zoom arrière » : chacun fait glisser le niveau de zoom, en douceur
// (courbe en S, vitesse nulle au départ et à l'arrivée), depuis le niveau atteint à cet instant vers le niveau cible. Le mouvement est
// donc continu quoi qu'on enchaîne. Aperçu (navigateur) et rendu (ffmpeg) calculent exactement la même courbe : `zoomAt` ci-dessous
// pour l'un, `zoomFilter` (même formule écrite en expression ffmpeg) pour l'autre.
//
// Pourquoi pas le filtre « zoompan » de ffmpeg : il déplace sa fenêtre par pas entiers de pixels, d'où les saccades bien connues.
// Ici le filtre `perspective` place les coins de la fenêtre source en nombres décimaux (interpolation de l'image au sous-pixel) :
// écart mesuré avec la courbe idéale inférieur à 0,2 px, sans à-coup.

export const FPS = 30; // le rendu impose 30 images par seconde : les expressions ffmpeg comptent les images, pas les secondes
export const ZOOM = {
  strengths: { light: 1.1, medium: 1.2, strong: 1.32 },
  rampIn: 0.5, // durée d'un zoom avant (s)
  rampOut: 0.7, // durée d'un zoom arrière (s)
  holdAuto: 1.3, // un zoom automatique reste en place ce temps avant de revenir (s)
  minGap: 0.5, // écart minimal entre deux événements (s)
  maxEvents: 40,
  focus: { x: 0.5, y: 0.42 }, // point sur lequel on zoome (fractions de l'écran) : à hauteur de visage dans une interview
};
export const BROLL = { maxItems: 8, minS: 1, maxS: 8, defaultS: 2.5, fade: 0.18, kenBurns: 0.08 };

const smooth = (p) => {
  const c = Math.min(1, Math.max(0, p));
  return c * c * (3 - 2 * c);
};
const r2 = (n) => Math.round(n * 100) / 100;

/** Réglages de zoom sûrs : force bornée, point de zoom dans l'écran, événements triés, à écart minimal. */
export function sanitizeZoom(input = {}, total = Infinity) {
  const z = input && typeof input === 'object' ? input : {};
  const strength = r2(clamp(z.strength, 1.05, 1.5, ZOOM.strengths.medium));
  const focus = { x: r2(clamp(z.focus?.x, 0.1, 0.9, ZOOM.focus.x)), y: r2(clamp(z.focus?.y, 0.1, 0.9, ZOOM.focus.y)) };
  const raw = Array.isArray(z.events) ? z.events : [];
  const events = [];
  for (const e of [...raw].sort((a, b) => Number(a?.t) - Number(b?.t))) {
    const t = r2(Number(e?.t));
    if (!Number.isFinite(t) || t < 0 || t > total) continue;
    const kind = e.kind === 'out' ? 'out' : e.kind === 'in' ? 'in' : null;
    if (!kind) continue;
    if (events.length && t - events.at(-1).t < ZOOM.minGap - 1e-9) continue;
    events.push({ t, kind });
    if (events.length >= ZOOM.maxEvents) break;
  }
  return { strength, focus, events };
}

/** Plan des transitions : [{ t, from, to, dur }] où `from` est le niveau atteint à l'instant t par les transitions précédentes. */
export function zoomPlan(events, strength) {
  const plan = [];
  for (const e of events) {
    const seg = { t: e.t, from: 1, to: e.kind === 'in' ? strength : 1, dur: e.kind === 'in' ? ZOOM.rampIn : ZOOM.rampOut };
    seg.from = zoomAt(plan, e.t);
    plan.push(seg);
  }
  return plan;
}

/** Niveau de zoom (1 = aucun) à l'instant t (secondes du clip). */
export function zoomAt(plan, t) {
  let seg = null;
  for (const s of plan) {
    if (s.t <= t) seg = s;
    else break;
  }
  return seg ? seg.from + (seg.to - seg.from) * smooth((t - seg.t) / seg.dur) : 1;
}

/** Fenêtre source (fractions de l'image) pour un niveau de zoom et un point de zoom : le point est suivi tant que la fenêtre reste dans l'image. */
export function zoomRect(z, focus) {
  const half = 0.5 / z;
  const cx = Math.min(1 - half, Math.max(half, focus.x));
  const cy = Math.min(1 - half, Math.max(half, focus.y));
  return { x0: cx - half, x1: cx + half, y0: cy - half, y1: cy + half };
}

/** Origine de la mise à l'échelle CSS (fractions) qui donne la même image que `zoomRect` (aperçu du navigateur). */
export function zoomOrigin(z, focus) {
  if (z <= 1 + 1e-9) return { x: 0.5, y: 0.5 };
  const { x0, y0 } = zoomRect(z, focus);
  return { x: (-x0 * z) / (1 - z), y: (-y0 * z) / (1 - z) };
}

/** Périodes [début, fin] pendant lesquelles le zoom n'est pas à 1 (le filtre n'est actif que là : le reste du clip n'est pas retraité). */
export function zoomWindows(plan, total) {
  if (!plan.length) return [];
  const marks = new Set([0, total]);
  for (const s of plan) {
    marks.add(s.t);
    marks.add(Math.min(total, s.t + s.dur));
  }
  const pts = [...marks].filter((m) => m >= 0 && m <= total).sort((a, b) => a - b);
  const wins = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const mid = (a + b) / 2;
    const moving = plan.some((s) => mid >= s.t && mid < s.t + s.dur && s.from !== s.to);
    if (moving || zoomAt(plan, mid) > 1 + 1e-9) {
      if (wins.length && Math.abs(wins.at(-1)[1] - a) < 1e-9) wins.at(-1)[1] = b;
      else wins.push([a, b]);
    }
  }
  return wins;
}

const num = (n) => String(Math.round(n * 1e6) / 1e6);

/**
 * Filtre ffmpeg `perspective` qui réalise le zoom, avec la même courbe que `zoomAt`. Le temps vient du compteur d'images (`in`,
 * qui vaut 1 pour la première image) divisé par FPS, donc sans aucune dérive. Il n'est actif (`enable`) que pendant les périodes
 * où l'image bouge ou reste zoomée : le reste du clip n'est pas retraité. Aucun zoom : chaîne vide.
 */
export function zoomFilter(plan, focus, total) {
  const wins = zoomWindows(plan, total);
  if (!wins.length) return '';
  const T = `((in-1)/${FPS})`;
  // niveau de zoom en fonction du temps : 1 avant le 1er événement, puis le segment du dernier événement commencé
  let z = null;
  for (let i = plan.length - 1; i >= 0; i--) {
    const s = plan[i];
    const seg = `(st(0,clip((${T}-${num(s.t)})/${num(s.dur)},0,1));${num(s.from)}+(${num(s.to - s.from)})*ld(0)*ld(0)*(3-2*ld(0)))`;
    z = z === null ? seg : `if(lt(${T},${num(plan[i + 1].t)}),${seg},${z})`;
  }
  z = `if(lt(${T},${num(plan[0].t)}),1,${z})`;
  const prep = `st(1,0.5/(${z}))`; // ld(1) : demi-largeur de la fenêtre source (fraction de l'image)
  const center = (v) => `clip(${num(v)},ld(1),1-ld(1))`; // le point de zoom est suivi tant que la fenêtre reste dans l'image
  const corner = (size, v, sign) => `'${prep};${size}*(${center(v)}${sign}ld(1))'`;
  const x0 = corner('W', focus.x, '-');
  const x1 = corner('W', focus.x, '+');
  const y0 = corner('H', focus.y, '-');
  const y2 = corner('H', focus.y, '+');
  const enable = `'gt(${wins.map(([a, b]) => `between(t,${num(a)},${num(b)})`).join('+')},0)'`;
  return `perspective=x0=${x0}:y0=${y0}:x1=${x1}:y1=${y0}:x2=${x0}:y2=${y2}:x3=${x1}:y3=${y2}:eval=frame:interpolation=linear:enable=${enable}`;
}

/** Léger zoom lent sur une image b-roll (même courbe en S) : niveau de zoom au point p (0 à 1) de sa durée. */
export const kenBurnsAt = (p) => 1 + BROLL.kenBurns * smooth(p);

/** Filtre ffmpeg `perspective` du zoom lent d'une image b-roll de `dur` secondes (flux propre à l'image : `in` repart de 1). */
export function kenBurnsFilter(dur) {
  const prep = `st(0,clip((in-1)/${num(FPS * dur)},0,1));st(1,0.5/(1+${BROLL.kenBurns}*ld(0)*ld(0)*(3-2*ld(0))))`;
  const c = (size, sign) => `'${prep};${size}*(0.5${sign}ld(1))'`;
  const [x0, x1, y0, y2] = [c('W', '-'), c('W', '+'), c('H', '-'), c('H', '+')];
  return `perspective=x0=${x0}:y0=${y0}:x1=${x1}:y1=${y0}:x2=${x0}:y2=${y2}:x3=${x1}:y3=${y2}:eval=frame:interpolation=linear`;
}

/** Opacité d'une image b-roll à l'instant t : fondu à l'entrée et à la sortie. */
export const brollOpacity = (item, t) => {
  const into = t - item.start;
  const left = item.start + item.dur - t;
  if (into < 0 || left < 0) return 0;
  return Math.min(1, into / BROLL.fade, left / BROLL.fade);
};

// --- zooms automatiques : repérage des mots importants ----------------------------------------------------------------------

const plain = (w) =>
  String(w ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
// mots qui portent l'insistance même s'ils sont courants (chiffres et ordres de grandeur, absolus)
const EMPHASIS = new Set(
  'jamais toujours aucun aucune absolument impossible urgence urgent priorite obligatoire interdit gratuit million millions milliard milliards pourcent cent mille'.split(' '),
);

/** Note d'un mot du clip : plus elle est haute, plus le mot mérite qu'on appuie dessus (chiffre, mot rare ou long, absolu, fin de phrase). */
function wordScore(text, counts) {
  const w = plain(text);
  if (w.length < 3) return 0;
  let score = 0;
  if (/\d/.test(w)) score += 3;
  else if (EMPHASIS.has(w) || EMPHASIS.has(w.replace(/[sx]$/, ''))) score += 2.5;
  else if (isStopWord(w) || w.length < 5) return 0;
  score += w.length >= 9 ? 2 : w.length >= 7 ? 1.5 : w.length >= 5 ? 0.8 : 0;
  if (/[.!?…]["»”')\]]*$/.test(text)) score += 0.7;
  score += Math.min(1.2, 0.6 * ((counts.get(w) ?? 1) - 1)); // un mot repris plusieurs fois est le sujet de l'extrait
  return score;
}

/**
 * Zooms automatiques : un zoom avant juste avant chaque mot important, un zoom arrière après ZOOM.holdAuto secondes.
 * `words` : mots horodatés du clip (voir wordsForExtracts) ; `duration` : durée du clip (s). Les zooms sont espacés d'au moins
 * `minSep` secondes et leur nombre dépend de la durée (un tous les 6 s au plus) : un zoom partout fatigue.
 * Renvoie { events: [{ t, kind }], hints: [{ t, word }] }.
 */
export function suggestZoomPoints(words, duration, { minSep = 3.5, minScore = 1.5, max: maxCount = 10 } = {}) {
  const counts = new Map();
  for (const w of words) {
    const k = plain(w.text);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const scored = words.map((w) => ({ w, score: wordScore(w.text, counts) })).filter((x) => x.score >= minScore);
  const max = minSep < 1 ? maxCount : Math.min(maxCount, Math.max(1, Math.floor(duration / 6)));
  const chosen = [];
  for (const c of scored.sort((a, b) => b.score - a.score || a.w.start - b.w.start)) {
    const t = Math.max(0, r2(c.w.start - 0.15));
    const out = r2(t + ZOOM.rampIn + ZOOM.holdAuto);
    if (out > duration - 0.2) continue; // il faut pouvoir revenir avant la fin du clip
    if (chosen.some((o) => Math.abs(o.t - t) < minSep)) continue;
    chosen.push({ t, out, word: c.w.text.replace(/[^\p{L}\p{N}'’-]+$/gu, '') });
    if (chosen.length >= max) break;
  }
  chosen.sort((a, b) => a.t - b.t);
  return {
    events: chosen.flatMap((c) => [{ t: c.t, kind: 'in' }, { t: c.out, kind: 'out' }]),
    hints: chosen.map((c) => ({ t: c.t, word: c.word })),
  };
}

/** Mot du clip le plus proche de l'instant t (pour rappeler à l'utilisateur sur quoi porte un zoom). */
export function wordNear(words, t) {
  let best = null;
  for (const w of words) if (!best || Math.abs(w.start - t) < Math.abs(best.start - t)) best = w;
  return best && Math.abs(best.start - t) < 1.5 ? best.text.replace(/[^\p{L}\p{N}'’-]+$/gu, '') : '';
}

// Library clip settings -> editor draft (localStorage v:1 format), for « Modifier »
// Account logo: placed on a 3 × 3 grid, sized as a share of the video width, drawn during the clip only
export const LOGO = { positions: ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'], minSize: 0.08, maxSize: 0.4, defaultSize: 0.18, minOpacity: 0.3, marginX: 0.05, marginTop: 0.07, marginBottom: 0.2 };

export function sanitizeLogo(input) {
  const l = input && typeof input === 'object' ? input : null;
  if (!l || typeof l.image !== 'string' || !/^[0-9a-f]{40}$/.test(l.image)) return null;
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.round(Math.min(hi, Math.max(lo, Number(v))) * 100) / 100 : d);
  return { image: l.image, pos: LOGO.positions.includes(l.pos) ? l.pos : 'tr', size: num(l.size, LOGO.minSize, LOGO.maxSize, LOGO.defaultSize), opacity: num(l.opacity, LOGO.minOpacity, 1, 1) };
}

export function draftFromClip(req, remixOf = null) {
  const r = req && typeof req === 'object' ? req : {};
  const l = r.layout ?? {};
  const zoom = r.zoom && Array.isArray(r.zoom.events) && r.zoom.events.length ? r.zoom : null;
  return {
    v: 1,
    extracts: (Array.isArray(r.extracts) ? r.extracts : []).map((e) => ({ start_ms: e.start_ms, end_ms: e.end_ms, title: null, from: null, caption: null })),
    style: r.style ?? null,
    music: r.music ? { id: r.music.id, volume: r.music.volume } : { id: null },
    voice: r.voice,
    layout: { fit: l.fit, cropX: l.cropX, quality: l.quality, mirror: l.mirror === true, follow: { on: l.follow?.on === true, subject: l.follow?.subject } },
    zoom: zoom ? { on: true, auto: false, strength: zoom.strength, focus: zoom.focus, events: zoom.events } : { on: false },
    broll: (Array.isArray(r.broll) ? r.broll : []).map((b) => ({ id: String(b.id), start: b.start, dur: b.dur, thumb: `/api/studio/stock/image/${encodeURIComponent(b.id)}` })),
    edits: r.edits && typeof r.edits === 'object' && !Array.isArray(r.edits) ? r.edits : {},
    endCard: r.end_card ? { ...r.end_card, on: true, fromClip: r.end_card.image ? remixOf : null } : { on: false },
    jobId: null,
    delivered: false,
    remixOf,
  };
}

export const MODELS = { max: 20, nameMax: 40 };
export const DEFAULT_END_CARD = { on: false, source: true, text: '', dur: END_CARD.defaultS };

// Kept even when switched off so unticking loses nothing
export function endCardSettings(input) {
  const c = input && typeof input === 'object' ? input : {};
  // Older settings only had a message and a source switch
  const legacy = !c.design && typeof c.text === 'string' && c.text.trim() ? { template: 'headline', values: { title: c.text }, source: c.source !== false } : { source: c.source !== false };
  const d = Math.round(Number(c.dur));
  return {
    on: c.on === true,
    dur: Number.isFinite(d) ? Math.min(END_CARD.maxS, Math.max(END_CARD.minS, d)) : END_CARD.defaultS,
    design: sanitizeDesign(c.design ?? legacy),
    image: typeof c.image === 'string' && /^[0-9a-f]{40}$/.test(c.image) ? c.image : null,
    fromClip: typeof c.fromClip === 'string' && /^[0-9a-f]{24}$/.test(c.fromClip) ? c.fromClip : null,
    dirty: c.dirty === true,
  };
}

// Model = every setting that does not depend on the interview (no extracts, text edits or b-roll)
export function modelFromState(S) {
  return {
    style: S.style,
    music: { id: S.music.id ?? null, volume: S.music.volume },
    voice: S.voice,
    layout: { fit: S.layout.fit, quality: S.layout.quality, mirror: S.layout.mirror, follow: { on: S.layout.follow.on, subject: S.layout.follow.subject } },
    zoom: { on: S.zoom.on, auto: S.zoom.auto, strength: S.zoom.strength, focus: S.zoom.focus },
    endCard: { on: S.endCard.on, dur: S.endCard.dur, design: S.endCard.design },
  };
}

export function sanitizeModel(m, { fontIds = [], musicIds = [], framingReady = false, identified = false } = {}) {
  const x = m && typeof m === 'object' ? m : {};
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const l = x.layout ?? {};
  const subject = ['lisnard', 'auto', 'left', 'right'].includes(l.follow?.subject) && (l.follow.subject !== 'lisnard' || identified) ? l.follow.subject : identified ? 'lisnard' : 'auto';
  const z = sanitizeZoom(x.zoom ?? {});
  return {
    style: sanitizeStyle(x.style, fontIds),
    music: { id: musicIds.includes(x.music?.id) ? x.music.id : null, volume: num(x.music?.volume, 0, 1, 0.25) },
    voice: num(x.voice, 0, 1.5, 1),
    layout: { fit: l.fit === 'crop' ? 'crop' : 'blur', quality: l.quality === 'fast' ? 'fast' : 'hd', mirror: l.mirror === true, follow: { on: l.follow?.on === true && framingReady, subject } },
    zoom: { on: x.zoom?.on === true, auto: x.zoom?.auto !== false, strength: z.strength, focus: z.focus },
    endCard: endCardSettings(x.endCard),
  };
}

export function parseModels(raw) {
  let list;
  try {
    list = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && m.settings && typeof m.settings === 'object')
    .map((m) => ({ id: m.id, name: m.name.trim().slice(0, MODELS.nameMax) || 'Modèle', settings: m.settings }))
    .slice(0, MODELS.max)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
