// Aperçu en direct du clip : cadre 9:16 avec la vidéo (cadrage seul, préparé par le serveur), les sous-titres dessinés par le
// navigateur avec exactement les mêmes groupes, horaires, tailles et réductions que le rendu final (studio-core.js), la musique
// synchronisée. Les sous-titres se déplacent au doigt ou à la souris. Aucun innerHTML : tout est posé en nœuds.
import { cropXAtClip, splitAtClip } from './framing.js';
import { OUT, activeAt, boxPad, boxPath, brollOpacity, displayText, fitScale, kenBurnsAt, usableWidth, zoomAt, zoomOrigin } from './studio-core.js';

/** Crée un élément (propriétés, style, événements « on… »). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'muted', 'loop'].includes(k)) node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Contour rond façon libass : couronnes d'ombres décalées (rend pareil dans tous les navigateurs, sans pointes aux angles). */
export function outlineShadow(radius, color, shadow, scaleShadow) {
  const parts = [];
  if (radius > 0.4) {
    for (const r of radius > 3 ? [radius, radius * 0.66, radius * 0.33] : [radius]) {
      const n = Math.max(10, Math.round(r * 5));
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        parts.push(`${(Math.cos(a) * r).toFixed(2)}px ${(Math.sin(a) * r).toFixed(2)}px 0 ${color}`);
      }
    }
  }
  if (shadow > 0) parts.push(`${(shadow * scaleShadow).toFixed(2)}px ${(shadow * scaleShadow).toFixed(2)}px 0 rgba(0,0,0,.65)`);
  return parts.join(',') || 'none';
}

export const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

/**
 * Cadre de téléphone. `onMove({ x, y })` : les sous-titres ont été déplacés (fractions 0–1 du cadre) ; `onCrop(cropX)` : la vidéo
 * plein écran a été glissée pour recentrer le cadrage (0 = bord gauche de la vidéo, 1 = bord droit).
 * Renvoie l'élément racine et les commandes.
 */
