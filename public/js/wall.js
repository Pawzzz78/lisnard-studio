// Mur des clips : classement des TikToks du hashtag suivi, présenté comme un collage d'affiches. Les données viennent de /api/wall
// (lue dans la base du serveur) ; le papier déchiré et l'inclinaison des affiches sont tirés au hasard à partir de l'identifiant du clip,
// donc stables d'une visite à l'autre.

const SORTS = [
  ['score', 'Classement'],
  ['views', 'Vues'],
  ['likes', 'J’aime'],
  ['comments', 'Commentaires'],
];
// adresses lisibles : /mur/?tri=vues&periode=7
const SORT_PARAM = { score: 'classement', views: 'vues', likes: 'jaime', comments: 'commentaires' };
const PAGE = 60; // le serveur limite de toute façon le classement à son nombre maximal de clips (13)

const $ = (id) => document.getElementById(id);
const DEFAULT_PERIOD = '7'; // le classement affiché d'abord : les 7 derniers jours
const state = { sort: 'score', period: DEFAULT_PERIOD, clips: [], total: 0, max: 13, loading: false, ticket: 0 };
// Un seul appel au serveur par période : le classement ne compte que 13 clips, les onglets Vues / J'aime / Commentaires les réordonnent ici.
const loaded = new Map(); // période → réponse du serveur (clips dans l'ordre du score)
const METRIC = { views: 'views', likes: 'likes', comments: 'comments' };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

// --- papier déchiré -------------------------------------------------------------------------------------------------------------------

