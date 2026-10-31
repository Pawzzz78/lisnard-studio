// Interface d'administration : liste des vidéos, ajout, édition de la transcription.

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');

// ---------------------------------------------------------------- utilitaires

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

class AuthError extends Error {
  constructor(message = 'Session expirée : reconnecte-toi.') {
    super(message);
  }
}

async function api(method, path, body) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') throw new AuthError();
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { data, status: res.status });
  return data;
}

function parseTs(str) {
  const s = String(str).trim();
  let m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (m) {
    const [, hh = '0', mm, ss, ms = '0'] = m;
    return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number(ms.padEnd(3, '0'));
  }
  m = s.match(/^(\d+)(?:[.,](\d{1,3}))?$/);
  return m ? Number(m[1]) * 1000 + Number((m[2] ?? '0').padEnd(3, '0')) : null;
}

function fmtTs(ms) {
  const t = Math.floor(ms / 1000);
  const hh = Math.floor(t / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  const rest = `${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
  return hh ? `${hh}:${rest}` : rest;
}

const fmtDuration = (sec) => {
  if (sec == null) return '';
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
};

const fmtSpan = (sec) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m} min${s ? ` ${String(s).padStart(2, '0')}` : ''}` : `${s} s`;
};

const fmtDate = (d) => {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('fr-FR');
};

function status(el, msg, kind = '') {
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function fail(e, el) {
  if (e instanceof AuthError) {
    if (!dirtyGuard()) return renderLogin();
    // Unsaved work: sign in again over the page instead of replacing it
    reauth().then((ok) => (ok ? status(el, 'Reconnecté : relance ton action.', 'ok') : renderLogin()));
    return undefined;
  }
  status(el, e.message, 'err');
}

window.addEventListener('unhandledrejection', (ev) => {
  if (ev.reason instanceof AuthError) {
    ev.preventDefault();
    renderLogin();
  }
});

async function busy(btn, fn) {
  if (btn.disabled) return undefined;
  const isInput = btn.tagName === 'INPUT';
  const label = btn.textContent;
  btn.disabled = true;
  if (!isInput) btn.textContent = '… en cours';
  try {
    return await fn();
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      if (!isInput) btn.textContent = label;
    }
  }
}

let toastEl = null;
let toastTimer = 0;
function toast(text, kind = 'ok', actionLabel, onAction) {
  toastEl ??= document.body.appendChild(h('div', { class: 'toast', role: 'status' }));
  clearTimeout(toastTimer);
  toastEl.className = `toast ${kind}`;
  toastEl.replaceChildren(
    text,
    actionLabel
      ? h('button', { type: 'button', class: 'btn secondary small', onclick: () => { toastEl.hidden = true; onAction(); } }, actionLabel)
      : null,
  );
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), actionLabel ? 10000 : 6000);
}

function reauth() {
  return new Promise((resolve) => {
    let settled = false;
    // The dialog's async 'close' event is unreliable here: settle explicitly
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(ok);
    };
    const msg = h('p', { class: 'status', role: 'status' });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const ok = h('button', { class: 'btn', type: 'submit' }, 'Se reconnecter');
    const cancel = h('button', { class: 'btn secondary', type: 'button' }, 'Annuler');
    const dlg = h(
      'dialog',
      { class: 'panel reauth', 'aria-labelledby': 'reauth-title' },
      h(
        'form',
        {
          onsubmit: (ev) => {
            ev.preventDefault();
            busy(ok, async () => {
              try {
                await api('POST', '/login', { password: pw.value });
                finish(true);
              } catch (err) {
                status(msg, err.message, 'err');
                pw.select();
              }
            });
          },
        },
        h('h2', { id: 'reauth-title' }, 'Session expirée'),
        h('p', { class: 'status' }, 'Reconnecte-toi pour enregistrer : tes modifications sont conservées.'),
        h('label', { class: 'field' }, 'Mot de passe', pw),
        h('div', { class: 'actions' }, ok, cancel),
        msg,
      ),
    );
    cancel.addEventListener('click', () => finish(false));
    dlg.addEventListener('cancel', () => finish(false));
    dlg.addEventListener('close', () => finish(false));
    document.body.append(dlg);
    dlg.showModal();
    pw.focus();
  });
}


const SCRIPT_URL = 'https://github.com/Pawzzz78/A-t-il-dit-a/tree/main/tools';

const unavailable = (text, tech, cls = 'status err') => h('p', { class: cls }, `Fonction indisponible : ${text} `, h('small', { class: 'tech' }, `(à activer par le développeur : ${tech})`));

/** Commande à copier-coller, avec un bouton « Copier ». */
function commandBox(command) {
  const status = h('span', { class: 'status' });
  const copy = h(
    'button',
    {
      class: 'btn secondary small',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(command);
          status.textContent = 'Copié';
        } catch {
          const range = document.createRange();
          range.selectNodeContents(box);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          status.textContent = 'Sélectionné : copie-le à la main';
        }
      },
    },
    'Copier la commande',
  );
  const box = h('pre', { class: 'cmd' }, command);
  return h('div', {}, box, h('div', { class: 'actions' }, copy, status));
}

const whisperCommand = (youtubeId) =>
  `python tools/transcribe.py --site ${location.origin} https://www.youtube.com/watch?v=${youtubeId}`;

let cleanup = () => {};
let dirtyGuard = () => false;
let routeGen = 0; // bumped on every navigation: async work from a previous page checks it before touching the screen
let lastHash = location.hash;

let ytPromise;
function loadYT() {
  ytPromise ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    document.head.append(h('script', { src: 'https://www.youtube.com/iframe_api' }));
  });
  return ytPromise;
}

// --------------------------------------------------------------------- routeur

function confirmLeave() {
  const ask = dirtyGuard();
  return !ask || confirm(typeof ask === 'string' ? ask : 'Des modifications ne sont pas enregistrées. Quitter quand même ?');
}

function resetPage() {
  routeGen++;
  cleanup();
  cleanup = () => {};
  dirtyGuard = () => false;
}

async function route() {
  if (!confirmLeave()) {
    // Restore the previous address without firing hashchange (history.back() would ask again)
    history.replaceState(null, '', `${location.pathname}${location.search}${lastHash}`);
    return;
  }
  lastHash = location.hash;
  resetPage();
  const gen = routeGen;
  try {
    const me = await api('GET', '/me');
    if (gen !== routeGen) return;
    if (!me.authenticated) return renderLogin();
    renderNav();
    $app.replaceChildren(h('p', { class: 'status', role: 'status' }, 'Chargement…'));
    const m = location.hash.match(/^#\/video\/(\d+)/);
    if (m) await renderEditor(Number(m[1]));
    else if (location.hash === '#/sync') await renderSync();
    else if (location.hash === '#/studio') await renderStudioStats();
    else if (location.hash === '#/musique') await renderMusicLibrary();
    else if (location.hash === '#/visages') await renderFaceReferences();
    else if (location.hash === '#/mur') await renderWallAdmin();
    else if (location.hash === '#/bibliotheque') await renderLibraryAdmin();
    else await renderList();
    if (gen !== routeGen) return;
    const title = $app.querySelector('h2, h1');
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  } catch (e) {
    if (gen !== routeGen) return;
    if (e instanceof AuthError) return renderLogin();
    $app.replaceChildren(h('p', { class: 'status err', role: 'alert' }, e.message));
  }
}
window.addEventListener('hashchange', route);

function renderNav() {
  const hash = location.hash;
  const here = hash === '' || hash === '#' || hash === '#/' || hash.startsWith('#/video/') ? '#/' : hash;
  const link = (href, label) => h('a', { href, 'aria-current': href === here ? 'page' : null }, label);
  $nav.replaceChildren(
    link('#/', 'Vidéos'),
    link('#/sync', 'Synchronisation'),
    link('#/studio', 'Stats studio'),
    link('#/musique', 'Musique'),
    link('#/visages', 'Reconnaissance'),
    link('#/mur', 'Mur'),
    link('#/bibliotheque', 'Bibliothèque'),
    h('a', { href: '/' }, 'Voir le site'),
    h(
      'a',
      {
        href: '#',
        onclick: async (e) => {
          e.preventDefault();
          if (!confirmLeave()) return;
          try {
            await api('POST', '/logout', {});
          } catch (err) {
            if (!(err instanceof AuthError)) return alert(err.message);
          }
          renderLogin();
        },
      },
      'Déconnexion',
    ),
  );
}

// ----------------------------------------------------------------------- login

function renderLogin() {
  resetPage();
  $nav.replaceChildren();
  const msg = h('p', { class: 'status', role: 'status' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, autofocus: true });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Se connecter');
  const form = h(
    'form',
    {
      class: 'panel login',
      onsubmit: (e) => {
        e.preventDefault();
        busy(submit, async () => {
          try {
            await api('POST', '/login', { password: pw.value });
            route();
          } catch (err) {
            status(msg, err.message, 'err');
          }
        });
      },
    },
    h('h2', {}, 'Connexion'),
    h('label', { class: 'field' }, 'Mot de passe', pw),
    submit,
    msg,
  );
  $app.replaceChildren(form);
  pw.focus();
}

// ----------------------------------------------------------------------- liste

async function renderList() {
  const gen = routeGen;
  const [videos, config] = await Promise.all([api('GET', '/videos'), api('GET', '/config')]);
  if (gen !== routeGen) return;

  const tbody = h('tbody');
  for (const v of videos) {
    tbody.append(
      h(
        'tr',
        { class: 'clickable', 'data-q': [v.title, v.channel, v.youtube_id].filter(Boolean).join(' ').toLowerCase(), onclick: () => (location.hash = `#/video/${v.id}`) },
        h('td', {}, v.thumbnail_url ? h('img', { src: v.thumbnail_url, alt: '', loading: 'lazy' }) : null),
        h('td', {}, h('div', { class: 't' }, h('a', { href: `#/video/${v.id}` }, v.title || v.youtube_id)), h('div', { class: 'status' }, [v.channel, fmtDuration(v.duration_s)].filter(Boolean).join(' · '))),
        h('td', {}, fmtDate(v.published_at)),
        h('td', {}, String(v.segment_count)),
        h(
          'td',
          {},
          v.translated ? h('span', { class: 'badge ok', title: `Traduit automatiquement depuis ${v.original_lang ?? '?'}` }, `traduit ${v.original_lang ?? ''}→${v.lang ?? ''}`) : null,
          !v.translated && v.lang && v.lang !== 'fr' ? h('span', { class: 'badge warn', title: 'Transcription non traduite' }, `langue : ${v.lang}`) : null,
          v.sync_status === 'pending' ? h('span', { class: 'badge' }, 'en attente') : null,
          v.sync_status === 'failed' ? h('span', { class: 'badge warn', title: v.sync_error ?? '' }, 'échec') : null,
          v.segment_count === 0 && !v.sync_status ? h('span', { class: 'badge' }, 'vide') : null,
          v.edited ? h('span', { class: 'badge ok' }, 'corrigée') : h('span', { class: 'badge' }, { supadata: 'auto', whisper: 'whisper' }[v.source] ?? (v.sync_status ? 'synchro' : 'manuelle')),
        ),
      ),
    );
  }

  const count = h('h2', {}, `Vidéos (${videos.length})`);
  const none = h('p', { class: 'status', role: 'status', hidden: true }, 'Aucune vidéo ne correspond.');
  const filter = h('input', {
    type: 'search',
    class: 'text',
    placeholder: 'Filtrer par titre ou chaîne…',
    'aria-label': 'Filtrer les vidéos par titre ou chaîne',
    oninput: () => {
      const q = filter.value.trim().toLowerCase();
      let shown = 0;
      for (const tr of tbody.children) {
        tr.hidden = Boolean(q) && !tr.dataset.q.includes(q);
        if (!tr.hidden) shown++;
      }
      count.textContent = q ? `Vidéos (${shown} sur ${videos.length})` : `Vidéos (${videos.length})`;
      none.hidden = shown > 0;
    },
  });
  const list = h(
    'section',
    { class: 'panel' },
    count,
    videos.length
      ? [
          filter,
          none,
          h(
            'table',
            { class: 'videos list' },
            h('thead', {}, h('tr', {}, ...['', 'Titre', 'Date', 'Segments', 'Transcription'].map((t) => h('th', {}, t)))),
            tbody,
          ),
        ]
      : h('p', { class: 'status' }, 'Aucune vidéo pour le moment. Ajoute-en une ci-dessous.'),
  );

  $app.replaceChildren(addForm(config), list);
}

function addForm(config) {
  const msg = h('p', { class: 'status', role: 'status' });
  const url = h('input', { type: 'text', placeholder: 'https://www.youtube.com/watch?v=…', required: true });
  const lang = h('input', { type: 'text', value: 'fr', maxlength: '5' });
  const title = h('input', { type: 'text', placeholder: 'Rempli automatiquement si vide' });
  const channel = h('input', { type: 'text', placeholder: 'Rempli automatiquement si vide' });
  const date = h('input', { type: 'date' });
  const paste = h('textarea', { rows: '8', placeholder: 'SRT, VTT, ou lignes « [00:12] texte »… ou texte brut' });
  const pasteWrap = h('label', { class: 'field', hidden: true }, 'Transcription à coller', paste);
  pasteWrap.hidden = true;

  const mode = (value, label, checked, disabled = false) =>
    h(
      'label',
      { class: 'radio' },
      h('input', {
        type: 'radio',
        name: 'mode',
        value,
        checked,
        disabled,
        onchange: () => (pasteWrap.hidden = value !== 'paste'),
      }),
      label,
    );

  const submit = h('button', { class: 'btn', type: 'submit' }, 'Ajouter la vidéo');
  const form = h(
    'form',
    {
      class: 'panel',
      onsubmit: (e) => {
        e.preventDefault();
        busy(submit, async () => {
        const chosen = form.querySelector('input[name=mode]:checked').value;
        status(msg, chosen === 'supadata' ? 'Récupération de la transcription…' : 'Ajout…');
        try {
          const { id } = await api('POST', '/videos', {
            input: url.value,
            mode: chosen,
            lang: lang.value || 'fr',
            transcript: paste.value,
            title: title.value || undefined,
            channel: channel.value || undefined,
            published_at: date.value || undefined,
          });
          location.hash = `#/video/${id}`;
        } catch (err) {
          if (err.status === 409 && err.data?.id) {
            status(msg, 'Déjà ajoutée — ouverture…', 'ok');
            location.hash = `#/video/${err.data.id}`;
          } else fail(err, msg);
        }
        });
      },
    },
    h('h2', {}, 'Ajouter une vidéo'),
    h('label', { class: 'field' }, 'URL ou identifiant YouTube', url),
    h(
      'div',
      { class: 'field' },
      'Transcription',
      mode('supadata', config.supadata ? 'Récupérer automatiquement (Supadata)' : 'Récupérer automatiquement (indisponible : à activer par le développeur)', config.supadata, !config.supadata),
      mode('paste', 'Coller une transcription', !config.supadata),
      mode('empty', 'Vide (je la saisis dans l’éditeur)', false),
    ),
    pasteWrap,
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field' }, 'Langue', lang),
      h('label', { class: 'field' }, 'Titre (optionnel)', title),
      h('label', { class: 'field' }, 'Chaîne (optionnel)', channel),
      h('label', { class: 'field' }, 'Date de publication', date),
    ),
    h('div', { class: 'actions' }, submit, msg),
  );
  pasteWrap.hidden = config.supadata;
  return form;
}


