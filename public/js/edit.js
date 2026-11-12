// Section « Edit » : l'adhérent choisit un modèle, les interviews et ses textes ; le serveur cale tout sur le son et crée la vidéo.
import { DESCRIPTION_MAX, descriptionFooter, fitDescription } from './studio-core.js';

const root = document.getElementById('edit');
const JOIN_URL = 'https://soutenir.unenouvelleenergie.fr/?form=adhesion';
const loginHref = () => `/api/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (['checked', 'disabled', 'value', 'muted'].includes(k)) node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c);
  return node;
}
const put = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

class GateError extends Error {}
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/edit${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Connexion impossible : vérifie ton réseau.');
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) throw new GateError(data.error);
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status });
  return data;
}

function showGate() {
  put(root,
    el('section', { class: 'ed-card ed-gate' },
      el('p', { class: 'eyebrow' }, 'Réservé aux adhérents'),
      el('h2', {}, 'Connecte-toi avec ton compte adhérent'),
      el('p', {}, 'Comme le clipping, l’edit est réservé aux adhérents de Nouvelle Énergie : ton adresse e-mail, puis un code à 6 chiffres, sans mot de passe.'),
      el('p', { class: 'ed-actions' }, el('a', { class: 'btn', href: loginHref() }, 'Me connecter'), el('a', { class: 'btn secondary', href: JOIN_URL, rel: 'noopener' }, 'Adhérer'))));
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let data;
  try {
    data = await api('GET', '/');
  } catch (e) {
    if (e instanceof GateError) return showGate();
    return put(root, el('p', { class: 'ed-msg err', role: 'alert' }, e.message));
  }
  if (!data.templates.length) {
    return put(root, el('section', { class: 'ed-card' }, el('h2', {}, 'Bientôt disponible'), el('p', {}, 'Aucun modèle d’edit n’est encore en ligne. En attendant, crée un clip dans le '), el('a', { class: 'btn', href: '/' }, 'Clipping')));
  }

  const S = { template: data.templates[0], videos: [], auto: true, photos: data.photos > 0, texts: [...data.templates[0].texts], job: null, busy: false };

  // --- 1. template
  const tplList = el('ul', { class: 'ed-tpls', role: 'radiogroup', 'aria-label': 'Modèles' });
  const drawTemplates = () =>
    put(tplList, data.templates.map((t) => {
      const on = t === S.template;
      return el('li', {},
        el('button', { type: 'button', class: on ? 'ed-tpl on' : 'ed-tpl', role: 'radio', 'aria-checked': String(on), onclick: () => {
          S.template = t;
          S.texts = [...t.texts];
          drawTemplates();
          drawTexts();
          resetResult();
        } },
          el('video', { src: t.preview_url, muted: true, loop: true, playsinline: '', autoplay: true, preload: 'metadata', 'aria-hidden': 'true' }),
          el('span', { class: 'ed-tpl-name' }, on ? `✓ ${t.name}` : t.name),
          t.track_title ? el('span', { class: 'ed-tpl-song' }, `♪ ${t.track_title}`) : null));
    }));

  // --- 2. interviews and photos
  const videoBox = el('div');
  const drawVideos = () => {
    const mode = (auto, label, hint) =>
      el('label', { class: S.auto === auto ? 'ed-opt on' : 'ed-opt' },
        el('input', { type: 'radio', name: 'mode', checked: S.auto === auto, onchange: () => { S.auto = auto; drawVideos(); resetResult(); } }),
        el('span', {}, el('strong', {}, label), el('small', {}, hint)));
    put(videoBox,
      el('div', { class: 'ed-opts' },
        mode(true, 'Les interviews les plus récentes', 'Le plus simple : on prend les meilleurs moments des dernières interviews.'),
        mode(false, 'Je choisis les interviews', `Jusqu’à ${data.limits.maxVideos}.`)),
      !S.auto
        ? el('ul', { class: 'ed-videos' }, data.videos.map((v) => {
            const on = S.videos.includes(v.youtube_id);
            const full = !on && S.videos.length >= data.limits.maxVideos;
            return el('li', {},
              el('label', { class: on ? 'ed-video on' : 'ed-video' },
                el('input', { type: 'checkbox', checked: on, disabled: full, onchange: () => {
                  S.videos = on ? S.videos.filter((x) => x !== v.youtube_id) : [...S.videos, v.youtube_id];
                  drawVideos();
                  resetResult();
                } }),
                v.thumbnail_url ? el('img', { src: v.thumbnail_url, alt: '', loading: 'lazy' }) : el('span', { class: 'ed-noimg', 'aria-hidden': 'true' }),
                el('span', {}, el('strong', {}, v.title), el('small', {}, fmtDate(v.published_at)))));
          }))
        : null,
      data.photos > 0
        ? el('label', { class: 'ed-check' },
            el('input', { type: 'checkbox', checked: S.photos, onchange: (e) => { S.photos = e.target.checked; resetResult(); } }),
            ` Ajouter des photos de David Lisnard (${data.photos} disponible${data.photos > 1 ? 's' : ''})`)
        : null);
  };

  // --- 3. texts
  const textBox = el('div');
  const drawTexts = () =>
    put(textBox, Array.from({ length: data.limits.maxTexts }, (_, i) =>
      el('label', { class: 'ed-text' },
        el('span', {}, `Texte ${i + 1}${i ? ' (facultatif)' : ''}`),
        el('input', { type: 'text', maxlength: String(data.limits.maxTextLen), value: S.texts[i] ?? '', placeholder: i === 0 ? 'Ex. : Il a osé le dire' : '', oninput: (e) => { S.texts[i] = e.target.value; resetResult(); } }))));

  // --- 4. create
  const pledge = el('input', { type: 'checkbox' });
  const msg = el('p', { class: 'ed-msg', role: 'status' });
  const previewBtn = el('button', { type: 'button', class: 'btn secondary' }, 'Voir l’aperçu');
  const makeBtn = el('button', { type: 'button', class: 'btn' }, 'Créer la vidéo');
  const result = el('div', { class: 'ed-result' });
  const say = (text, err = false) => {
    msg.textContent = text;
    msg.className = err ? 'ed-msg err' : 'ed-msg';
  };
  function resetResult() {
    if (S.busy) return;
    put(result);
    say('');
  }
  const body = () => ({
    template_id: S.template.id,
    youtube_ids: S.auto ? [] : S.videos,
    photos: S.photos,
    texts: S.texts.slice(0, data.limits.maxTexts).map((t) => t ?? ''),
  });
  async function run(kind) {
    if (S.busy) return;
    if (!S.auto && !S.videos.length && !S.photos) return say('Choisis au moins une interview, ou ajoute les photos.', true);
    if (kind === 'render' && !pledge.checked) return say('Coche l’engagement avant de créer la vidéo.', true);
    S.busy = true;
    previewBtn.disabled = makeBtn.disabled = true;
    put(result);
    try {
      say(kind === 'preview' ? 'Préparation de l’aperçu…' : 'Création de ta vidéo…');
      let job = (await api('POST', kind === 'preview' ? '/preview' : '/render', { ...body(), quality: 'hd' })).job;
      while (job.status === 'queued' || job.status === 'running') {
        say(job.status === 'queued' ? `En file d’attente (place ${job.position})…` : `${kind === 'preview' ? 'Aperçu' : 'Création'} en cours… ${Math.round(job.progress * 100)} %`);
        await sleep(1200);
        job = await api('GET', `/jobs/${job.id}`);
      }
      if (job.status !== 'done') throw new Error(job.error || 'La création a échoué. Réessaie.');
      S.job = job;
      showResult(kind, job);
    } catch (e) {
      if (e instanceof GateError) return showGate();
      say(e.message, true);
    } finally {
      S.busy = false;
      previewBtn.disabled = makeBtn.disabled = false;
    }
  }
  function showResult(kind, job) {
    const src = `/api/edit/jobs/${job.id}/file`;
    if (kind === 'preview') {
      say('Voici l’aperçu, en petit. Si ça te plaît, crée la vidéo en haute qualité.');
      return put(result, el('video', { src, controls: true, playsinline: '', autoplay: true }));
    }
    say('Ta vidéo est prête ! Elle est gardée une heure : télécharge-la maintenant.');
    const caption = (S.texts.find((t) => t?.trim()) ?? S.template.name).trim();
    const desc = fitDescription(caption, descriptionFooter({ title: S.template.track_title, credit: S.template.track_credit }));
    const area = el('textarea', { rows: '5', maxlength: String(DESCRIPTION_MAX), 'aria-label': 'Description à copier pour TikTok' });
    area.value = desc;
    const copy = el('button', { type: 'button', class: 'btn secondary small', onclick: async () => {
      try {
        await navigator.clipboard.writeText(area.value);
      } catch {
        area.select();
        document.execCommand?.('copy');
      }
      copy.textContent = 'Copié ✓';
      setTimeout(() => (copy.textContent = 'Copier la description'), 2000);
    } }, 'Copier la description');
    const share = navigator.canShare
      ? el('button', { type: 'button', class: 'btn secondary', onclick: async () => {
          try {
            const blob = await (await fetch(`${src}?use=share`)).blob();
            const file = new File([blob], job.filename, { type: 'video/mp4' });
            if (!navigator.canShare({ files: [file] })) throw new Error('Partage impossible sur cet appareil : télécharge la vidéo.');
            await navigator.clipboard?.writeText(area.value).catch(() => {});
            await navigator.share({ files: [file], title: 'Studio Lisnard' });
          } catch (e) {
            if (e?.name !== 'AbortError') say(e.message, true);
          }
        } }, 'Partager sur TikTok')
      : null;
    put(result,
      el('video', { src, controls: true, playsinline: '' }),
      el('p', { class: 'ed-actions' }, el('a', { class: 'btn', href: `${src}?use=download`, download: job.filename }, 'Télécharger'), share),
      el('h3', {}, 'Description à copier-coller'),
      area,
      copy);
  }
  previewBtn.addEventListener('click', () => run('preview'));
  makeBtn.addEventListener('click', () => run('render'));

  drawTemplates();
  drawVideos();
  drawTexts();
  put(root,
    el('section', { class: 'ed-card' }, el('h2', {}, el('span', { class: 'ed-n' }, '1'), ' Choisis un modèle'), el('p', { class: 'ed-hint' }, 'Chaque modèle a son son et son rythme. Touche celui qui te plaît.'), tplList),
    el('section', { class: 'ed-card' }, el('h2', {}, el('span', { class: 'ed-n' }, '2'), ' Les images'), videoBox),
    el('section', { class: 'ed-card' }, el('h2', {}, el('span', { class: 'ed-n' }, '3'), ' Tes textes'), el('p', { class: 'ed-hint' }, 'Ils apparaissent en grand, en rythme. Courts et percutants.'), textBox),
    el('section', { class: 'ed-card' },
      el('h2', {}, el('span', { class: 'ed-n' }, '4'), ' Crée ta vidéo'),
      el('label', { class: 'ed-check' }, pledge, ' Je m’engage à ce que mes textes ne prêtent pas à David Lisnard des propos qu’il n’a pas tenus.'),
      el('p', { class: 'ed-actions' }, previewBtn, makeBtn),
      msg,
      result));
}

main();