const hash = (s) => [...String(s)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
/** Générateur pseudo-aléatoire (mulberry32) : le même identifiant donne toujours la même suite. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Découpe irrégulière d'un rectangle (propriété clip-path) : les côtés demandés (`edges` : lettres t, r, b, l) sont « déchirés », avec des
 * dents de 0 à `amp` pixels, parfois plus profondes ; les autres restent droits.
 */
export function tornPolygon(seed, { edges = 'tblr', amp = 5, along = 18 } = {}) {
  const rnd = rng(hash(seed));
  const jag = (on) => {
    if (!on) return 0;
    const bite = rnd() < 0.12 ? 1.8 : 1; // une encoche plus profonde de temps en temps
    return Math.round(rnd() * amp * bite * 10) / 10;
  };
  const pts = [];
  const side = (n, on, at) => {
    for (let i = 0; i < n; i++) pts.push(at((i / n) * 100 + rnd() * (100 / n) * 0.6, jag(on)));
  };
  side(along, edges.includes('t'), (x, j) => `${x.toFixed(1)}% ${j}px`);
  side(Math.round(along * 1.5), edges.includes('r'), (y, j) => `calc(100% - ${j}px) ${y.toFixed(1)}%`);
  side(along, edges.includes('b'), (x, j) => `${(100 - x).toFixed(1)}% calc(100% - ${j}px)`);
  side(Math.round(along * 1.5), edges.includes('l'), (y, j) => `${j}px ${(100 - y).toFixed(1)}%`);
  return `polygon(${pts.join(', ')})`;
}

/** Applique un bord déchiré aux éléments marqués data-torn (bannière, bande d'appel) : « t » haut, « b » bas, « tb » les deux. */
function tearMarked() {
  document.querySelectorAll('[data-torn]').forEach((node, i) => {
    node.style.clipPath = tornPolygon(`${node.className}-${i}`, { edges: node.dataset.torn, amp: node.classList.contains('torn-edge') ? 16 : 9, along: 30 });
  });
}

// --- icônes et nombres ----------------------------------------------------------------------------------------------------------------

const ICONS = {
  views: 'M12 5C6.5 5 2.7 8.9 1.5 12c1.2 3.1 5 7 10.5 7s9.3-3.9 10.5-7C21.3 8.9 17.5 5 12 5zm0 11.2A4.2 4.2 0 1 1 12 7.8a4.2 4.2 0 0 1 0 8.4zm0-6.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z',
  likes: 'M12 21s-7.5-4.6-9.6-9.1C.9 8.5 2.7 5 6.1 5c2 0 3.3 1.1 3.9 2.2h.0C10.6 6.1 12 5 14 5c3.4 0 5.2 3.5 3.7 6.9C19.5 16.4 12 21 12 21z',
  comments: 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  play: 'M7 4.5v15l13-7.5z',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('fr-FR');
const fmt = (n) => (n < 1000 ? String(n) : compact.format(n));

const parisDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayNumber = (ms) => Date.parse(parisDay.format(ms)) / 86_400_000;
const pts = (n) => `${n} point${n > 1 ? 's' : ''}`;

function ago(iso) {
  if (!iso) return '';
  const days = Math.max(0, dayNumber(Date.now()) - dayNumber(Date.parse(iso)));
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  if (days < 1) return 'aujourd’hui';
  if (days < 2) return 'hier';
  if (days < 30) return rtf.format(-days, 'day');
  if (days < 365) return rtf.format(-Math.round(days / 30), 'month');
  return rtf.format(-Math.round(days / 365), 'year');
}

const tiktokUrl = (c) => (/^https:\/\/(www\.|m\.)?tiktok\.com\//.test(c.url) ? c.url : `https://www.tiktok.com/@${encodeURIComponent(c.author)}/video/${encodeURIComponent(c.id)}`);

function stats(c, withLabels = false) {
  const one = (cls, name, n, label) => el('span', { class: cls, title: `${full.format(n)} ${label}` }, icon(name), fmt(n), withLabels ? ` ${label}` : null);
  return [one('s-views', 'views', c.views, c.views > 1 ? 'vues' : 'vue'), one('s-likes', 'likes', c.likes, 'j’aime'), one('s-comments', 'comments', c.comments, c.comments > 1 ? 'commentaires' : 'commentaire')];
}

// --- une affiche ----------------------------------------------------------------------------------------------------------------------

const ordinal = (n) => el('span', {}, String(n), el('small', {}, n === 1 ? 'er' : 'e'));

function card(c, rank, { podium = false } = {}) {
  const rnd = rng(hash(c.id));
  const tilt = (rnd() < 0.5 ? -1 : 1) * (0.9 + rnd() * 2.2); // entre 0,9° et 3,1°, dans un sens ou dans l'autre
  const lift = Math.round(rnd() * 16 - 4);
  const label = `Voir le clip de @${c.author}${rank ? `, numéro ${rank}` : ''} : ${fmt(c.views)} vues`;
  const photo = el('span', { class: 'clip-photo' },
    c.cover ? el('img', { src: c.cover, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.remove() }) : null,
    el('span', { class: 'clip-play', 'aria-hidden': 'true' }, icon('play')));
  const button = el('button', { class: 'clip-open', type: 'button', 'aria-label': label, style: `clip-path:${tornPolygon(c.id, { amp: podium ? 6 : 5, edges: 'tblr', along: 16 })}`, onclick: () => openClip(c) },
    photo,
    el('span', { class: 'clip-caption' }, el('span', { class: 'clip-author' }, `@${c.author}`), el('span', { class: 'clip-stats' }, stats(c))));
  return el('li', { class: podium ? `clip r${rank}` : 'clip', style: podium ? '' : `--tilt:${tilt.toFixed(2)}deg;--lift:${lift}px;--tape:${(rnd() * 14 - 7).toFixed(1)}deg` },
    button,
    el('span', { class: 'clip-tape', 'aria-hidden': 'true' }),
    rank ? el('span', { class: 'clip-rank', 'aria-hidden': 'true' }, ordinal(rank)) : null);
}

// --- fenêtre du clip ----------------------------------------------------------------------------------------------------------------

const dialog = $('dialog');
function openClip(c) {
  $('dialog-title').textContent = `@${c.author}`;
  const text = $('dialog-text');
  text.textContent = [c.text, ago(c.created_at)].filter(Boolean).join(' · ');
  text.classList.add('clamped');
  const more = $('dialog-more');
  more.hidden = true;
  more.setAttribute('aria-expanded', 'false');
  more.textContent = 'Voir plus';
  $('dialog-stats').replaceChildren(...stats(c, true));
  $('dialog-link').href = tiktokUrl(c);
  // le lecteur officiel de TikTok n'est chargé qu'ici, à la demande du visiteur
  $('dialog-player').replaceChildren(el('iframe', { src: `https://www.tiktok.com/embed/v2/${encodeURIComponent(c.id)}`, title: `Clip de @${c.author}`, allow: 'encrypted-media; fullscreen', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin', loading: 'eager' }));
  dialog.showModal();
  more.hidden = text.scrollHeight <= text.clientHeight + 1;
}
$('dialog-more').addEventListener('click', (e) => {
  const open = !$('dialog-text').classList.toggle('clamped');
  e.currentTarget.setAttribute('aria-expanded', String(open));
  e.currentTarget.textContent = open ? 'Voir moins' : 'Voir plus';
});
dialog.addEventListener('close', () => $('dialog-player').replaceChildren()); // arrête la lecture
dialog.addEventListener('click', (e) => {
  if (e.target !== dialog) return;
  const r = dialog.getBoundingClientRect(); // Padding clicks also target the dialog: only clicks outside its box close it
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
});

// --- affichage ------------------------------------------------------------------------------------------------------------------------

const sortButtons = new Map();
function renderSorts() {
  if (!sortButtons.size) {
    for (const [key, label] of SORTS) {
      const b = el('button', { type: 'button', onclick: () => { state.sort = key; sync(); show(); } }, label);
      sortButtons.set(key, b);
      $('sorts').append(b);
    }
  }
  for (const [key, b] of sortButtons) b.setAttribute('aria-pressed', String(state.sort === key));
}

function sync() {
  const q = new URLSearchParams();
  if (state.sort !== 'score') q.set('tri', SORT_PARAM[state.sort]);
  if (state.period !== DEFAULT_PERIOD) q.set('periode', state.period === 'all' ? 'tout' : state.period);
  const query = q.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  renderSorts();
  $('period').value = state.period;
}

/** Les clips dans l'ordre de l'onglet choisi (à égalité, l'identifiant le plus grand d'abord, comme le serveur). */
function ordered() {
  if (state.sort === 'score') return state.clips;
  const m = METRIC[state.sort];
  return [...state.clips].sort((a, b) => b[m] - a[m] || (a.id < b.id ? 1 : -1));
}

function render() {
  const all = ordered();
  const podium = state.sort === 'score' && all.length >= 3 ? all.slice(0, 3) : [];
  const rest = all.slice(podium.length);
  const visual = [1, 0, 2].filter((i) => i < podium.length); // DOM order matches the visual order so tabbing follows the eye
  $('podium').replaceChildren(...visual.map((i) => card(podium[i], i + 1, { podium: true })));
  $('grid').replaceChildren(...rest.map((c, i) => card(c, podium.length + i + 1)));
  const sub = $('sub');
  sub.hidden = !rest.length;
  const by = { score: 'le classement', views: 'les vues', likes: 'les j’aime', comments: 'les commentaires' }[state.sort];
  sub.textContent = podium.length ? `Du ${podium.length + 1}ᵉ au ${all.length}ᵉ rang` : `Classés selon ${by}`;
}

/** Affiche la réponse du serveur pour la période choisie. */
function show(data) {
  data ??= loaded.get(state.period);
  if (!data) return;
  state.clips = data.clips;
  state.total = data.total;
  state.max = data.max ?? state.max;
  state.loading = false;
  $('stamp-n').textContent = Math.min(data.total, state.max);
  $('stamp').hidden = !data.total || data.enabled === false;
  $('wall-bar').hidden = data.enabled === false || (!data.total && state.period === 'all');
  $('updated').textContent = data.updated_at ? `Mis à jour ${ago(data.updated_at)}, ${new Date(data.updated_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.` : '';
  $('explain').textContent = `Le mur présente les ${data.max} meilleurs clips ; les onglets les réordonnent. Chaque clip reçoit un score : ${pts(data.weights.views)} par vue, ${pts(data.weights.likes)} par j’aime et ${pts(data.weights.comments)} par commentaire. Sont repris les clips publiés avec #${data.hashtag}.`;
  if (state.total) $('state').textContent = '';
  else if (data.enabled === false) $('state').textContent = 'Le mur est désactivé pour le moment.';
  else if (state.period === 'all') $('state').textContent = 'Le mur se remplit : aucun clip pour le moment. Sois le premier : publie ton TikTok avec #lisnard2027 !';
  else $('state').replaceChildren(`Aucun clip sur ${state.period === '7' ? 'les 7 derniers jours' : 'les 30 derniers jours'}. `, el('button', { class: 'btn small', type: 'button', onclick: () => { state.period = 'all'; sync(); load(); } }, 'Voir depuis le début'));
  render();
}

/** Charge la période choisie : un seul appel au serveur par période, les onglets réordonnent ensuite les mêmes clips. */
async function load() {
  const mine = ++state.ticket;
  const period = state.period;
  if (loaded.has(state.period)) return show();
  state.loading = true;
  state.clips = [];
  state.total = 0;
  render();
  $('state').textContent = 'Chargement du mur…';
  try {
    const res = await fetch(`/api/wall?period=${period}&limit=${PAGE}&offset=0`);
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const data = await res.json();
    loaded.set(period, data);
    if (mine !== state.ticket) return;
    show(data);
  } catch {
    if (mine !== state.ticket) return;
    state.loading = false;
    $('state').replaceChildren('Impossible de charger le mur. ', el('button', { class: 'btn small', type: 'button', onclick: () => load() }, 'Réessayer'));
    render();
  }
}

// --- démarrage -------------------------------------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const fromParam = Object.entries(SORT_PARAM).find(([, v]) => v === params.get('tri'));
if (fromParam) state.sort = fromParam[0];
if (['7', '30'].includes(params.get('periode'))) state.period = params.get('periode');
else if (params.get('periode') === 'tout') state.period = 'all';
$('period').addEventListener('change', () => { state.period = $('period').value; sync(); load(); });
tearMarked();
sync();
load();
