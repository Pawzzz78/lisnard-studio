// Studio de clips : choix d'une interview, extraits (proposés par l'IA ou libres), sous-titres TikTok (style, police, couleurs,
// contour, position, taille), musique, cadrage, puis création du MP4 sur le serveur. Aucun innerHTML : tout est posé en nœuds.
import { CARD, PALETTES as EC_PALETTES, TEMPLATES as EC_TEMPLATES, cardBlob, drawEndCard, loadImage, needsPhoto } from './endcard.js';
import { BEGINNER_DEFAULTS, DESCRIPTION_MAX, LIMITS, LOGO, MODELS, PRESETS, SIMILARITY_WARNING, draftFromClip, endCardSettings, fitDescription, modelFromState, parseModels, sanitizeModel, groupWords, lineSimilarity, sanitizeLevel, sanitizeStyle, sanitizeZoom, sourceText, stepLabels, stepsFor, wordsForExtracts } from './studio-core.js';
import { createPhone, el, outlineShadow, rgba } from './studio-preview.js';
import { fmtDate } from './ui.js';

const root = document.getElementById('studio');
const params = new URLSearchParams(location.search);
const SWATCHES = [['#FFFFFF', 'Blanc'], ['#FFE600', 'Jaune'], ['#25F4EE', 'Cyan'], ['#FE2C55', 'Rose'], ['#7CFF6B', 'Vert'], ['#FF9500', 'Orange'], ['#000000', 'Noir']];
const PREF_KEY = 'studio.prefs.v1';
const MODELS_KEY = 'studio.models.v1';
const LEVEL_KEY = 'studio.level.v1';
const loadLevel = () => {
  try {
    return sanitizeLevel(localStorage.getItem(LEVEL_KEY));
  } catch {
    return null;
  }
};
const saveLevel = (level) => {
  try {
    localStorage.setItem(LEVEL_KEY, level);
  } catch {
    // stockage indisponible : le niveau sera redemandé
  }
};
const LOGO_KEY = 'studio.logo.v1';

// Native replaceChildren would print null/false children as text
const put = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter(Boolean));
const putKeep = (node, ...kids) => {
  const a = document.activeElement;
  const sel = 'button,input,select,textarea,summary,a[href]';
  const was = a && a !== document.body && node.contains(a) ? { k: a.dataset?.k ?? null, i: [...node.querySelectorAll(sel)].indexOf(a), tag: a.tagName } : null;
  put(node, ...kids);
  if (!was) return;
  const all = [...node.querySelectorAll(sel)];
  const next = (was.k && all.find((n) => n.dataset.k === was.k)) || (all[was.i]?.tagName === was.tag ? all[was.i] : null);
  next?.focus({ preventScroll: true });
};
let teardown = null;
const early = new Map();

const request = async (method, path, body) => {
  let res;
  try {
    res = await fetch(`/api/studio${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('Connexion impossible : vérifie ton réseau.'), { status: 0, network: true });
  }
  return { res, data: await res.json().catch(() => ({})) };
};
const prefetch = (path) => {
  const p = request('GET', path);
  p.catch(() => {});
  early.set(path, p);
};
const api = async (method, path, body) => {
  const pending = method === 'GET' ? early.get(path) : null;
  early.delete(path);
  const { res, data } = await (pending ?? request(method, path, body));
  if (res.status === 401 && data.login) {
    showGate();
    throw Object.assign(new Error(data.error), { status: 401, gate: true });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status });
  return data;
};

// Resolves to null when the library is disabled (503)
const libApi = async (method, path, body) => {
  const res = await fetch(`/api/library${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
  if (!res) throw new Error('Connexion impossible : vérifie ton réseau.');
  if (res.status === 503) return null;
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status, data });
  return data;
};

const fetchMe = () => fetch('/api/auth/me').then((r) => r.json()).catch(() => null);
let mePromise = fetchMe();
if (params.get('v')) {
  prefetch('/assets');
  prefetch(`/videos/${encodeURIComponent(params.get('v'))}`);
}

// --- accès réservé aux adhérents Nouvelle Énergie (SSO) ---------------------------------------------------------------------------------
const JOIN_URL = 'https://soutenir.unenouvelleenergie.fr/?form=adhesion';
const GATE_MESSAGES = {
  membership_not_found: ["Cette adresse e-mail ne figure pas au fichier des adhérents. Le fichier est mis à jour chaque soir : si tu viens d'adhérer, réessaie demain.", true],
  membership_unavailable: ["L'adhésion n'a pas pu être vérifiée pour le moment. Réessaie un peu plus tard.", false],
  code_throttled: ['Trop de codes demandés. Réessaie dans un quart d’heure.', false],
  code_send_failed: ["Le code n'a pas pu être envoyé par e-mail. Réessaie un peu plus tard.", false],
  echec: ["La connexion n'a pas abouti. Tu peux réessayer.", false],
  sso_unavailable: ["Le service de connexion de Nouvelle Énergie est injoignable pour le moment. Réessaie un peu plus tard.", false],
};
const loginHref = () => `/api/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;

/** Écran de connexion : le studio est réservé aux adhérents ; la personne reçoit un code par e-mail (SSO de NE, sans mot de passe). */
function showGate(failure, configured = true) {
  const [text, canJoin] = GATE_MESSAGES[failure] ?? [null, false];
  teardown?.();
  teardown = null;
  document.querySelector('.hero .st-top')?.remove();
  document.querySelector('.hero')?.classList.remove('editor');
  root.classList.remove('editing');
  put(root,
    el('section', { class: 'card st-gate' },
      el('p', { class: 'eyebrow' }, 'Réservé aux adhérents'),
      el('h2', {}, 'Connecte-toi avec ton compte adhérent'),
      el('p', {}, 'L’accès au studio est réservé aux adhérents de Nouvelle Énergie. Tu te connectes avec ton espace adhérent : ton adresse e-mail, puis un code à 6 chiffres, sans mot de passe.'),
      el('p', { class: 'hint' }, 'Ce site est indépendant de Nouvelle Énergie : la connexion sert seulement à vérifier ton adhésion.'),
      text ? el('p', { class: 'st-gate-msg', role: 'alert' }, text) : null,
      configured
        ? el('p', { class: 'st-gate-actions' }, el('a', { class: 'btn', href: loginHref() }, 'Me connecter'), canJoin ? el('a', { class: 'btn small secondary', href: JOIN_URL, rel: 'noopener' }, 'Adhérer') : null)
        : el('p', { class: 'st-gate-msg', role: 'alert' }, "La connexion des adhérents n'est pas encore configurée sur ce site."),
      !canJoin ? el('p', { class: 'hint' }, 'Pas encore adhérent ? ', el('a', { href: JOIN_URL, rel: 'noopener' }, 'Adhérer à Nouvelle Énergie')) : null,
    ),
  );
}

/** Vérifie l'accès avant d'afficher le studio ; affiche « Bonjour Camille · Se déconnecter » pour un adhérent connecté. */
async function memberGate() {
  const me = await mePromise;
  const failure = params.get('connexion');
  if (failure) {
    params.delete('connexion');
    const q = params.toString();
    history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
  }
  if (!me?.enabled) return true; // accès libre (réglage MEMBERS_ONLY)
  if (!me.member) {
    showGate(failure ?? undefined, me.configured);
    return false;
  }
  const nav = document.querySelector('.site-header nav');
  if (nav && !nav.querySelector('.st-logout')) {
    const logout = el('button', { type: 'button', class: 'st-logout' }, 'Se déconnecter');
    logout.addEventListener('click', async () => {
      logout.disabled = true;
      const r = await fetch('/api/auth/logout', { method: 'POST' }).then((x) => x.json()).catch(() => ({ redirect: '/' }));
      location.href = r.redirect || '/';
    });
    nav.append(el('span', { class: 'st-member' }, me.member.given_name ? `Bonjour ${me.member.given_name}` : 'Adhérent connecté'), logout);
  }
  return true;
}
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const secs = (n) => {
  const r = Math.round(n * 10) / 10;
  return `${String(r).replace('.', ',')} s`;
};
/** Instant d'une vidéo : 1:23,5 (dixièmes) ou 1:23,45 (centièmes si besoin). */
const fmtT = (ms) => {
  const t = Math.max(0, Math.round(ms / 10) * 10);
  const cs = t % 1000;
  const frac = cs % 100 === 0 ? String(cs / 100) : String(cs / 10).padStart(2, '0');
  return `${Math.floor(t / 60000)}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')},${frac}`;
};
/** « 1:23,5 », « 1:23.5 », « 83,5 » ou « 83 » -> millisecondes ; null si illisible. */
const parseT = (text) => {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,5})(?:[.,](\d{1,3}))?\s*$/.exec(String(text));
  if (!m) return null;
  return Math.round(((Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 + Number((m[3] ?? '').padEnd(3, '0'))) / 10) * 10;
};
const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
  } catch {
    return {};
  }
};
const readLogo = () => {
  const d = { on: false, dataUrl: '', pos: 'tr', size: 0.18, opacity: 1 };
  try {
    const l = JSON.parse(localStorage.getItem(LOGO_KEY) ?? '{}');
    const num = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
    return {
      on: l.on === true && typeof l.dataUrl === 'string' && l.dataUrl.startsWith('data:image/png'),
      dataUrl: typeof l.dataUrl === 'string' && l.dataUrl.startsWith('data:image/png') ? l.dataUrl : '',
      pos: ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'].includes(l.pos) ? l.pos : 'tr',
      size: num(l.size, 0.08, 0.4, 0.18),
      opacity: num(l.opacity, 0.3, 1, 1),
    };
  } catch {
    return d;
  }
};
let prefsTimer = 0;
let flushPrefs = () => {};
const savePrefs = (S) => {
  flushPrefs = () => {
    clearTimeout(prefsTimer);
    prefsTimer = 0;
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ style: S.style, music: S.music, voice: S.voice, layout: { fit: S.layout.fit, quality: S.layout.quality, mirror: S.layout.mirror }, step: S.step, endCard: { on: S.endCard.on, dur: S.endCard.dur, design: S.endCard.design } }));
      S.onSaved?.();
    } catch {
      // stockage indisponible : sans importance
    }
  };
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(flushPrefs, 300);
};
addEventListener('pagehide', () => { if (prefsTimer) flushPrefs(); });
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const fail = (node, e) => {
  node.className = 'st-msg err';
  node.textContent = e.message;
};

// ---------------------------------------------------------------------------------------- étapes

/**
 * Barre des étapes (« Interview », « Niveau », « Extrait »…). `go(n)` est appelé pour une étape accessible ;
 * `sync(courante, accessible)` met à jour : étapes faites (✓), étape en cours, étapes encore fermées.
 */
function createSteps(labels, go) {
  const buttons = labels.map((label, i) =>
    el('button', { type: 'button', class: 'st-step', onclick: () => go(i + 1) }, el('span', { class: 'st-step-n', 'aria-hidden': 'true' }, String(i + 1)), el('span', { class: 'st-step-l' }, label)));
  const list = el('ol', { class: 'st-steps', 'aria-label': 'Étapes de création' }, buttons.map((b) => el('li', {}, b)));
  function sync(current, canGo = () => true) {
    buttons.forEach((b, i) => {
      const n = i + 1;
      b.classList.toggle('done', n < current);
      b.classList.toggle('current', n === current);
      if (n === current) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
      b.disabled = n !== current && !canGo(n);
      b.firstChild.textContent = n < current ? '✓' : String(n);
      b.setAttribute('aria-label', `Étape ${n} sur ${labels.length} : ${labels[i]}${n < current ? ' (faite)' : n === current ? ' (en cours)' : ''}`);
    });
  }
  return { root: list, sync };
}

// ---------------------------------------------------------------------------------------- liste des interviews

async function showList() {
  const { videos } = await api('GET', '/videos');
  if (!videos.length) {
    put(root, el('section', { class: 'card st-empty' }, el('h2', {}, 'Le studio arrive bientôt'), el('p', {}, 'Aucune interview n’est encore disponible dans le studio. Reviens bientôt !')));
    return;
  }
  const labels = stepLabels(loadLevel());
  const steps = createSteps(labels, () => {});
  steps.sync(1, () => false); // les étapes suivantes s'ouvrent une fois l'interview choisie
  put(root,
    el('section', { class: 'card st-stepcard' }, steps.root),
    el('section', { class: 'card st-pick' }, el('p', { class: 'eyebrow' }, `Étape 1 sur ${labels.length}`), el('h2', { class: 'section-title' }, 'Choisis ton interview'),
      el('div', { class: 'st-list' }, videos.map((v) =>
        el('a', { class: 'st-video', href: `/?v=${v.youtube_id}` },
          v.thumbnail_url ? el('img', { src: v.thumbnail_url, alt: '', loading: 'lazy' }) : el('span', { class: 'thumb-empty', 'aria-hidden': 'true' }, '▶'),
          el('span', { class: 'st-video-info' }, el('strong', {}, v.title), el('small', {}, [fmtDate(v.published_at), v.suggestions ? `${v.suggestions} extraits proposés` : ''].filter(Boolean).join(' · '))),
        )),
      ),
    ),
    disclaimer(),
  );
}

const disclaimer = () =>
  el('p', { class: 'st-legal' }, 'Les extraits proviennent d’interviews dont les droits appartiennent à leurs auteurs. Pense à citer la source dans la description de ta vidéo (le studio te prépare le texte). Ne déforme pas le sens des propos : garde les phrases entières, et le contexte.');

// ---------------------------------------------------------------------------------------- éditeur