export function createPhone({ onMove, onCrop, onPick }) {
  const video = el('video', { class: 'ph-video', playsinline: '', preload: 'auto', loop: true });
  const splitCanvas = el('canvas', { class: 'ph-split', hidden: true }); // écran coupé en deux : la même vidéo dessinée deux fois
  const stage = el('div', { class: 'ph-stage' }, video, splitCanvas); // la vidéo seule zoome : images b-roll et sous-titres restent fixes
  const brollImg = el('img', { class: 'ph-broll', alt: '', hidden: true });
  const pickLayer = el('div', { class: 'ph-pick', hidden: true }, el('span', {}, 'Touche l’écran pour choisir le point de zoom'));
  const pickDot = el('div', { class: 'ph-pickdot', hidden: true });
  const subText = el('div', { class: 'sub-text' });
  const subBox = el('div', { class: 'sub-box', title: 'Glisse pour déplacer les sous-titres' }, subText);
  const guides = el('div', { class: 'ph-guides', hidden: true }, el('span', { class: 'top' }, 'barre TikTok'), el('span', { class: 'bottom' }, 'légende, boutons et description TikTok'));
  const guideV = el('div', { class: 'ph-guide v', hidden: true });
  const guideH = el('div', { class: 'ph-guide h', hidden: true });
  const hint = el('div', { class: 'ph-hint', hidden: true }, '↔ Glisse la vidéo pour la recentrer');
  const busy = el('div', { class: 'ph-busy', hidden: true, role: 'status' });
  const playBtn = el('button', { class: 'ph-play', type: 'button', 'aria-label': 'Lire l’aperçu' }, '▶');
  const logoImg = el('img', { class: 'ph-logo', alt: '', hidden: true });
  const screen = el('div', { class: 'ph-screen' }, stage, brollImg, logoImg, subBox, pickLayer, pickDot, guideV, guideH, guides, hint, busy, playBtn);
  const range = el('input', { class: 'ph-range', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Position dans l’aperçu' });
  const time = el('span', { class: 'ph-time' }, '0:00 / 0:00');
  const guideToggle = el('label', { class: 'ph-toggle' }, el('input', { type: 'checkbox' }), 'Zones masquées par TikTok');
  const bar = el('div', { class: 'ph-bar' }, range, time);
  // téléphone : « Agrandir » donne un aperçu presque plein écran pour vérifier le rendu (le réglage reste dessous)
  const sizeBtn = el('button', { class: 'ph-size', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Agrandir l’aperçu' }, '⤢ Agrandir');
  const root = el('div', { class: 'phone' }, screen, bar, guideToggle, sizeBtn);
  sizeBtn.addEventListener('click', () => {
    const big = root.classList.toggle('big');
    root.parentElement?.classList.toggle('big', big);
    sizeBtn.setAttribute('aria-pressed', String(big));
    sizeBtn.textContent = big ? '⤡ Réduire' : '⤢ Agrandir';
    sizeBtn.setAttribute('aria-label', big ? 'Réduire l’aperçu' : 'Agrandir l’aperçu');
  });
  const music = new Audio();
  music.loop = true;
  music.preload = 'none';
  music.addEventListener('loadedmetadata', () => syncMusic());

  let cfg = { groups: [], style: null, font: null };
  let fx = { plan: [], focus: { x: 0.5, y: 0.42 }, broll: [], picking: false }; // zooms et images b-roll
  let framing = { fit: 'blur', cropX: 0.5, mirror: false };
  let hintTimer = 0;
  let playing = false;
  let lastKey = '';
  let lastGroup = null;
  let raf = 0;

  document.fonts?.addEventListener?.('loadingdone', () => {
    lastKey = '';
    renderSub();
  });

  const scale = () => (screen.clientWidth || 360) / OUT.w;

  function applyStyle() {
    const { style, font } = cfg;
    if (!style) return;
    const s = scale();
    const emRatio = font?.em_ratio ?? 1;
    const css = {
      '--ff': `'ST-${style.font}', 'Montserrat', sans-serif`,
      '--fs': `${style.size * s}px`,
      '--lh': `${(style.size / emRatio) * s}px`,
      '--c': style.color,
      '--hl': style.highlight,
      '--w': `${usableWidth(style) * s}px`,
    };
    subText.style.cssText = Object.entries(css).map(([k, v]) => `${k}:${v}`).join(';');
    subText.style.textShadow = style.box ? 'none' : outlineShadow(style.outline * s, style.outlineColor, style.shadow, s);
    subBox.style.left = `${style.x * 100}%`;
    subBox.style.top = `${style.y * 100}%`;
    lastKey = '';
  }

  /**
   * Fond derrière le texte : mêmes règles que le rendu final (une cellule de la hauteur d'une ligne par ligne de texte, élargie de la
   * marge `boxPad`, aux coins arrondis, d'un seul tenant), calculées d'après les mots tels que le navigateur les a placés. Les
   * mesures sont celles de la mise en page (hors zoom du « pop »), dans le repère du bloc de texte avant réduction `k`.
   */
  function drawBox(inner, k) {
    const { style, font } = cfg;
    const s = scale();
    const lh = (style.size / (font?.em_ratio ?? 1)) * s; // hauteur d'une ligne
    const pad = (boxPad(style) * s) / k; // la marge ne rétrécit pas avec le texte réduit
    const lines = new Map(); // ordonnée de la ligne -> { min, max }
    for (const w of inner.querySelectorAll('.w')) {
      const top = Math.round(w.offsetTop / (lh / 2));
      const l = lines.get(top) ?? { min: Infinity, max: -Infinity };
      l.min = Math.min(l.min, w.offsetLeft);
      l.max = Math.max(l.max, w.offsetLeft + w.offsetWidth);
      lines.set(top, l);
    }
    const rects = [...lines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, l], i) => ({ x0: l.min - pad, x1: l.max + pad, y0: i * lh - pad, y1: (i + 1) * lh + pad }));
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', boxPath(rects, style.boxRadius, 'svg'));
    path.setAttribute('fill', style.boxColor);
    path.setAttribute('fill-opacity', String(style.boxOpacity));
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'sub-fond');
    svg.append(path);
    subText.prepend(svg);
  }

  function renderSub() {
    const { groups, style, font } = cfg;
    if (!style) return;
    const t = video.currentTime || 0;
    let at = activeAt(groups, t);
    let ghost = false;
    if (!at && !playing && groups.length) {
      at = { group: groups.find((g) => g.start >= t) ?? groups.at(-1), active: -1 };
      ghost = true; // à l'arrêt, on montre le groupe le plus proche pour pouvoir régler et déplacer les sous-titres
    }
    if (!at) {
      subBox.style.visibility = 'hidden';
      lastKey = '';
      return;
    }
    const idx = at.group.words.findIndex((w, i) => i === at.active);
    const key = `${groups.indexOf(at.group)}|${at.active}|${ghost}|${style.mode}`;
    subBox.style.visibility = 'visible';
    subBox.classList.toggle('ghost', ghost);
    if (key === lastKey) return;
    lastKey = key;
    const texts = at.group.words.map((w) => displayText(w.text, style));
    const k = fitScale(texts, style, font);
    const frag = document.createDocumentFragment();
    texts.forEach((text, i) => {
      const on = !ghost && (style.mode === 'words' ? i === idx : style.mode === 'karaoke' ? i <= idx : false);
      frag.append(el('span', { class: on ? 'w on' : 'w' }, text), i < texts.length - 1 ? ' ' : '');
    });
    const inner = el('span', { class: 'sub-inner' }, frag);
    subText.style.setProperty('--k', String(k));
    subText.replaceChildren(inner);
    if (style.box) drawBox(inner, k);
    const popped = style.animation === 'pop' && at.group !== lastGroup && !ghost;
    lastGroup = at.group;
    subText.classList.remove('pop');
    if (popped) {
      void subText.offsetWidth; // relance l'animation
      subText.classList.add('pop');
    }
  }

  /**
   * Deux panneaux (la personne suivie en haut, l'autre en bas) : la vidéo est dessinée deux fois dans un canevas, avec les mêmes fenêtres
   * que le rendu (framing.js, splitAtClip). Cachés quand l'écran n'est pas coupé en deux à cet instant.
   */
  function drawSplit() {
    const sp = framing.fit === 'crop' && framing.follow && video.videoWidth ? splitAtClip(framing.follow, video.currentTime || 0) : null;
    if (!sp) {
      if (!splitCanvas.hidden) splitCanvas.hidden = true;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(2, Math.round(screen.clientWidth * dpr));
    const H = Math.max(2, Math.round(screen.clientHeight * dpr));
    if (splitCanvas.width !== W || splitCanvas.height !== H) {
      splitCanvas.width = W;
      splitCanvas.height = H;
    }
    const g = splitCanvas.getContext('2d');
    const [vw, vh] = [video.videoWidth, video.videoHeight];
    for (const [p, y] of [[sp.top, 0], [sp.bottom, H / 2]]) {
      const [sw, sh] = [p.fw * vw, p.fh * vh];
      g.drawImage(video, (vw - sw) * p.x, p.cy * vh - sh / 2, sw, sh, 0, y, W, H / 2);
    }
    splitCanvas.style.transform = framing.mirror ? 'scaleX(-1)' : '';
    splitCanvas.hidden = false;
  }

  /** Cadrage appliqué en direct : position (plein écran) et miroir, sans demander de nouvel aperçu au serveur. */
  function applyFraming() {
    video.style.objectPosition = framing.fit === 'crop' ? `${(framing.follow ? cropXAtClip(framing.follow, video.currentTime || 0, framing.cropX) : framing.cropX) * 100}% 50%` : '50% 50%';
    video.style.transform = framing.mirror ? 'scaleX(-1)' : '';
    video.classList.toggle('panning', framing.fit === 'crop');
    drawSplit();
  }

  /** Zoom de la vidéo et image b-roll à l'instant t : mêmes courbes que le rendu (studio-core.js), calculées à chaque image. */
  function renderFx(t) {
    const z = fx.picking ? 1 : zoomAt(fx.plan, t);
    if (z > 1 + 1e-6) {
      const o = zoomOrigin(z, fx.focus);
      stage.style.transformOrigin = `${o.x * 100}% ${o.y * 100}%`;
      stage.style.transform = `scale(${z})`;
    } else if (stage.style.transform) stage.style.transform = '';
    const item = fx.picking ? null : fx.broll.find((b) => t >= b.start && t < b.start + b.dur);
    if (!item) {
      if (!brollImg.hidden) brollImg.hidden = true;
      return;
    }
    if (brollImg.getAttribute('src') !== item.url) brollImg.src = item.url;
    brollImg.hidden = false;
    brollImg.style.opacity = String(brollOpacity(item, t));
    brollImg.style.transform = `scale(${kenBurnsAt((t - item.start) / item.dur)})`;
  }

  function tick() {
    if (framing.fit === 'crop' && framing.follow) applyFraming(); // le cadre suit le visage : même trajectoire que le rendu
    renderFx(video.currentTime || 0);
    renderSub();
    const d = video.duration || 0;
    if (d) {
      range.value = String(Math.round((video.currentTime / d) * 1000));
      time.textContent = `${fmt(video.currentTime)} / ${fmt(d)}`;
    }
    if (playing) raf = requestAnimationFrame(tick);
  }

  const syncMusic = () => {
    if (!music.src || !music.duration) return;
    music.currentTime = video.currentTime % music.duration;
  };
  const play = () => video.play().catch(() => {});
  const showPlayState = () => {
    playBtn.classList.toggle('playing', playing);
    playBtn.textContent = playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', playing ? 'Mettre l’aperçu en pause' : 'Lire l’aperçu');
  };
  playBtn.addEventListener('click', () => (video.paused ? play() : video.pause()));
  // clic = lecture / pause ; glissement horizontal en plein écran = recentrer la vidéo (comme déplacer une image dans Canva)
  let pan = null;
  video.addEventListener('pointerdown', (e) => {
    pan = { x: e.clientX, cropX: framing.cropX, moved: false, id: e.pointerId };
  });
  video.addEventListener('pointermove', (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    const dx = e.clientX - pan.x;
    if (!pan.moved && Math.abs(dx) < 5) return;
    pan.moved = true;
    if (framing.fit !== 'crop' || framing.follow || !video.videoWidth) return; // cadrage automatique : pas de recadrage au doigt
    video.setPointerCapture(e.pointerId);
    const overflow = (screen.clientHeight * video.videoWidth) / video.videoHeight - screen.clientWidth; // largeur de la vidéo hors de l'écran
    if (overflow < 2) return;
    // vidéo tirée vers la droite à l'écran : la fenêtre de cadrage recule dans la source (et inversement quand l'image est en miroir)
    const next = pan.cropX + (framing.mirror ? 1 : -1) * (dx / overflow);
    const cropX = Math.round(Math.min(1, Math.max(0, next)) * 1000) / 1000;
    framing.cropX = cropX;
    applyFraming();
    onCrop?.(cropX);
  });
  const endPan = (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    const moved = pan.moved;
    pan = null;
    if (!moved && e.type === 'pointerup') video.paused ? play() : video.pause();
  };
  video.addEventListener('pointerup', endPan);
  video.addEventListener('pointercancel', endPan);
  video.addEventListener('play', () => {
    playing = true;
    showPlayState();
    syncMusic();
    if (music.src) music.play().catch(() => {});
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  });
  video.addEventListener('pause', () => {
    playing = false;
    showPlayState();
    music.pause();
    tick();
  });
  video.addEventListener('seeked', () => {
    syncMusic();
    tick();
  });
  video.addEventListener('loadedmetadata', tick);
  video.addEventListener('timeupdate', () => !playing && tick());
  range.addEventListener('input', () => {
    if (video.duration) video.currentTime = (Number(range.value) / 1000) * video.duration;
  });
  guideToggle.firstChild.addEventListener('change', (e) => (guides.hidden = !e.target.checked));
  new ResizeObserver(() => {
    applyStyle();
    renderSub();
  }).observe(screen);

  // choix du point de zoom : un appui sur l'écran (la vidéo est alors montrée sans zoom)
  const placeDot = () => {
    pickDot.hidden = !fx.picking;
    pickDot.style.left = `${fx.focus.x * 100}%`;
    pickDot.style.top = `${fx.focus.y * 100}%`;
  };
  pickLayer.addEventListener('pointerdown', (e) => {
    const r = screen.getBoundingClientRect();
    const x = Math.round(Math.min(0.9, Math.max(0.1, (e.clientX - r.left) / r.width)) * 100) / 100;
    const y = Math.round(Math.min(0.9, Math.max(0.1, (e.clientY - r.top) / r.height)) * 100) / 100;
    fx.focus = { x, y };
    placeDot();
    onPick?.({ x, y });
    e.preventDefault();
  });

  // déplacement des sous-titres : le centre du bloc suit le doigt ou la souris ; il s'aimante au centre de l'écran
  // (repères pointillés, qui s'allument quand le bloc est exactement centré, comme dans Canva)
  const SNAP_X = 0.018;
  const SNAP_Y = 0.014;
  let drag = null;
  let wasSnapped = false;
  const showGuides = (on, sx = false, sy = false) => {
    guideV.hidden = guideH.hidden = !on;
    guideV.classList.toggle('on', sx);
    guideH.classList.toggle('on', sy);
  };
  subBox.addEventListener('pointerdown', (e) => {
    drag = { rect: screen.getBoundingClientRect() };
    subBox.setPointerCapture(e.pointerId);
    subBox.classList.add('dragging');
    showGuides(true);
    e.preventDefault();
    e.stopPropagation();
  });
  subBox.addEventListener('pointermove', (e) => {
    if (!drag) return;
    let x = Math.min(0.9, Math.max(0.1, (e.clientX - drag.rect.left) / drag.rect.width));
    let y = Math.min(0.9, Math.max(0.1, (e.clientY - drag.rect.top) / drag.rect.height));
    const sx = Math.abs(x - 0.5) < SNAP_X;
    const sy = Math.abs(y - 0.5) < SNAP_Y;
    if (sx) x = 0.5;
    if (sy) y = 0.5;
    showGuides(true, sx, sy);
    if ((sx || sy) && !wasSnapped) navigator.vibrate?.(8); // petit « clic » au toucher quand on atteint le centre
    wasSnapped = sx || sy;
    onMove({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
  });
  const stop = () => {
    drag = null;
    wasSnapped = false;
    subBox.classList.remove('dragging');
    showGuides(false);
  };
  subBox.addEventListener('pointerup', stop);
  subBox.addEventListener('pointercancel', stop);

  return {
    root,
    video,
    // Same geometry as the render: share of the width, 5 % side margins, 7 % from the top, 20 % from the bottom
    setLogo({ url = '', pos = 'tr', size = 0.18, opacity = 1 } = {}) {
      logoImg.hidden = !url;
      if (!url) return;
      if (logoImg.getAttribute('src') !== url) logoImg.src = url;
      const x = { l: 'left:5%', c: 'left:50%', r: 'right:5%' }[pos[1]];
      const y = { t: 'top:7%', m: 'top:50%', b: 'bottom:20%' }[pos[0]];
      const shift = `translate(${pos[1] === 'c' ? '-50%' : '0'},${pos[0] === 'm' ? '-50%' : '0'})`;
      logoImg.style.cssText = `${x};${y};width:${size * 100}%;opacity:${opacity};transform:${shift}`;
    },
    /** Nouvelle vidéo d'aperçu. On garde la position de lecture (cadrage modifié), sauf `reset` (autre extrait : on repart de zéro). */
    setSource(url, { reset = false } = {}) {
      const keep = reset ? 0 : video.currentTime || 0;
      const wasPlaying = !video.paused;
      if (video.getAttribute('src') === url) return;
      if (reset) this.rewind();
      video.src = url;
      video.addEventListener('loadedmetadata', function once() {
        video.removeEventListener('loadedmetadata', once);
        if (keep && keep < video.duration) video.currentTime = keep;
        if (wasPlaying) play();
      });
      video.load();
    },
    /** Cadrage : mode (« blur » ou « crop »), position du cadrage plein écran (0–1), miroir et, si le cadre suit le visage, ses segments (framing.js). */
    setFraming(next) {
      const wasCrop = framing.fit === 'crop';
      framing = { ...framing, ...next };
      applyFraming();
      hint.textContent = framing.follow ? '◎ Le cadre suit le visage' : '↔ Glisse la vidéo pour la recentrer';
      if (framing.fit === 'crop' && !wasCrop) {
        hint.hidden = false;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => (hint.hidden = true), 4500);
      }
      if (framing.fit !== 'crop') hint.hidden = true;
    },
    /** Retour au début : l'aperçu en cours est celui d'un autre extrait. Le curseur et le temps repartent de zéro tout de suite. */
    rewind() {
      if (video.getAttribute('src')) video.currentTime = 0;
      range.value = '0';
      time.textContent = '0:00 / 0:00';
      if (music.src) music.currentTime = 0;
    },
    /** Message sur l'aperçu ; `loading` : grand rond qui tourne et « Quelques secondes… » (préparation en cours, bien visible). */
    setBusy(message, { retry = null, loading = false } = {}) {
      busy.hidden = !message;
      busy.classList.toggle('loading', Boolean(message) && loading && !retry);
      const kids = [];
      if (message && loading && !retry) kids.push(el('span', { class: 'ph-spinner', 'aria-hidden': 'true' }));
      kids.push(el('span', { class: 'ph-busy-text' }, message ?? ''));
      if (message && loading && !retry) kids.push(el('small', {}, 'Quelques secondes…'));
      if (message && retry) kids.push(el('button', { class: 'btn small', type: 'button', onclick: retry }, 'Réessayer'));
      busy.replaceChildren(...kids);
    },
    hasSource: () => Boolean(video.getAttribute('src')),
    /** Sous-titres : groupes horodatés, style complet, police (métriques). */
    configure(next) {
      cfg = { ...cfg, ...next };
      applyStyle();
      renderSub();
    },
    setAudio({ url, volume, voice }) {
      if (url && music.getAttribute('src') !== url) {
        music.src = url;
        music.load();
      }
      if (!url) {
        music.pause();
        music.removeAttribute('src');
      }
      music.volume = Math.min(1, Math.max(0, volume ?? 0.25));
      video.volume = Math.min(1, Math.max(0, voice ?? 1));
      if (url && !video.paused) music.play().catch(() => {});
    },
    /**
     * Zooms et images b-roll : { plan (zoomPlan), focus, broll: [{ start, dur, url }], picking }. `picking` : on choisit le point de
     * zoom, la vidéo est montrée sans zoom ni image.
     */
    setEffects(next) {
      fx = { ...fx, ...next };
      pickLayer.hidden = !fx.picking;
      if (fx.picking) video.pause();
      placeDot();
      renderFx(video.currentTime || 0);
    },
    /** Place l'aperçu à l'instant t (secondes du clip) ; avec `play`, lit à partir de là. */
    seek(t, play = false) {
      const go = () => {
        video.currentTime = Math.max(0, Math.min(t, video.duration || t));
        if (play) video.play().catch(() => {});
        else tick();
      };
      if (video.readyState >= 1) go();
      else video.addEventListener('loadedmetadata', go, { once: true });
    },
    pause: () => video.pause(),
    refresh: () => {
      lastKey = '';
      renderSub();
    },
  };
}