// ------------------------------------------------------------- synchronisation

// --------------------------------------------------------------- statistiques du studio

async function renderStudioStats() {
  const gen = routeGen;
  const st = await api('GET', '/studio/stats');
  if (gen !== routeGen) return;
  const periods = [['today', 'Aujourd’hui'], ['d7', '7 jours'], ['d30', '30 jours'], ['all', 'Depuis le début']];
  let current = 'd7';
  const plural = (n, one, many) => (n > 1 ? many : one);
  const stat = (n, label, hint) => h('div', { class: 'stat', title: hint ?? '' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, label));
  const grid = h('div', { class: 'stats' });
  const switcher = h('div', { class: 'pills', role: 'group', 'aria-label': 'Période' });
  const draw = () => {
    const p = st.periods[current];
    const got = p.retrieved ?? p.downloaded + p.shared;
    const rate = p.created ? Math.min(100, Math.round((got / p.created) * 100)) : null;
    const capped = p.created > 0 && got > p.created;
    switcher.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === current)));
    grid.replaceChildren(
      stat(p.created, plural(p.created, 'clip créé', 'clips créés'), 'Clips dont la création a été lancée'),
      stat(p.downloaded, plural(p.downloaded, 'clip téléchargé', 'clips téléchargés'), 'Clics sur « Télécharger » (un clip compte une fois)'),
      stat(p.shared, plural(p.shared, 'clip partagé', 'clips partagés'), 'Partages depuis le téléphone'),
      stat(p.people_downloaded, plural(p.people_downloaded, 'personne a récupéré son clip', 'personnes ont récupéré leur clip'), 'Personnes distinctes (approximation par connexion) ayant téléchargé ou partagé'),
      stat(rate == null ? '–' : `${rate} %`, capped ? 'clips récupérés (plafonné à 100 %)' : 'clips récupérés', 'Part des clips créés qui ont été téléchargés ou partagés (100 % au maximum)'),
    );
  };
  for (const [key, label] of periods) switcher.append(h('button', { type: 'button', 'data-p': key, onclick: () => { current = key; draw(); } }, label));
  draw();

  const max = Math.max(1, ...st.daily.map((d) => Math.max(d.created, d.retrieved ?? d.downloaded + d.shared)));
  const dayRows = [...st.daily].reverse().map((d) =>
    h('tr', {},
      h('td', {}, fmtDate(d.day)),
      h('td', {}, String(d.created)),
      h('td', {}, String(d.retrieved ?? d.downloaded + d.shared)),
      h('td', { class: 'bars' }, h('span', { class: 'bar a', style: `width:${(d.created / max) * 100}%` }), h('span', { class: 'bar b', style: `width:${((d.retrieved ?? d.downloaded + d.shared) / max) * 100}%` }))));
  const videoRows = st.videos.map((v) => h('tr', {}, h('td', {}, v.title || v.youtube_id), h('td', {}, String(v.created)), h('td', {}, String(v.retrieved ?? v.downloaded))));

  $app.replaceChildren(
    h('section', { class: 'panel' },
      h('h2', {}, 'Studio TikTok / Reels'),
      h('p', { class: 'status' }, 'Combien de clips ont été créés, puis téléchargés ou partagés par les visiteurs.'),
      switcher,
      grid,
      h('p', { class: 'status' }, `Les personnes sont comptées d’après une empreinte de leur connexion (l’adresse n’est jamais enregistrée, l’empreinte est effacée après ${st.retention_days} jours) : c’est une approximation.`)),
    h('section', { class: 'panel' },
      h('h3', {}, '14 derniers jours'),
      h('table', { class: 'videos' }, h('thead', {}, h('tr', {}, h('th', {}, 'Jour'), h('th', {}, 'Créés'), h('th', {}, 'Récupérés'), h('th', {}, ''))), h('tbody', {}, dayRows))),
    h('section', { class: 'panel' },
      h('h3', {}, 'Interviews les plus utilisées'),
      videoRows.length
        ? h('table', { class: 'videos' }, h('thead', {}, h('tr', {}, h('th', {}, 'Interview'), h('th', {}, 'Clips créés'), h('th', {}, 'Clips récupérés'))), h('tbody', {}, videoRows))
        : h('p', { class: 'status' }, 'Aucun clip pour le moment.')),
  );
}