async function openEditor(youtubeId) {
  const [assets, detail] = await Promise.all([api('GET', '/assets'), api('GET', `/videos/${encodeURIComponent(youtubeId)}`)]);
  const fonts = assets.fonts;
  const fontIds = fonts.map((f) => f.id);
  const fontById = new Map(fonts.map((f) => [f.id, f]));
  const prefs = loadPrefs();
  const S = {
    video: detail.video,
    lines: detail.lines.map(([start_ms, end_ms, text]) => ({ start_ms, end_ms, text })),
    suggestions: detail.suggestions,
    extracts: [], // { start_ms, end_ms, title, from } : bornes en millisecondes ; `from` : début de l'extrait proposé d'origine
    level: loadLevel(), // 'debutant' | 'avance' | null (pas encore choisi) : voir « niveau » plus bas
    step: prefs.step === 'line' ? 'line' : Number.isFinite(prefs.step) && prefs.step >= 10 && prefs.step <= 30000 ? prefs.step : 500, // pas de réglage : 'line' (limite de ligne) ou durée en ms
    style: sanitizeStyle(prefs.style, fontIds),
    music: { id: assets.music.some((m) => m.id === prefs.music?.id) ? prefs.music.id : null, volume: Number.isFinite(prefs.music?.volume) ? prefs.music.volume : 0.25 },
    voice: Number.isFinite(prefs.voice) ? prefs.voice : 1,
    layout: { fit: prefs.layout?.fit === 'crop' ? 'crop' : 'blur', cropX: 0.5, quality: prefs.layout?.quality === 'fast' ? 'fast' : 'hd', mirror: prefs.layout?.mirror === true, follow: { on: false, subject: detail.faces?.identified ? 'lisnard' : 'auto' } }, // follow : le cadre suit le visage (plein écran) ; décoché au départ, c'est le visiteur qui le demande ; « lisnard » : la personne de référence quand elle est reconnue
    framing: { ready: detail.faces?.ready === true, identified: detail.faces?.identified === true, segments: null, faces: 0, coverage: 0, split: 0, crowded: 0, recognized: 0, reason: null, missing: 0, loading: false }, // cadrage automatique : trajectoire reçue du serveur
    zoom: { on: false, auto: true, ...sanitizeZoom({}), events: [] }, // plus d'étape « Images & zooms » : toujours éteint (le champ reste pour les modèles enregistrés avant)
    ticket: 0,
    edits: new Map(), // corrections de texte : début de la ligne (ms) -> { orig, text }
    endCard: { ...endCardSettings(prefs.endCard), on: false },
    logo: readLogo(),
  };
  // corrections gardées dans le navigateur (un rechargement ne les perd pas) ; ignorées si la transcription a changé depuis
  const editsKey = `studio.edits.${S.video.youtube_id}`;
  try {
    const saved = JSON.parse(localStorage.getItem(editsKey) ?? '{}');
    for (const [start, e] of Object.entries(saved)) {
      if (S.lines.some((l) => l.start_ms === Number(start) && l.text === e.orig) && typeof e.text === 'string') S.edits.set(Number(start), { orig: e.orig, text: e.text });
    }
  } catch {
    // stockage indisponible : sans importance
  }
  const saveEdits = () => {
    try {
      if (!S.edits.size) localStorage.removeItem(editsKey); // no leftover key per interview
      else localStorage.setItem(editsKey, JSON.stringify(Object.fromEntries(S.edits)));
    } catch {
      // idem
    }
  };

  const draftKey = `studio.draft.${S.video.youtube_id}`;
  let draftTimer = 0;
  const saveDraftNow = () => {
    clearTimeout(draftTimer);
    draftTimer = 0;
    try {
      if (!S.extracts.length && !S.jobId) localStorage.removeItem(draftKey);
      else {
        localStorage.setItem(draftKey, JSON.stringify({
          v: 1, extracts: S.extracts, style: S.style, music: S.music, voice: S.voice, jobId: S.jobId ?? null, delivered: S.delivered === true, remixOf: S.remixOf ?? null,
          layout: { fit: S.layout.fit, cropX: S.layout.cropX, quality: S.layout.quality, mirror: S.layout.mirror, follow: { on: S.layout.follow.on, subject: S.layout.follow.subject } },
          endCard: S.endCard,
        }));
      }
    } catch {
      // stockage indisponible : sans importance
    }
  };
  const scheduleDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftNow, 400);
  };
  S.onSaved = scheduleDraft;
  const onPageHide = () => { if (draftTimer) saveDraftNow(); };
  addEventListener('pagehide', onPageHide);
  const storedDraft = () => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) ?? 'null');
    } catch {
      return null;
    }
  };
  function restoreDraft(d = storedDraft()) {
    if (!d || d.v !== 1) return false;
    S.extracts = [];
    const endMs = videoEndMs();
    let total = 0;
    for (const e of Array.isArray(d.extracts) ? d.extracts : []) {
      const start_ms = Math.round(Number(e?.start_ms));
      const end_ms = Math.round(Number(e?.end_ms));
      const dur = (end_ms - start_ms) / 1000;
      if (!(start_ms >= 0 && end_ms <= endMs && dur >= LIMITS.minExtractS)) continue;
      if (S.extracts.length >= LIMITS.maxExtracts || total + dur > LIMITS.maxTotalS) break;
      total += dur;
      S.extracts.push({ start_ms, end_ms, title: typeof e.title === 'string' ? e.title : null, from: Number.isFinite(e.from) ? e.from : null, caption: typeof e.caption === 'string' ? e.caption : null });
    }
    if (!S.extracts.length) return false;
    if (d.style) S.style = sanitizeStyle(d.style, fontIds);
    if (assets.music.some((m) => m.id === d.music?.id)) S.music.id = d.music.id;
    else if (d.music && d.music.id == null) S.music.id = null;
    if (Number.isFinite(d.music?.volume)) S.music.volume = Math.min(1, Math.max(0, d.music.volume));
    if (Number.isFinite(d.voice)) S.voice = Math.min(1.5, Math.max(0, d.voice));
    const l = d.layout ?? {};
    S.layout.fit = l.fit === 'crop' ? 'crop' : 'blur';
    if (Number.isFinite(l.cropX)) S.layout.cropX = Math.min(1, Math.max(0, l.cropX));
    S.layout.quality = l.quality === 'fast' ? 'fast' : 'hd';
    S.layout.mirror = l.mirror === true;
    S.layout.follow.on = l.follow?.on === true && S.framing.ready;
    if (['lisnard', 'auto', 'left', 'right'].includes(l.follow?.subject) && (l.follow.subject !== 'lisnard' || S.framing.identified)) S.layout.follow.subject = l.follow.subject;
    if (d.endCard) S.endCard = endCardSettings(d.endCard);
    S.jobId = typeof d.jobId === 'string' ? d.jobId : null;
    S.delivered = d.delivered === true;
    S.remixOf = typeof d.remixOf === 'string' && /^[0-9a-f]{24}$/.test(d.remixOf) ? d.remixOf : null;
    if (d.edits && typeof d.edits === 'object') {
      S.edits.clear();
      for (const [start, text] of Object.entries(d.edits)) {
        const line = S.lines.find((x) => x.start_ms === Number(start));
        if (line && typeof text === 'string' && text !== line.text) S.edits.set(line.start_ms, { orig: line.text, text });
      }
      saveEdits();
    }
    return true;
  }

  async function draftFromLibrary() {
    const clipId = params.get('clip');
    if (!clipId) return null;
    params.delete('clip');
    const q = params.toString();
    history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
    const found = await libApi('GET', `/clips/${encodeURIComponent(clipId)}/request`).catch(() => null);
    if (!found || found.youtube_id !== S.video.youtube_id) return null;
    const current = storedDraft();
    if (current?.extracts?.length && !confirm('Remplacer ton brouillon en cours par les réglages de ce clip ?')) return null;
    return draftFromClip(found.req, found.id);
  }

  // @font-face de toutes les polices (le navigateur ne télécharge que celles qui servent)
  const fontCss = fonts.map((f) => `@font-face{font-family:'ST-${f.id}';src:url('/fonts/studio/${f.file}') format('truetype');font-display:swap}`).join('');
  document.head.append(el('style', {}, fontCss));

  // --- outils sur les extraits
  /** Parcours débutant : les outils fins sont masqués (voir `data-adv` et studio.css). */
  const easy = () => S.level === 'debutant';
  const exMs = (ex) => ({ start_ms: ex.start_ms, end_ms: ex.end_ms });
  const exDur = (ex) => (ex.end_ms - ex.start_ms) / 1000;
  const totalS = () => S.extracts.reduce((n, ex) => n + exDur(ex), 0);
  /** Ligne de la transcription dite à l'instant `ms` (sinon la plus proche), pour rappeler où l'on en est. */
  const lineAround = (ms) => {
    let best = S.lines[0];
    for (const l of S.lines) {
      if (ms >= l.start_ms && ms < l.end_ms) return l;
      if (Math.abs(l.start_ms - ms) < Math.abs(best.start_ms - ms)) best = l;
    }
    return best;
  };
  // File duration may be missing: fall back to the last transcript line
  const videoEndMs = () => (S.video.duration_s > 0 ? Math.floor(S.video.duration_s * 1000) : (S.lines.at(-1)?.end_ms ?? 0));

  // --- aperçu
  let cropSlider = null; // curseur « position du cadrage » de l'onglet Cadrage, tenu à jour quand on glisse la vidéo
  const phone = createPhone({
    onMove: ({ x, y }) => setStyle({ x, y }),
    onCrop: (cropX) => {
      S.layout.cropX = cropX;
      if (cropSlider) cropSlider.value = String(Math.round(cropX * 100));
    },
  });
  /** Le cadre suit le visage : plein écran, suivi demandé, interview analysée et trajectoire reçue. */
  const following = () => S.layout.fit === 'crop' && S.layout.follow.on && S.framing.ready && Boolean(S.framing.segments);
  const pushFraming = () => phone.setFraming({ fit: S.layout.fit, cropX: S.layout.cropX, mirror: S.layout.mirror, follow: following() ? S.framing.segments : null });
  let framingTicket = 0;
  /**
   * Demande au serveur où placer le cadre pour les extraits actuels (rapide : les visages sont déjà analysés). Fait même quand le
   * suivi n'est pas demandé : on sait ainsi dire au visiteur si le cadrage automatique est possible sur ce clip.
   */
  async function refreshFraming() {
    const mine = ++framingTicket;
    const empty = { segments: null, faces: 0, coverage: 0, split: 0, crowded: 0, recognized: 0, identBest: null, reason: null, missing: 0, loading: false };
    if (!(S.layout.fit === 'crop' && S.framing.ready && S.extracts.length)) {
      S.framing = { ...S.framing, ...empty };
      pushFraming();
      if (S.layout.fit === 'crop') renderFrame();
      return;
    }
    S.framing.loading = true;
    try {
      const r = await api('POST', '/framing', { youtube_id: S.video.youtube_id, extracts: S.extracts.map(exMs), subject: S.layout.follow.subject });
      if (mine !== framingTicket) return;
      S.framing = { ...S.framing, segments: r.segments, faces: r.faces, coverage: r.coverage, split: r.split ?? 0, crowded: r.crowded ?? 0, recognized: r.recognized ?? 0, identBest: r.ident_best ?? null, reason: r.reason ?? null, missing: r.missing ?? 0, loading: false };
    } catch {
      if (mine !== framingTicket) return;
      S.framing = { ...S.framing, ...empty };
    }
    pushFraming();
    renderFrame();
  }
  /** Mots horodatés du clip, corrections de texte comprises. */
  const clipWords = () => wordsForExtracts(S.edits.size ? S.lines.map((l) => (S.edits.has(l.start_ms) ? { ...l, text: S.edits.get(l.start_ms).text } : l)) : S.lines, S.extracts.map(exMs)).words;
  function rebuildSubtitles() {
    const words = clipWords();
    phone.configure({ groups: groupWords(words, S.style), style: S.style, font: fontById.get(S.style.font) });
  }
  function applyAudio() {
    const track = assets.music.find((m) => m.id === S.music.id);
    phone.setAudio({ url: track ? track.url : null, volume: S.music.volume, voice: S.voice });
  }
  let previewKey = '';
  /** L'extrait vient de changer : l'aperçu affiché n'est plus le bon. On l'arrête, on le remet à zéro et on le dit tout de suite, sans attendre la demande au serveur. */
  function previewStale() {
    if (!S.extracts.length || !phone.hasSource() || JSON.stringify(S.extracts.map(exMs)) === shownExtracts) return;
    phone.pause();
    phone.rewind();
    phone.setBusy('Préparation de l’aperçu…', { loading: true });
  }
  let shownExtracts = ''; // extraits de l'aperçu affiché : un autre extrait repart de zéro, un simple changement de cadrage garde la position
  async function requestPreview(force = false) {
    const mine = ++S.ticket;
    refreshFraming();
    if (!S.extracts.length) {
      previewKey = '';
      phone.setBusy('Ajoute un extrait pour voir l’aperçu');
      return;
    }
    const body = { youtube_id: S.video.youtube_id, extracts: S.extracts.map(exMs), layout: S.layout };
    const key = JSON.stringify(body);
    if (force !== true && key === previewKey && phone.hasSource()) {
      phone.setBusy(null);
      return;
    }
    const extractsKey = JSON.stringify(body.extracts);
    const changed = extractsKey !== shownExtracts;
    if (changed && phone.hasSource()) {
      phone.pause(); // l'ancien aperçu n'est plus le bon : il s'arrête et revient à zéro sous le message
      phone.rewind();
    }
    phone.setBusy('Préparation de l’aperçu…', { loading: true });
    try {
      const r = await api('POST', '/preview', body);
      if (mine !== S.ticket) return;
      previewKey = key;
      shownExtracts = extractsKey;
      phone.setBusy(null);
      phone.setSource(r.url, { reset: changed });
    } catch (e) {
      if (mine === S.ticket && !e.gate) phone.setBusy(e.message, { retry: () => requestPreview(true) });
    }
  }
  let previewTimer = 0;
  const schedulePreview = (ms = 450) => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(requestPreview, ms);
  };

  function setStyle(patch) {
    S.style = sanitizeStyle({ ...S.style, ...patch }, fontIds);
    savePrefs(S);
    rebuildSubtitles();
    syncStyleControls();
  }

  // ============================================================ onglet Extraits
  const panelExtracts = el('div', { class: 'st-panel' });
  const minTotalNote = () => `${secs(totalS())} sur ${LIMITS.maxTotalS} s maximum`;

  let booting = true;
  let justAdded = null;
  function addExtract(start_ms, end_ms, title, from, caption = null, replace = false) {
    if (!replace && S.extracts.length >= LIMITS.maxExtracts) return alertNote(`${LIMITS.maxExtracts} extraits au maximum.`);
    const ex = { start_ms, end_ms: Math.min(end_ms, videoEndMs()), title, from, caption };
    if ((replace ? 0 : totalS()) + exDur(ex) > LIMITS.maxTotalS) return alertNote(`Le clip ne peut pas dépasser ${LIMITS.maxTotalS} secondes.`);
    if (replace) S.extracts = [ex];
    else S.extracts.push(ex);
    justAdded = booting ? null : ex;
    extractsChanged();
    if (!booting) toast(easy() ? 'Extrait choisi ✓' : replace ? 'Extrait choisi : il remplace ton clip (voir « Mon clip »).' : 'Extrait ajouté à ton clip (voir « Mon clip »).');
  }
  function extractsChanged(fine = false) {
    rebuildSubtitles();
    renderExtracts();
    renderTextEditor();
    previewStale();
    schedulePreview(fine ? 1400 : 450);
    renderCreateSummary();
    syncNav();
    scheduleDraft();
  }
  const note = el('p', { class: 'st-msg' });
  const toastEl = el('p', { class: 'st-toast', role: 'status' });
  let toastTimer = 0;
  const toast = (msg, err = false) => {
    toastEl.className = err ? 'st-toast err' : 'st-toast';
    toastEl.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.textContent = ''), 4000);
  };
  let noteTimer = 0;
  const alertNote = (msg) => {
    note.className = 'st-msg err';
    note.textContent = msg;
    toast(msg, true);
    clearTimeout(noteTimer); // the latest message keeps its full display time
    noteTimer = setTimeout(() => (note.textContent = ''), 4000);
  };

  /**
   * Règle une borne de l'extrait (`which` : 'start_ms' ou 'end_ms') sur l'instant `ms`, au centième de seconde. Refuse un clip trop
   * court, trop long ou hors de la vidéo, en le disant.
   */
  function setEdge(ex, which, ms) {
    const next = { ...ex, [which]: Math.round(ms / 10) * 10 };
    if (next.start_ms < 0 || next.end_ms > videoEndMs()) return alertNote(`L’extrait doit rester entre 0:00 et ${fmtT(videoEndMs())}.`);
    if (exDur(next) < LIMITS.minExtractS) return alertNote(`Un extrait doit durer au moins ${LIMITS.minExtractS} secondes.`);
    if (totalS() - exDur(ex) + exDur(next) > LIMITS.maxTotalS) return alertNote(`Le clip ne peut pas dépasser ${LIMITS.maxTotalS} secondes.`);
    Object.assign(ex, next);
    extractsChanged(true);
  }
  /** Avance (+1) ou recule (-1) une borne d'un pas : une durée, ou jusqu'à la limite de ligne suivante / précédente. */
  function nudge(ex, which, dir) {
    const cur = ex[which];
    if (S.step === 'line') {
      const key = which === 'start_ms' ? 'start_ms' : 'end_ms';
      const marks = S.lines.map((l) => l[key]);
      const target = dir > 0 ? marks.find((t) => t > cur + 20) : [...marks].reverse().find((t) => t < cur - 20);
      return target == null ? alertNote('Il n’y a pas de ligne plus loin.') : setEdge(ex, which, target);
    }
    setEdge(ex, which, cur + dir * S.step);
  }
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= S.extracts.length) return;
    [S.extracts[i], S.extracts[j]] = [S.extracts[j], S.extracts[i]];
    extractsChanged();
  };
  const excerpt = (t, n = 70) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

  function extractRow(ex, i) {
    const btn = (label, title, fn, disabled, key) => el('button', { class: 'st-mini', type: 'button', title, 'aria-label': title, disabled, 'data-k': key, onclick: fn }, label);
    const edge = (label, which, lessTitle, moreTitle) => {
      // iOS decimal keypads have no ':'
      const field = el('input', { class: 'st-time', type: 'text', inputmode: 'text', autocomplete: 'off', value: fmtT(ex[which]), 'aria-label': `${label} de l’extrait (minutes:secondes,dixièmes)`, title: 'Tu peux taper un instant : 1:23,5' });
      field.addEventListener('change', () => {
        const ms = parseT(field.value);
        if (ms == null) { field.value = fmtT(ex[which]); return alertNote('Instant illisible : écris par exemple 1:23,5 ou 83,5.'); }
        setEdge(ex, which, ms);
        field.value = fmtT(ex[which]);
      });
      field.dataset.k = `${i}:${which}:t`;
      const go = (dir) => nudge(ex, which, dir);
      return el('div', { class: 'st-edge' },
        el('div', { class: 'st-edge-ctl' }, el('span', { class: 'st-edge-label' }, label), btn('−', lessTitle, () => go(-1), false, `${i}:${which}:-1`), field, btn('+', moreTitle, () => go(1), false, `${i}:${which}:1`)),
        el('span', { class: 'st-edge-text' }, `« ${excerpt(lineAround(ex[which]).text)} »`));
    };
    return el('li', { class: 'st-ex', 'data-ex': String(i) },
      el('div', { class: 'st-ex-head' }, el('strong', {}, ex.title || 'Passage libre'), el('span', { class: 'badge' }, `${fmtT(ex.start_ms)} → ${fmtT(ex.end_ms)} · ${secs(exDur(ex))}`)),
      edge('Début', 'start_ms', 'Commencer plus tôt (ajoute du temps avant)', 'Commencer plus tard (retire du temps au début)'),
      edge('Fin', 'end_ms', 'Finir plus tôt (retire du temps à la fin)', 'Finir plus tard (ajoute du temps après)'),
      el('div', { class: 'st-ex-tools' }, btn('↑', 'Monter', () => move(i, -1), i === 0, `${i}:up`), btn('↓', 'Descendre', () => move(i, 1), i === S.extracts.length - 1, `${i}:down`),
        el('button', { class: 'st-link', type: 'button', onclick: () => { S.extracts.splice(i, 1); extractsChanged(); } }, 'Retirer')),
    );
  }

  /** Pas de réglage des bornes : quelques valeurs rapides, ou n'importe quelle durée (champ libre). */
  function stepBar() {
    const chips = [[100, '0,1 s'], [500, '0,5 s'], [1000, '1 s'], [2000, '2 s'], ['line', 'Ligne']];
    const custom = el('input', { class: 'st-time short', type: 'text', inputmode: 'text', autocomplete: 'off', 'aria-label': 'Autre pas, en secondes', placeholder: 'autre' });
    const group = el('div', { class: 'seg st-stepchips', role: 'group', 'aria-label': 'Pas de réglage' });
    const sync = () => {
      group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(String(S.step) === b.dataset.step)));
      custom.value = chips.some(([v]) => v === S.step) ? '' : String(S.step / 1000).replace('.', ',');
      custom.classList.toggle('on', Boolean(custom.value));
    };
    for (const [v, label] of chips) group.append(el('button', { type: 'button', 'data-step': String(v), onclick: () => { S.step = v; savePrefs(S); sync(); } }, label));
    custom.addEventListener('change', () => {
      const ms = parseT(custom.value);
      if (ms == null || ms < 10 || ms > 30000) { sync(); return alertNote('Pas libre : entre 0,01 et 30 secondes (par exemple 0,3).'); }
      S.step = ms;
      savePrefs(S);
      sync();
    });
    sync();
    return el('div', { class: 'st-stepbar' }, el('span', { class: 'st-step-label' }, 'Précision des boutons − / +'), group, el('span', { class: 'st-step-custom' }, custom, el('small', {}, 's')));
  }

  const search = el('input', { type: 'search', class: 'st-search', placeholder: 'Chercher un mot dans la transcription…', 'aria-label': 'Chercher dans la transcription' });
  const lineList = el('ul', { class: 'st-lines' });
  let shown = 60;
  function renderLines() {
    const q = search.value.trim().toLowerCase();
    const matches = S.lines.map((l, i) => ({ l, i })).filter(({ l }) => !q || l.text.toLowerCase().includes(q));
    put(lineList,
      ...matches.slice(0, shown).map(({ l, i }) =>
        el('li', {}, el('button', { type: 'button', onclick: () => startFree(i) }, el('span', { class: 'st-t' }, mmss(l.start_ms)), el('span', {}, l.text))),
      ),
      matches.length > shown ? el('li', {}, el('button', { type: 'button', class: 'st-more', onclick: () => { shown += 60; renderLines(); } }, `Afficher plus (${matches.length - shown} lignes)`)) : null,
      !matches.length ? el('li', { class: 'st-none' }, 'Aucune ligne ne correspond.') : null,
    );
  }
  search.addEventListener('input', debounce(() => { shown = 60; renderLines(); }, 200));
  function startFree(i) {
    let b = i;
    while (b + 1 < S.lines.length && (S.lines[b].end_ms - S.lines[i].start_ms) / 1000 < 25) b++;
    addExtract(S.lines[i].start_ms, S.lines[b].end_ms, null);
  }

  let suggShown = 6; // extraits proposés affichés d'emblée (les mieux notés d'abord) ; le reste sur demande
  let easyShown = 3;

  /** Niveau débutant : uniquement les extraits proposés par l'IA, en grandes cartes, un seul bouton par carte. */
  function easyExtracts() {
    const cur = S.extracts[0] ?? null;
    const custom = cur && cur.from == null ? cur : null; // passage libre choisi en niveau avancé : on le garde, on ne le modifie pas ici
    const pickBtn = (on, onclick, key) => el('button', { class: on ? 'btn st-easy-pick on' : 'btn st-easy-pick', type: 'button', 'aria-pressed': String(on), 'data-k': key, onclick }, on ? '✓ Extrait choisi' : 'Choisir cet extrait');
    const card = (sg) => {
      const on = cur?.from === sg.start_ms;
      return el('li', { class: on ? 'st-easy-card on' : 'st-easy-card' },
        el('h3', { class: 'st-easy-title' }, sg.title),
        el('p', { class: 'st-easy-meta' }, `Durée : ${Math.round(sg.duration_s)} secondes`),
        sg.why ? el('p', { class: 'st-easy-why' }, sg.why) : null,
        el('details', {}, el('summary', {}, 'Lire le texte de cet extrait'), el('p', { class: 'st-text' }, sg.text)),
        pickBtn(on, () => addExtract(sg.start_ms, sg.end_ms, sg.title, sg.start_ms, sg.description, true), `easy:${sg.start_ms}`));
    };
    return [
      custom ? el('div', { class: 'st-easy-card on' },
        el('h3', { class: 'st-easy-title' }, 'Ton passage actuel'),
        el('p', { class: 'st-easy-meta' }, `De ${mmss(custom.start_ms)} à ${mmss(custom.end_ms)} · ${Math.round(exDur(custom))} secondes`),
        el('p', { class: 'st-easy-why' }, 'Tu l’as choisi toi-même en niveau avancé. Choisis un extrait ci-dessous pour le remplacer.'),
        el('p', { class: 'st-easy-chosen' }, '✓ Extrait choisi')) : null,
      S.suggestions.length
        ? el('ul', { class: 'st-easy' }, S.suggestions.slice(0, easyShown).map(card))
        : el('div', { class: 'st-easy-empty' },
            el('p', {}, 'L’intelligence artificielle n’a pas trouvé de passage assez fort dans cette interview.'),
            el('p', {}, 'Tu peux choisir une autre interview, ou passer en niveau avancé pour choisir toi-même le passage.'),
            el('button', { class: 'btn secondary', type: 'button', onclick: () => { setLevel('avance'); renderExtracts(); } }, 'Passer en niveau avancé')),
      S.suggestions.length > easyShown ? el('button', { class: 'btn secondary st-easy-more', type: 'button', onclick: () => { easyShown += 3; renderExtracts(); } }, 'Voir d’autres extraits') : null,
    ];
  }

  function renderExtracts() {
    if (easy()) {
      justAdded = null;
      return putKeep(panelExtracts, ...easyExtracts());
    }
    const taken = new Set(S.extracts.map((e) => e.from).filter((v) => v != null));
    const addLabel = S.extracts.length === 1 ? 'Utiliser cet extrait' : 'Remplacer mon clip par cet extrait';
    putKeep(panelExtracts,
      el('h3', {}, 'Mon clip'),
      S.extracts.length ? stepBar() : null,
      S.extracts.length ? el('ol', { class: 'st-exlist' }, S.extracts.map(extractRow)) : el('p', { class: 'st-help' }, 'Ajoute un extrait ci-dessous : l’aperçu apparaît avec la vidéo.'),
      el('p', { class: totalS() > LIMITS.maxTotalS ? 'st-total err' : 'st-total' }, S.extracts.length ? `Durée : ${minTotalNote()}` : ''),
      note,
      el('h3', {}, S.suggestions.length ? `Extraits proposés par l’IA (${S.suggestions.length}, du plus au moins viral)` : 'Extraits proposés par l’IA'),
      S.suggestions.length
        ? el('ul', { class: 'st-sugg' }, S.suggestions.slice(0, suggShown).map((sg) =>
            el('li', { class: 'st-card' },
              el('div', { class: 'st-card-head' }, el('strong', {}, sg.title), el('span', { class: 'badge ok', title: 'Potentiel viral estimé par l’IA' }, `${sg.score}/10`)),
              el('p', { class: 'st-why' }, sg.why),
              el('p', { class: 'st-meta' }, `${mmss(sg.start_ms)} → ${mmss(sg.end_ms)} · ${secs(sg.duration_s)}`),
              el('details', {}, el('summary', {}, 'Lire l’extrait'), el('p', { class: 'st-text' }, sg.text)),
              el('div', { class: 'st-card-actions' },
                taken.has(sg.start_ms)
                  ? el('button', { class: 'btn secondary small', type: 'button', 'data-k': `sg:${sg.start_ms}`, onclick: () => { const k = S.extracts.findIndex((e) => e.from === sg.start_ms); if (k >= 0) { S.extracts.splice(k, 1); extractsChanged(); } } }, 'Retirer de mon clip')
                  : S.extracts.length
                    ? [el('button', { class: 'btn small', type: 'button', 'data-k': `sg:${sg.start_ms}`, onclick: () => addExtract(sg.start_ms, sg.end_ms, sg.title, sg.start_ms, sg.description, true) }, addLabel),
                       el('button', { class: 'btn secondary small', type: 'button', 'data-k': `sga:${sg.start_ms}`, onclick: () => addExtract(sg.start_ms, sg.end_ms, sg.title, sg.start_ms, sg.description) }, 'Ajouter à la suite')]
                    : el('button', { class: 'btn small', type: 'button', 'data-k': `sg:${sg.start_ms}`, onclick: () => addExtract(sg.start_ms, sg.end_ms, sg.title, sg.start_ms, sg.description) }, 'Utiliser cet extrait')),
            )),
          )
        : el('p', { class: 'st-help' }, 'Pas d’extrait proposé pour cette vidéo : choisis un passage dans la transcription.'),
      ...(S.suggestions.length > suggShown ? [el('button', { class: 'btn secondary small', type: 'button', onclick: () => { suggShown += 8; renderExtracts(); } }, `Voir ${Math.min(8, S.suggestions.length - suggShown)} extrait${S.suggestions.length - suggShown > 1 ? 's' : ''} de plus (${S.suggestions.length - suggShown} restant${S.suggestions.length - suggShown > 1 ? 's' : ''})`)] : []),
      el('h3', {}, 'Choisir un autre passage'),
      el('p', { class: 'st-help' }, 'Touche une ligne : l’extrait démarre là (environ 25 s), puis ajuste le début et la fin au dixième de seconde (ou tape l’instant exact).'),
      search,
      lineList,
    );
    renderLines();
    if (justAdded) {
      const i = S.extracts.indexOf(justAdded);
      justAdded = null;
      panelExtracts.querySelector(`[data-ex="${i}"]`)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  // ============================================================ onglet Sous-titres
  const ctl = {}; // références des contrôles, pour les resynchroniser
  let rowSeq = 0;
  const row = (label, ...nodes) => {
    const target = nodes.flat().find((n) => n?.matches?.('input,select,textarea'));
    const lab = el('label', {}, label);
    if (target) {
      target.id ||= `st-c${++rowSeq}`;
      lab.htmlFor = target.id;
    }
    return el('div', { class: 'st-row' }, lab, el('div', { class: 'st-row-ctl' }, ...nodes));
  };
  const slider = (key, min, max, step, fmtVal) => {
    const out = el('output', {}, '');
    const input = el('input', { type: 'range', min, max, step });
    input.addEventListener('input', () => setStyle({ [key]: Number(input.value) }));
    ctl[key] = { input, out, fmtVal };
    return [input, out];
  };
  const colorInput = (key) => {
    const input = el('input', { type: 'color' });
    input.addEventListener('input', () => setStyle({ [key]: input.value.toUpperCase() }));
    const sw = el('span', { class: 'st-swatches' }, SWATCHES.map(([c, name]) => el('button', { type: 'button', class: 'st-sw', title: name, 'aria-label': name, onclick: () => setStyle({ [key]: c }) }, el('span', { style: { background: c } }))));
    ctl[key] = { input };
    return [input, sw];
  };
  const toggle = (key, label, toPatch = (checked) => ({ [key]: checked })) => {
    const input = el('input', { type: 'checkbox' });
    input.addEventListener('change', () => setStyle(toPatch(input.checked)));
    ctl[key] = { input };
    return el('label', { class: 'st-check' }, input, label);
  };

  const presetGrid = el('div', { class: 'st-presets' });
  function renderPresets() {
    put(presetGrid, ...Object.entries(PRESETS).map(([id, p]) => {
      const st = sanitizeStyle({ preset: id }, fontIds);
      const sample = el('span', { class: 'st-sample' }, st.uppercase ? 'LES MOTS' : 'Les mots');
      sample.style.fontFamily = `'ST-${st.font}', sans-serif`;
      sample.style.color = st.color;
      sample.style.fontSize = `${Math.min(30, st.size * 0.28)}px`;
      sample.style.textShadow = st.box ? 'none' : outlineShadow(Math.min(3, st.outline * 0.28), st.outlineColor, 0, 1);
      if (st.box) { sample.style.background = rgba(st.boxColor, st.boxOpacity); sample.style.padding = '.1em .35em'; sample.style.borderRadius = `${st.boxRadius * 0.7}em`; }
      if (st.mode === 'words' || st.mode === 'karaoke') sample.append(el('span', { class: 'st-sample-hl', style: { color: st.highlight } }, ' ici'));
      const b = el('button', { type: 'button', class: 'st-preset', 'data-preset': id, onclick: () => { S.style = sanitizeStyle({ preset: id, x: S.style.x }, fontIds); savePrefs(S); rebuildSubtitles(); syncStyleControls(); } },
        el('span', { class: 'st-sample-box' }, sample), el('strong', {}, p.label), el('small', {}, p.hint));
      return b;
    }));
  }
  const fontGrid = el('div', { class: 'st-fonts', role: 'listbox', 'aria-label': 'Police' });
  const fontSeen = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          en.target.style.fontFamily = `'ST-${en.target.dataset.f}', sans-serif`;
          fontSeen.unobserve(en.target);
        }
      }, { root: fontGrid, rootMargin: '60px' })
    : null;
  function renderFonts() {
    const cats = [...new Set(fonts.map((f) => f.category))];
    put(fontGrid, ...cats.flatMap((c) => [el('p', { class: 'st-cat' }, c), el('div', { class: 'st-font-row' }, fonts.filter((f) => f.category === c).map((f) => {
      const sample = el('span', { 'data-f': f.id }, 'Lisnard');
      if (fontSeen) fontSeen.observe(sample);
      else sample.style.fontFamily = `'ST-${f.id}', sans-serif`;
      return el('button', { type: 'button', class: 'st-font', role: 'option', 'data-font': f.id, onclick: () => setStyle({ font: f.id }) }, sample, el('small', {}, f.label));
    }))]));
  }
  const panelStyle = el('div', { class: 'st-panel' });
  const lookWrap = el('div', {});
  const textWrap = el('div', { hidden: true, 'data-adv': '' });
  const subNav = el('div', { class: 'seg st-subnav', role: 'group', 'aria-label': 'Sous-titres', 'data-adv': '' });
  const openSub = (which) => {
    textWrap.hidden = which !== 'text';
    lookWrap.hidden = which !== 'look';
    subNav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sub === which)));
    if (which === 'text') renderTextEditor();
  };
  for (const [which, label] of [['look', 'Apparence'], ['text', 'Texte']]) subNav.append(el('button', { type: 'button', 'data-sub': which, onclick: () => openSub(which) }, label));
  const boxRows = el('div', { class: 'st-sub' });
  const posButtons = el('div', { class: 'st-pos' }, [['Haut', 0.3], ['Milieu', 0.5], ['Bas', 0.68]].map(([label, y]) => el('button', { type: 'button', class: 'st-mini wide', onclick: () => setStyle({ y }) }, label)), el('button', { type: 'button', class: 'st-mini wide', onclick: () => setStyle({ x: 0.5 }) }, 'Centrer'));
  const rowHl = row('Couleur du mot actif', ...colorInput('highlight'));
  const rowShadow = row('Ombre', ...slider('shadow', 0, 12, 0.5, (v) => (v ? `${v}` : 'aucune')));
  const rowGroup = row('Mots affichés à la fois', ...slider('wordsPerGroup', 1, 8, 1, (v) => `${v}`));
  lookWrap.append(
    el('h3', {}, 'Style'), presetGrid,
    el('div', { 'data-adv': '' }, // niveau avancé : le reste des réglages (police, couleurs, contour, position…)
    el('h3', {}, 'Police'), fontGrid,
    el('h3', {}, 'Texte'),
    row('Taille', ...slider('size', 30, 220, 1, (v) => `${v}`)),
    row('Couleur du texte', ...colorInput('color')), rowHl,
    toggle('uppercase', 'Majuscules'), rowGroup,
    el('h3', {}, 'Contour et fond'),
    row('Épaisseur du contour', ...slider('outline', 0, 24, 0.5, (v) => (v ? `${v}` : 'aucun'))),
    row('Couleur du contour', ...colorInput('outlineColor')), rowShadow,
    toggle('box', 'Fond sombre derrière le texte'),
    boxRows,
    el('h3', {}, 'Position et animation'),
    row('Largeur du texte', ...slider('maxWidth', 0.4, 0.96, 0.02, (v) => `${Math.round(v * 100)} %`)),
    row('Position verticale', ...slider('y', 0.1, 0.9, 0.01, (v) => `${Math.round(v * 100)} %`)),
    el('p', { class: 'st-help' }, 'Tu peux aussi glisser les sous-titres directement sur l’aperçu avec le doigt ou la souris.'),
    posButtons,
    toggle('animation_pop', 'Petit « pop » à l’apparition de chaque groupe', (checked) => ({ animation: checked ? 'pop' : 'none' })),
    ),
  );
  boxRows.append(row('Couleur du fond', ...colorInput('boxColor')), row('Opacité du fond', ...slider('boxOpacity', 0, 1, 0.02, (v) => `${Math.round(v * 100)} %`)),
    row('Arrondi du fond', ...slider('boxRadius', 0, 1, 0.05, (v) => (v ? `${Math.round(v * 100)} %` : 'angles droits'))));

  function syncStyleControls() {
    const s = S.style;
    for (const [key, c] of Object.entries(ctl)) {
      if (key === 'animation_pop') c.input.checked = s.animation === 'pop';
      else if (c.input.type === 'checkbox') c.input.checked = Boolean(s[key]);
      else if (c.input.type === 'color') c.input.value = s[key].toLowerCase();
      else {
        c.input.value = String(s[key]);
        if (c.out) c.out.textContent = c.fmtVal(s[key]);
      }
    }
    presetGrid.querySelectorAll('.st-preset').forEach((b) => b.classList.toggle('on', b.dataset.preset === s.preset));
    fontGrid.querySelectorAll('.st-font').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.font === s.font)));
    rowHl.hidden = !(s.mode === 'words' || s.mode === 'karaoke');
    rowGroup.hidden = s.mode === 'one';
    rowShadow.hidden = s.box;
    boxRows.hidden = !s.box;
    ctl.outline.input.closest('.st-row').hidden = s.box;
    ctl.outlineColor.input.closest('.st-row').hidden = s.box;
  }

  // --- texte des sous-titres : on corrige les mots, la ligne garde son horodatage d'origine
  const clipLines = () => {
    const rows = [];
    let offset = 0;
    S.extracts.forEach((ex, k) => {
      for (const l of S.lines) if (l.end_ms > ex.start_ms && l.start_ms < ex.end_ms) rows.push({ k, line: l, at: offset + Math.max(0, (l.start_ms - ex.start_ms) / 1000) });
      offset += exDur(ex);
    });
    return rows;
  };
  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const editedInClip = () => clipLines().filter((r) => S.edits.has(r.line.start_ms)).length;

  const fitAreas = () => textWrap.querySelectorAll('textarea').forEach((a) => { a.style.height = 'auto'; a.style.height = `${a.scrollHeight}px`; });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => !textWrap.hidden && fitAreas()).observe(textWrap); // largeur modifiée, onglet ouvert

  function renderTextEditor() {
    if (!textWrap || textWrap.hidden) return;
    const rows = clipLines();
    const summary = el('p', { class: 'st-help', role: 'status' });
    const refreshSummary = () => {
      const n = editedInClip();
      summary.textContent = n ? `${n} ligne${n > 1 ? 's' : ''} corrigée${n > 1 ? 's' : ''}.` : 'Corrige les mots mal reconnus : chaque ligne garde son horodatage, les mots sont répartis sur la même durée.';
    };
    const resetAll = el('button', { type: 'button', class: 'st-link', onclick: () => { for (const r of rows) S.edits.delete(r.line.start_ms); saveEdits(); rebuildSubtitles(); renderTextEditor(); renderCreateSummary(); } }, 'Tout rétablir');
    let lastK = -1;
    const items = rows.flatMap(({ k, line, at }) => {
      const original = line.text;
      const area = el('textarea', { class: 'st-line-text', rows: '1', spellcheck: 'true', lang: 'fr', 'aria-label': `Sous-titre de ${clock(at)}`, maxlength: '500' });
      area.value = S.edits.get(line.start_ms)?.text ?? original;
      const badge = el('span', { class: 'st-badge' }, 'corrigé');
      const warn = el('p', { class: 'st-line-warn' });
      const undo = el('button', { type: 'button', class: 'st-link', title: 'Rétablir le texte de la transcription' }, 'Rétablir');
      const li = el('li', { class: 'st-line' });
      const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
      const refresh = () => {
        const edited = S.edits.has(line.start_ms);
        const text = area.value.trim();
        li.classList.toggle('edited', edited);
        badge.hidden = undo.hidden = !edited;
        const far = edited && text && lineSimilarity(original, text) < SIMILARITY_WARNING;
        warn.hidden = !(far || (edited && !text));
        warn.textContent = !text ? 'Aucun sous-titre ne sera affiché pour cette ligne.' : '⚠ Ce texte s’écarte beaucoup de la transcription : vérifie qu’il reste fidèle à ce qui est dit.';
        li.classList.toggle('far', Boolean(far));
        refreshSummary();
      };
      area.addEventListener('input', () => {
        if (area.value.trim() === original) S.edits.delete(line.start_ms);
        else S.edits.set(line.start_ms, { orig: original, text: area.value });
        saveEdits(); fit(); refresh(); rebuildSubtitles(); renderCreateSummary();
      });
      area.addEventListener('focus', () => phone.seek(at));
      undo.addEventListener('click', () => { S.edits.delete(line.start_ms); area.value = original; saveEdits(); fit(); refresh(); rebuildSubtitles(); renderCreateSummary(); });
      li.append(
        el('button', { type: 'button', class: 'st-seek', title: 'Écouter cette ligne', onclick: () => phone.seek(at, true) }, `▶ ${clock(at)}`),
        el('div', { class: 'st-line-body' }, area, el('div', { class: 'st-line-meta' }, badge, undo), warn),
      );
      refresh();
      requestAnimationFrame(fit);
      const head = k !== lastK && S.extracts.length > 1 ? el('li', { class: 'st-line-head' }, `Extrait ${k + 1} · ${S.extracts[k].title || 'Passage libre'}`) : null;
      lastK = k;
      return head ? [head, li] : [li];
    });
    putKeep(textWrap,
      el('h3', {}, 'Texte des sous-titres'),
      summary,
      ...(S.edits.size ? [resetAll] : []),
      rows.length ? el('ul', { class: 'st-line-list' }, items) : el('p', { class: 'st-help' }, 'Ajoute d’abord un extrait pour corriger ses sous-titres.'),
    );
  }

  // ============================================================ onglet Musique
  const panelMusic = el('div', { class: 'st-panel' });
  const audition = new Audio();
  audition.preload = 'none';
  let auditionId = null;
  let musicCat = 'all'; // catégorie affichée dans la liste
  audition.addEventListener('ended', () => { auditionId = null; renderMusic(); });
  const catLabel = (id) => (assets.music_categories ?? []).find((c) => c.id === id)?.label ?? '';
  function renderMusic() {
    const pick = (id) => { S.music.id = id; savePrefs(S); applyAudio(); updateSource(); renderMusic(); };
    const track = (m) => el('li', { class: m.id === S.music.id ? 'st-track on' : 'st-track' },
      el('button', { type: 'button', class: 'st-playtrack', 'data-k': `p:${m.id}`, 'aria-label': auditionId === m.id ? `Arrêter ${m.title}` : `Écouter ${m.title}`, onclick: () => {
        if (auditionId === m.id) { audition.pause(); auditionId = null; } else { phone.pause(); audition.src = m.url; audition.volume = 0.6; audition.play().catch(() => {}); auditionId = m.id; }
        renderMusic();
      } }, auditionId === m.id ? '■' : '▶'),
      el('button', { type: 'button', class: 'st-trackname', 'data-k': `t:${m.id}`, 'aria-pressed': String(m.id === S.music.id), onclick: () => pick(m.id) }, el('strong', {}, m.title), el('small', {}, [catLabel(m.category), m.mood, m.bpm ? `${m.bpm} bpm` : '', mmss(m.duration_s * 1000)].filter(Boolean).join(' · '))),
      m.id === S.music.id ? el('span', { class: 'badge ok' }, 'choisie') : null);
    const cats = (assets.music_categories ?? []).filter((c) => assets.music.some((m) => m.category === c.id));
    if (musicCat !== 'all' && !cats.some((c) => c.id === musicCat)) musicCat = 'all';
    const shown = assets.music.filter((m) => musicCat === 'all' || m.category === musicCat);
    const chip = (id, label, n) => el('button', { type: 'button', class: musicCat === id ? 'st-chip on' : 'st-chip', 'aria-pressed': String(musicCat === id), 'data-k': `c:${id}`, onclick: () => { musicCat = id; renderMusic(); } }, `${label} (${n})`);
    const vol = (label, key, min, max, get, set) => {
      const out = el('output', {}, `${Math.round(get() * 100)} %`);
      const input = el('input', { type: 'range', min, max, step: '1', value: String(Math.round(get() * 100)), id: `st-vol-${key}` });
      input.addEventListener('input', () => { set(Number(input.value) / 100); out.textContent = `${input.value} %`; applyAudio(); });
      input.addEventListener('change', () => savePrefs(S));
      return el('div', { class: 'st-row' }, el('label', { for: input.id }, label), el('div', { class: 'st-row-ctl' }, input, out));
    };
    putKeep(panelMusic,
      el('h3', {}, 'Musique de fond'),
      el('p', { class: 'st-help' }, 'Motivantes, épiques, cinématiques : le morceau est joué sous la voix (en boucle s’il est plus court que le clip). Appuie sur ▶ pour écouter.'),
      ...(cats.length > 1 ? [el('div', { class: 'st-chips', role: 'group', 'aria-label': 'Catégorie de musique', 'data-adv': '' }, chip('all', 'Toutes', assets.music.length), cats.map((c) => chip(c.id, c.label, assets.music.filter((m) => m.category === c.id).length)))] : []),
      el('ul', { class: 'st-tracks' }, el('li', { class: S.music.id ? 'st-track' : 'st-track on' }, el('button', { type: 'button', class: 'st-trackname', 'data-k': 't:none', 'aria-pressed': String(!S.music.id), onclick: () => pick(null) }, el('strong', {}, 'Aucune musique'), el('small', {}, 'Seulement la voix')), S.music.id ? null : el('span', { class: 'badge ok' }, 'choisie')), shown.map(track)),
      el('div', { 'data-adv': '' },
        el('h3', {}, 'Volumes'),
        vol('Musique', 'music', 0, 100, () => S.music.volume, (v) => { S.music.volume = v; }),
        vol('Voix', 'voice', 0, 150, () => S.voice, (v) => { S.voice = v; }),
        el('p', { class: 'st-help' }, 'Dans l’aperçu, le volume de la voix ne dépasse pas 100 % ; la vidéo finale applique bien le réglage.')),
    );
  }

  // ============================================================ onglet Cadrage
  const panelFrame = el('div', { class: 'st-panel' });
  /** Réglages du plein écran : suivi automatique du visage (si l'interview a été analysée) et position manuelle. */
  function cropBlock() {
    const fr = S.framing;
    const n = S.extracts.length;
    const unavailable = fr.ready && n > 0 && !fr.loading && !fr.segments; // aucun extrait ne peut être suivi
    const why = { small: 'le visage est trop petit dans l’image', rare: 'le visage est trop peu visible', none: 'aucun visage n’a été repéré' }[fr.reason] ?? 'le visage n’a pas pu être repéré';
    const follow = el('input', { type: 'checkbox', checked: S.layout.follow.on && !unavailable, disabled: unavailable });
    follow.addEventListener('change', () => { S.layout.follow.on = follow.checked; pushFraming(); renderFrame(); renderCreateSummary(); });
    const subject = (value, label) => el('button', { type: 'button', class: S.layout.follow.subject === value ? 'st-chip on' : 'st-chip', 'aria-pressed': String(S.layout.follow.subject === value), onclick: () => { S.layout.follow.subject = value; refreshFraming(); renderFrame(); } }, label);
    const on = S.layout.follow.on && fr.ready && Boolean(fr.segments);
    let status = null;
    let warn = false;
    if (!fr.ready) status = null;
    else if (!n) status = 'Ajoute un extrait pour savoir si le cadrage automatique est possible.';
    else if (fr.loading && !fr.segments) status = 'Recherche du visage…';
    else if (unavailable) {
      status = `Le cadrage automatique n’est pas disponible pour ce clip : ${why}. Règle le cadrage à la main ci-dessous.`;
      warn = true;
    } else if (!S.layout.follow.on) status = `Le cadrage automatique est possible sur ce clip${fr.missing ? ` (sauf pour ${fr.missing} extrait${fr.missing > 1 ? 's' : ''} sur ${n} : ${why})` : ''} : coche la case pour que le cadre suive le visage.`;
    else {
      const who = { lisnard: fr.crowded ? 'David Lisnard' : 'le visage', left: 'le visage de gauche', right: 'le visage de droite' }[S.layout.follow.subject] ?? (fr.faces > 1 ? 'le plus gros visage' : 'le visage');
      const seen = fr.split > 0 ? 'repéré par moments' : `repéré sur ${Math.round(fr.coverage * 100)} % de la durée`;
      if (S.layout.follow.subject === 'lisnard' && fr.crowded) {
        const unsure = fr.identBest !== null
          ? ` (la reconnaissance n’est pas assez sûre sur cette interview)`
          : fr.identified ? ' (visages trop petits ou trop flous pour être reconnus)' : ' (la reconnaissance de David Lisnard n’est pas disponible pour cette interview)';
        status = fr.recognized === fr.crowded
          ? `David Lisnard est reconnu dans ${fr.crowded > 1 ? `les ${fr.crowded} plans` : 'le plan'} où plusieurs personnes apparaissent : le cadre le suit (${seen}).`
          : `David Lisnard est reconnu dans ${fr.recognized} des ${fr.crowded} plan${fr.crowded > 1 ? 's' : ''} à plusieurs personnes ; ailleurs le cadre suit le plus gros visage${unsure} (${seen}).`;
      } else status = `${fr.faces > 1 ? `${fr.faces} visages repérés. ` : ''}Le cadre suit ${who} (${seen}).`;
      if (fr.split > 0) {
        // le visage suivi n'est pas repéré partout : l'écran est coupé en deux pour qu'aucune des deux personnes ne sorte du cadre
        const top = { lisnard: 'David Lisnard', left: 'la personne de gauche', right: 'la personne de droite' }[S.layout.follow.subject] ?? 'la personne suivie';
        status += fr.split >= 0.98
          ? ` Le visage n’est pas repéré partout : l’écran est coupé en deux, ${top} en haut et l’autre personne en bas, pour que personne ne sorte du cadre.`
          : ` Dans ${Math.round(fr.split * 100)} % du clip, le visage n’est pas repéré partout : l’écran est alors coupé en deux, ${top} en haut et l’autre personne en bas.`;
      }
      if (fr.missing) status += ` Pour ${fr.missing} extrait${fr.missing > 1 ? 's' : ''} sur ${n}, ${why} : le cadrage manuel s’y applique.`;
    }
    return el('div', { class: 'st-sub-block' },
      fr.ready
        ? el('label', { class: 'st-check' }, follow, 'Suivre automatiquement le visage')
        : el('p', { class: 'st-help' }, detail.faces?.poor ? 'Le suivi automatique du visage n’est pas disponible pour cette interview (visages trop petits ou trop rarement visibles) : règle le cadrage à la main.' : 'Le suivi automatique du visage n’est pas disponible pour cette interview : règle le cadrage à la main.'),
      status ? el('p', { class: warn ? 'st-help warn' : 'st-help', role: 'status' }, status) : null,
      on && S.layout.follow.on && fr.faces > 1 ? el('div', { class: 'st-chips', role: 'group', 'aria-label': 'Visage à suivre' }, fr.identified ? subject('lisnard', 'David Lisnard') : null, subject('auto', 'Le plus gros'), subject('left', 'Celui de gauche'), subject('right', 'Celui de droite')) : null,
      on && fr.coverage < 0.6 ? el('p', { class: 'st-help warn' }, 'Le visage est assez peu visible dans ces extraits : le cadrage peut être approximatif. Vérifie l’aperçu.') : null,
      !on
        ? el('div', {},
            el('p', { class: 'st-help' }, 'Glisse la vidéo vers la gauche ou la droite sur l’aperçu pour recentrer le cadrage sur la personne. Le curseur permet de régler plus finement.'),
            el('div', { class: 'st-row' }, el('label', { for: 'st-crop' }, 'Position du cadrage'), el('div', { class: 'st-row-ctl' }, el('span', { class: 'st-end' }, 'gauche'), cropSlider, el('span', { class: 'st-end' }, 'droite'))),
            el('button', { type: 'button', class: 'st-mini wide', onclick: () => { S.layout.cropX = 0.5; cropSlider.value = '50'; pushFraming(); } }, 'Recentrer'))
        : el('p', { class: 'st-help' }, 'Pour régler le cadrage à la main, décoche le suivi du visage.'));
  }

  function renderFrame() {
    const opt = (value, title, text) => el('label', { class: S.layout.fit === value ? 'st-opt on' : 'st-opt' },
      el('input', { type: 'radio', name: 'fit', value, 'data-k': `fit:${value}`, checked: S.layout.fit === value, onchange: () => { S.layout.fit = value; savePrefs(S); pushFraming(); renderFrame(); schedulePreview(); renderCreateSummary(); } }),
      el('strong', {}, title), el('small', {}, text));
    cropSlider = el('input', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(S.layout.cropX * 100)), id: 'st-crop' });
    cropSlider.addEventListener('input', () => { S.layout.cropX = Number(cropSlider.value) / 100; pushFraming(); });
    const mirror = el('input', { type: 'checkbox', checked: S.layout.mirror });
    mirror.addEventListener('change', () => { S.layout.mirror = mirror.checked; savePrefs(S); pushFraming(); renderCreateSummary(); });
    putKeep(panelFrame,
      el('h3', {}, 'Format de la vidéo'),
      el('div', { class: 'st-opts' }, opt('blur', 'Vidéo entière', 'Sur un fond flou fait avec la vidéo'), opt('crop', 'Plein écran', 'La vidéo est recadrée pour remplir l’écran')),
      S.layout.fit === 'crop' ? cropBlock() : null,
      el('div', { 'data-adv': '' }, // niveau avancé seulement
        el('h3', {}, 'Ton logo'),
        el('p', { class: 'st-help' }, 'Facultatif : le logo de ton compte, à l’endroit de ton choix, pendant tout le clip. Il n’apparaît que dans ta vidéo, jamais dans la version publiée dans la bibliothèque.'),
        logoBlock(),
        el('h3', {}, 'Miroir'),
        el('label', { class: 'st-check' }, mirror, 'Retourner l’image horizontalement (miroir)'),
        el('p', { class: 'st-help' }, 'L’image est retournée gauche-droite ; les sous-titres ne le sont jamais. Attention : les textes visibles dans l’image (panneaux, logos, bandeaux de chaîne) apparaîtront à l’envers. Le miroir ne change pas les droits sur la vidéo d’origine.')),
    );
  }

  // ============================================================ account logo (Format tab)
  // Kept in this browser only; sent for the render and never published with the library copy
  const saveLogoPrefs = () => {
    try {
      localStorage.setItem(LOGO_KEY, JSON.stringify(S.logo));
    } catch {
      toast('Logo trop lourd pour être gardé dans ce navigateur : il servira pour cette vidéo seulement.', true);
    }
  };
  const pushLogo = () => phone.setLogo({ url: S.logo.on ? S.logo.dataUrl : '', pos: S.logo.pos, size: S.logo.size, opacity: S.logo.opacity });
  const logoChanged = (rerender = true) => {
    saveLogoPrefs();
    pushLogo();
    renderCreateSummary();
    if (rerender) renderFrame();
  };
  async function pickLogo(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return toast('Choisis une image PNG, JPG, WebP ou SVG.', true);
    if (file.size > 8 * 1024 * 1024) return toast('Image trop lourde (8 Mo au maximum).', true);
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const k = Math.min(1, 512 / Math.max(img.naturalWidth || 512, img.naturalHeight || 512));
      const cv = el('canvas', { width: String(Math.max(16, Math.round((img.naturalWidth || 512) * k))), height: String(Math.max(16, Math.round((img.naturalHeight || 512) * k))) });
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      S.logo = { ...S.logo, on: true, dataUrl: cv.toDataURL('image/png') };
      logoChanged();
    } catch {
      toast('Cette image n’a pas pu être lue.', true);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function logoPayload() {
    if (!S.logo.on || !S.logo.dataUrl) return null;
    // Decoded locally: the CSP (connect-src 'self') forbids fetching a data: URL
    const bytes = Uint8Array.from(atob(S.logo.dataUrl.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    const res = await fetch('/api/studio/logo', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) throw new Error(data.error || 'Le logo n’a pas pu être envoyé : réessaie.');
    return { image: data.id, pos: S.logo.pos, size: S.logo.size, opacity: S.logo.opacity };
  }
  const POS_LABELS = { tl: 'En haut à gauche', tc: 'En haut au centre', tr: 'En haut à droite', ml: 'Au milieu à gauche', mc: 'Au centre', mr: 'Au milieu à droite', bl: 'En bas à gauche', bc: 'En bas au centre', br: 'En bas à droite' };
  function logoBlock() {
    const L = S.logo;
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', class: 'st-ec-file', 'data-k': 'logo:file', onchange: (e) => pickLogo(e.target.files[0]) });
    const upload = el('label', { class: 'btn small secondary st-ec-upload' }, L.dataUrl ? 'Changer le logo' : 'Ajouter mon logo', file);
    if (!L.dataUrl) return [upload];
    const range = (k, min, max, value, label, fmt) => {
      const out = el('output', {}, fmt(value));
      const input = el('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(value), 'data-k': `logo:${k}`, 'aria-label': label });
      input.addEventListener('input', () => {
        S.logo[k] = Number(input.value) / 100;
        out.textContent = fmt(Number(input.value));
        logoChanged(false);
      });
      return el('label', { class: 'st-logo-range' }, el('span', {}, label), input, out);
    };
    return [
      el('div', { class: 'st-logo-row' },
        el('img', { class: 'st-logo-thumb', src: L.dataUrl, alt: 'Ton logo' }),
        el('div', { class: 'st-logo-actions' },
          el('label', { class: 'st-check' }, el('input', { type: 'checkbox', checked: L.on, 'data-k': 'logo:on', onchange: (e) => { S.logo.on = e.target.checked; logoChanged(); } }), 'Ajouter mon logo à la vidéo'),
          el('span', {}, upload, el('button', { type: 'button', class: 'st-link', onclick: () => { S.logo = { ...S.logo, on: false, dataUrl: '' }; logoChanged(); } }, 'Retirer')))),
      L.on ? [
        el('p', { class: 'st-ec-label' }, 'Emplacement'),
        el('div', { class: 'st-logo-grid', role: 'group', 'aria-label': 'Emplacement du logo' },
          LOGO.positions.map((p) => el('button', { type: 'button', class: L.pos === p ? 'on' : '', 'aria-pressed': String(L.pos === p), 'aria-label': POS_LABELS[p], title: POS_LABELS[p], 'data-k': `logo:p:${p}`, onclick: () => { S.logo.pos = p; logoChanged(); } }, el('span', {})))),
        range('size', LOGO.minSize * 100, LOGO.maxSize * 100, Math.round(L.size * 100), 'Taille', (v) => `${v} %`),
        range('opacity', LOGO.minOpacity * 100, 100, Math.round(L.opacity * 100), 'Opacité', (v) => `${v} %`),
      ] : null,
    ];
  }

  // ============================================================ onglet Créer
  const panelCreate = el('div', { class: 'st-panel' });
  const panelEnd = el('div', { class: 'st-panel st-panel-end' });
  const createSummary = el('div', {});
  const pledge = el('input', { type: 'checkbox' });
  const makeBtn = el('button', { class: 'btn', type: 'button' }, 'Créer la vidéo');
  // description à copier-coller : légende générée une fois avec les extraits proposés (accroche + 2 à 4 hashtags), suivie de la source
  const sourceField = el('textarea', { class: 'st-source-text', rows: '7', maxlength: String(DESCRIPTION_MAX), 'aria-label': 'Description à copier-coller pour TikTok', 'aria-describedby': 'st-source-count' });
  const sourceCount = el('p', { class: 'st-help st-count', id: 'st-source-count' });
  const countSource = () => {
    sourceCount.textContent = `${sourceField.value.length} / ${DESCRIPTION_MAX} caractères (limite de TikTok et d’Instagram)`;
  };
  let captionEdited = false; // si tu la modifies, elle n'est plus recalculée
  sourceField.addEventListener('input', () => {
    captionEdited = true;
    countSource();
  });
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      sourceField.select();
      return Boolean(document.execCommand?.('copy'));
    }
  };
  const copyBtn = el('button', { class: 'btn secondary small', type: 'button' }, 'Copier la description');
  copyBtn.addEventListener('click', async () => {
    await copyText(sourceField.value);
    copyBtn.textContent = 'Copié ✓';
    setTimeout(() => (copyBtn.textContent = 'Copier la description'), 2000);
  });
  const sourceBox = el('div', { class: 'st-source' }, sourceField, sourceCount, copyBtn);
  const makeMsg = el('p', { class: 'st-msg', role: 'status' });
  const makeHint = el('p', { class: 'st-help', id: 'st-make-hint' });
  makeBtn.setAttribute('aria-describedby', 'st-make-hint');
  const captionHelp = el('p', { class: 'st-help' });
  const jobBox = el('div', { class: 'st-job' });
  let job = null;
  let ready = null;
  let polling = 0;
  let expiryTimer = 0;
  let netFails = 0;
  let netIssue = false;
  const markDelivered = () => {
    S.delivered = true;
    scheduleDraft();
  };
  const jobActive = () => Boolean(job && ['queued', 'running'].includes(job.status));
  const setJob = (next) => {
    job = next;
    S.jobId = next?.id && ['queued', 'running', 'done'].includes(next.status) ? next.id : null;
    scheduleDraft();
  };
  const stopExpiry = () => { clearInterval(expiryTimer); expiryTimer = 0; };

  function renderCreateSummary() {
    const track = assets.music.find((m) => m.id === S.music.id);
    put(createSummary, el('ul', { class: 'st-sum' },
      el('li', {}, el('strong', {}, 'Durée : '), S.extracts.length ? (easy() ? secs(totalS()) : `${secs(totalS())} (${S.extracts.length} extrait${S.extracts.length > 1 ? 's' : ''})`) : 'aucun extrait choisi'),
      el('li', {}, el('strong', {}, 'Sous-titres : '), easy() ? PRESETS[S.style.preset].label : `${PRESETS[S.style.preset].label}, ${fontById.get(S.style.font).label}`),
      el('li', {}, el('strong', {}, 'Musique : '), track ? track.title : 'aucune'),
      editedInClip() ? el('li', {}, el('strong', {}, 'Texte : '), `${editedInClip()} ligne${editedInClip() > 1 ? 's' : ''} de sous-titres corrigée${editedInClip() > 1 ? 's' : ''}`) : null,
      S.endCard.on ? el('li', {}, el('strong', {}, 'Écran de fin : '), `${S.endCard.dur} s`) : null,
      S.logo.on && S.logo.dataUrl ? el('li', {}, el('strong', {}, 'Logo : '), POS_LABELS[S.logo.pos].toLowerCase()) : null,
      el('li', {}, el('strong', {}, 'Format : '), `${S.layout.fit === 'blur' ? 'vidéo entière sur fond flou' : following() ? 'plein écran, suit le visage' : 'plein écran'}${S.layout.mirror ? ', en miroir' : ''}`)));
    const busy = jobActive();
    makeBtn.disabled = !S.extracts.length || !pledge.checked || busy;
    makeHint.textContent = busy ? '' : !S.extracts.length ? 'Ajoute d’abord un extrait (onglet « Extraits »).' : !pledge.checked ? 'Coche l’engagement ci-dessus pour pouvoir créer la vidéo.' : '';
  }
  const quality = (value, title, text) => el('label', { class: S.layout.quality === value ? 'st-opt on' : 'st-opt' },
    el('input', { type: 'radio', name: 'quality', value, 'data-k': `q:${value}`, checked: S.layout.quality === value, onchange: () => { S.layout.quality = value; savePrefs(S); renderCreate(); } }),
    el('strong', {}, title), el('small', {}, text));
  // End card visual: drawn here in a canvas, uploaded as a JPEG when the video is created
  const ec = { photo: null, photoUrl: '', canvas: el('canvas', { class: 'st-ec-canvas', width: '1080', height: '1920', role: 'img', 'aria-label': 'Aperçu de l’écran de fin' }), missing: [], timer: 0, base: null };
  const ecSource = () => sourceText(S.video.title, S.video.published_at);
  const ecMsg = el('p', { class: 'st-help warn', role: 'status' });
  async function drawEc() {
    if (!S.endCard.on) return;
    if (S.endCard.fromClip && !S.endCard.dirty) {
      ec.base ??= await loadImage(`/api/library/clips/${S.endCard.fromClip}/card`).catch(() => null);
      if (ec.base) {
        const ctx = ec.canvas.getContext('2d');
        ctx.drawImage(ec.base, 0, 0, CARD.w, CARD.h);
        ec.missing = [];
        ecMsg.textContent = '';
        return;
      }
    }
    ec.missing = await drawEndCard(ec.canvas, S.endCard.design, { photo: ec.photo, sourceLine: ecSource() });
    ecMsg.textContent = ec.missing.length ? `À compléter : ${ec.missing.join(', ')}.` : '';
  }
  const redrawEc = () => {
    clearTimeout(ec.timer);
    ec.timer = setTimeout(drawEc, 120);
  };
  const ecChanged = (rerender = true, design = false) => {
    if (design) S.endCard.dirty = true;
    savePrefs(S);
    scheduleDraft();
    renderCreateSummary();
    if (rerender) renderEnd();
    else redrawEc();
  };
  const setDesign = (patch, rerender = true) => {
    S.endCard.design = { ...S.endCard.design, ...patch };
    ecChanged(rerender, true);
  };
  async function pickPhoto(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return toast('Choisis une image JPG, PNG ou WebP.', true);
    if (file.size > CARD.maxPhotoMb * 1024 * 1024) return toast(`Image trop lourde (${CARD.maxPhotoMb} Mo au maximum).`, true);
    if (ec.photoUrl) URL.revokeObjectURL(ec.photoUrl);
    ec.photoUrl = URL.createObjectURL(file);
    ec.photo = await loadImage(ec.photoUrl).catch(() => null);
    if (!ec.photo) return toast('Cette image n’a pas pu être lue.', true);
    ecChanged(true, true);
  }
  async function endCardPayload() {
    if (!S.endCard.on) return null;
    await drawEc();
    if (ec.missing.length) {
      openTab('fin');
      throw new Error(`Écran de fin : complète ${ec.missing.join(', ')}, ou décoche-le.`);
    }
    const blob = await cardBlob(ec.canvas);
    const res = await fetch('/api/studio/endcard', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) throw new Error(data.error || 'Le visuel de fin n’a pas pu être envoyé : réessaie.');
    return { on: true, source: false, dur: S.endCard.dur, image: data.id, design: S.endCard.design };
  }
  function endCardBox() {
    const c = S.endCard;
    const d = c.design;
    const t = EC_TEMPLATES[d.template];
    const head = el('label', { class: 'st-check' }, el('input', { type: 'checkbox', checked: c.on, 'data-k': 'ec:on', onchange: (e) => { S.endCard.on = e.target.checked; ecChanged(); } }), 'Ajouter un écran de fin à la vidéo');
    if (!c.on) return el('div', { class: 'st-ec' }, head, el('p', { class: 'st-help' }, 'Un visuel de 2 à 5 s après ton clip : message, citation, chiffre, événement, ta photo…'));
    const chip = (on, label, onclick, k, extra = {}) => el('button', { type: 'button', class: on ? 'st-ec-chip on' : 'st-ec-chip', 'aria-pressed': String(on), 'data-k': k, onclick, ...extra }, label);
    const field = (f) => {
      const value = d.values[f.key] ?? '';
      const input = f.area
        ? el('textarea', { rows: '2', maxlength: String(f.max), placeholder: f.placeholder, 'data-k': `ec:f:${f.key}` }, value)
        : el('input', { type: f.type, maxlength: String(f.max), placeholder: f.placeholder, value, 'data-k': `ec:f:${f.key}` });
      input.addEventListener('input', () => setDesign({ values: { ...S.endCard.design.values, [f.key]: input.value.slice(0, f.max) } }, false));
      input.addEventListener('change', () => renderEnd());
      return el('label', { class: 'st-field' }, f.label, input);
    };
    const photoInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'st-ec-file', 'data-k': 'ec:photo', onchange: (e) => pickPhoto(e.target.files[0]) });
    const wantsPhoto = needsPhoto(d);
    redrawEc();
    return el('div', { class: 'st-ec' },
      head,
      el('div', { class: 'st-ec-grid' },
        el('div', { class: 'st-ec-preview' }, ec.canvas, c.fromClip && !c.dirty ? el('p', { class: 'st-help' }, 'Visuel repris du clip d’origine : modifie-le librement.') : null),
        el('div', { class: 'st-ec-form' },
          el('p', { class: 'st-ec-label' }, 'Modèle'),
          el('div', { class: 'st-ec-chips', role: 'group', 'aria-label': 'Modèle de visuel' },
            Object.entries(EC_TEMPLATES).map(([id, x]) => chip(d.template === id, x.label, () => setDesign({ template: id }), `ec:t:${id}`, { title: x.hint }))),
          el('p', { class: 'st-ec-label' }, 'Couleurs'),
          el('div', { class: 'st-ec-chips', role: 'group', 'aria-label': 'Couleurs' },
            Object.entries(EC_PALETTES).map(([id, p]) => chip(d.palette === id, el('span', { class: 'st-ec-swatch', style: `background:${p.bg};border-color:${p.accent}` }, ''), () => setDesign({ palette: id }), `ec:p:${id}`, { 'aria-label': p.label, title: p.label }))),
          t.fields.map(field),
          el('p', { class: 'st-ec-label' }, 'Photo'),
          el('div', { class: 'st-ec-photo' },
            el('label', { class: 'btn small secondary st-ec-upload' }, ec.photo ? 'Changer la photo' : 'Ajouter une photo', photoInput),
            ec.photo ? el('button', { type: 'button', class: 'st-link', onclick: () => { URL.revokeObjectURL(ec.photoUrl); ec.photo = null; ec.photoUrl = ''; ecChanged(true, true); } }, 'Retirer') : null,
            !t.photo ? el('label', { class: 'st-check' }, el('input', { type: 'checkbox', checked: d.photoBg, 'data-k': 'ec:pbg', onchange: (e) => setDesign({ photoBg: e.target.checked }) }), 'En fond, assombrie') : null),
          wantsPhoto && !ec.photo ? el('p', { class: 'st-help' }, 'Ce modèle utilise ta photo (JPG, PNG ou WebP). Elle n’est pas gardée si tu recharges la page.') : null,
          el('p', { class: 'st-ec-label' }, 'Options'),
          el('div', { class: 'st-ec-opts' },
            el('label', { class: 'st-check' }, el('input', { type: 'checkbox', checked: d.align === 'center', 'data-k': 'ec:al', onchange: (e) => setDesign({ align: e.target.checked ? 'center' : 'left' }) }), 'Centrer'),
            el('label', { class: 'st-check' }, el('input', { type: 'checkbox', checked: d.upper, 'data-k': 'ec:up', onchange: (e) => setDesign({ upper: e.target.checked }) }), 'Majuscules'),
            el('label', { class: 'st-check' }, el('input', { type: 'checkbox', checked: d.logo, 'data-k': 'ec:lg', onchange: (e) => setDesign({ logo: e.target.checked }) }), 'Logo Projet Lisnard'),
            el('label', { class: 'st-check' }, el('input', { type: 'checkbox', checked: d.source, 'data-k': 'ec:src', onchange: (e) => setDesign({ source: e.target.checked }) }), 'Citer l’interview')),
          el('div', { class: 'st-ec-dur', role: 'group', 'aria-label': 'Durée de l’écran de fin' },
            el('span', {}, 'Durée'),
            [2, 3, 4, 5].map((n) => el('button', { type: 'button', class: 'btn small secondary', 'data-k': `ec:d${n}`, 'aria-pressed': String(c.dur === n), onclick: () => { S.endCard.dur = n; savePrefs(S); scheduleDraft(); renderEnd(); renderCreateSummary(); } }, `${n} s`))),
          ecMsg,
          el('p', { class: 'st-help' }, 'S’ajoute après ton clip, en plus de sa durée ; visible dans la vidéo créée, pas dans l’aperçu.'))));
  }

  function renderEnd() {
    putKeep(panelEnd, el('h3', {}, 'Écran de fin'), endCardBox());
  }

  function renderCreate() {
    putKeep(panelCreate,
      el('h3', {}, 'Ton clip'), createSummary,
      el('h3', {}, 'Description à copier-coller'),
      captionHelp,
      sourceBox,
      el('div', { 'data-adv': '' },
        el('h3', {}, 'Qualité'),
        el('div', { class: 'st-opts' }, quality('hd', 'HD 1080 × 1920', 'Meilleure qualité, un peu plus long à créer'), quality('fast', 'Rapide 720 × 1280', 'Création plus rapide, fichier plus léger'))),
      el('label', { class: 'st-check pledge' }, pledge, 'Je m’engage à ne pas déformer le sens des propos de cette interview, y compris dans les sous-titres que j’ai corrigés.'),
      makeBtn, makeHint, makeMsg, jobBox,
      el('p', { class: 'st-help' }, 'Ta vidéo est conservée une heure sur le serveur : télécharge-la dès qu’elle est prête.'),
    );
    renderCreateSummary();
  }
  pledge.addEventListener('change', renderCreateSummary);

  const run = {
    text: el('p', { class: 'st-job-text' }),
    bar: el('progress', { max: '100', 'aria-label': 'Avancement de la création' }),
    say: el('p', { class: 'st-sr', role: 'status' }),
    net: el('p', { class: 'st-help warn' }, 'Connexion instable : on réessaie, ta vidéo continue d’être créée.'),
    cancel: el('button', { class: 'btn secondary small', type: 'button' }, 'Annuler'),
  };
  run.cancel.addEventListener('click', async () => {
    try {
      await api('DELETE', `/render/${job.id}`);
    } catch {
      // Already finished
    }
  });
  function showRunning() {
    const pct = Math.round(job.progress * 100);
    const queued = job.status === 'queued';
    run.text.textContent = queued ? `En attente… (${job.position}${job.position > 1 ? 'e' : 'er'} dans la file)` : `Création de la vidéo… ${pct} %`;
    run.bar.value = queued ? 0 : pct;
    const spoken = queued ? 'En attente dans la file.' : `Création de la vidéo : ${Math.floor(pct / 25) * 25} %`;
    if (run.say.textContent !== spoken) run.say.textContent = spoken;
    run.net.hidden = !netIssue;
    if (jobBox.dataset.mode !== 'running') {
      jobBox.dataset.mode = 'running';
      put(jobBox, run.text, run.bar, run.say, run.net, run.cancel);
    }
  }

  function showExpired() {
    stopExpiry();
    ready = null;
    jobBox.dataset.mode = 'expired';
    put(jobBox,
      el('p', { class: 'st-job-text err', role: 'status' }, 'Ta vidéo a expiré : les clips ne sont conservés qu’une heure.'),
      el('button', { class: 'btn secondary small', type: 'button', onclick: () => { setJob(null); showJob(); } }, 'Créer à nouveau'));
  }

  function showDone() {
    const jobId = job.id;
    const filename = job.filename; // Captured now: `job` may change before the async work ends
    if (job.expiresAt == null && job.expires_in_s != null) job.expiresAt = Date.now() + job.expires_in_s * 1000;
    if (job.expiresAt != null && Date.now() >= job.expiresAt) return showExpired();
    const url = `/api/studio/render/${jobId}/file`;
    const say = (text, kind = 'ok') => { makeMsg.className = `st-msg ${kind === 'ok' ? '' : 'err'}`; makeMsg.textContent = text; };
    const touch = /Android|iPhone|iPad/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const mobile = Boolean(navigator.canShare) && touch;
    const counted = (use) => api('POST', `/render/${jobId}/used`, { use }).catch(() => {});
    const share = el('button', { class: 'btn secondary small', type: 'button' }, 'Partager');
    const publish = el('button', { class: 'btn tiktok', type: 'button' }, 'Publier sur TikTok');
    // Mobile: load the file on first tap; native share needs a fresh user gesture
    const prepare = () => {
      if (ready?.id === jobId) return;
      const mine = (ready = { id: jobId, file: null, failed: false, loading: true, refresh: null });
      fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fichier')))).then((blob) => {
        const file = new File([blob], filename, { type: 'video/mp4' });
        if (navigator.canShare({ files: [file] })) mine.file = file; else mine.failed = true;
      }, () => { mine.failed = true; }).finally(() => { mine.loading = false; mine.refresh?.(); });
    };
    const fileReady = () => (ready?.id === jobId ? ready.file : null);
    const needsPrepare = () => mobile && !fileReady() && !(ready?.id === jobId && ready.failed);
    function setPublishState() {
      const st = ready?.id === jobId ? ready : null;
      publish.disabled = share.disabled = Boolean(mobile && st?.loading);
      publish.textContent = mobile && st?.loading ? 'Préparation de la vidéo…' : mobile && st?.file ? 'Envoyer à TikTok' : 'Publier sur TikTok';
    }
    const afterPrepare = () => {
      setPublishState();
      if (ready?.file) say('Vidéo prête : touche à nouveau le bouton pour l’envoyer.');
      else say('Le partage direct n’est pas disponible ici : le bouton enregistrera la vidéo, puis ouvrira TikTok.', 'err');
    };
    const startPrepare = () => {
      prepare();
      ready.refresh = afterPrepare;
      say('Préparation de la vidéo…');
      setPublishState();
    };
    const saveFile = () => {
      markDelivered();
      const a = el('a', { href: `${url}?use=download`, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
    };
    const openTikTok = () => {
      if (/Android/i.test(navigator.userAgent)) location.href = 'intent://#Intent;scheme=snssdk1233;package=com.zhiliaoapp.musically;S.browser_fallback_url=https%3A%2F%2Fwww.tiktok.com%2Fupload;end';
      else location.href = 'snssdk1233://';
    };
    const nativeShare = (withText) => {
      const file = fileReady();
      if (!file) return null;
      return navigator.share({ files: [file], title: 'Studio Lisnard', ...(withText ? { text: sourceField.value.split('\n\n')[0] } : {}) });
    };
    share.addEventListener('click', async () => {
      if (needsPrepare()) return startPrepare();
      try {
        const p = nativeShare(false);
        if (!p) return say('Le partage direct n’est pas disponible ici : télécharge la vidéo.', 'err');
        await p;
        markDelivered();
        counted('share');
      } catch { /* partage annulé */ }
    });
    publish.addEventListener('click', async () => {
      if (!mobile) {
        window.open('https://www.tiktok.com/upload', '_blank', 'noopener'); // Opened synchronously, otherwise the browser blocks the popup
        saveFile();
        const copied = await copyText(sourceField.value);
        return say(`${copied ? 'Description copiée. ' : ''}La vidéo se télécharge et TikTok s’ouvre : choisis le fichier, puis colle la description.`);
      }
      if (needsPrepare()) return startPrepare();
      const copying = copyText(sourceField.value); // sans attendre : le partage doit partir dans le geste du clic
      const sharing = nativeShare(true);
      if (sharing) {
        try {
          await sharing;
          markDelivered();
          counted('share');
          return say((await copying) ? 'Description copiée : colle-la dans la légende de TikTok.' : 'Vidéo envoyée.');
        } catch (e) {
          if (e?.name === 'AbortError') return say((await copying) ? 'Partage annulé. La description reste copiée.' : 'Partage annulé.');
        }
      }
      // Repli : le partage n'a pas pu s'ouvrir.
      saveFile();
      say(`${(await copying) ? 'Description copiée. ' : ''}Vidéo enregistrée : dans TikTok, appuie sur « + », puis choisis-la dans ta galerie.`);
      setTimeout(openTikTok, 1200);
    });
    if (ready?.id === jobId) ready.refresh = afterPrepare;
    setPublishState();
    const expiry = el('p', { class: 'st-help' });
    const tickExpiry = () => {
      const left = Math.round((job.expiresAt - Date.now()) / 1000);
      if (left <= 0) return showExpired();
      expiry.textContent = left < 60 ? 'Ta vidéo expire dans moins d’une minute : télécharge-la maintenant.' : `Ta vidéo reste disponible encore ${Math.ceil(left / 60)} min.`;
      expiry.className = left < 300 ? 'st-help warn' : 'st-help';
    };
    stopExpiry();
    if (job.expiresAt != null) {
      tickExpiry();
      expiryTimer = setInterval(tickExpiry, 1000);
    }
    jobBox.dataset.mode = 'done';
    put(jobBox,
      el('p', { class: 'st-job-text ok', role: 'status' }, 'Ta vidéo est prête !'),
      job.has_logo ? el('p', { class: 'st-help' }, 'Ta vidéo contient ton logo ; la version publiée dans la bibliothèque n’en a pas.') : null,
      libraryBox(jobId),
      job.expiresAt != null ? expiry : null,
      el('video', { class: 'st-result', src: url, controls: true, playsinline: '', preload: 'metadata' }),
      el('div', { class: 'st-job-actions' }, publish, el('a', { class: 'btn secondary', href: `${url}?use=download`, download: filename, onclick: () => { markDelivered(); } }, 'Télécharger'), mobile ? share : null,
        el('button', { class: 'btn secondary small', type: 'button', onclick: () => { stopExpiry(); S.delivered = false; setJob(null); showJob(); } }, 'Faire un autre clip')),
      el('p', { class: 'st-help' }, 'Description et source prêtes à coller : « Copier la description » ci-dessus (la vidéo n’affiche pas la source).'));
  }

  const lib = { jobId: null, clip: null, busy: false, off: false, error: '' };
  const libPref = () => loadPrefs().library !== false;
  const setLibPref = (on) => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ ...loadPrefs(), library: on }));
    } catch {
      // Storage unavailable: harmless
    }
  };
  const libNode = el('div', { class: 'st-lib' });
  async function libDo(fn) {
    lib.busy = true;
    lib.error = '';
    renderLib();
    try {
      await fn();
    } catch (e) {
      lib.error = e.status === 401 ? 'Connecte-toi avec ton compte adhérent pour publier.' : e.message;
    }
    lib.busy = false;
    renderLib();
  }
  const libPublish = () => libDo(async () => {
    const clip = await libApi('POST', '/clips', { job_id: lib.jobId, visibility: 'public', remix_of: S.remixOf ?? null });
    if (clip === null) lib.off = true;
    else lib.clip = clip;
  });
  function renderLib() {
    if (lib.off) return put(libNode);
    const check = el('input', { type: 'checkbox', disabled: lib.busy });
    check.checked = Boolean(lib.clip);
    check.addEventListener('change', () => {
      setLibPref(check.checked);
      if (check.checked) libPublish();
      else if (lib.clip) libDo(async () => { await libApi('DELETE', `/clips/${lib.clip.id}`); lib.clip = null; });
    });
    const c = lib.clip;
    put(libNode,
      el('label', { class: 'st-check' }, check, 'Publier dans la bibliothèque (visible par tous pendant 30 jours)'),
      c ? el('p', { class: 'st-help' },
        c.visibility === 'public' ? 'Publié : les autres peuvent le télécharger, le noter et le réutiliser. ' : 'Gardé en privé dans « Mes clips ». ',
        el('a', { href: `/bibliotheque/?clip=${c.id}` }, 'Voir dans la bibliothèque'), ' · ',
        el('button', { class: 'st-link', type: 'button', disabled: lib.busy, onclick: () => libDo(async () => { lib.clip = await libApi('PATCH', `/clips/${c.id}`, { visibility: c.visibility === 'public' ? 'private' : 'public' }); }) },
          c.visibility === 'public' ? 'Passer en privé' : 'Rendre public')) : null,
      lib.busy ? el('p', { class: 'st-help', role: 'status' }, 'Bibliothèque…') : null,
      lib.error ? el('p', { class: 'st-help warn', role: 'alert' }, lib.error) : null);
  }
  function libraryBox(jobId) {
    if (lib.jobId !== jobId) {
      Object.assign(lib, { jobId, clip: null, busy: false, error: '' });
      if (libPref()) libPublish();
    }
    renderLib();
    return libNode;
  }

  function showJob() {
    if (!job) {
      stopExpiry();
      jobBox.dataset.mode = '';
      put(jobBox);
    } else if (jobActive()) {
      stopExpiry();
      showRunning();
    } else if (job.status === 'done') {
      showDone();
    } else {
      stopExpiry();
      jobBox.dataset.mode = job.status;
      put(jobBox, el('p', { class: job.status === 'cancelled' ? 'st-job-text' : 'st-job-text err', role: 'status' }, job.status === 'cancelled' ? 'Création annulée.' : job.error || 'La création a échoué.'));
    }
    renderCreateSummary();
  }
  async function poll() {
    clearTimeout(polling);
    if (!jobActive()) return;
    const id = job.id;
    try {
      const next = await api('GET', `/render/${id}`);
      if (job?.id !== id) return;
      netFails = 0;
      netIssue = false;
      setJob(next);
    } catch (e) {
      if (e.gate || job?.id !== id) return;
      if (e.status !== 404) {
        // Network error or 5xx: the server keeps rendering, retry with backoff
        netFails += 1;
        netIssue = true;
        showJob();
        polling = setTimeout(poll, Math.min(900 * 2 ** netFails, 10000));
        return;
      }
      setJob({ id, status: 'error', error: e.message });
    }
    showJob();
    if (jobActive()) polling = setTimeout(poll, 900);
  }
  async function resumeJob(id) {
    try {
      setJob(await api('GET', `/render/${id}`));
    } catch (e) {
      if (e.status === 404) {
        S.jobId = null;
        scheduleDraft();
      }
      return;
    }
    if (!['queued', 'running', 'done'].includes(job.status)) return setJob(null);
    showJob();
    openTab('creer');
    if (jobActive()) poll();
  }
  makeBtn.addEventListener('click', async () => {
    makeMsg.textContent = '';
    makeBtn.disabled = true;
    try {
      netFails = 0;
      netIssue = false;
      S.delivered = false;
      setJob(await api('POST', '/render', {
        youtube_id: S.video.youtube_id,
        extracts: S.extracts.map(exMs),
        layout: S.layout,
        style: S.style,
        music: S.music.id ? S.music : null,
        voice: S.voice,
        edits: Object.fromEntries(clipLines().filter((r) => S.edits.has(r.line.start_ms)).map((r) => [r.line.start_ms, S.edits.get(r.line.start_ms).text])),
        end_card: await endCardPayload(),
        logo: await logoPayload(),
      }));
      showJob();
      poll();
    } catch (e) {
      if (!e.gate) fail(makeMsg, e);
      renderCreateSummary();
    }
  });

  const beforeUnload = (e) => {
    const waiting = job?.status === 'done' && !S.delivered && !(job.expiresAt != null && Date.now() >= job.expiresAt);
    if (!jobActive() && !waiting) return;
    e.preventDefault();
    e.returnValue = '';
  };
  addEventListener('beforeunload', beforeUnload);

  /** Description à copier : légende de l'extrait choisi (générée avec les extraits), puis la source de l'interview et les crédits de la musique. */
  function updateSource() {
    captionHelp.textContent = S.extracts.some((e) => e.caption)
      ? 'Légende TikTok prête à l’emploi (accroche et hashtags proposés avec l’extrait), suivie de la source de l’interview, que la vidéo n’affiche pas. Tu peux la modifier.'
      : 'Source de l’interview à coller dans ta description, car la vidéo ne l’affiche pas. Ajoute ton accroche et tes hashtags.';
    if (captionEdited) return;
    const caption = S.extracts.find((e) => e.caption)?.caption ?? '';
    const song = assets.music.find((m) => m.id === S.music.id);
    const source =
      `${sourceText(S.video.title, S.video.published_at)} — https://www.youtube.com/watch?v=${S.video.youtube_id}` +
      (song?.credit ? `\nMusique : ${song.title} — ${song.credit}` : '');
    sourceField.value = fitDescription(caption, source);
    countSource();
    const wrapped = sourceField.value.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 30)), 0);
    sourceField.rows = Math.min(12, Math.max(3, wrapped + 1));
  }

  // ============================================================ niveau : débutant ou avancé
  // Le parcours avancé est le studio complet ; le parcours débutant retire les outils fins (voir `data-adv`, `easyExtracts` et studio.css).
  const panelLevel = el('div', { class: 'st-panel' });
  let beginnerBackup = null; // réglages avancés mis de côté pendant le parcours débutant, rendus au retour en avancé
  function enterBeginner() {
    if (S.extracts.length > 1) S.extracts = S.extracts.slice(0, 1); // un seul extrait en débutant
    if (beginnerBackup) return;
    beginnerBackup = { mirror: S.layout.mirror, logoOn: S.logo.on, endCardOn: S.endCard.on, quality: S.layout.quality, musicVolume: S.music.volume, voice: S.voice };
    Object.assign(S.layout, { mirror: BEGINNER_DEFAULTS.mirror, quality: BEGINNER_DEFAULTS.quality });
    S.logo = { ...S.logo, on: BEGINNER_DEFAULTS.logoOn };
    S.endCard = { ...S.endCard, on: BEGINNER_DEFAULTS.endCardOn };
    S.music.volume = BEGINNER_DEFAULTS.musicVolume;
    S.voice = BEGINNER_DEFAULTS.voice;
  }
  function leaveBeginner() {
    if (!beginnerBackup) return;
    const b = beginnerBackup;
    beginnerBackup = null;
    Object.assign(S.layout, { mirror: b.mirror, quality: b.quality });
    S.logo = { ...S.logo, on: b.logoOn };
    S.endCard = { ...S.endCard, on: b.endCardOn };
    S.music.volume = b.musicVolume;
    S.voice = b.voice;
  }
  const LEVEL_LABEL = { debutant: 'Débutant', avance: 'Avancé' };
  function renderLevel() {
    const opt = (value, title, desc, what) => el('label', { class: S.level === value ? 'st-level on' : 'st-level' },
      el('input', { type: 'radio', name: 'level', value, 'data-k': `level:${value}`, checked: S.level === value, onchange: () => setLevel(value) }),
      el('strong', { class: 'st-level-title' }, title),
      el('span', { class: 'st-level-desc' }, desc),
      el('small', { class: 'st-level-what' }, what));
    putKeep(panelLevel,
      el('div', { class: 'st-levels', role: 'radiogroup', 'aria-label': 'Ton niveau' },
        opt('debutant', 'Débutant', 'Je n’utilise pas ce genre d’outils régulièrement et je crée rarement des vidéos TikTok.', 'Un parcours simple : tu choisis un extrait proposé, un style de sous-titres, une musique, et on s’occupe du reste.'),
        opt('avance', 'Avancé', 'Je crée régulièrement des vidéos TikTok et je veux personnaliser complètement ma vidéo.', 'Tous les réglages : passage libre, durée, polices, couleurs, volumes, logo, miroir, écran de fin…')),
      el('p', { class: 'st-help' }, 'Tu pourras changer de niveau à tout moment : ton extrait est gardé.'));
  }
  /** Applique un niveau : parcours (étapes), outils visibles et réglages simples du parcours débutant. */
  function setLevel(level) {
    if (!level || level === S.level) return;
    S.level = level;
    saveLevel(level);
    root.dataset.level = level;
    if (level === 'debutant') {
      enterBeginner();
      openSub('look'); // l'onglet « Texte » n'existe pas en débutant
    } else leaveBeginner();
    mountSteps();
    renderLevel();
    extractsChanged();
    renderMusic();
    renderFrame();
    renderCreate();
    renderEnd();
    applyAudio();
    pushFraming();
    pushLogo();
    syncStyleControls();
    savePrefs(S);
    openTab(root.dataset.tab || 'niveau');
  }

  // ============================================================ mise en page : une étape à la fois
  // étape 1 = choix de l'interview (page d'accueil du studio) ; les suivantes sont les panneaux ci-dessous, dans l'ordre (voir FLOW)
  const CONTENT = {
    niveau: { title: 'Quel est ton niveau ?', hint: 'Choisis ce qui te ressemble : on adapte les étapes pour que ce soit simple pour toi.', panel: panelLevel },
    extraits: {
      title: 'Choisis ton extrait',
      hint: { debutant: 'Voici les meilleurs passages repérés par l’intelligence artificielle. Touche « Choisir cet extrait » sous celui qui te plaît : tu le vois tout de suite dans l’aperçu.', avance: 'Prends un extrait proposé par l’IA, ou cherche le passage que tu veux dans la transcription.' },
      panel: panelExtracts,
    },
    style: {
      title: 'Choisis tes sous-titres',
      hint: { debutant: 'Touche le style que tu préfères : tu le vois tout de suite dans l’aperçu.', avance: 'Le style, la police, les couleurs et la position. Tu peux aussi corriger le texte.' },
      panel: panelStyle,
    },
    musique: {
      title: 'Ajoute de la musique',
      hint: { debutant: 'Facultatif. Touche ▶ pour écouter un morceau, puis touche son nom pour le choisir.', avance: 'Facultatif : un fond sonore discret sous la voix.' },
      panel: panelMusic,
    },
    cadrage: {
      title: 'Choisis le format',
      hint: { debutant: 'Comment la vidéo remplit l’écran du téléphone.', avance: 'Comment la vidéo remplit l’écran vertical, et ton logo.' },
      panel: panelFrame,
    },
    fin: { title: 'Termine sur un écran de fin', hint: 'Facultatif : un visuel de quelques secondes ajouté après le clip.', panel: panelEnd },
    creer: {
      title: 'Crée ta vidéo',
      hint: { debutant: 'Vérifie le résumé, coche la case, puis touche « Créer la vidéo ».', avance: 'Vérifie le résumé, puis lance la création.' },
      panel: panelCreate,
    },
  };
  const textOf = (v) => (typeof v === 'string' ? v : v[easy() ? 'debutant' : 'avance']);
  const stepList = () => stepsFor(S.level); // [{ id, label }] sans l'étape 1 (l'interview)
  const stage = el('div', { class: 'st-stage card' });
  let steps = createSteps(stepLabels(S.level), (n) => goStep(n));
  const goStep = (n) => (n === 1 ? (location.href = '/') : openTab(stepList()[n - 2].id, true));
  /** Reconstruit la barre des étapes (le niveau change le nombre d'étapes). */
  function mountSteps() {
    const next = createSteps(stepLabels(S.level), goStep);
    steps.root.replaceWith(next.root);
    steps = next;
  }
  const stepEyebrow = el('p', { class: 'eyebrow' });
  const stepTitle = el('h2', { class: 'st-step-title', tabindex: '-1' });
  const stepHint = el('p', { class: 'st-help' });
  const levelNote = el('p', { class: 'st-levelnote' });
  const stepHead = el('header', { class: 'st-stephead' }, stepEyebrow, stepTitle, stepHint, levelNote);
  const prevBtn = el('button', { class: 'btn secondary st-prev', type: 'button' });
  const nextBtn = el('button', { class: 'btn st-next', type: 'button' });
  const nextNote = el('p', { class: 'st-help st-next-note', role: 'status' });
  const nextBar = el('div', { class: 'st-nextbar' }, prevBtn, nextBtn, nextNote);
  const stepOf = () => stepList().findIndex((st) => st.id === root.dataset.tab);
  /** Une étape est ouverte : le niveau choisi pour celles d'après le niveau, un extrait pour celles d'après l'extrait. */
  const allowed = (id) => id === 'niveau' || (S.level !== null && (id === 'extraits' || S.extracts.length > 0));
  /** Boutons Retour / Suivant et barre des étapes. */
  function syncNav() {
    const list = stepList();
    const i = stepOf();
    if (i < 0) return;
    steps.sync(i + 2, (n) => n === 1 || allowed(list[n - 2].id));
    const next = list[i + 1];
    nextBtn.hidden = !next;
    nextBtn.disabled = !next || !allowed(next.id);
    nextBtn.textContent = !next ? '' : list[i].id === 'niveau' ? 'Continuer →' : `Étape suivante : ${next.label} →`;
    nextNote.textContent = next && !allowed(next.id) ? (list[i].id === 'niveau' ? 'Choisis ton niveau pour continuer.' : 'Choisis d’abord un extrait pour continuer.') : '';
    prevBtn.textContent = i === 0 ? '← Changer d’interview' : '← Retour';
  }
  function openTab(id, focus = false) {
    const list = stepList();
    const i = list.findIndex((st) => st.id === id);
    if (i < 0) return;
    Object.entries(CONTENT).forEach(([sid, c]) => (c.panel.hidden = sid !== id));
    root.dataset.tab = id;
    stepEyebrow.textContent = `Étape ${i + 2} sur ${list.length + 1}`;
    stepTitle.textContent = CONTENT[id].title;
    stepHint.textContent = textOf(CONTENT[id].hint);
    put(levelNote, id !== 'niveau' && S.level ? [`Niveau : ${LEVEL_LABEL[S.level]} · `, el('button', { type: 'button', class: 'st-link', onclick: () => openTab('niveau', true) }, 'Changer de niveau')] : null);
    modelsBar.hidden = id === 'niveau' || id === 'extraits' || easy(); // les modèles enregistrent les réglages d'habillage : pas avant l'extrait, pas en débutant
    if (id === 'niveau') renderLevel();
    syncNav();
    if (id !== 'musique' && auditionId) { audition.pause(); auditionId = null; renderMusic(); }
    if (id === 'creer') renderCreateSummary();
    if (id === 'fin') renderEnd();
    if (focus) {
      stepTitle.focus({ preventScroll: true });
      steps.root.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
  Object.entries(CONTENT).forEach(([id, { panel }]) => {
    panel.id = `st-p-${id}`;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', 'st-step-title');
  });
  stepTitle.id = 'st-step-title';
  prevBtn.addEventListener('click', () => (stepOf() === 0 ? (location.href = '/') : openTab(stepList()[stepOf() - 1].id, true)));
  nextBtn.addEventListener('click', () => openTab(stepList()[stepOf() + 1].id, true));
  const modelsBar = el('div', { class: 'st-models' });
  let undoModel = null;
  const readModels = () => {
    try {
      return parseModels(localStorage.getItem(MODELS_KEY));
    } catch {
      return [];
    }
  };
  const writeModels = (list) => {
    try {
      localStorage.setItem(MODELS_KEY, JSON.stringify(list));
      return true;
    } catch {
      toast('Impossible d’enregistrer : le stockage du navigateur est indisponible.', true);
      return false;
    }
  };
  const modelContext = () => ({ fontIds, musicIds: assets.music.map((m) => m.id), framingReady: S.framing.ready, identified: S.framing.identified });
  function applySettings(m) {
    S.style = m.style;
    S.music = { id: m.music.id, volume: m.music.volume };
    S.voice = m.voice;
    S.layout = { ...S.layout, fit: m.layout.fit, quality: m.layout.quality, mirror: m.layout.mirror, follow: { ...m.layout.follow } };
    S.endCard = { ...m.endCard };
    renderPresets();
    renderFonts();
    syncStyleControls();
    rebuildSubtitles();
    renderMusic();
    applyAudio();
    renderFrame();
    pushFraming();
    renderCreate();
    renderEnd();
    savePrefs(S);
    scheduleDraft();
    requestPreview();
  }
  function applyModel(model) {
    undoModel = { ...sanitizeModel(modelFromState(S), modelContext()), endCard: { ...S.endCard } };
    applySettings(sanitizeModel(model.settings, modelContext()));
    renderModels();
    toast(`Modèle « ${model.name} » appliqué.`);
  }
  function saveModel() {
    const list = readModels();
    const name = (prompt('Nom du modèle (ex. « Débat punchy ») :') ?? '').trim().slice(0, MODELS.nameMax);
    if (!name) return;
    const same = list.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (!same && list.length >= MODELS.max) return toast(`${MODELS.max} modèles au maximum : supprimes-en un d’abord.`, true);
    if (same && !confirm(`Remplacer le modèle « ${same.name} » ?`)) return;
    const entry = { id: same?.id ?? `m${Date.now().toString(36)}`, name, settings: modelFromState(S) };
    if (writeModels([...list.filter((m) => m.id !== entry.id), entry])) {
      toast(`Modèle « ${name} » enregistré.`);
      renderModels(entry.id);
    }
  }
  function renameModel(model) {
    const name = (prompt('Nouveau nom :', model.name) ?? '').trim().slice(0, MODELS.nameMax);
    if (!name) return;
    if (writeModels(readModels().map((m) => (m.id === model.id ? { ...m, name } : m)))) renderModels(model.id);
  }
  function deleteModel(model) {
    if (!confirm(`Supprimer le modèle « ${model.name} » ?`)) return;
    if (writeModels(readModels().filter((m) => m.id !== model.id))) renderModels();
  }
  function renderModels(selected = '') {
    const list = readModels();
    const pick = el('select', { 'aria-label': 'Choisir un modèle', 'data-k': 'models' },
      el('option', { value: '' }, list.length ? 'Mes modèles…' : 'Aucun modèle enregistré'),
      list.map((m) => el('option', { value: m.id, selected: m.id === selected }, m.name)));
    const current = () => list.find((m) => m.id === pick.value);
    const tools = el('span', { class: 'st-models-tools' });
    const sync = () => put(tools, current() ? [
      el('button', { type: 'button', class: 'btn small', onclick: () => applyModel(current()) }, 'Appliquer'),
      el('button', { type: 'button', class: 'st-link', onclick: () => renameModel(current()) }, 'Renommer'),
      el('button', { type: 'button', class: 'st-link', onclick: () => deleteModel(current()) }, 'Supprimer'),
    ] : []);
    pick.addEventListener('change', sync);
    sync();
    putKeep(modelsBar,
      el('span', { class: 'st-models-label' }, 'Modèles'),
      list.length ? pick : null,
      tools,
      el('button', { type: 'button', class: 'st-link', title: 'Style, musique, format et écran de fin (pas les extraits)', onclick: saveModel }, '+ Enregistrer mes réglages'),
      undoModel ? el('button', { type: 'button', class: 'st-link', onclick: () => { const back = undoModel; undoModel = null; applySettings(back); renderModels(); toast('Réglages précédents rétablis.'); } }, 'Annuler le modèle') : null,
      el('span', { class: 'st-help inline st-models-hint' }, 'Gardés dans ce navigateur'),
    );
  }

  stage.append(steps.root, stepHead, modelsBar, ...Object.values(CONTENT).map((c) => c.panel), nextBar);
  renderModels();

  // « ← Autres interviews » et le titre vont dans l'en-tête bleu : un titre long sur deux ou trois lignes (téléphone) ne déborde plus
  // en blanc sur le fond clair
  const hero = document.querySelector('.hero .wrap');
  hero?.querySelector('.st-top')?.remove();
  const top = el('div', { class: 'st-top' }, el('a', { class: 'st-back', href: '/' }, '← Autres interviews'), el('p', { class: 'st-title' }, S.video.title));
  if (hero) {
    hero.append(top);
    hero.closest('.hero').classList.add('editor');
  }
  root.classList.add('editing');
  put(root,
    hero ? null : top,
    el('div', { class: 'st-grid' }, el('div', { class: 'st-left' }, phone.root), stage),
    disclaimer(),
    toastEl,
  );

  const fromClip = await draftFromLibrary();
  const restored = fromClip ? restoreDraft(fromClip) : restoreDraft();
  if (fromClip && restored) saveDraftNow();
  root.dataset.level = S.level ?? '';
  if (easy()) enterBeginner();
  renderPresets();
  renderFonts();
  renderExtracts();
  renderMusic();
  renderFrame();
  renderCreate();
  renderEnd();
  panelStyle.prepend(subNav, textWrap, lookWrap);
  openSub('look');
  syncStyleControls();
  applyAudio();
  pushFraming();
  pushLogo();
  openTab('niveau');

  const best = [...S.suggestions].sort((x, y) => y.score - x.score)[0];
  if (!restored && best) addExtract(best.start_ms, best.end_ms, best.title, best.start_ms, best.description);
  else extractsChanged();
  booting = false;
  if (S.jobId) resumeJob(S.jobId);

  teardown = () => {
    clearTimeout(polling);
    clearTimeout(previewTimer);
    stopExpiry();
    phone.pause();
    phone.setAudio({ url: null });
    audition.pause();
    jobBox.querySelector('video')?.pause();
    removeEventListener('beforeunload', beforeUnload);
    removeEventListener('pagehide', onPageHide);
  };
}

async function start() {
  try {
    if (!(await memberGate())) return;
    const id = params.get('v');
    if (id) await openEditor(id);
    else await showList();
  } catch (e) {
    if (e.gate) return;
    put(root, el('section', { class: 'card st-empty' },
      el('h2', {}, 'Oups'),
      el('p', { role: 'alert' }, e.message),
      el('p', { class: 'st-gate-actions' },
        el('button', { class: 'btn small', type: 'button', onclick: () => { mePromise = fetchMe(); put(root, el('p', { class: 'hint', role: 'status' }, 'Chargement du studio…')); start(); } }, 'Réessayer'),
        el('a', { class: 'btn small secondary', href: '/' }, 'Retour à la liste'))));
  }
}
start();
