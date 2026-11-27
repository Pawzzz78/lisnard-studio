// Choix du début et de la fin d'un extrait : lecteur YouTube de l'interview, réglages au dixième de seconde, barre zoomée à deux
// curseurs, barre de toute la vidéo et transcription mot à mot qui suit la lecture.
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
 * Choix du début et de la fin, en un seul écran : le lecteur YouTube (`playerBox`, placé par le studio dans la zone d'aperçu),
 * les réglages compacts (`root`) et la transcription mot à mot qui suit la lecture (`transcript`).
 * `allWords()` : tous les mots de l'interview { text, start, end } en secondes ; `onChange(start_ms, end_ms)` : bornes validées ;
 * `onPlay()` : le lecteur YouTube démarre (l'aperçu du clip s'arrête).
 */
export function createRangePicker({ youtubeId, durationMs, minMs, maxMs, allWords, onChange, onPlay }) {
  let start = 0;
  let end = Math.min(durationMs, 30_000);
  let view = viewAround(start, end, durationMs);
  let player = null;
  let playerState = 'idle'; // idle | loading | ready | failed
  let listenUntil = null; // « Écouter l'extrait » : arrêt automatique à la fin
  let poll = 0;
  let commitTimer = 0;
  const limits = { durationMs, minMs, maxMs };
  const btn = (label, title, onclick, cls = '') => el('button', { type: 'button', class: `rp-btn ${cls}`.trim(), title, 'aria-label': title, onclick }, label);

  // --- lecteur YouTube (créé quand il apparaît à l'écran)
  const playerHost = el('div', { class: 'rp-yt' });
  const playerBox = el('div', { class: 'rp-player' }, playerHost, el('p', { class: 'rp-player-msg' }, 'Chargement de la vidéo…'));
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
    playerBox.querySelector('.rp-player-msg').textContent = 'La vidéo YouTube ne peut pas être lue ici : règle le début et la fin avec la barre et le texte.';
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

  // --- bornes : une ligne compacte, réglage au dixième de seconde (2 à 3 images)
  const startTime = el('strong', { class: 'rp-time' });
  const endTime = el('strong', { class: 'rp-time' });
  const length = el('span', { class: 'rp-len' });
  const hereStart = btn('Ici', 'Le début passe à la position de la vidéo', () => fromPlayer('start'), 'here');
  const hereEnd = btn('Ici', 'La fin passe à la position de la vidéo', () => fromPlayer('end'), 'here');
  const bound = (title, time, which, here) =>
    el('div', { class: 'rp-bound' },
      el('span', { class: 'rp-label' }, title),
      btn('−', `${title} : un dixième de seconde plus tôt`, () => nudge(which, -100)),
      time,
      btn('+', `${title} : un dixième de seconde plus tard`, () => nudge(which, 100)),
      here);
  const listen = el('button', { type: 'button', class: 'btn small rp-listen', onclick: () => toggleListen() }, '▶ Écouter l’extrait');

  // --- barre zoomée : deux curseurs ; la zone choisie se déplace d'un bloc
  const sel = el('div', { class: 'rp-sel', title: 'Glisse pour déplacer tout l’extrait' });
  const handle = (which, label) =>
    el('div', { class: `rp-h rp-h-${which}`, role: 'slider', tabindex: '0', 'aria-label': label, 'data-which': which }, el('span', { class: 'rp-grip' }));
  const hStart = handle('start', 'Début de l’extrait');
  const hEnd = handle('end', 'Fin de l’extrait');
  const head = el('div', { class: 'rp-head', hidden: true });
  const track = el('div', { class: 'rp-track' }, sel, head, hStart, hEnd);
  const viewLo = el('span');
  const viewHi = el('span');
  const zoomRow = el('div', { class: 'rp-scale' }, viewLo, el('span', { class: 'rp-zoom' }, btn('−', 'Voir plus large', () => zoom(2)), btn('+', 'Voir de plus près', () => zoom(0.5))), viewHi);

  // --- toute la vidéo : un clic y emmène la vidéo ; « Placer l'extrait ici » y amène l'extrait
  const ovSel = el('div', { class: 'rp-ov-sel' });
  const ovHead = el('div', { class: 'rp-ov-head', hidden: true });
  const overview = el('div', { class: 'rp-ov', role: 'presentation', title: 'Touche pour aller à ce moment de la vidéo' }, ovSel, ovHead);
  const moveHere = btn('Placer l’extrait ici', 'L’extrait commence à la position de la vidéo, même durée', () => {
    const t = now();
    if (t == null) return;
    apply(t, t + (end - start), 'both');
  }, 'move');
  const ovBox = el('div', { class: 'rp-ovbox' }, el('p', { class: 'rp-label' }, 'Toute la vidéo ', el('span', {}, `· ${fmtTime(durationMs, false)}`), moveHere), overview);

  const root = el('div', { class: 'rp' },
    el('div', { class: 'rp-bounds' }, bound('Début', startTime, 'start', hereStart), bound('Fin', endTime, 'end', hereEnd)),
    el('div', { class: 'rp-zoombox' }, track, zoomRow),
    el('div', { class: 'rp-actions' }, listen, length),
    ovBox);

  // --- transcription mot à mot : suit la lecture ; toucher un mot règle le début, puis la fin
  let wordEls = []; // [{ span, start_ms, end_ms }]
  let lineEls = []; // [{ p, start_ms, end_ms }]
  let next = 'start';
  let follow = true;
  let quietUntil = 0; // the visitor scrolled: following pauses for a few seconds
  const body = el('div', { class: 'rp-tx-body', tabindex: '0', 'aria-label': 'Transcription de l’interview' });
  const nextChip = el('button', { type: 'button', class: 'rp-next', onclick: () => setNext(next === 'start' ? 'end' : 'start') });
  const followBtn = el('button', { type: 'button', class: 'rp-follow', 'aria-pressed': 'true', onclick: () => setFollow(!follow) }, 'Suivre la vidéo');
  const search = el('input', { type: 'search', class: 'rp-search', placeholder: 'Chercher un mot…', 'aria-label': 'Chercher dans la transcription', enterkeyhint: 'search' });
  const transcript = el('section', { class: 'rp-tx' },
    el('div', { class: 'rp-tx-head' }, search, followBtn),
    el('p', { class: 'rp-tx-hint' }, 'Touche un mot : ', nextChip),
    body);
  function setNext(v) {
    next = v;
    nextChip.textContent = next === 'start' ? 'il devient le début' : 'il devient la fin';
    nextChip.classList.toggle('end', next === 'end');
  }
  function setFollow(on) {
    follow = on;
    followBtn.setAttribute('aria-pressed', String(on));
    if (on) quietUntil = 0;
  }
  let wordsKey = '';
  function buildTranscript() {
    const keep = body.scrollTop;
    const words = allWords();
    // Rebuilding drops the scroll position and any pending tap: only when the words really changed
    const key = `${words.length}|${words.map((w) => w.text).join(' ')}|${words.at(-1)?.end ?? 0}`;
    if (key === wordsKey) return;
    wordsKey = key;
    wordEls = [];
    lineEls = [];
    const frag = document.createDocumentFragment();
    let p = null;
    let curLine = -1;
    for (const w of words) {
      if (w.line !== curLine) {
        curLine = w.line;
        const t = Math.round(w.start * 1000);
        p = el('p', { class: 'rp-line' }, el('button', { type: 'button', class: 'rp-t', 'data-t': String(t) }, fmtTime(t, false)));
        lineEls.push({ p, start_ms: t, end_ms: t });
        frag.append(p);
      }
      const span = el('span', { class: 'rp-w', 'data-i': String(wordEls.length) }, w.text);
      p.append(span, ' ');
      const item = { span, start_ms: Math.round(w.start * 1000), end_ms: Math.round(w.end * 1000) };
      wordEls.push(item);
      lineEls.at(-1).end_ms = item.end_ms;
    }
    body.replaceChildren(frag);
    body.scrollTop = keep;
    markSelection();
  }
  function markSelection() {
    for (const w of wordEls) w.span.classList.toggle('in', (w.start_ms + w.end_ms) / 2 >= start && (w.start_ms + w.end_ms) / 2 < end);
  }
  let nowLine = null;
  function followLine(t) {
    let lo = 0;
    let hi = lineEls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineEls[mid].start_ms <= t) lo = mid;
      else hi = mid - 1;
    }
    const line = lineEls[lo]?.p;
    if (!line || line === nowLine) return;
    nowLine?.classList.remove('now');
    line.classList.add('now');
    nowLine = line;
    if (follow && Date.now() > quietUntil) body.scrollTo({ top: line.offsetTop - body.clientHeight / 3, behavior: 'smooth' });
  }
  body.addEventListener('click', (e) => {
    const tBtn = e.target.closest('.rp-t');
    if (tBtn) {
      ensurePlayer();
      seek(Number(tBtn.dataset.t), true);
      return;
    }
    const span = e.target.closest('.rp-w');
    if (!span) return;
    const w = wordEls[Number(span.dataset.i)];
    quietUntil = Date.now() + 8000; // the visitor is reading here: no auto-scroll
    if (next === 'start') {
      // The extract moves to start on this word, same length, until the last word is tapped
      apply(w.start_ms, w.start_ms + (end - start), 'both');
      setNext('end');
      seek(start);
    } else {
      apply(w.end_ms > start + minMs ? start : w.end_ms - (end - start), w.end_ms, w.end_ms > start + minMs ? 'end' : 'both');
      setNext('start');
      seek(Math.max(start, end - 3000));
    }
  });
  for (const ev of ['wheel', 'touchmove']) body.addEventListener(ev, () => (quietUntil = Date.now() + 5000), { passive: true });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    findNext();
  });
  search.addEventListener('search', findNext);
  let lastHit = -1;
  function findNext() {
    const q = search.value.trim().toLowerCase();
    body.querySelector('.hit')?.classList.remove('hit');
    if (!q) return;
    const n = lineEls.length;
    for (let k = 1; k <= n; k++) {
      const i = (lastHit + k) % n;
      if (lineEls[i].p.textContent.toLowerCase().includes(q)) {
        lastHit = i;
        lineEls[i].p.classList.add('hit');
        setFollow(false);
        body.scrollTo({ top: lineEls[i].p.offsetTop - body.clientHeight / 3, behavior: 'smooth' });
        return;
      }
    }
    search.setCustomValidity('Aucun passage ne contient ce mot.');
    search.reportValidity();
    setTimeout(() => search.setCustomValidity(''), 1500);
  }

  // --- dessin
  const pct = (ms) => `${((ms - view.lo) / (view.hi - view.lo)) * 100}%`;
  const ovPct = (ms) => `${(ms / durationMs) * 100}%`;
  function drawHead(t) {
    const inView = t >= view.lo && t <= view.hi;
    head.hidden = !inView;
    if (inView) head.style.left = pct(t);
    ovHead.hidden = false;
    ovHead.style.left = ovPct(t);
    // "Place the extract here" only makes sense when the video is elsewhere
    moveHere.hidden = t >= start - 1000 && t <= end + 1000;
    followLine(t);
  }
  function draw() {
    sel.style.left = pct(Math.max(start, view.lo));
    sel.style.right = `calc(100% - ${pct(Math.min(end, view.hi))})`;
    hStart.style.left = pct(start);
    hEnd.style.left = pct(end);
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
    length.textContent = `${spoken(end - start)}${end - start >= maxMs ? ' (maximum)' : ''}`;
    length.classList.toggle('max', end - start >= maxMs);
    ovSel.style.left = ovPct(start);
    ovSel.style.width = `max(4px, ${((end - start) / durationMs) * 100}%)`;
    markSelection();
  }
  function syncButtons() {
    const ready = playerState === 'ready';
    hereStart.disabled = !ready;
    hereEnd.disabled = !ready;
    listen.disabled = playerState === 'failed';
    listen.textContent = isPlaying() && listenUntil != null ? '⏸ Arrêter' : '▶ Écouter l’extrait';
  }

  // --- changements : la vue suit toujours l'extrait
  function apply(a, b, which, commit = 'now') {
    [start, end] = constrain(a, b, which, limits);
    if (start < view.lo || end > view.hi || end - start < (view.hi - view.lo) / 10) view = viewAround(start, end, durationMs);
    if (listenUntil != null) listenUntil = end; // « Écouter l'extrait » stops at the new end
    draw();
    clearTimeout(commitTimer);
    if (commit === 'now') onChange(start, end);
    else if (commit === 'soon') commitTimer = setTimeout(() => onChange(start, end), 700);
  }
  function nudge(which, delta) {
    if (which === 'start') apply(start + delta, end, 'start', 'soon');
    else apply(start, end + delta, 'end', 'soon');
    seek(which === 'start' ? start : Math.max(start, end - 2000));
  }
  function fromPlayer(which) {
    const t = now();
    if (t == null) return;
    const len = end - start;
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
    ensurePlayer();
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
  function zoom(f) {
    const c = (start + end) / 2;
    const w = clamp((view.hi - view.lo) * f, Math.max(MIN_VIEW_MS, end - start + 2000), durationMs);
    const lo = clamp(c - w / 2, 0, durationMs - w);
    view = { lo, hi: lo + w };
    draw();
  }

  // --- glisser
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
  // While dragging, the view is frozen so the handle stays under the finger
  const dragHandle = (h, which) =>
    drag(h, () => (e) => {
      const t = msAt(e, track, view.lo, view.hi);
      [start, end] = constrain(which === 'start' ? t : start, which === 'end' ? t : end, which, limits);
      draw();
    }, () => {
      onChange(start, end);
      seek(which === 'start' ? start : Math.max(start, end - 2000));
    });
  dragHandle(hStart, 'start');
  dragHandle(hEnd, 'end');
  drag(sel, (e0) => {
    const t0 = msAt(e0, track, view.lo, view.hi);
    const [a0, b0] = [start, end];
    return (e) => {
      const d = msAt(e, track, view.lo, view.hi) - t0;
      [start, end] = constrain(a0 + d, b0 + d, 'both', limits);
      draw();
    };
  }, () => {
    onChange(start, end);
    seek(start);
  });
  track.addEventListener('pointerdown', (e) => {
    if (e.target !== track && e.target !== head) return;
    ensurePlayer();
    seek(msAt(e, track, view.lo, view.hi));
  });
  overview.addEventListener('pointerdown', (e) => {
    ensurePlayer();
    seek(msAt(e, overview, 0, durationMs), true);
  });
  // Keyboard on the handles: arrows ±0,1 s, Maj+flèches ±1 s, Page ±10 s
  for (const h of [hStart, hEnd]) {
    h.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -100, ArrowDown: -100, ArrowRight: 100, ArrowUp: 100, PageDown: -10_000, PageUp: 10_000 }[e.key];
      if (step == null) return;
      e.preventDefault();
      nudge(h.dataset.which, e.shiftKey ? step * 10 : step);
    });
  }

  // YouTube is only contacted once the player is on screen (not at studio start-up, nor on other steps)
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

  setNext('start');
  draw();
  syncButtons();
  let built = false;
  let stale = false; // words changed while the transcript was off screen: rebuilt when it shows again
  return {
    root,
    playerBox,
    transcript,
    /** Bornes venues d'ailleurs (extrait proposé) : la vue se recentre. */
    set(a, b) {
      watchVisible();
      if (!built || stale) {
        built = true;
        stale = false;
        buildTranscript();
      }
      if (a === start && b === end) return;
      [start, end] = constrain(a, b, 'end', limits);
      view = viewAround(start, end, durationMs);
      draw();
    },
    /** Les mots ont changé (corrections, pauses de la voix) : la transcription est reconstruite, à la même position. */
    refreshText() {
      if (!built) return;
      // Subtitle style changes call this too: only rebuild a transcript that is on screen
      if (body.offsetParent) buildTranscript();
      else stale = true;
    },
    /** Lit un passage dans la vidéo (bouton « Écouter » d'un extrait proposé) et s'arrête à sa fin. */
    play(a, b) {
      ensurePlayer();
      if (playerState !== 'ready') return;
      listenUntil = b;
      seek(a, true);
    },
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
