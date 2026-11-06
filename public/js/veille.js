// Veille #projetlisnard : publications TikTok et Instagram du hashtag et comptes qui les publient, lues depuis /api/veille.

const $ = (id) => document.getElementById(id);
const PLATFORMS = [
  ['', 'Tout'],
  ['tiktok', 'TikTok'],
  ['instagram', 'Instagram'],
];
const LABEL = { tiktok: 'TikTok', instagram: 'Instagram' };
const PAGE = 48;
const state = { platform: '', sort: 'recent', author: null, posts: [], total: 0, ticket: 0 };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const fmt = (n) => new Intl.NumberFormat('fr-FR', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const profile = (a) => (a.platform === 'instagram' ? `https://www.instagram.com/${a.author}/` : `https://www.tiktok.com/@${a.author}`);

async function load(append = false) {
  const ticket = ++state.ticket;
  const q = new URLSearchParams({ sort: state.sort, limit: PAGE, offset: append ? state.posts.length : 0 });
  if (state.platform) q.set('platform', state.platform);
  if (state.author) q.set('author', state.author);
  $('state').textContent = 'Chargement…';
  $('state').hidden = false;
  try {
    const res = await fetch(`/api/veille?${q}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    if (ticket !== state.ticket) return;
    state.posts = append ? [...state.posts, ...data.posts] : data.posts;
    state.total = data.total;
    render(data);
  } catch (e) {
    if (ticket === state.ticket) $('state').textContent = `La veille n’a pas pu être chargée (${e.message}).`;
  }
}

function render(data) {
  const t = data.totals;
  $('totals').replaceChildren(
    ...[
      [t.posts, 'publications'],
      [t.authors, 'comptes'],
      [t.views, 'vues'],
      [t.tiktok, 'sur TikTok'],
      [t.instagram, 'sur Instagram'],
    ].map(([n, l]) => el('li', {}, el('strong', {}, fmt(n)), el('span', {}, l))),
  );
  $('updated').textContent = data.updated_at ? `Mis à jour le ${new Date(data.updated_at).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}.` : '';
  $('authors').replaceChildren(
    ...data.authors.map((a) =>
      el('li', { class: state.author === a.author ? 'on' : null },
        el('button', { type: 'button', class: 'vl-author', 'aria-pressed': String(state.author === a.author), onclick: () => pickAuthor(state.author === a.author ? null : a.author) },
          el('span', { class: `vl-badge ${a.platform}` }, LABEL[a.platform]),
          el('span', { class: 'vl-name' }, `@${a.author}`),
          el('span', { class: 'vl-count' }, `${a.posts} publication${a.posts > 1 ? 's' : ''} · ${a.views ? `${fmt(a.views)} vues` : `${fmt(a.likes)} j’aime`}`)),
        el('a', { href: profile(a), target: '_blank', rel: 'noopener noreferrer', class: 'vl-profile', 'aria-label': `Profil de @${a.author} sur ${LABEL[a.platform]}` }, '↗'))),
  );
  if (!data.authors.length) $('authors').replaceChildren(el('li', { class: 'vl-none' }, 'Aucun compte pour le moment.'));
  $('filter').hidden = !state.author;
  if (state.author) $('filter').replaceChildren(`Publications de @${state.author} · `, el('button', { type: 'button', class: 'vl-link', onclick: () => pickAuthor(null) }, 'tout afficher'));
  $('grid').replaceChildren(...state.posts.map(card));
  $('state').hidden = state.posts.length > 0;
  $('state').textContent = 'Aucune publication avec #projetlisnard pour le moment.';
  $('more').hidden = state.posts.length >= state.total;
}

function card(p) {
  return el('li', { class: 'vl-card' },
    el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', class: 'vl-open', 'aria-label': `Voir la publication de @${p.author} sur ${LABEL[p.platform]}` },
      el('span', { class: 'vl-photo' }, p.cover ? el('img', { src: p.cover, alt: '', loading: 'lazy', decoding: 'async' }) : null, el('span', { class: `vl-badge ${p.platform}` }, LABEL[p.platform])),
      el('span', { class: 'vl-meta' },
        el('strong', {}, `@${p.author}`),
        el('span', { class: 'vl-text' }, p.text),
        el('span', { class: 'vl-stats' }, [day(p.created_at), p.views ? `${fmt(p.views)} vues` : '', `${fmt(p.likes)} j’aime`].filter(Boolean).join(' · ')))));
}

function pickAuthor(author) {
  state.author = author;
  load();
  if (author) $('posts-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('platforms').replaceChildren(
  ...PLATFORMS.map(([v, l]) =>
    el('button', { type: 'button', 'aria-pressed': String(v === state.platform), onclick: (e) => {
      state.platform = v;
      state.author = null;
      for (const b of $('platforms').children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      load();
    } }, l)),
);
$('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  load();
});
$('more').addEventListener('click', () => load(true));
load();