async function renderMusicLibrary() {
  const gen = routeGen;
  let data = await api('GET', '/studio/music');
  if (gen !== routeGen) return;
  const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(b / 1024))} Ko`);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const catSelect = (value, onchange) =>
    h('select', { onchange, 'aria-label': 'Catégorie' }, data.categories.map((c) => h('option', { value: c.id, selected: c.id === value }, c.label)));
  const root = h('div');
  const note = h('p', { class: 'status', role: 'status' });
  let libTitle = null;
  let libBody = null;
  let libUl = null;
  let upXhr = null;

  async function mutate(ctrl, method, path, body, okMsg, apply) {
    return (
      (await busy(ctrl, async () => {
        try {
          data = await api(method, `/studio/music${path}`, body);
          apply?.();
          status(note, okMsg ?? 'Enregistré.', 'ok');
          return true;
        } catch (e) {
          fail(e, note);
          return false;
        }
      })) ?? false
    );
  }

  const upGuard = (ev) => {
    ev.preventDefault();
    ev.returnValue = '';
  };
  dirtyGuard = () => (upXhr ? 'Un envoi de musique est en cours : quitter l’interrompra. Quitter quand même ?' : false);
  cleanup = () => {
    upXhr?.abort();
    window.removeEventListener('beforeunload', upGuard);
  };

  // --- ajout
  const file = h('input', { type: 'file', accept: 'audio/*,.mp3,.m4a,.wav,.ogg,.flac,.aac', id: 'mfile' });
  const title = h('input', { class: 'text', type: 'text', maxlength: '80', placeholder: 'Titre affiché dans le studio', id: 'mtitle' });
  const category = h('select', { id: 'mcat' }, data.categories.map((c) => h('option', { value: c.id }, c.label)));
  const credit = h('input', { class: 'text', type: 'text', maxlength: '200', placeholder: 'Ex. : Auteur, site (facultatif)', id: 'mcredit' });
  const rights = h('input', { type: 'checkbox', id: 'mrights' });
  const send = h('button', { class: 'btn', type: 'button' }, 'Ajouter à la bibliothèque');
  const cancelUp = h('button', { class: 'btn secondary small', type: 'button', hidden: true }, 'Annuler l’envoi');
  const upStatus = h('span', { class: 'status', role: 'status' });
  const endUpload = () => {
    upXhr = null;
    send.disabled = false;
    cancelUp.hidden = true;
    window.removeEventListener('beforeunload', upGuard);
  };
  cancelUp.addEventListener('click', () => upXhr?.abort());
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (f && !title.value) title.value = f.name.replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 80);
  });
  send.addEventListener('click', () => {
    if (upXhr) return;
    const f = file.files[0];
    if (!f) return status(upStatus, 'Choisis d’abord un fichier audio.', 'err');
    if (!rights.checked) return status(upStatus, 'Coche la case : tu confirmes avoir le droit d’utiliser ce morceau.', 'err');
    if (f.size > data.limits.maxBytes) return status(upStatus, `Fichier trop lourd (${Math.round(data.limits.maxBytes / 1048576)} Mo au maximum).`, 'err');
    const q = new URLSearchParams({ title: title.value, category: category.value, credit: credit.value, filename: f.name, rights: '1' });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/admin/studio/music?${q}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
    upXhr = xhr;
    send.disabled = true;
    cancelUp.hidden = false;
    window.addEventListener('beforeunload', upGuard);
    xhr.upload.onprogress = (ev) => ev.lengthComputable && status(upStatus, ev.loaded < ev.total ? `Envoi… ${Math.round((ev.loaded / ev.total) * 100)} %` : 'Conversion et normalisation du volume…');
    xhr.onload = () => {
      endUpload();
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* corps vide */ }
      if (xhr.status === 401) return renderLogin();
      if (xhr.status >= 400) return status(upStatus, body.error || `Erreur ${xhr.status}`, 'err');
      data = body;
      file.value = ''; title.value = ''; credit.value = ''; rights.checked = false;
      const fresh = libUl && data.library.find((t) => !libUl.querySelector(`[data-id="${t.id}"]`));
      if (fresh) {
        libUl.append(row(fresh, true));
        libTitle.textContent = `Ma bibliothèque (${data.library.length})`;
      } else draw();
      status(upStatus, '');
      status(note, 'Morceau ajouté : il est disponible dans le studio.', 'ok');
    };
    xhr.onerror = () => { endUpload(); status(upStatus, 'Envoi interrompu. Réessaie.', 'err'); };
    xhr.onabort = () => { endUpload(); status(upStatus, 'Envoi annulé.'); };
    status(upStatus, 'Envoi…');
    xhr.send(f);
  });

  const emptyLib = () => h('p', { class: 'status' }, 'Aucun morceau ajouté pour le moment. Pour des musiques motivantes, épiques ou cinématiques libres de droits, regarde la bibliothèque audio de YouTube Studio, Pixabay Music, Uppbeat ou Mixkit, puis ajoute ici les fichiers que tu télécharges.');

  const row = (t, own) => {
    const src = own ? `/api/admin/studio/music/${t.id}/file` : t.url;
    const meta = [mmss(t.duration_s), t.size_bytes ? fmtSize(t.size_bytes) : '', t.bpm ? `${t.bpm} bpm` : '', t.mood].filter(Boolean).join(' · ');
    const titleInput = h('input', { class: 'text', type: 'text', value: t.title, maxlength: '80', 'aria-label': 'Titre' });
    const creditInput = h('input', { class: 'text', type: 'text', value: t.credit ?? '', maxlength: '200', placeholder: 'Crédit (facultatif)', 'aria-label': 'Crédit' });
    const li = h('li', { class: `mrow${t.enabled ? '' : ' off'}`, 'data-id': t.id });
    const offBadge = h('span', { class: 'badge off-badge', hidden: t.enabled }, 'Masqué');
    const patch = (ctrl, body, okMsg) =>
      mutate(ctrl, 'PATCH', `/${t.id}`, body, okMsg, () => {
        const nt = [...data.library, ...data.builtin].find((x) => x.id === t.id);
        if (nt) Object.assign(t, nt);
        li.classList.toggle('off', !t.enabled);
        offBadge.hidden = t.enabled;
      });
    li.append(
      own ? h('div', { class: 'mfields' }, titleInput, creditInput) : h('div', { class: 'mfields' }, h('strong', {}, t.title)),
      h('small', { class: 'mmeta' }, meta, ' ', offBadge),
      h('audio', { controls: true, preload: 'none', src }),
      h('div', { class: 'actions' },
        own ? catSelect(t.category, (ev) => patch(ev.target, { category: ev.target.value })) : h('span', { class: 'badge' }, data.categories.find((c) => c.id === t.category)?.label ?? ''),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: t.enabled, onchange: async (ev) => {
          const box = ev.target;
          const want = box.checked;
          if (!(await patch(box, { enabled: want }, want ? 'Morceau visible dans le studio.' : 'Morceau masqué du studio.'))) box.checked = t.enabled;
        } }), ' Visible'),
        own && h('button', { class: 'btn secondary small', type: 'button', onclick: (ev) => { if (titleInput.value !== t.title || creditInput.value !== (t.credit ?? '')) patch(ev.currentTarget, { title: titleInput.value, credit: creditInput.value }); else status(note, 'Aucun changement.'); } }, 'Enregistrer'),
        own && h('button', { class: 'btn danger small', type: 'button', onclick: (ev) => {
          if (!confirm(`Supprimer « ${t.title} » définitivement ?`)) return;
          mutate(ev.currentTarget, 'DELETE', `/${t.id}`, undefined, 'Morceau supprimé.', () => {
            li.remove();
            libTitle.textContent = `Ma bibliothèque (${data.library.length})`;
            if (!data.library.length) {
              libUl = null;
              libBody.replaceChildren(emptyLib());
            }
          });
        } }, 'Supprimer')));
    return li;
  };

  function draw() {
    libTitle = h('h2', {}, `Ma bibliothèque (${data.library.length})`);
    libUl = data.library.length ? h('ul', { class: 'mlist' }, data.library.map((t) => row(t, true))) : null;
    libBody = h('div', {}, libUl ?? emptyLib());
    root.replaceChildren(
      h('section', { class: 'panel' },
        h('h2', {}, 'Ajouter un morceau'),
        h('p', { class: 'status' }, `MP3, M4A, WAV, OGG ou FLAC, de ${data.limits.minS} s à ${fmtSpan(data.limits.maxS)}, ${Math.round(data.limits.maxBytes / 1048576)} Mo au maximum. Le morceau est converti en MP3 et son volume est égalisé pour que tous sonnent pareil sous la voix (seules les ${fmtSpan(data.limits.keepS)} du début sont conservées).`),
        h('div', { class: 'field' }, h('label', { for: 'mfile' }, 'Fichier audio'), file),
        h('div', { class: 'field' }, h('label', { for: 'mtitle' }, 'Titre'), title),
        h('div', { class: 'field' }, h('label', { for: 'mcat' }, 'Catégorie'), category),
        h('div', { class: 'field' }, h('label', { for: 'mcredit' }, 'Crédit à afficher dans la description'), credit,
          h('small', {}, 'Certaines licences (CC BY, bibliothèque audio YouTube…) demandent de citer l’auteur : le crédit est alors ajouté à la description TikTok.')),
        h('label', { class: 'check' }, rights, ' Je confirme avoir le droit d’utiliser ce morceau (licence libre de droits, achetée ou créée par moi).'),
        h('div', { class: 'actions' }, send, cancelUp, upStatus)),
      note,
      h('section', { class: 'panel' }, libTitle, libBody),
      h('section', { class: 'panel' },
        h('h2', {}, `Morceaux d’origine (${data.builtin.length})`),
        h('p', { class: 'status' }, 'Créés pour le site, libres de droits. Décoche « Visible » pour retirer un morceau du studio.'),
        h('ul', { class: 'mlist' }, data.builtin.map((t) => row(t, false)))),
    );
  }
  draw();
  $app.replaceChildren(h('section', { class: 'panel' }, h('h2', {}, 'Musiques du studio'), h('p', { class: 'status' }, 'Les morceaux ajoutés ici apparaissent dans l’onglet « Musique » du studio, rangés par catégorie (motivant, épique, cinématique).')), root);
}

async function renderFaceReferences() {
  const gen = routeGen;
  let data = await api('GET', '/faces/references');
  if (gen !== routeGen) return;
  const root = h('div');
  const note = h('p', { class: 'status', role: 'status' });
  const results = h('ul', { class: 'upload-results' });
  const input = h('input', { type: 'file', accept: 'image/*,.jpg,.jpeg,.png,.webp', multiple: true, id: 'ref-files' });
  const sendBtn = h('button', { class: 'btn', type: 'button' }, 'Ajouter les photos');

  async function sendOne(file) {
    const li = h('li', {}, `${file.name} : envoi…`);
    results.append(li);
    try {
      const res = await fetch(`/api/admin/faces/references?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw new AuthError();
      if (!res.ok) throw new Error(body.error || `Erreur ${res.status}`);
      data = body;
      li.className = 'ok';
      li.textContent = `${file.name} : ajoutée.`;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      li.className = 'err';
      li.textContent = `${file.name} : ${e.message}`;
    }
  }

  sendBtn.addEventListener('click', () => {
    const files = [...(input.files ?? [])];
    if (!files.length) return status(note, 'Choisis d’abord une ou plusieurs photos.', 'err');
    busy(sendBtn, async () => {
    results.replaceChildren();
    try {
      for (const [i, f] of files.entries()) {
        status(note, `Analyse des photos… ${i + 1} / ${files.length} (environ une seconde par photo)`);
        await sendOne(f);
      }
      input.value = '';
      draw();
      const ok = results.querySelectorAll('li.ok').length;
      status(note, `${ok} photo${ok > 1 ? 's' : ''} ajoutée${ok > 1 ? 's' : ''} sur ${files.length}. Pense à mettre à jour les vidéos déjà analysées.`, ok ? 'ok' : 'err');
    } catch (e) {
      fail(e, note);
    }
    });
  });

  async function remove(r, btn) {
    if (!confirm('Retirer cette photo de la liste ?')) return;
    await busy(btn, async () => {
      try {
        data = await api('DELETE', `/faces/references/${r.id}`);
        draw();
        status(note, 'Photo retirée. Pense à mettre à jour les vidéos déjà analysées.', 'ok');
      } catch (e) {
        fail(e, note);
      }
    });
  }

  const redoBtn = h('button', { class: 'btn secondary', type: 'button' }, 'Refaire les analyses anciennes (meilleure définition)');
  redoBtn.addEventListener('click', () =>
    busy(redoBtn, async () => {
      try {
        const r = await api('POST', '/faces/reanalyze-all', {});
        status(note, r.queued ? `Analyse relancée pour ${r.queued} vidéo${r.queued > 1 ? 's' : ''} (une à la fois, en arrière-plan ; les anciennes analyses restent utilisées jusqu'à la fin).` : 'Toutes les analyses sont déjà à la meilleure définition.', 'ok');
      } catch (e) {
        fail(e, note);
      }
    }),
  );

  const updateBtn = h('button', { class: 'btn secondary', type: 'button' }, 'Mettre à jour les vidéos déjà analysées');
  updateBtn.addEventListener('click', () =>
    busy(updateBtn, async () => {
      try {
        const r = await api('POST', '/faces/identify-all', {});
        status(note, r.queued ? `Reconnaissance relancée pour ${r.queued} vidéo${r.queued > 1 ? 's' : ''} (en arrière-plan, quelques minutes chacune).` : 'Toutes les vidéos analysées sont déjà à jour.', 'ok');
      } catch (e) {
        fail(e, note);
      }
    }),
  );

  function draw() {
    const n = data.count;
    root.replaceChildren(
      h('section', { class: 'panel' },
        h('h2', {}, 'Reconnaissance de David Lisnard'),
        h('p', { class: 'status' }, 'Donne des photos de David Lisnard : dans les interviews où plusieurs personnes apparaissent (journaliste, public), le cadrage automatique du studio suivra lui plutôt que la personne la plus visible. Seules les empreintes des visages sont conservées, pas les photos.'),
        data.enabled ? null : unavailable('le cadrage automatique est désactivé sur ce serveur.', 'STUDIO_FACES=off'),
        h('ul', { class: 'tips' },
          h('li', {}, 'Une vingtaine de photos, variées : de face et de trois quarts, avec et sans lunettes, en intérieur et en extérieur, à différentes années.'),
          h('li', {}, `Une seule personne par photo, visage net et assez grand (au moins ${data.minFacePx} pixels de large) ; la photo est refusée sinon.`),
          h('li', {}, 'Évite les photos retouchées, très sombres ou de profil, et les images où il porte un masque ou des lunettes de soleil.')),
        h('div', { class: 'field' }, h('label', { for: 'ref-files' }, 'Photos (plusieurs à la fois)'), input),
        h('div', { class: 'actions' }, sendBtn),
        results),
      note,
      h('section', { class: 'panel' },
        h('h2', {}, `Photos de référence (${n} sur ${data.max} au maximum)`),
        n === 0 ? h('p', { class: 'status' }, 'Aucune photo pour le moment.') : n < 10 ? h('p', { class: 'status' }, `Il vaut mieux au moins 10 photos pour une reconnaissance fiable (${n} pour l’instant).`) : h('p', { class: 'status ok' }, `${n} photos : bonne base pour la reconnaissance.`),
        data.references.some((r) => r.suspicious) ? h('p', { class: 'status err' }, 'Les photos marquées « à vérifier » ne ressemblent à aucune autre de la liste : est-ce bien David Lisnard ? Une mauvaise photo dégrade la reconnaissance.') : null,
        h('div', { class: 'ref-grid' }, data.references.map((r) =>
          h('figure', { class: `ref${r.suspicious ? ' suspicious' : ''}` },
            h('img', { src: `/api/admin/faces/references/${r.id}/thumb`, alt: r.name || `Photo ${r.id}`, width: 112, height: 112, loading: 'lazy' }),
            h('figcaption', {}, h('span', { class: 'ref-name', title: r.name }, r.name || `Photo ${r.id}`), r.suspicious ? h('span', { class: 'badge warn' }, 'à vérifier') : null,
              h('button', { class: 'btn danger small', type: 'button', onclick: (ev) => remove(r, ev.currentTarget) }, 'Retirer'))))),
        h('div', { class: 'actions' }, updateBtn, redoBtn),
        h('p', { class: 'status' }, 'Les vidéos analysées plus tard utilisent automatiquement les photos actuelles. Pour celles déjà analysées, le premier bouton relance seulement la reconnaissance (pas la détection des visages) ; le second refait toute l’analyse des vidéos analysées avec une définition plus faible (plus long : une vidéo à la fois).')),
    );
  }
  draw();
  $app.replaceChildren(root);
}

async function renderWallAdmin() {
  const gen = routeGen;
  let data = await api('GET', '/wall');
  if (gen !== routeGen) return;
  const root = h('div');
  const note = h('p', { class: 'status', role: 'status' });
  let timer = 0;
  const prevCleanup = cleanup;
  cleanup = () => {
    prevCleanup();
    clearTimeout(timer);
  };
  const fmtNum = (n) => Number(n).toLocaleString('fr-FR');
  const when = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

  async function reload() {
    try {
      data = await api('GET', '/wall');
    } catch (e) {
      if (e instanceof AuthError) return renderLogin();
    }
    if (gen !== routeGen) return; // left the page meanwhile: no redraw, no new timer
    draw();
  }
  const act = (btn, fn, okMsg) =>
    busy(btn, async () => {
      try {
        await fn();
        status(note, okMsg, 'ok');
      } catch (e) {
        if (e instanceof AuthError) return renderLogin();
        status(note, e.message, 'err');
      }
      await reload();
    });
  const go = (fn, okMsg) => (ev) => act(ev.currentTarget, fn, okMsg);

  function draw() {
    clearTimeout(timer);
    const { config: cfg, last_run: last, counts, busy: wallBusy } = data;
    // A 'running' row older than 30 min is a leftover from a restart
    const stale = last?.status === 'running' && Date.now() - new Date(last.started_at).getTime() > 30 * 60 * 1000;
    const running = Boolean(wallBusy) || (last?.status === 'running' && !stale);
    const refreshBtn = h('button', { class: 'btn', type: 'button', disabled: running || !cfg.has_token || !cfg.enabled }, running ? 'Actualisation en cours…' : 'Actualiser maintenant');
    refreshBtn.addEventListener('click', go(() => api('POST', '/wall/refresh', {}), 'Actualisation lancée : elle prend quelques minutes (Apify visite TikTok).'));
    const perRun = cfg.results * 0.0017;
    const lastText = !last
      ? 'Jamais actualisé.'
      : last.status === 'running'
        ? stale
          ? `Une actualisation commencée le ${when(last.started_at)} semble interrompue (redémarrage du serveur ?). Tu peux en lancer une nouvelle.`
          : `Actualisation en cours depuis ${when(last.started_at)}…`
        : last.status === 'ok'
          ? `Dernière actualisation réussie : ${when(last.finished_at)} (${last.trigger === 'schedule' ? 'automatique' : 'à la demande'}) : ${fmtNum(last.received ?? 0)} vidéos reçues, ${fmtNum(last.kept ?? 0)} retenues, ${fmtNum(last.added ?? 0)} nouvelle${last.added > 1 ? 's' : ''}, ${fmtNum(last.covers ?? 0)} vignette${last.covers > 1 ? 's' : ''} copiée${last.covers > 1 ? 's' : ''}${last.cost_usd != null ? `, coût Apify ${last.cost_usd.toFixed(2).replace('.', ',')} $` : ''}.`
          : `Dernière tentative en échec ou interrompue (${when(last.finished_at ?? last.started_at)}) : ${last.error ?? 'erreur inconnue'}`;
    const skipped = last?.status === 'ok' && last.skipped ? Object.entries(last.skipped).map(([k, v]) => `${v} ${{ ad: 'publicité(s)', hashtag: 'sans le hashtag', error: 'erreur(s) de l’acteur', invalid: 'illisible(s)' }[k] ?? k}`).join(', ') : '';

    const clipRow = (c) =>
      h('tr', { class: c.hidden || c.author_hidden ? 'wall-hidden' : '' },
        h('td', {}, c.cover ? h('img', { src: c.cover, alt: '', width: 36, height: 64, loading: 'lazy', class: 'wall-thumb' }) : h('span', { class: 'wall-thumb none' }, '·')),
        h('td', {}, h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, `@${c.author}`), c.hidden || c.author_hidden ? h('span', { class: 'badge' }, 'Masqué') : null, h('div', { class: 'status wall-text' }, c.text)),
        h('td', { class: 'num' }, fmtNum(c.views)),
        h('td', { class: 'num' }, fmtNum(c.likes)),
        h('td', { class: 'num' }, fmtNum(c.comments)),
        h('td', { class: 'num' }, h('strong', {}, fmtNum(c.score))),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'btn secondary small', type: 'button', onclick: go(() => api('PATCH', `/wall/clips/${c.id}`, { hidden: !c.hidden }), c.hidden ? 'Clip rétabli.' : 'Clip masqué.') }, c.hidden ? 'Rétablir' : 'Masquer'),
          h('button', { class: 'btn secondary small', type: 'button', title: 'Masque tous les clips de cet auteur', onclick: go(() => api('PUT', `/wall/authors/${encodeURIComponent(c.author)}`, { hidden: !c.author_hidden }), c.author_hidden ? 'Auteur rétabli.' : 'Auteur masqué.') }, c.author_hidden ? 'Rétablir l’auteur' : 'Masquer l’auteur'))));

    root.replaceChildren(
      h('section', { class: 'panel' },
        h('h2', {}, 'Mur des clips'),
        h('p', { class: 'status' }, `Les TikToks publiés avec #${cfg.hashtag} sont récupérés avec Apify (acteur ${cfg.actor}), classés par vues, j’aime et commentaires (score = ${cfg.weights[0]} × vues + ${cfg.weights[1]} × j’aime + ${cfg.weights[2]} × commentaires), et les ${cfg.max} meilleurs sont affichés sur la page publique « Le mur ». `, h('a', { href: '/mur/', target: '_blank' }, 'Voir le mur')),
        !cfg.has_token ? unavailable('la connexion à Apify (récupération des TikToks) n’est pas configurée.', 'APIFY_TOKEN') : null,
        !cfg.enabled ? unavailable('le mur est désactivé.', 'WALL_ENABLED=false') : null,
        h('p', { class: 'status' }, lastText),
        skipped ? h('p', { class: 'status' }, `Écartés : ${skipped}.`) : null,
        last?.status === 'ok' && last.received > 0 && last.kept === 0 ? h('p', { class: 'status err' }, `Aucune vidéo retenue sur ${last.received} reçues : le format des résultats de l’acteur a peut-être changé. Champs du premier élément : ${(last.sample_keys ?? []).join(', ') || '(aucun)'}.`) : null,
        last?.status === 'ok' && last.received === 0 ? h('p', { class: 'status err' }, `Apify n’a renvoyé aucune vidéo pour #${cfg.hashtag} : vérifie l’orthographe du hashtag et le crédit Apify.`) : null,
        h('p', { class: 'status' }, `Actualisation ${cfg.refresh_hours ? `automatique toutes les ${cfg.refresh_hours} h` : 'à la demande seulement'} · ${fmtNum(cfg.results)} vidéos demandées à chaque fois, soit environ ${perRun.toFixed(2).replace('.', ',')} $ d’Apify par actualisation (1,70 $ pour 1 000 résultats)${cfg.refresh_hours ? `, ${(perRun * (24 / cfg.refresh_hours) * 30).toFixed(0)} $ par mois` : ''}.`),
        h('div', { class: 'actions' }, refreshBtn)),
      note,
      h('section', { class: 'panel' },
        h('h3', {}, `Clips (${fmtNum(counts.total)}, dont ${fmtNum(counts.hidden)} masqué${counts.hidden > 1 ? 's' : ''}, ${fmtNum(counts.covers)} avec vignette)`),
        data.hidden_authors.length ? h('p', { class: 'status' }, 'Auteurs masqués : ', data.hidden_authors.map((a) => h('button', { class: 'btn secondary small', type: 'button', title: 'Rétablir', onclick: go(() => api('PUT', `/wall/authors/${encodeURIComponent(a)}`, { hidden: false }), 'Auteur rétabli.') }, `@${a} ×`))) : null,
        data.clips.length
          ? h('div', { class: 'wall-table-wrap' }, h('table', { class: 'videos wall-table' },
            h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Clip'), h('th', {}, 'Vues'), h('th', {}, 'J’aime'), h('th', {}, 'Comm.'), h('th', {}, 'Score'), h('th', {}, ''))),
            h('tbody', {}, data.clips.map(clipRow))))
          : h('p', { class: 'status' }, 'Aucun clip pour le moment : lance une actualisation.'),
        data.clips.length >= 300 ? h('p', { class: 'status' }, 'Les 300 clips les mieux classés sont listés.') : null),
    );
    if (running) timer = setTimeout(reload, 3000);
  }
  draw();
  $app.replaceChildren(root);
}

