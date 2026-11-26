// Choix du début et de la fin d'un extrait : lecteur YouTube de l'interview, barre zoomée à deux curseurs, barre de toute la
// vidéo (niveau avancé), boutons « Début ici » / « Fin ici » et aperçu des premiers et derniers mots.
import { el } from './studio-preview.js';

const STEP_MS = 100; // free placement, rounded to a tenth of a second
const MIN_VIEW_MS = 10_000;

let ytReady = null;
/** API IFrame de YouTube, chargée une seule fois. */
function loadYT() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  ytReady ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      ytReady = null;
      reject(new Error('Lecteur YouTube indisponible'));
    };
    document.head.append(s);
  });
  return ytReady;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (ms) => Math.round(ms / STEP_MS) * STEP_MS;
/** 754300 -> « 12:34,3 » ; au-delà d'une heure « 1:02:34,3 ». */
export function fmtTime(ms, tenths = true) {
  const t = Math.max(0, Math.round(ms / 100));
  const s = Math.floor(t / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const base = `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
  return tenths ? `${base},${t % 10}` : base;
}
const spoken = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} seconde${s > 1 ? 's' : ''}` : `${Math.floor(s / 60)} minute${s >= 120 ? 's' : ''}${s % 60 ? ` ${s % 60}` : ''}`;
};

/**
 * Nouvelles bornes [début, fin] après le déplacement de `which` ('start', 'end' ou 'both'), dans la vidéo, entre `minMs` et `maxMs` de long.
 * Fonction pure (testée).
 */
export function constrain(start, end, which, { durationMs, minMs, maxMs }) {
  let a = round(start);
  let b = round(end);
  if (which === 'both') {
    const len = clamp(b - a, minMs, maxMs);
    a = clamp(a, 0, Math.max(0, durationMs - len));
    return [a, Math.min(durationMs, a + len)];
  }
  if (which === 'start') a = clamp(a, Math.max(0, b - maxMs), Math.max(0, b - minMs));
  else b = clamp(b, Math.min(durationMs, a + minMs), Math.min(durationMs, a + maxMs));
  return [a, b];
}

/** Fenêtre de la barre zoomée autour de [a, b] : un peu de marge de chaque côté, au moins une minute visible. */
export function viewAround(a, b, durationMs) {
  const pad = Math.max(15_000, (b - a) * 0.5);
  let lo = a - pad;
  let hi = b + pad;
  if (hi - lo < 60_000) {
    const c = (a + b) / 2;
    lo = c - 30_000;
    hi = c + 30_000;
  }
  if (lo < 0) [lo, hi] = [0, Math.min(durationMs, hi - lo)];
  if (hi > durationMs) [lo, hi] = [Math.max(0, durationMs - (hi - lo)), durationMs];
  return { lo, hi };
}

/**
 * `wordsFor(start_ms, end_ms)` : mots dits dans l'extrait ({ text }) ; `onChange(start_ms, end_ms)` : bornes validées (fin d'un
 * glissement, bouton, clavier). `onPlay()` : le lecteur YouTube démarre (l'aperçu du clip s'arrête).
 */
export function createRangePicker({ youtubeId, durationMs, minMs, maxMs, wordsFor, onChange, onPlay }) {
  let start = 0;
  let end = Math.min(durationMs, 30_000);
  let view = viewAround(start, end, durationMs);
  let full = false;
  let player = null;
  let playerState = 'idle'; // idle | loading | ready | failed
  let listenUntil = null; // « Écouter l'extrait » : arrêt automatique à la fin
  let poll = 0;
  let commitTimer = 0;
  const limits = { durationMs, minMs, maxMs };

  // --- lecteur YouTube (créé au premier affichage)
  const playerHost = el('div', { class: 'rp-yt' });
  const playerBox = el('div', { class: 'rp-player' }, playerHost, el('p', { class: 'rp-player-msg' }, 'Chargement du lecteur…'));
  function ensurePlayer() {
    if (playerState !== 'idle') return;
    playerState = 'loading';
    loadYT()
      .then((YT) => {
        player = new YT.Player(playerHost, {
          host: 'https://www.youtube-nocookie.com', // privacy-enhanced mode: no tracking cookie before playback
          videoId: youtubeId,
          width: '100%',
          height: '100%',
          playerVars: { rel: 0, playsinline: 1, modestbranding: 1, start: Math.floor(start / 1000) },
          events: {
            onReady: () => {
              playerState = 'ready';
              playerBox.classList.add('ready');
              syncButtons();
            },
            onStateChange: (e) => {
              if (e.data === 1) {
                onPlay?.();
                startPolling();
              } else if (e.data !== 3) stopPolling();
              syncButtons();
            },
            onError: () => fail(),
          },
        });
      })
      .catch(fail);
  }
  function fail() {
    playerState = 'failed';
    playerBox.querySelector('.rp-player-msg').textContent = 'La vidéo YouTube ne peut pas être lue ici : règle le début et la fin avec la barre ci-dessous.';
    playerBox.classList.add('failed');
    syncButtons();
  }
  const now = () => (playerState === 'ready' && player?.getCurrentTime ? player.getCurrentTime() * 1000 : null);
  const isPlaying = () => playerState === 'ready' && player?.getPlayerState?.() === 1;
  function seek(ms, play = false) {
    if (playerState !== 'ready') return;
    player.seekTo(ms / 1000, true);
    if (play) player.playVideo();
    drawHead(ms);
  }
  function startPolling() {
    clearInterval(poll);
    poll = setInterval(() => {
      const t = now();
      if (t == null) return;
      drawHead(t);
      if (listenUntil != null && t >= listenUntil) {
        player.pauseVideo();
        listenUntil = null;
      }
    }, 200);
  }
  function stopPolling() {
    clearInterval(poll);
    const t = now();
    if (t != null) drawHead(t);
  }

  // --- barre zoomée : deux curseurs, la zone choisie se déplace d'un bloc
  const sel = el('div', { class: 'rp-sel', title: 'Glisse pour déplacer tout l’extrait' });
  const handle = (which, label) =>
    el('div', { class: `rp-h rp-h-${which}`, role: 'slider', tabindex: '0', 'aria-label': label, 'data-which': which }, el('span', { class: 'rp-grip' }));
  const hStart = handle('start', 'Début de l’extrait');
  const hEnd = handle('end', 'Fin de l’extrait');
  const head = el('div', { class: 'rp-head', hidden: true });
  const track = el('div', { class: 'rp-track' }, sel, head, hStart, hEnd);
  const viewLo = el('span');
  const viewHi = el('span');
  const btn = (label, title, onclick, cls = '') => el('button', { type: 'button', class: `rp-btn ${cls}`.trim(), title, 'aria-label': title, onclick }, label);
  const zoomRow = el('div', { class: 'rp-scale' },
    viewLo,
    el('span', { class: 'rp-zoom' },
      btn('◀', 'Voir plus tôt', () => pan(-0.5)),
      btn('−', 'Élargir la vue', () => zoom(2)),
      btn('+', 'Resserrer la vue', () => zoom(0.5)),
      btn('▶', 'Voir plus tard', () => pan(0.5))),
    viewHi);

  // --- toute la vidéo (niveau avancé) : la fenêtre se déplace, un clic y emmène la vue
  const ovSel = el('div', { class: 'rp-ov-sel' });
  const ovWin = el('div', { class: 'rp-ov-win', title: 'Glisse pour parcourir la vidéo' });
  const ovHead = el('div', { class: 'rp-ov-head', hidden: true });
  const overview = el('div', { class: 'rp-ov', role: 'presentation' }, ovSel, ovWin, ovHead);
  const ovBox = el('div', { class: 'rp-ovbox' }, el('p', { class: 'rp-label' }, 'Toute la vidéo ', el('span', {}, `· ${fmtTime(durationMs, false)}`)), overview);

  // --- bornes, réglages fins et texte
  const startTime = el('strong', { class: 'rp-time' });
  const endTime = el('strong', { class: 'rp-time' });
  const length = el('span', { class: 'rp-len' });
  const hereStart = btn('Début ici', 'Le début de l’extrait passe à la position du lecteur YouTube', () => fromPlayer('start'), 'here');
  const hereEnd = btn('Fin ici', 'La fin de l’extrait passe à la position du lecteur YouTube', () => fromPlayer('end'), 'here');
  const listen = el('button', { type: 'button', class: 'btn small rp-listen', onclick: () => toggleListen() }, '▶ Écouter l’extrait');
  const firstWords = el('p', { class: 'rp-words' });
  const lastWords = el('p', { class: 'rp-words' });
  const bound = (title, time, which, here) =>
    el('div', { class: 'rp-bound' },
      el('span', { class: 'rp-label' }, title),
      time,
      el('span', { class: 'rp-nudge' }, btn('−1 s', `${title} : une seconde plus tôt`, () => nudge(which, -1000)), btn('+1 s', `${title} : une seconde plus tard`, () => nudge(which, 1000))),
      here);

  const root = el('div', { class: 'rp' },
    playerBox,
    ovBox,
    el('div', { class: 'rp-zoombox' }, el('p', { class: 'rp-label' }, 'Ton extrait ', length), track, zoomRow),
    el('div', { class: 'rp-bounds' }, bound('Début', startTime, 'start', hereStart), bound('Fin', endTime, 'end', hereEnd)),
    el('div', { class: 'rp-actions' }, listen),
    el('div', { class: 'rp-text' }, el('span', { class: 'rp-label' }, 'Commence par'), firstWords, el('span', { class: 'rp-label' }, 'Finit par'), lastWords));

  // --- dessin
  const pct = (ms) => `${((ms - view.lo) / (view.hi - view.lo)) * 100}%`;
  const ovPct = (ms) => `${(ms / durationMs) * 100}%`;
  function drawHead(t) {
    const inView = t >= view.lo && t <= view.hi;
    head.hidden = !inView;
    if (inView) head.style.left = pct(t);
    ovHead.hidden = false;
    ovHead.style.left = ovPct(t);
  }
  let textFrame = 0;
  function draw() {
    sel.style.left = pct(Math.max(start, view.lo));
    sel.style.right = `calc(100% - ${pct(Math.min(end, view.hi))})`;
    hStart.style.left = pct(start);
    hEnd.style.left = pct(end);
    hStart.hidden = start < view.lo || start > view.hi;
    hEnd.hidden = end < view.lo || end > view.hi;
    for (const [h, v, lo, hi] of [[hStart, start, Math.max(0, end - maxMs), end - minMs], [hEnd, end, start + minMs, Math.min(durationMs, start + maxMs)]]) {
      h.setAttribute('aria-valuemin', String(Math.round(lo / 1000)));
      h.setAttribute('aria-valuemax', String(Math.round(hi / 1000)));
      h.setAttribute('aria-valuenow', String(Math.round(v / 1000)));
      h.setAttribute('aria-valuetext', fmtTime(v));
    }
    viewLo.textContent = fmtTime(view.lo, false);
    viewHi.textContent = fmtTime(view.hi, false);
    startTime.textContent = fmtTime(start);
    endTime.textContent = fmtTime(end);
    length.textContent = `· ${spoken(end - start)}`;
    length.classList.toggle('max', end - start >= maxMs);
    ovSel.style.left = ovPct(start);
    ovSel.style.width = `max(3px, ${((end - start) / durationMs) * 100}%)`;
    ovWin.style.left = ovPct(view.lo);
    ovWin.style.width = `${((view.hi - view.lo) / durationMs) * 100}%`;
    // The words are recomputed at most once per frame while dragging
    cancelAnimationFrame(textFrame);
    textFrame = requestAnimationFrame(drawText);
  }
  function drawText() {
    const words = wordsFor(start, end).map((w) => w.text);
    const n = 12;
    if (!words.length) {
      firstWords.textContent = 'Aucune parole dans ce passage.';
      lastWords.textContent = '';
      return;
    }
    firstWords.textContent = `« ${words.slice(0, n).join(' ')}${words.length > n ? ' …' : ''} »`;
    lastWords.textContent = words.length > n ? `« … ${words.slice(-n).join(' ')} »` : '';
    lastWords.previousElementSibling.hidden = words.length <= n;
  }
  function syncButtons() {
    const ready = playerState === 'ready';
    hereStart.disabled = !ready;
    hereEnd.disabled = !ready;
    listen.disabled = playerState === 'failed';
    listen.textContent = isPlaying() && listenUntil != null ? '⏸ Arrêter' : '▶ Écouter l’extrait';
  }

  // --- changements
  function apply(a, b, which, commit = 'now') {
    [start, end] = constrain(a, b, which, limits);
    if (start < view.lo || end > view.hi) view = viewAround(start, end, durationMs);
    if (listenUntil != null) listenUntil = end; // « Écouter l'extrait » stops at the new end
    draw();
    clearTimeout(commitTimer);
    if (commit === 'now') onChange(start, end);
    else if (commit === 'soon') commitTimer = setTimeout(() => onChange(start, end), 700);
  }
  function nudge(which, delta) {
    if (which === 'start') apply(start + delta, end, 'start', 'soon');
    else apply(start, end + delta, 'end', 'soon');
    seek(which === 'start' ? start : Math.max(start, end - 3000));
  }
  function fromPlayer(which) {
    const t = now();
    if (t == null) return;
    const len = end - start;
    // A start after the current end keeps the length; an end before the start does too
    // Past the other bound, or too far from it for the 90 s limit: the whole extract moves there, same length
    if (which === 'start') {
      const move = t >= end - minMs || end - t > maxMs;
      apply(t, move ? t + len : end, move ? 'both' : 'start');
    } else {
      const move = t <= start + minMs || t - start > maxMs;
      apply(move ? t - len : start, t, move ? 'both' : 'end');
    }
  }
  function toggleListen() {
    if (playerState === 'idle') ensurePlayer();
    if (playerState !== 'ready') return;
    if (isPlaying() && listenUntil != null) {
      player.pauseVideo();
      listenUntil = null;
    } else {
      listenUntil = end;
      seek(start, true);
    }
    setTimeout(syncButtons, 300);
  }
  function setView(lo, hi) {
    const w = clamp(hi - lo, MIN_VIEW_MS, durationMs);
    lo = clamp(lo, 0, durationMs - w);
    view = { lo, hi: lo + w };
    draw();
  }
  const pan = (f) => setView(view.lo + (view.hi - view.lo) * f, view.hi + (view.hi - view.lo) * f);
  function zoom(f) {
    const c = (start + end) / 2;
    const w = (view.hi - view.lo) * f;
    setView(c - w / 2, c + w / 2);
  }

  // --- glisser : curseurs, zone choisie, fenêtre de la vue d'ensemble
  const msAt = (e, box, lo, hi) => {
    const r = box.getBoundingClientRect();
    return lo + clamp((e.clientX - r.left) / r.width, 0, 1) * (hi - lo);
  };
  function drag(target, onMove, onEnd) {
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      target.setPointerCapture(e.pointerId);
      target.classList.add('dragging');
      const move = onMove(e);
      const up = () => {
        target.classList.remove('dragging');
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        onEnd?.();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    });
  }
  const dragHandle = (h, which) =>
    drag(h, () => (e) => {
      const t = msAt(e, track, view.lo, view.hi);
      apply(which === 'start' ? t : start, which === 'end' ? t : end, which, 'none');
    }, () => {
      onChange(start, end);
      seek(which === 'start' ? start : Math.max(start, end - 3000));
    });
  dragHandle(hStart, 'start');
  dragHandle(hEnd, 'end');
  drag(sel, (e0) => {
    const t0 = msAt(e0, track, view.lo, view.hi);
    const [a0, b0] = [start, end];
    return (e) => {
      const d = msAt(e, track, view.lo, view.hi) - t0;
      apply(a0 + d, b0 + d, 'both', 'none');
    };
  }, () => {
    onChange(start, end);
    seek(start);
  });
  // A click on the bar (outside the handles) moves the player there
  track.addEventListener('pointerdown', (e) => {
    if (e.target !== track && e.target !== head) return;
    ensurePlayer();
    seek(msAt(e, track, view.lo, view.hi));
  });
  drag(ovWin, (e0) => {
    const t0 = msAt(e0, overview, 0, durationMs);
    const { lo, hi } = view;
    return (e) => {
      const d = msAt(e, overview, 0, durationMs) - t0;
      setView(lo + d, hi + d);
    };
  });
  overview.addEventListener('pointerdown', (e) => {
    if (e.target === ovWin) return;
    const t = msAt(e, overview, 0, durationMs);
    const w = view.hi - view.lo;
    setView(t - w / 2, t + w / 2);
    ensurePlayer();
    seek(t);
  });
  // Keyboard on the handles: arrows ±1 s, Maj+flèches ±5 s, Page ±10 s
  for (const h of [hStart, hEnd]) {
    h.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1000, ArrowDown: -1000, ArrowRight: 1000, ArrowUp: 1000, PageDown: -10_000, PageUp: 10_000 }[e.key];
      if (step == null) return;
      e.preventDefault();
      nudge(h.dataset.which, e.shiftKey ? step * 5 : step);
    });
  }

  // YouTube is only contacted once the block is on screen (not at studio start-up, nor on other steps)
  let seen = null;
  function watchVisible() {
    if (seen || playerState !== 'idle') return;
    if (typeof IntersectionObserver === 'undefined') return ensurePlayer();
    seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      ensurePlayer();
    });
    seen.observe(playerBox);
  }

  draw();
  syncButtons();
  return {
    root,
    /** Bornes venues d'ailleurs (extrait proposé, ligne de la transcription) : la vue se recentre si elles en sortent. */
    set(a, b) {
      watchVisible();
      if (a === start && b === end) return;
      [start, end] = constrain(a, b, 'end', limits);
      if (start < view.lo || end > view.hi || end - start < (view.hi - view.lo) / 8) view = viewAround(start, end, durationMs);
      draw();
    },
    /** Niveau avancé : la barre de toute la vidéo est visible. */
    setFull(on) {
      full = on;
      ovBox.hidden = !full;
    },
    /** Les mots ont changé (corrections, pauses de la voix) : le texte affiché est recalculé. */
    refreshText: drawText,
    pause() {
      if (isPlaying()) player.pauseVideo();
    },
    destroy() {
      seen?.disconnect();
      clearInterval(poll);
      clearTimeout(commitTimer);
      player?.destroy?.();
    },
  };
}