async function renderLibraryAdmin() {
  const gen = routeGen;
  let filter = 'recent';
  let data = await api('GET', `/library?filter=${filter}`);
  if (gen !== routeGen) return;
  const root = h('div');
  const note = h('p', { class: 'status', role: 'status' });
  const fmtNum = (n) => Number(n).toLocaleString('fr-FR');
  const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} Mo`;
  const when = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

  async function reload() {
    try {
      data = await api('GET', `/library?filter=${filter}`);
    } catch (e) {
      if (e instanceof AuthError) return renderLogin();
      return status(note, e.message, 'err');
    }
    if (gen !== routeGen) return;
    draw();
  }
  const go = (fn, okMsg, ask) => (ev) => {
    if (ask && !confirm(ask)) return undefined;
    return busy(ev.currentTarget, async () => {
      try {
        await fn();
        toast(okMsg, 'ok');
      } catch (e) {
        if (e instanceof AuthError) return renderLogin();
        toast(e.message, 'err');
      }
      await reload();
    });
  };

  function draw() {
    const { counts, disk, clips, config: cfg } = data;
    const row = (c) =>
      h('tr', { class: c.hidden || c.owner_hidden ? 'wall-hidden' : '' },
        h('td', {}, c.has_poster ? h('img', { src: `/api/admin/library/clips/${c.id}/poster`, alt: '', width: 36, height: 64, loading: 'lazy', class: 'wall-thumb' }) : h('span', { class: 'wall-thumb none' }, '·')),
        h('td', {},
          h('a', { href: `/bibliotheque/?clip=${c.id}`, target: '_blank' }, c.video_title || c.youtube_id),
          c.visibility === 'private' ? h('span', { class: 'badge' }, 'Privé') : null,
          c.hidden ? h('span', { class: 'badge' }, 'Masqué') : null,
          c.owner_hidden ? h('span', { class: 'badge' }, 'Auteur masqué') : null,
          c.file_state !== 'active' ? h('span', { class: 'badge' }, c.file_state === 'pending' ? 'En création' : 'Archivé') : null,
          h('div', { class: 'status' }, `${when(c.created_at)} · auteur ${c.owner_short} · ${Math.round(c.duration_s)} s`),
          c.report_list.length ? h('div', { class: 'status err' }, c.report_list.map((r) => `« ${r.reason || 'sans motif'} »`).join(' · ')) : null),
        h('td', { class: 'num' }, fmtNum(c.downloads)),
        h('td', { class: 'num' }, c.rating ? `${String(c.rating).replace('.', ',')} (${c.rating_count})` : '—'),
        h('td', { class: 'num' }, fmtNum(c.reports)),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'btn secondary small', type: 'button', onclick: go(() => api('PATCH', `/library/clips/${c.id}`, { hidden: !c.hidden }), c.hidden ? 'Clip rétabli.' : 'Clip masqué.') }, c.hidden ? 'Rétablir' : 'Masquer'),
          h('button', { class: 'btn secondary small', type: 'button', title: 'Masque tous les clips de cet auteur', onclick: go(() => api('PUT', `/library/owners/${c.owner}`, { hidden: !c.owner_hidden }), c.owner_hidden ? 'Auteur rétabli.' : 'Auteur masqué.') }, c.owner_hidden ? 'Rétablir l’auteur' : 'Masquer l’auteur'),
          c.reports ? h('button', { class: 'btn secondary small', type: 'button', onclick: go(() => api('DELETE', `/library/clips/${c.id}/reports`), 'Signalements effacés.') }, 'Effacer les signalements') : null,
          c.file_state === 'active' ? h('button', { class: 'btn secondary small', type: 'button', onclick: go(() => api('DELETE', `/library/clips/${c.id}/file`), 'Vidéo archivée.', 'Supprimer la vidéo de ce clip (les réglages restent) ?') }, 'Archiver la vidéo') : null,
          h('button', { class: 'btn secondary small', type: 'button', onclick: go(() => api('DELETE', `/library/clips/${c.id}`), 'Clip supprimé.', 'Supprimer définitivement ce clip ?') }, 'Supprimer'))));
    const filters = [['recent', 'Récents'], ['reported', `Signalés (${counts.reported})`], ['hidden', 'Masqués'], ['archived', 'Archivés']];
    root.replaceChildren(
      h('section', { class: 'panel' },
        h('h2', {}, 'Bibliothèque de clips'),
        h('p', { class: 'status' }, 'Les clips publiés depuis le studio, publics ou privés. Publication directe : masque un clip ou un auteur pour le retirer de la page publique. ', h('a', { href: '/bibliotheque/', target: '_blank' }, 'Voir la bibliothèque')),
        h('p', { class: 'status' }, `${fmtNum(counts.clips)} clips (${fmtNum(counts.public)} publics, ${fmtNum(counts.active)} avec vidéo) · ${fmtNum(counts.owners)} auteurs · ${fmtNum(counts.downloads)} téléchargements`),
        h('p', { class: 'status' }, `Espace utilisé : ${mb(disk.used)} sur ${mb(disk.max)}${disk.free != null ? ` · ${mb(disk.free)} libres sur le volume` : ''} · vidéos gardées ${cfg.retentionDays} jours · ${cfg.maxPerOwner} clips par auteur${cfg.autohideReports ? ` · masquage automatique à ${cfg.autohideReports} signalements` : ''}.`)),
      note,
      h('section', { class: 'panel' },
        h('div', { class: 'actions' }, filters.map(([key, label]) => h('button', { class: key === filter ? 'btn small' : 'btn secondary small', type: 'button', 'aria-pressed': String(key === filter), onclick: () => { filter = key; reload(); } }, label))),
        clips.length
          ? h('div', { class: 'wall-table-wrap' }, h('table', { class: 'videos wall-table' },
            h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Clip'), h('th', {}, 'Téléch.'), h('th', {}, 'Note'), h('th', {}, 'Sign.'), h('th', {}, ''))),
            h('tbody', {}, clips.map(row))))
          : h('p', { class: 'status' }, 'Aucun clip ici.')),
    );
  }
  draw();
  $app.replaceChildren(root);
}

async function renderSync() {
  const gen = routeGen;
  const [o, files] = await Promise.all([api('GET', '/sync/overview'), api('GET', '/sync/files')]);
  if (gen !== routeGen) return; // left the page meanwhile: never repaint over another page
  let inFlight = 0;
  const counters = {};
  const act = (btn, fn, okMsg) =>
    busy(btn, async () => {
      inFlight++;
      try {
        const result = await fn();
        const text = typeof result === 'string' ? result : okMsg;
        await renderSync();
        if (text) toast(text, 'ok');
      } catch (e) {
        if (e instanceof AuthError) renderLogin();
        else toast(e.message, 'err');
      } finally {
        inFlight--;
      }
    });
  const go = (fn, okMsg) => (ev) => act(ev.currentTarget, fn, okMsg);

  const plural = (n, one, many) => (n > 1 ? many : one);
  /** Aperçu puis, après confirmation, suppression des Shorts déjà importés d'une chaîne. */
  const purgeShortsFlow = async (c) => {
    const p = await api('POST', `/sync/channels/${c.id}/shorts/preview`, {});
    if (!p.total) {
      return p.protected
        ? `Aucun Short à supprimer (${p.protected} corrigé${plural(p.protected, '', 's')} à la main conservé${plural(p.protected, '', 's')}).`
        : 'Aucun Short à supprimer : la chaîne est propre.';
    }
    const text = [
      `${p.total} Short${plural(p.total, '', 's')} (ou vidéo${plural(p.total, '', 's')} trop courte${plural(p.total, '', 's')}) à supprimer : ${p.with_transcript} déjà transcrit${plural(p.with_transcript, '', 's')} (crédits Supadata déjà dépensés) et ${p.pending} en attente.`,
      p.detection === 'playlist'
        ? `Détection : liste des Shorts de YouTube + durée de 60 s ou moins${c.min_duration_s ? ` + durée inférieure à ${c.min_duration_s} s` : ''}.`
        : c.min_duration_s
          ? `Détection par la durée seule (60 s ou moins, ou inférieure à ${c.min_duration_s} s).`
          : 'Détection par la durée seule (60 s ou moins) : les Shorts plus longs ne seront pas repérés. Utilise « Durée minimale… » (181 s) pour les écarter tous.',
      p.protected ? `${p.protected} corrigé${plural(p.protected, '', 's')} à la main : conservé${plural(p.protected, '', 's')}.` : '',
      `Exemples :\n${p.examples.map((e) => `• ${e.title} (${fmtDuration(e.duration_s) || '?'})`).join('\n')}`,
      'Les vidéos ajoutées à la main ne sont jamais touchées. Les Shorts supprimés ne reviendront pas. Cette action est définitive. Continuer ?',
    ].filter(Boolean).join('\n\n');
    if (!confirm(text)) return null;
    const r = await api('POST', `/sync/channels/${c.id}/shorts/purge`, { confirm: true });
    return `${r.removed} Short${plural(r.removed, '', 's')} supprimé${plural(r.removed, '', 's')}. Ils ne seront plus importés.`;
  };
  const when = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const keyLine = (ok, label, envName, help) =>
    h('li', {}, ok ? '✅ ' : '❌ ', h('strong', {}, label), ok ? ' : disponible' : ` : fonction indisponible, à activer par le développeur (${help}). `, ok ? null : h('small', { class: 'tech' }, `variable ${envName}`));

  const stat = (n, label, key) => {
    const num = h('div', { class: 'n' }, String(n));
    counters[key] = num;
    return h('div', { class: 'stat' }, num, h('div', { class: 'l' }, label));
  };

  const state = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Synchronisation automatique'),
    h(
      'ul',
      { class: 'checks' },
      keyLine(o.keys.youtube, 'Liste des vidéos d’une chaîne YouTube', 'YOUTUBE_API_KEY', 'nécessaire pour lister les vidéos d’une chaîne'),
      keyLine(o.keys.supadata, 'Récupération des transcriptions', 'SUPADATA_API_KEY', 'nécessaire pour récupérer les transcriptions'),
    ),
    h('div', { class: 'stats' }, stat(o.counts.pending, 'en attente', 'pending'), stat(o.counts.done, 'transcrites auto.', 'done'), stat(o.counts.failed, 'en échec', 'failed'), stat(o.counts.manual, 'ajoutées à la main', 'manual')),
    h(
      'p',
      { class: 'status' },
      `Chaque jour (toutes les ${o.interval_hours} h), les nouvelles vidéos des chaînes suivies sont détectées puis mises en file d’attente. `,
      'Chaque vidéo coûte 1 crédit Supadata (sous-titres existants uniquement : aucune transcription générée par IA). ',
      'Les vidéos déjà présentes ne sont jamais retraitées : leurs transcriptions, automatiques ou corrigées à la main, ne sont jamais modifiées.',
    ),
    o.paused
      ? h(
          'p',
          { class: 'notice' },
          `Traitement en pause. ${o.counts.pending} vidéo${o.counts.pending > 1 ? 's' : ''} en attente ≈ ${o.counts.pending} crédit${o.counts.pending > 1 ? 's' : ''} Supadata. La détection des nouvelles vidéos continue, mais aucune transcription n’est demandée tant que tu n’as pas démarré.`,
        )
      : h('p', { class: 'status ok' }, '▶ Traitement actif.'),
    o.llm_error
      ? h(
          'p',
          { class: 'notice' },
          `Dernière erreur du modèle IA (${o.llm_error.feature}, ${when(o.llm_error.at)}) : ${o.llm_error.message}`,
        )
      : null,
    o.cooldown_until ? h('p', { class: 'status err' }, `Traitement suspendu jusqu’à ${when(o.cooldown_until)} : ${o.last_error ?? ''}`) : null,
    h(
      'div',
      { class: 'actions' },
      o.paused
        ? h('button', { class: 'btn', type: 'button', disabled: !o.keys.supadata, onclick: go(() => api('POST', '/sync/resume', {}), 'Traitement démarré.') }, 'Démarrer le traitement')
        : h('button', { class: 'btn secondary', type: 'button', onclick: go(() => api('POST', '/sync/pause', {}), 'Mis en pause.') }, 'Mettre en pause'),
      !o.paused ? h('button', { class: 'btn secondary', type: 'button', onclick: go(() => api('POST', '/sync/run', {}), 'Passe lancée.') }, 'Lancer une passe maintenant') : null,
    ),
  );


  // --- résumés automatiques
  const sm = o.summaries;
  const summariesPanel = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Résumés automatiques'),
    h('ul', { class: 'checks' }, keyLine(sm.configured, 'Rédaction des résumés par l’IA', 'OPENROUTER_API_KEY', 'nécessaire pour rédiger les résumés')),
    h('div', { class: 'stats' }, stat(sm.ready, 'résumés prêts', 'sReady'), stat(sm.waiting, 'en attente', 'sWaiting'), stat(sm.failed, 'en échec', 'sFailed')),
    h(
      'p',
      { class: 'status' },
      `Chaque vidéo transcrite reçoit automatiquement son résumé, quelques minutes après sa transcription (modèle : ${sm.model}). Un résumé n’est écrit qu’une seule fois : une vidéo qui en a un n’est jamais re-résumée automatiquement. Les visiteurs ne font qu’afficher les résumés déjà prêts : ils ne déclenchent aucun appel à l’IA, donc aucun coût.`,
    ),
    sm.paused
      ? h('p', { class: 'notice' }, 'Génération des résumés en pause : les nouvelles vidéos n’auront pas de résumé tant que tu ne l’as pas relancée.')
      : sm.configured
        ? h('p', { class: 'status ok' }, 'Génération automatique active.')
        : null,
    sm.cooldown_until ? h('p', { class: 'status err' }, `Génération suspendue jusqu’à ${when(sm.cooldown_until)} après une erreur du modèle (voir le message ci-dessus).`) : null,
    h(
      'div',
      { class: 'actions' },
      sm.paused
        ? h('button', { class: 'btn', type: 'button', disabled: !sm.configured, onclick: go(() => api('POST', '/sync/summaries/resume', {}), 'Génération des résumés relancée.') }, 'Relancer les résumés')
        : h('button', { class: 'btn secondary', type: 'button', onclick: go(() => api('POST', '/sync/summaries/pause', {}), 'Génération des résumés mise en pause.') }, 'Mettre en pause'),
      !sm.paused && sm.configured ? h('button', { class: 'btn secondary', type: 'button', onclick: go(() => api('POST', '/sync/summaries/run', {}), 'Passe lancée : les résumés en attente sont rédigés (une minute environ chacun).') }, 'Lancer maintenant') : null,
    ),
    sm.failed_list.length
      ? h(
          'div',
          { class: 'chan-list', style: 'margin-top:1rem' },
          h('p', { class: 'status' }, 'Résumés en échec (5 tentatives) :'),
          sm.failed_list.map((v) =>
            h(
              'article',
              { class: 'chan' },
              h('div', { class: 't' }, v.title),
              h('p', { class: 'status err' }, v.summary_error ?? ''),
              h(
                'div',
                { class: 'actions' },
                h('button', { class: 'btn secondary small', type: 'button', onclick: go(() => api('POST', `/sync/summaries/${v.id}/retry`, {}), 'Nouvelle tentative lancée.') }, 'Réessayer'),
                h('a', { class: 'btn small', href: `#/video/${v.id}` }, 'Ouvrir'),
              ),
            ),
          ),
        )
      : null,
  );

  // --- chaînes
  const input = h('input', { type: 'text', placeholder: 'https://www.youtube.com/@nomdelachaine', required: true });
  const minD = h('input', { type: 'number', min: '0', value: '0' });
  const noShorts = h('input', { type: 'checkbox', checked: true });
  const addMsg = h('p', { class: 'status', role: 'status' });
  const addBtn = h('button', { class: 'btn', type: 'submit', disabled: !o.keys.youtube }, 'Ajouter et lister les vidéos');
  const addForm = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        busy(addBtn, async () => {
          inFlight++;
          status(addMsg, 'Recherche de la chaîne et liste des vidéos… (peut prendre quelques secondes)');
          try {
            const r = await api('POST', '/sync/channels', { input: input.value, min_duration_s: Number(minD.value) || 0, exclude_shorts: noShorts.checked });
            if (r.error) status(addMsg, `Chaîne ajoutée, mais la liste a échoué : ${r.error}`, 'err');
            else {
              await renderSync();
              toast(`${r.added} vidéo${r.added > 1 ? 's' : ''} trouvée${r.added > 1 ? 's' : ''} et mise${r.added > 1 ? 's' : ''} en file d’attente.`, 'ok');
            }
          } catch (err) {
            fail(err, addMsg);
          } finally {
            inFlight--;
          }
        });
      },
    },
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Chaîne YouTube (URL, @nom ou identifiant UC…)', input), h('label', { class: 'field' }, 'Durée minimale (secondes, 0 = aucune)', minD)),
    h('label', { class: 'radio' }, noShorts, 'Exclure les Shorts (vidéos courtes verticales) : seulement les vidéos longues'),
    h('div', { class: 'actions' }, addBtn, addMsg),
  );

  const rows = o.channels.map((c) => {
    const minInput = h('input', { type: 'number', min: '0', step: '1', class: 'inline-num', value: String(c.min_duration_s || 0), 'aria-label': 'Durée minimale en secondes' });
    return h(
      'article',
      { class: 'chan' },
      h('div', { class: 't' }, c.title || c.youtube_channel_id, c.handle ? h('span', { class: 'status' }, ` ${c.handle}`) : null),
      h(
        'p',
        { class: 'chan-meta' },
        h('span', {}, `${c.video_count} vidéo${plural(c.video_count, '', 's')}`),
        h('span', {}, `Durée min. : ${c.min_duration_s ? `${c.min_duration_s} s` : 'aucune'}`),
        h('span', {}, 'Shorts : ', c.exclude_shorts ? 'exclus' : h('strong', { class: 'status err' }, 'inclus')),
        h('span', {}, c.enabled ? '' : 'suspendue'),
        h('span', {}, c.last_discovery_error ? h('span', { class: 'status err' }, c.last_discovery_error) : `Vérifiée : ${when(c.last_discovery_at)}`),
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn secondary small', type: 'button', onclick: go(async () => { const r = await api('POST', `/sync/channels/${c.id}/discover`, {}); return `${r.added} nouvelle${r.added > 1 ? 's' : ''} vidéo${r.added > 1 ? 's' : ''}.`; }) }, 'Chercher maintenant'),
        h('button', { class: 'btn small', type: 'button', title: 'Supprime les Shorts déjà importés (aperçu et confirmation avant)', onclick: go(() => purgeShortsFlow(c)) }, 'Retirer les Shorts…'),
        h(
          'span',
          { class: 'min-dur', title: 'Les vidéos plus courtes ne sont pas importées. Astuce : 181 écarte tous les Shorts, même ceux de 1 à 3 minutes. Clique ensuite sur « Retirer les Shorts… » pour supprimer ceux déjà importés.' },
          h('label', {}, 'Durée min. (s) ', minInput),
          h(
            'button',
            {
              class: 'btn secondary small',
              type: 'button',
              onclick: go(async () => {
                const n = Number(minInput.value);
                if (!Number.isFinite(n) || n < 0) throw new Error('Durée invalide.');
                await api('PATCH', `/sync/channels/${c.id}`, { min_duration_s: Math.round(n) });
                return n ? `Durée minimale : ${Math.round(n)} s. Clique sur « Retirer les Shorts… » pour supprimer celles déjà importées.` : 'Plus de durée minimale.';
              }),
            },
            'Appliquer',
          ),
        ),
        c.exclude_shorts ? null : h('button', { class: 'btn secondary small', type: 'button', onclick: go(() => api('PATCH', `/sync/channels/${c.id}`, { exclude_shorts: true }), 'Les Shorts sont désormais exclus.') }, 'Exclure les Shorts'),
        h('button', { class: 'btn secondary small', type: 'button', onclick: go(() => api('PATCH', `/sync/channels/${c.id}`, { enabled: !c.enabled })) }, c.enabled ? 'Suspendre' : 'Reprendre'),
        h('button', { class: 'btn danger small', type: 'button', onclick: (ev) => confirm('Ne plus suivre cette chaîne ? Les vidéos déjà importées sont conservées.') && act(ev.currentTarget, () => api('DELETE', `/sync/channels/${c.id}`)) }, 'Retirer la chaîne'),
      ),
    );
  });
  const channels = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Chaînes suivies'),
    rows.length ? h('div', { class: 'chan-list' }, rows) : h('p', { class: 'status' }, 'Aucune chaîne suivie.'),
    h('h3', { style: 'margin-top:1.2rem' }, 'Ajouter une chaîne'),
    addForm,
  );

  // --- échecs
  const failed = o.failed.length
    ? h(
        'section',
        { class: 'panel' },
        h('h2', {}, `Vidéos en échec (${o.counts.failed})`),
        h('p', { class: 'status' }, 'Souvent : pas de sous-titres disponibles. Pour une vidéo récente, la synchro réessaie toute seule (les sous-titres automatiques arrivent parfois après quelques heures). Sinon, transcris-les gratuitement avec Whisper sur ton ordinateur (une fois fini, la transcription est enregistrée pour tout le monde). Pour toutes les vidéos de cette liste d’un coup :'),
        commandBox(`python tools/transcribe.py --site ${location.origin} --all-failed`),
        h('p', { class: 'status' }, h('a', { href: SCRIPT_URL, target: '_blank', rel: 'noopener' }, 'Récupérer le dossier tools/ ↗'), ' · ou ouvre une vidéo pour la transcrire seule, ou coller une transcription à la main.'),
        h(
          'div',
          { class: 'chan-list' },
          o.failed.map((v) =>
            h(
              'article',
              { class: 'chan' },
              h('div', { class: 't' }, v.title || v.youtube_id),
              h('p', { class: 'status err' }, v.sync_error ?? ''),
              h(
                'div',
                { class: 'actions' },
                h('button', { class: 'btn secondary small', type: 'button', onclick: go(() => api('POST', `/sync/videos/${v.id}/retry`, {}), 'Remise en file d’attente.') }, 'Réessayer'),
                h('a', { class: 'btn small', href: `#/video/${v.id}` }, 'Ouvrir'),
              ),
            ),
          ),
        ),
      )
    : null;

  // --- téléchargement automatique des vidéos (yt-dlp)
  const gb = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1).replace('.', ',')} Go` : `${Math.round(b / 1048576)} Mo`);
  const filesPanel = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Téléchargement automatique des vidéos'),
    h(
      'p',
      { class: 'status' },
      `Dès qu’une vidéo a sa transcription, son fichier est téléchargé (${files.max_height} p au plus, vidéos de ${Math.round(files.min_duration_s / 60)} min ou plus), les clips sont autorisés et les extraits proposés. `,
      `Les fichiers téléchargés par le site sont supprimés après ${files.retention_days} jours ; ceux déposés à la main ne le sont jamais.`,
    ),
    files.enabled
      ? h('p', { class: 'status ok' }, `▶ Actif (yt-dlp ${files.ytdlp_version ?? 'pas encore installé'}).`)
      : h('p', { class: 'notice' }, 'Désactivé. Pour l’activer, le développeur ajoute la variable AUTO_DOWNLOAD=on sur le serveur.'),
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'n' }, String(files.waiting)), h('div', { class: 'l' }, 'à télécharger')),
      h('div', { class: 'stat' }, h('div', { class: 'n' }, String(files.downloaded)), h('div', { class: 'l' }, 'téléchargées')),
      h('div', { class: 'stat' }, h('div', { class: 'n' }, gb(files.bytes)), h('div', { class: 'l' }, 'espace utilisé')),
      h('div', { class: 'stat' }, h('div', { class: 'n' }, files.free_mb == null ? '—' : gb(files.free_mb * 1048576)), h('div', { class: 'l' }, 'espace libre')),
    ),
    files.cooldown_until ? h('p', { class: 'status err' }, `Téléchargements suspendus jusqu’à ${when(files.cooldown_until)} (YouTube bloque le serveur).`) : null,
    files.last_error ? h('p', { class: 'status err' }, `Dernière erreur : ${files.last_error.replace(/^\S+ — /, '')}`) : null,
    files.enabled
      ? h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: go(() => api('POST', '/sync/files/run', {}), 'Téléchargement lancé : il peut durer quelques minutes.') }, 'Télécharger maintenant'),
          files.with_error || files.cooldown_until
            ? h('button', { class: 'btn secondary', type: 'button', onclick: go(async () => `${(await api('POST', '/sync/files/retry', {})).reset} vidéo(s) remise(s) en file.`) }, 'Réessayer les échecs')
            : null,
        )
      : null,
  );

  $app.replaceChildren(...[state, summariesPanel, filesPanel, channels, failed].filter(Boolean));
  cleanup(); // a re-render (timer, action) replaces the previous timer instead of adding one

  const sigOf = (x) =>
    JSON.stringify([
      x.paused, x.cooldown_until, x.last_error, x.llm_error, x.keys,
      x.summaries.paused, x.summaries.configured, x.summaries.cooldown_until, x.summaries.failed_list.map((v) => v.id),
      x.channels.map((c) => [c.id, c.title, c.enabled, c.exclude_shorts, c.min_duration_s, c.last_discovery_error]),
      x.failed.map((v) => v.id),
    ]);
  const sig = sigOf(o);
  // A full redraw would wipe typed text and focus
  const idle = () => {
    const ae = document.activeElement;
    const typing = ae && $app.contains(ae) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName);
    return !typing && !input.value && !addBtn.disabled && !inFlight;
  };
  const tick = async () => {
    if (document.hidden || inFlight) return;
    try {
      const fresh = await api('GET', '/sync/overview');
      if (gen !== routeGen || inFlight) return;
      const set = (k, v) => counters[k] && (counters[k].textContent = String(v));
      set('pending', fresh.counts.pending);
      set('done', fresh.counts.done);
      set('failed', fresh.counts.failed);
      set('manual', fresh.counts.manual);
      set('sReady', fresh.summaries.ready);
      set('sWaiting', fresh.summaries.waiting);
      set('sFailed', fresh.summaries.failed);
      if (sigOf(fresh) !== sig && idle()) await renderSync();
    } catch (err) {
      if (err instanceof AuthError) renderLogin();
    }
  };
  const timer = setInterval(tick, 20000);
  cleanup = () => clearInterval(timer);
}

// ---------------------------------------------------------------------- éditeur

async function renderEditor(id) {
  const gen = routeGen;
  const [{ video, segments, summary }, config, firstClipState] = await Promise.all([
    api('GET', `/videos/${id}`),
    api('GET', '/config'),
    api('GET', `/videos/${id}/clips`).catch((err) => {
      if (err instanceof AuthError) throw err;
      return null;
    }),
  ]);
  if (gen !== routeGen) return;
  let clipState = firstClipState;
  let segs = segments.map((s) => ({ ...s, orig: s.text, origStart: s.start_ms }));
  let dirty = false;
  let rev = 0;
  let saving = false;
  let player = null;
  let activeIdx = -1;
  let pageLeft = false; // set by cleanup: late async callbacks must not act on a page that is gone
  let uploading = null; // AbortController of a running video upload

  const setDirty = (v) => {
    dirty = v;
    saveBtn.disabled = !dirty || saving;
    saveMsg.textContent = dirty ? 'Modifications non enregistrées' : 'À jour';
    saveMsg.className = `status${dirty ? '' : ' ok'}`;
  };
  const markDirty = () => {
    rev++;
    setDirty(true);
  };
  const savedInfo = { title: video.title ?? '', channel: video.channel ?? '', date: video.published_at?.slice(0, 10) ?? '', lang: video.lang ?? '' };
  const isDirty = () => dirty || sumArea.value !== summary.content || Object.keys(savedInfo).some((k) => f[k].value !== savedInfo[k]);
  dirtyGuard = () => (uploading ? 'Un envoi de vidéo est en cours : quitter l’interrompra. Quitter quand même ?' : isDirty());
  const beforeUnload = (e) => isDirty() && e.preventDefault();
  window.addEventListener('beforeunload', beforeUnload);
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const focus = document.activeElement;
      if (sumArea.contains(focus)) saveSum.click();
      else if (info.contains(focus)) saveInfoBtn.click();
      else save();
    }
  };
  window.addEventListener('keydown', onKey);

  // --- infos de la vidéo
  const infoMsg = h('span', { class: 'status', role: 'status' });
  const f = {
    title: h('input', { type: 'text', value: video.title }),
    channel: h('input', { type: 'text', value: video.channel }),
    date: h('input', { type: 'date', value: video.published_at?.slice(0, 10) ?? '' }),
    lang: h('input', { type: 'text', value: video.lang ?? '', maxlength: '5' }),
  };
  const saveInfoBtn = h('button', { class: 'btn secondary small', type: 'button' }, 'Enregistrer les infos');
  saveInfoBtn.addEventListener('click', () =>
    busy(saveInfoBtn, async () => {
      try {
        const sent = { title: f.title.value, channel: f.channel.value, date: f.date.value, lang: f.lang.value };
        await api('PATCH', `/videos/${id}`, { title: sent.title, channel: sent.channel, published_at: sent.date || null, lang: sent.lang });
        Object.assign(savedInfo, sent);
        status(infoMsg, 'Infos enregistrées', 'ok');
      } catch (err) {
        fail(err, infoMsg);
      }
    }),
  );
  const info = h(
    'section',
    { class: 'panel' },
    h('h2', {}, video.title || video.youtube_id),
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field' }, 'Titre', f.title),
      h('label', { class: 'field' }, 'Chaîne', f.channel),
      h('label', { class: 'field' }, 'Date', f.date),
      h('label', { class: 'field' }, 'Langue', f.lang),
    ),
    h(
      'div',
      { class: 'actions' },
      saveInfoBtn,
      infoMsg,
      config.youtube
        ? h(
            'button',
            {
              class: 'btn secondary small',
              type: 'button',
              title: 'Remplace titre, chaîne, date de publication et miniature par ceux de YouTube',
              onclick: (ev) => {
                if (!confirm('Remplacer titre, chaîne et date de publication par ceux de YouTube ?')) return;
                busy(ev.currentTarget, async () => {
                  try {
                    const v = await api('POST', `/videos/${id}/refresh-meta`, {});
                    f.title.value = v.title;
                    f.channel.value = v.channel;
                    f.date.value = v.published_at?.slice(0, 10) ?? '';
                    Object.assign(savedInfo, { title: f.title.value, channel: f.channel.value, date: f.date.value });
                    status(infoMsg, 'Mis à jour depuis YouTube', 'ok');
                  } catch (err) {
                    fail(err, infoMsg);
                  }
                });
              },
            },
            'Mettre à jour depuis YouTube',
          )
        : null,
      h('a', { href: `https://www.youtube.com/watch?v=${video.youtube_id}`, target: '_blank', rel: 'noopener' }, 'Ouvrir sur YouTube ↗'),
    ),
  );

  // --- liste des segments
  const list = h('div', { class: 'panel segs' });
  const rowEls = [];

  const autosize = (ta) => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };

  function renderSegs() {
    rowEls.length = 0;
    list.replaceChildren();
    if (!segs.length) list.append(h('p', { class: 'status' }, 'Aucun segment. Utilise « + » ou importe une transcription.'));
    segs.forEach((s, i) => {
      const ts = h('input', {
        class: 'ts',
        type: 'text',
        value: fmtTs(s.start_ms),
        'aria-label': 'Horodatage',
        onchange: () => {
          const ms = parseTs(ts.value);
          if (ms == null) ts.value = fmtTs(s.start_ms);
          else if (Math.floor(ms / 1000) !== Math.floor(s.start_ms / 1000)) {
            s.start_ms = ms;
            ts.value = fmtTs(ms);
            row.classList.add('dirty');
            markDirty();
          }
        },
      });
      const ta = h('textarea', {
        class: 'tseg-text',
        'aria-label': `Texte du segment à ${fmtTs(s.start_ms)}`,
        rows: '1',
        value: s.text,
        spellcheck: 'true',
        lang: 'fr',
        oninput: () => {
          s.text = ta.value;
          row.classList.toggle('dirty', s.text !== s.orig || s.start_ms !== s.origStart);
          autosize(ta);
          markDirty();
        },
      });
      const btn = (label, title, fn) => h('button', { type: 'button', title, 'aria-label': title, onclick: fn }, label);
      const row = h(
        'div',
        { class: `tseg${s.text !== s.orig || s.start_ms !== s.origStart ? ' dirty' : ''}` },
        h(
          'div',
          { class: 'tcell' },
          h('button', { class: 'play', type: 'button', title: 'Écouter à partir d’ici', onclick: () => seek(s.start_ms) }, '▶'),
          ts,
        ),
        h('div', { class: 'textcell' }, ta, s.text_original ? h('div', { class: 'orig', title: 'Texte d’origine avant traduction' }, s.text_original) : null),
        h(
          'div',
          { class: 'tools' },
          btn('✂', 'Couper au curseur', () => {
            const at = ta.selectionStart;
            const left = s.text.slice(0, at).trim();
            const right = s.text.slice(at).trim();
            if (!left || !right) return toast('Place d’abord le curseur dans le texte, à l’endroit où couper, puis clique sur ✂.', 'err');
            const next = segs[i + 1];
            const span = s.duration_ms ?? (next ? next.start_ms - s.start_ms : 0);
            const newStart = s.start_ms + Math.round(Math.max(span, 0) * (left.length / s.text.length));
            s.text = left;
            segs.splice(i + 1, 0, { start_ms: newStart, duration_ms: null, text: right, text_original: null, orig: '', origStart: -1 });
            markDirty();
            renderSegs();
          }),
          btn('⤵', 'Fusionner avec la suivante', () => {
            const next = segs[i + 1];
            if (!next) return;
            s.text = `${s.text.trim()} ${next.text.trim()}`;
            s.text_original = [s.text_original, next.text_original].filter(Boolean).join(' ') || null;
            s.duration_ms = null;
            segs.splice(i + 1, 1);
            markDirty();
            renderSegs();
          }),
          btn('＋', 'Insérer un segment dessous', () => {
            segs.splice(i + 1, 0, { start_ms: s.start_ms + (s.duration_ms ?? 0), duration_ms: null, text: '', text_original: null, orig: '', origStart: -1 });
            markDirty();
            renderSegs();
            rowEls[i + 1]?.querySelector('textarea').focus();
          }),
          btn('✕', 'Supprimer', () => {
            const [removed] = segs.splice(i, 1);
            markDirty();
            renderSegs();
            rowEls[Math.min(i, rowEls.length - 1)]?.querySelector('textarea')?.focus();
            toast('Segment supprimé.', 'ok', 'Annuler', () => {
              if (pageLeft) return;
              // Reinsert by time: other rows may have changed since
              let at = segs.findIndex((x) => x.start_ms > removed.start_ms);
              if (at < 0) at = segs.length;
              segs.splice(at, 0, removed);
              markDirty();
              renderSegs();
              rowEls[at]?.querySelector('textarea')?.focus();
            });
          }),
        ),
      );
      rowEls.push(row);
      list.append(row);
    });
    requestAnimationFrame(() => list.querySelectorAll('textarea.tseg-text').forEach(autosize));
    activeIdx = -1;
  }

  // --- lecteur
  const playerBox = h('div', { class: 'player' }, h('div', { id: 'yt-player' }));
  const follow = h('input', { type: 'checkbox', checked: true });
  loadYT().then((YT) => {
    if (pageLeft) return;
    player = new YT.Player('yt-player', {
      videoId: video.youtube_id,
      width: '100%',
      height: '100%',
      playerVars: { rel: 0, modestbranding: 1, cc_load_policy: 0 },
    });
  });
  function seek(ms) {
    if (!player?.seekTo) return;
    player.seekTo(ms / 1000, true);
    player.playVideo();
  }
  const timer = setInterval(() => {
    if (!player?.getCurrentTime || player.getPlayerState?.() !== 1) return;
    const t = player.getCurrentTime() * 1000;
    let idx = -1;
    for (let i = 0; i < segs.length; i++) if (segs[i].start_ms <= t) idx = i;
    if (idx === activeIdx) return;
    rowEls[activeIdx]?.classList.remove('active');
    activeIdx = idx;
    const el = rowEls[idx];
    el?.classList.add('active');
    if (follow.checked && !document.activeElement?.classList.contains('tseg-text')) el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 400);

  // --- chercher / remplacer
  const findIn = h('input', { class: 'text', type: 'text', placeholder: 'Chercher…' });
  const replIn = h('input', { class: 'text', type: 'text', placeholder: 'Remplacer par…' });
  const findMsg = h('span', { class: 'status', role: 'status' });
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const countMatches = () => {
    if (!findIn.value) return status(findMsg, '');
    const re = new RegExp(escapeRe(findIn.value), 'gi');
    const n = segs.reduce((acc, s) => acc + (s.text.match(re)?.length ?? 0), 0);
    status(findMsg, `${n} occurrence${n > 1 ? 's' : ''}`);
  };
  findIn.addEventListener('input', countMatches);
  const tools = h(
    'section',
    { class: 'panel' },
    h('h3', {}, 'Chercher / remplacer'),
    h('p', { class: 'status' }, 'Pratique pour corriger un nom propre mal reconnu (insensible à la casse).'),
    findIn,
    h('div', { style: 'height:.4rem' }),
    replIn,
    h(
      'div',
      { class: 'actions', style: 'margin-top:.6rem' },
      h(
        'button',
        {
          class: 'btn secondary small',
          type: 'button',
          onclick: () => {
            if (!findIn.value) return;
            const re = new RegExp(escapeRe(findIn.value), 'gi');
            let n = 0;
            for (const s of segs) {
              const next = s.text.replace(re, () => (n++, replIn.value));
              s.text = next;
            }
            if (n) {
              markDirty();
              renderSegs();
            }
            status(findMsg, `${n} remplacement${n > 1 ? 's' : ''}`, n ? 'ok' : '');
          },
        },
        'Tout remplacer',
      ),
      findMsg,
    ),
  );

  // --- source de la transcription
  const srcMsg = h('p', { class: 'status', role: 'status' });
  const pasteArea = h('textarea', { class: 'text', rows: '6', placeholder: 'SRT, VTT, « [00:12] texte »…' });
  const source = h(
    'section',
    { class: 'panel' },
    h(
      'details',
      {},
      h('summary', {}, 'Remplacer la transcription'),
      h('p', { class: 'status' }, 'Écrase les segments actuels (modifications non enregistrées comprises).'),
      config.supadata
        ? h(
            'button',
            {
              class: 'btn secondary small',
              type: 'button',
              onclick: (ev) => {
                if (!confirm(video.edited ? 'Tes corrections manuelles seront perdues. Continuer ?' : 'Récupérer à nouveau la transcription ?')) return;
                busy(ev.currentTarget, async () => {
                  status(srcMsg, 'Récupération…');
                  try {
                    await api('POST', `/videos/${id}/refetch`, { lang: f.lang.value || undefined });
                    dirty = false;
                    route();
                  } catch (err) {
                    fail(err, srcMsg);
                  }
                });
              },
            },
            'Récupérer via Supadata',
          )
        : null,
      h('div', { style: 'height:.6rem' }),
      pasteArea,
      h(
        'button',
        {
          class: 'btn secondary small',
          type: 'button',
          style: 'margin-top:.5rem',
          onclick: (ev) => {
            if (!pasteArea.value.trim() || !confirm('Remplacer toute la transcription par ce texte ?')) return;
            busy(ev.currentTarget, async () => {
              try {
                await api('POST', `/videos/${id}/import`, { transcript: pasteArea.value });
                dirty = false;
                route();
              } catch (err) {
                fail(err, srcMsg);
              }
            });
          },
        },
        'Importer le texte collé',
      ),
      srcMsg,
    ),
  );


  // --- traduction
  const trMsg = h('p', { class: 'status', role: 'status' });
  const translatable = Boolean(video.lang) && video.lang !== 'fr';
  const translatePanel = h(
    'section',
    { class: 'panel' },
    h(
      'details',
      { open: translatable || video.translated },
      h('summary', {}, 'Langue et traduction'),
      h(
        'p',
        { class: 'status' },
        `Langue du texte affiché : ${video.lang ?? 'inconnue'}. `,
        video.translated ? `Traduit automatiquement depuis « ${video.original_lang ?? '?'} » : le texte d’origine est conservé sous chaque segment. Sur le site, les résultats sont signalés comme traduction.` : '',
      ),
      translatable
        ? config.translate
          ? h(
              'button',
              {
                class: 'btn secondary small',
                type: 'button',
                onclick: (ev) => {
                  if (dirty) return status(trMsg, 'Enregistre d’abord tes modifications.', 'err');
                  if (!confirm('Le texte affiché sera remplacé par une traduction automatique en français (le texte d’origine est conservé). Continuer ?')) return;
                  busy(ev.currentTarget, async () => {
                    status(trMsg, 'Traduction en cours… (une à deux minutes pour une longue vidéo)');
                    try {
                      await api('POST', `/videos/${id}/translate`, { lang: 'fr' });
                      route();
                    } catch (err) {
                      fail(err, trMsg);
                    }
                  });
                },
              },
              'Traduire en français',
            )
          : unavailable('la traduction automatique n’est pas configurée.', 'OPENROUTER_API_KEY')
        : null,
      trMsg,
    ),
  );



  // --- résumé IA (modifiable à la main)
  const sumMsg = h('p', { class: 'status', role: 'status' });
  const sumDate = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const sumText = {
    edited: `Corrigé à la main le ${sumDate(summary.edited_at)} : il n’est jamais régénéré automatiquement.${summary.outdated ? ' La transcription a été modifiée depuis : relis ce résumé.' : ''}`,
    ready: `Rédigé par l’IA le ${sumDate(summary.created_at)} (modèle ${summary.model}). Il s’affiche sur le site et n’est jamais refait automatiquement.${summary.outdated ? ' La transcription a été modifiée depuis : si besoin, corrige le résumé ou clique sur « Régénérer avec l’IA ».' : ''}`,
    waiting: 'Sera rédigé automatiquement dans quelques minutes (délai après la dernière modification). Tu peux aussi l’écrire toi-même ci-dessous.',
    failed: `En échec après ${summary.attempts} tentatives : ${summary.error ?? ''} Tu peux l’écrire toi-même ci-dessous.`,
    none: 'Pas de transcription : pas de résumé.',
  }[summary.status];
  const sumArea = h('textarea', { class: 'text sum-area', rows: 14, spellcheck: 'true', 'aria-label': 'Résumé de la vidéo', value: summary.content });
  sumArea.value = summary.content;
  const saveSum = h('button', { class: 'btn small', type: 'button', disabled: true }, 'Enregistrer le résumé');
  sumArea.addEventListener('input', () => {
    saveSum.disabled = sumArea.value === summary.content;
    status(sumMsg, '');
  });
  saveSum.addEventListener('click', async () => {
    if (saveSum.disabled) return;
    let ok = false;
    await busy(saveSum, async () => {
      try {
        const r = await api('PUT', `/videos/${id}/summary`, { markdown: sumArea.value });
        sumArea.value = r.markdown;
        summary.content = r.markdown;
        ok = true;
        status(sumMsg, 'Résumé enregistré : il est affiché tel quel sur le site.', 'ok');
      } catch (e) {
        fail(e, sumMsg);
      }
    });
    saveSum.disabled = ok;
  });
  const summaryPanel = h(
    'section',
    { class: 'panel' },
    h(
      'details',
      { open: summary.status === 'failed' || summary.status === 'edited' },
      h('summary', {}, `Résumé IA : ${{ edited: 'corrigé à la main', ready: 'prêt', waiting: 'en attente', failed: 'en échec', none: 'aucun' }[summary.status]}`),
      h('p', { class: summary.status === 'failed' ? 'status err' : 'status' }, sumText),
      summary.status === 'none'
        ? null
        : [
            h(
              'p',
              { class: 'status' },
              'Format : « ## En bref » puis du texte ; « ## [12:34] Titre » pour une section avec repère de temps cliquable ; « - » pour une puce ; **gras** pour un mot important.',
            ),
            sumArea,
            h(
              'div',
              { class: 'actions' },
              saveSum,
              h(
                'button',
                {
                  class: 'btn secondary small',
                  type: 'button',
                  onclick: (ev) => {
                    if (dirty) return status(sumMsg, 'Enregistre d’abord tes modifications de la transcription.', 'err');
                    if (summary.content && !confirm('Régénérer remplacera le résumé actuel (y compris tes corrections) par un nouveau résumé IA. Continuer ?')) return;
                    busy(ev.currentTarget, async () => {
                      status(sumMsg, 'Rédaction du résumé… (environ une minute)');
                      try {
                        await api('POST', `/videos/${id}/summary`, {});
                        route();
                      } catch (err) {
                        fail(err, sumMsg);
                      }
                    });
                  },
                },
                'Régénérer avec l’IA',
              ),
            ),
          ],
      sumMsg,
    ),
  );

  // --- clips TikTok / Reels : fichier vidéo, autorisation, extraits proposés
  const clipsPanel = h('section', { class: 'panel' });
  let clipsPreview = null; // <video> d'aperçu (pour « Voir » un extrait)

  // --- cadrage automatique : détection des visages dans la vidéo (le studio s'en sert en mode plein écran)
  const facesBox = h('div');
  let facesTimer = 0;
  const prevCleanup = cleanup;
  cleanup = () => {
    prevCleanup();
    clearTimeout(facesTimer);
  };
  function drawFaces() {
    clearTimeout(facesTimer);
    const fc = clipState?.faces;
    if (!clipState?.file || !fc || fc.status === 'off') return facesBox.replaceChildren();
    const analysing = fc.status === 'queued' || fc.status === 'running';
    const phase = fc.phase === 'identify' ? 'Reconnaissance de David Lisnard' : fc.phase === 'rescue' ? 'Deuxième passe sur les visages difficiles' : 'Analyse';
    const id2 = fc.ident ?? { state: 'off' };
    const text = {
      none: 'Pas encore analysée : en plein écran, les visiteurs devront cadrer à la main.',
      queued: `${phase} en attente…`,
      running: `${phase} en cours… ${Math.round((fc.progress ?? 0) * 100)} % (quelques minutes pour une interview d’une heure ; le site reste utilisable).`,
      ready: `Visages repérés (${fc.summary?.seconds ?? '?'} s analysées à ${fc.summary?.fps ?? '?'} image${fc.summary?.fps > 1 ? 's' : ''} par seconde, ${fc.summary?.cuts ?? 0} changement${fc.summary?.cuts > 1 ? 's' : ''} de plan).${fc.summary?.share != null ? ` Un visage est détecté sur ${Math.round(fc.summary.share * 100)} % du temps, largeur médiane ${Math.round((fc.summary.median_w ?? 0) * 1000) / 10} % de l’image.` : ''} En plein écran, le cadre suit la personne qui parle.`,
      failed: `L’analyse a échoué : ${fc.error ?? 'erreur inconnue'}`,
      stale: 'La vidéo a été remplacée depuis l’analyse : relance-la.',
    }[fc.status];
    const identText = fc.status !== 'ready' ? null : {
      off: 'Reconnaissance de David Lisnard : aucune photo de référence (onglet « Reconnaissance »).',
      none: 'Reconnaissance de David Lisnard : pas encore faite.',
      stale: 'Reconnaissance de David Lisnard : à mettre à jour (les photos de référence ont changé).',
      ready: `Reconnaissance de David Lisnard : à jour (${id2.matches ?? 0} visage${id2.matches > 1 ? 's' : ''} reconnu${id2.matches > 1 ? 's' : ''} sur ${id2.samples ?? 0} comparé${id2.samples > 1 ? 's' : ''}, dans les plans à plusieurs personnes).`,
    }[id2.state];
    const identBtn = fc.status === 'ready' && (id2.state === 'none' || id2.state === 'stale')
      ? h('button', { class: 'btn secondary small', type: 'button', onclick: async (ev) => {
        await busy(ev.currentTarget, async () => {
          try {
            clipState = await api('POST', `/videos/${id}/faces/identify`, {});
          } catch (err) {
            fail(err, clipMsg);
          }
        });
        drawFaces();
      } }, 'Lancer la reconnaissance')
      : null;
    const btn = h('button', { class: 'btn secondary small', type: 'button', disabled: analysing }, fc.status === 'ready' || fc.status === 'failed' || fc.status === 'stale' ? 'Relancer l’analyse' : 'Analyser les visages');
    btn.addEventListener('click', async () => {
      await busy(btn, async () => {
        try {
          clipState = await api('POST', `/videos/${id}/faces`, {});
        } catch (err) {
          fail(err, clipMsg);
        }
      });
      drawFaces();
    });
    facesBox.replaceChildren(
      h('h3', { class: 'clips-sub' }, 'Cadrage automatique sur le visage'),
      h('p', { class: `status${fc.status === 'failed' ? ' err' : ''}` }, text),
      fc.status === 'ready' && fc.summary?.share != null && (fc.summary.share < 0.5 || fc.summary.median_w < 0.04)
        ? h('p', { class: 'status err' }, fc.summary.share < 0.15
            ? 'Visages trop petits ou rarement visibles dans cette vidéo : le cadrage automatique sera indisponible pour les visiteurs.'
            : 'Visages petits ou souvent absents dans cette vidéo : le cadrage automatique ne sera proposé que pour les clips où le visage est assez grand et visible (la reconnaissance peut aussi échouer).')
        : null,
      fc.status === 'ready' && fc.summary?.rescued ? h('p', { class: 'status' }, `Deuxième passe : ${fc.summary.rescued} image${fc.summary.rescued > 1 ? 's' : ''} où un visage a été retrouvé en grande définition.`) : null,
      fc.status === 'ready' && fc.outdated ? h('p', { class: 'status err' }, `Analyse ancienne (définition ${fc.summary?.max_side ?? 384} px, sans deuxième passe) : relance-la pour mieux repérer les visages, surtout les petits.`) : null,
      identText ? h('p', { class: 'status' }, identText) : null,
      h('div', { class: 'actions' }, btn, identBtn));
    if (analysing) {
      facesTimer = setTimeout(async () => {
        try {
          clipState = await api('GET', `/videos/${id}/clips`);
        } catch (e) {
          if (e instanceof AuthError) return;
        }
        if (pageLeft) return;
        drawFaces();
      }, 3000);
    }
  }
  const mo = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes > 99 * 1024 * 1024 ? 0 : 1)} Mo`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const putChunk = (url, blob, onLoaded, signal) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onLoaded(e.loaded);
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // réponse sans corps JSON
        }
        if (xhr.status < 300) resolve(body);
        else reject(Object.assign(new Error(xhr.status === 401 ? 'Session expirée : reconnecte-toi puis recommence.' : body.error || `Erreur ${xhr.status}`), { status: xhr.status, body }));
      };
      xhr.onerror = () => reject(Object.assign(new Error('Connexion interrompue'), { network: true }));
      xhr.onabort = () => reject(Object.assign(new Error('Dépôt annulé'), { aborted: true }));
      signal.addEventListener('abort', () => xhr.abort());
      xhr.send(blob);
    });

  /** Dépôt par morceaux : une coupure ne fait pas tout recommencer (le serveur indique où reprendre). */
  async function uploadVideoFile(file, onProgress, signal) {
    const total = file.size;
    const { chunk_bytes: step } = await api('POST', `/videos/${id}/file/start`, { size: total });
    let offset = 0;
    let retries = 0;
    while (offset < total) {
      if (signal.aborted) throw Object.assign(new Error('Dépôt annulé'), { aborted: true });
      const end = Math.min(offset + step, total);
      try {
        await putChunk(`/api/admin/videos/${id}/file/chunk?offset=${offset}&total=${total}`, file.slice(offset, end), (loaded) => onProgress(offset + loaded, total), signal);
        offset = end;
        retries = 0;
      } catch (e) {
        if (e.aborted) throw e;
        if (e.status === 409 && typeof e.body?.received === 'number') {
          offset = e.body.received; // le serveur a déjà reçu ce morceau (réponse perdue) : on repart de là
          continue;
        }
        if (e.status && e.status < 500) throw e;
        if (++retries > 6) throw new Error(`Connexion perdue pendant le dépôt (${e.message}). Relance le dépôt.`);
        await sleep(1000 * retries);
      }
      onProgress(offset, total);
    }
    return api('POST', `/videos/${id}/file/finish`, { size: total });
  }

  const clipMsg = h('p', { class: 'status', role: 'status' });
  function renderClips() {
    const st = clipState;
    if (!st) {
      clipsPanel.replaceChildren(h('p', { class: 'status err' }, 'Le studio de clips est indisponible.'));
      return;
    }
    const f = st.file;
    const label = f ? (st.enabled ? 'clips autorisés' : 'fichier prêt') : 'pas de fichier';
    const fileInput = h('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm' });
    const progress = h('progress', { max: 100, value: 0, hidden: true });
    const progressText = h('span', { class: 'status' });
    const sendBtn = h('button', { class: 'btn small', type: 'button' }, f ? 'Remplacer la vidéo' : 'Déposer la vidéo');
    const cancelBtn = h('button', { class: 'btn secondary small', type: 'button', hidden: true }, 'Annuler');
    const guard = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    sendBtn.addEventListener('click', async () => {
      const file = fileInput.files?.[0];
      if (!file) return status(clipMsg, 'Choisis d’abord un fichier vidéo.', 'err');
      if (file.size > st.max_mb * 1024 * 1024) return status(clipMsg, `Fichier trop gros (${st.max_mb} Mo au maximum). Télécharge plutôt la vidéo en 720p.`, 'err');
      const ctrl = new AbortController();
      uploading = ctrl;
      sendBtn.disabled = true;
      fileInput.disabled = true;
      progress.hidden = false;
      cancelBtn.hidden = false;
      cancelBtn.onclick = () => ctrl.abort();
      status(clipMsg, '');
      window.addEventListener('beforeunload', guard);
      try {
        clipState = await uploadVideoFile(
          file,
          (done, total) => {
            progress.value = (done / total) * 100;
            progressText.textContent = `${Math.round((done / total) * 100)} % · ${mo(done)} / ${mo(total)}`;
          },
          ctrl.signal,
        );
        uploading = null;
        window.removeEventListener('beforeunload', guard);
        renderClips();
        status(clipMsg, 'Vidéo déposée et vérifiée.', 'ok');
      } catch (e) {
        uploading = null;
        window.removeEventListener('beforeunload', guard);
        sendBtn.disabled = false;
        fileInput.disabled = false;
        progress.hidden = true;
        cancelBtn.hidden = true;
        progressText.textContent = '';
        fail(e, clipMsg);
      }
    });

    const fileBlock = f
      ? [
          h('p', { class: 'status' }, `${f.width && f.height ? `${f.height}p · ` : ''}${fmtDuration(Math.round(f.duration_s))} · ${mo(f.size)} · déposée le ${new Date(f.uploaded_at).toLocaleDateString('fr-FR')}${f.has_audio ? '' : ' · sans son'}`),
          f.duration_mismatch
            ? h('p', { class: 'status err' }, `Attention : ce fichier dure ${fmtDuration(Math.round(f.duration_s))} alors que la vidéo YouTube dure ${fmtDuration(f.youtube_duration_s)}. Ce n’est sans doute pas la même version : les extraits seraient décalés.`)
            : null,
          f.has_audio ? null : h('p', { class: 'status err' }, 'Ce fichier n’a pas de piste audio.'),
        ]
      : [h('p', { class: 'status' }, 'Télécharge la vidéo (de préférence en 720p) puis dépose-la ici. Elle doit être exactement la même que sur YouTube pour que les extraits tombent au bon endroit.')];

    clipsPreview = f ? h('video', { class: 'clip-preview', controls: true, preload: 'metadata', playsinline: true, src: `/api/admin/videos/${id}/file?v=${encodeURIComponent(f.uploaded_at)}` }) : null;

    const toggle = h('input', { type: 'checkbox', checked: st.enabled, disabled: !f || !st.has_text });
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      status(clipMsg, toggle.checked ? 'Autorisation… (les extraits sont proposés au passage, environ une minute)' : '');
      try {
        const r = await api('PUT', `/videos/${id}/clips`, { enabled: toggle.checked });
        clipState = r;
        renderClips();
        status(clipMsg, r.suggestions_error ? `Clips autorisés, mais les extraits n’ont pas pu être proposés : ${r.suggestions_error}` : '', r.suggestions_error ? 'err' : '');
      } catch (e) {
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
        fail(e, clipMsg);
      }
    });

    const sg = st.suggestions;
    const suggestBtn = h('button', { class: 'btn secondary small', type: 'button', disabled: !st.llm || !st.has_text }, sg ? 'Régénérer les extraits' : 'Proposer des extraits');
    suggestBtn.addEventListener('click', () =>
      busy(suggestBtn, async () => {
        status(clipMsg, 'Recherche des meilleurs extraits… (une minute environ)');
        try {
          clipState = await api('POST', `/videos/${id}/clips/suggest`, {});
          renderClips();
          status(clipMsg, 'Extraits proposés.', 'ok');
        } catch (e) {
          fail(e, clipMsg);
        }
      }),
    );

    const cards = (sg?.clips ?? []).map((c) => {
      const seek = h('button', { class: 'btn secondary small', type: 'button' }, 'Voir');
      seek.addEventListener('click', () => {
        if (clipsPreview) {
          clipsPreview.currentTime = c.start_ms / 1000;
          clipsPreview.play().catch(() => {});
          clipsPreview.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else window.open(`https://www.youtube.com/watch?v=${video.youtube_id}&t=${Math.floor(c.start_ms / 1000)}s`, '_blank', 'noopener');
      });
      return h(
        'article',
        { class: 'clip-card' },
        h('div', { class: 'clip-top' }, h('strong', {}, `${fmtTs(c.start_ms)} → ${fmtTs(c.end_ms)}`), h('span', { class: 'badge' }, `${Math.round(c.duration_s)} s`), h('span', { class: 'badge ok', title: 'Note donnée par l’IA' }, `${c.score}/10`), seek),
        h('p', { class: 'clip-title' }, c.title),
        c.why ? h('p', { class: 'status' }, c.why) : null,
        h('details', {}, h('summary', {}, 'Texte de l’extrait'), h('p', { class: 'clip-text' }, c.text)),
      );
    });

    clipsPanel.replaceChildren(
      h(
        'details',
        { open: Boolean(f) || Boolean(sg) },
        h('summary', {}, `Clips TikTok : ${label}`),
        st.ffmpeg ? null : unavailable('le dépôt de vidéos est impossible sur ce serveur.', 'ffmpeg absent'),
        st.ffmpeg && !st.render_ready ? unavailable('le studio ne pourra pas créer de clips (le serveur ne sait pas incruster les sous-titres ni encoder la vidéo).', 'ffmpeg sans sous-titres / H.264 ; voir les journaux de démarrage') : null,
        ...fileBlock,
        clipsPreview,
        h('div', { class: 'actions' }, fileInput),
        h('div', { class: 'actions' }, sendBtn, cancelBtn, f ? h('button', { class: 'btn secondary small', type: 'button', onclick: (ev) => {
          if (!confirm('Supprimer le fichier vidéo ? Les clips ne seront plus proposés au public pour cette vidéo.')) return;
          busy(ev.currentTarget, async () => {
            try {
              clipState = await api('DELETE', `/videos/${id}/file`);
              renderClips();
            } catch (e) {
              fail(e, clipMsg);
            }
          });
        } }, 'Supprimer le fichier') : null),
        progress,
        progressText,
        h('label', { class: 'switch-row' }, toggle, h('span', {}, 'Autoriser les clips pour le public')),
        h('p', { class: 'status' }, 'Les visiteurs pourront créer des TikToks à partir de cette vidéo. N’autorise que des vidéos dont tu peux diffuser des extraits.'),
        facesBox,
        h('h3', { class: 'clips-sub' }, 'Extraits proposés par l’IA'),
        sg?.outdated ? h('p', { class: 'status err' }, 'La transcription a changé depuis : régénère les extraits.') : null,
        cards.length ? h('div', { class: 'clip-list' }, cards) : st.llm ? h('p', { class: 'status' }, sg ? 'Aucun passage assez fort dans cette interview : l’IA n’en propose pas (note minimale de 7, salutations et remerciements écartés). Les visiteurs peuvent toujours choisir leur passage à la main dans la transcription.' : 'Pas encore d’extraits.') : unavailable('la proposition d’extraits par l’IA n’est pas configurée.', 'OPENROUTER_API_KEY'),
        h('div', { class: 'actions' }, suggestBtn),
        clipMsg,
      ),
    );
    drawFaces();
  }
  renderClips();

  // --- transcription locale (Whisper)
  const hasTranscript = segs.length > 0;
  const whisperPanel = h(
    'section',
    { class: 'panel' },
    h(
      'details',
      { open: !hasTranscript },
      h('summary', {}, hasTranscript ? 'Refaire la transcription (Whisper)' : 'Transcrire avec Whisper (gratuit)'),
      h(
        'p',
        { class: 'status' },
        hasTranscript
          ? 'Cette vidéo a déjà une transcription : elle ne sera pas remplacée sauf si tu ajoutes --overwrite à la commande (attention, ça écrase tes corrections).'
          : 'Whisper tourne sur ton ordinateur (il ne peut pas tourner dans ce navigateur) : il télécharge l’audio, le transcrit, puis envoie le texte ici. Dès que c’est fini, la transcription est enregistrée dans la base : elle est visible par tout le monde (recherche, résumés) sans rien d’autre à faire.',
      ),
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, 'Une seule fois : récupère le dossier ', h('a', { href: SCRIPT_URL, target: '_blank', rel: 'noopener' }, 'tools/ ↗'), ' puis ', h('code', {}, 'pip install -r tools/requirements.txt'), ' (Python 3.10+).'),
        h('li', {}, 'Lance cette commande (le mot de passe de l’admin est demandé) :'),
      ),
      commandBox(whisperCommand(video.youtube_id)),
      h(
        'ol',
        { class: 'steps', start: '3' },
        h('li', {}, 'Une fois terminé, recharge cette page.'),
      ),
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => route() }, 'Recharger la page'),
    ),
  );

  const danger = h(
    'section',
    { class: 'panel' },
    h(
      'button',
      {
        class: 'btn danger small',
        type: 'button',
        onclick: (ev) => {
          if (!confirm('Supprimer cette vidéo et sa transcription ?')) return;
          busy(ev.currentTarget, async () => {
            try {
              await api('DELETE', `/videos/${id}`);
            } catch (e) {
              if (e instanceof AuthError) return renderLogin();
              alert(e.message);
              return;
            }
            dirty = false;
            sumArea.value = summary.content;
            Object.keys(savedInfo).forEach((k) => (savedInfo[k] = f[k].value));
            location.hash = '#/';
          });
        },
      },
      'Supprimer la vidéo',
    ),
  );

  // --- enregistrement
  const saveMsg = h('span', { class: 'status ok', role: 'status' }, 'À jour');
  const saveBtn = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => save() }, 'Enregistrer (Ctrl+S)');
  const putSegments = (list) => api('PUT', `/videos/${id}/segments`, { segments: list });
  async function save() {
    if (!dirty || saving) return;
    saving = true;
    saveBtn.disabled = true;
    status(saveMsg, 'Enregistrement…');
    // Snapshot: edits made during the request stay dirty
    const sentRev = rev;
    const snapshot = segs.map((s) => ({ seg: s, text: s.text, start: s.start_ms }));
    const payload = segs
      .filter((s) => s.text.trim())
      .map(({ start_ms, duration_ms, text, text_original }) => ({ start_ms, duration_ms, text, text_original }));
    try {
      try {
        await putSegments(payload);
      } catch (err) {
        if (!(err instanceof AuthError) || !(await reauth())) throw err;
        await putSegments(payload);
      }
      for (const { seg, text, start } of snapshot) {
        if (seg.text === text && seg.start_ms === start) {
          seg.orig = text;
          seg.origStart = start;
        }
      }
      segs.forEach((s, i) => rowEls[i]?.classList.toggle('dirty', s.text !== s.orig || s.start_ms !== s.origStart));
      saving = false;
      if (rev === sentRev) setDirty(false);
      else setDirty(true);
    } catch (err) {
      saving = false;
      setDirty(true);
      status(saveMsg, err instanceof AuthError ? 'Session expirée : reconnecte-toi pour enregistrer.' : err.message, 'err');
    }
  }

  const savebar = h(
    'div',
    { class: 'savebar' },
    h('span', {}, h('strong', {}, `${video.title || video.youtube_id}`), ' ', video.edited ? h('span', { class: 'badge ok' }, 'corrigée') : null),
    h('label', { class: 'status' }, follow, ' Suivre la lecture'),
    saveMsg,
    saveBtn,
  );

  renderSegs();
  $app.replaceChildren(
    h('p', {}, h('a', { href: '#/' }, '← Toutes les vidéos')),
    info,
    h('div', { class: 'editor' }, h('aside', { class: 'side' }, playerBox, summaryPanel, clipsPanel, whisperPanel, translatePanel, tools, source, danger), list),
    savebar,
  );

  const facesCleanup = cleanup; // set with the faces panel: stops its polling
  cleanup = () => {
    facesCleanup();
    pageLeft = true;
    clearInterval(timer);
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('keydown', onKey);
    player?.destroy?.();
    uploading?.abort(); // only reached once the user confirmed leaving
  };
}

route();
