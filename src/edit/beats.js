/**
 * Temps forts d'un son, pour les montages rythmés (section « Edit ») : tempo, grille des temps, temps forts (un sur quatre) et
 * « drops » (moments où la musique repart plus fort). Calcul local avec ffmpeg, sans service payant.
 *
 * Méthode : le son est décodé en mono 11 kHz ; l'énergie des attaques (signal accentué dans les aigus, variation du logarithme de
 * l'énergie d'une fenêtre à la suivante) donne une courbe « d'attaques ». Le tempo vient de l'autocorrélation de cette courbe
 * (70 à 180 BPM), affinée en cherchant la grille régulière qui tombe le mieux sur les attaques. Les fonctions de calcul sont pures.
 *
 * Résultat gardé en base (`music_beats`), lié à l'empreinte du fichier : un son n'est analysé qu'une fois.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { pool } from '../db.js';

export const BEATS = {
  rate: 11025,
  hop: 128, // ≈ 11,6 ms entre deux mesures
  win: 256,
  minBpm: 70,
  maxBpm: 180,
  maxS: 360, // au-delà, on n'analyse pas : les modèles n'utilisent que quelques dizaines de secondes
  reliableAbove: 2.5, // netteté de la pulsation (grille trouvée / grilles d'autres tempos) au-dessus de laquelle l'analyse est jugée sûre
  timeoutMs: 2 * 60 * 1000,
};

/** Décode le son en mono 11 kHz (Float32Array). */
export function decodeMono(file, { maxS = BEATS.maxS, rate = BEATS.rate, timeoutMs = BEATS.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-t', String(maxS), '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-1000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code !== 0 || buf.length < 4) return reject(new Error(err.trim().split('\n').pop() || `Son illisible (code ${code}).`));
      // Copy into an aligned buffer: a Float32Array view needs a multiple-of-4 offset
      const aligned = new Float32Array(Math.floor(buf.length / 4));
      Buffer.from(aligned.buffer).set(buf.subarray(0, aligned.length * 4));
      resolve(aligned);
    });
  });
}

/** Courbe des attaques : une valeur par pas de `hop` échantillons (≥ 0, centrée sur sa moyenne locale). */
export function onsetEnvelope(samples, { hop = BEATS.hop, win = BEATS.win, rate = BEATS.rate } = {}) {
  const frames = Math.max(0, Math.floor((samples.length - win) / hop) + 1);
  const logE = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const o = f * hop;
    for (let k = 1; k < win; k++) {
      const x = samples[o + k] - 0.95 * samples[o + k - 1]; // accent sur les aigus : les attaques ressortent
      e += x * x;
    }
    logE[f] = Math.log(1e-10 + e / win);
  }
  const env = new Float64Array(frames);
  for (let f = 1; f < frames; f++) env[f] = Math.max(0, logE[f] - logE[f - 1]);
  // Remove the slow trend (≈ 0,4 s): only sudden rises are attacks
  const half = Math.max(1, Math.round((0.2 * rate) / hop));
  const out = new Float64Array(frames);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let f = 0; f < frames; f++) {
    while (hi < Math.min(frames - 1, f + half)) sum += env[++hi];
    while (lo < f - half) sum -= env[lo++];
    out[f] = Math.max(0, env[f] - sum / (hi - lo + 1));
  }
  return out;
}

/** Valeur de la courbe à une position non entière (interpolation linéaire). */
const at = (env, x) => {
  if (x < 0 || x > env.length - 1) return 0;
  const i = Math.floor(x);
  const r = x - i;
  return i + 1 < env.length ? env[i] * (1 - r) + env[i + 1] * r : env[i];
};

/** Score d'une grille régulière (période et décalage en mesures) : moyenne de la courbe sur les temps de la grille. */
function gridScore(env, period, phase) {
  let s = 0;
  let n = 0;
  for (let x = phase; x < env.length; x += period) {
    s += Math.max(at(env, x), at(env, x - 0.5), at(env, x + 0.5));
    n++;
  }
  return n ? s / n : 0;
}

/** Meilleur décalage pour une période donnée. */
function bestPhase(env, period) {
  let best = { phase: 0, score: -1 };
  for (let ph = 0; ph < period; ph += 0.5) {
    const score = gridScore(env, period, ph);
    if (score > best.score) best = { phase: ph, score };
  }
  return best;
}

/**
 * Tempo et grille. Renvoie { bpm, period (s), phase (s), reliability } ; `frameRate` : mesures par seconde de la courbe.
 * L'autocorrélation donne une première période, légèrement favorisée autour de 120 BPM pour éviter de choisir le double ou la moitié ;
 * la période est ensuite affinée (± 3 %) avec la grille qui colle le mieux aux attaques sur toute la durée.
 */
export function estimateTempo(env, frameRate, { minBpm = BEATS.minBpm, maxBpm = BEATS.maxBpm } = {}) {
  const n = env.length;
  if (n < frameRate * 2) return null;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  const lagMin = Math.floor((frameRate * 60) / maxBpm);
  const lagMax = Math.min(n - 1, Math.ceil((frameRate * 60) / minBpm));
  const ac = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean);
    ac.push({ lag, v: s / (n - lag) });
  }
  if (!ac.length) return null;
  const prior = (lag) => {
    const bpm = (60 * frameRate) / lag;
    return Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
  };
  let best = ac[0];
  for (const a of ac) if (a.v * prior(a.lag) > best.v * prior(best.lag)) best = a;
  // Refine the period over the whole track (sub-frame precision)
  let top = { period: best.lag, phase: 0, score: -1 };
  for (let p = best.lag * 0.97; p <= best.lag * 1.03; p += best.lag * 0.002) {
    const { phase, score } = bestPhase(env, p);
    if (score > top.score) top = { period: p, phase, score };
  }
  // Reliability: the beat grid against grids of unrelated tempos (noise or speech fits any tempo about as well)
  const others = [];
  for (let k = 0; k < 24; k++) {
    const p = lagMin * (lagMax / lagMin) ** (k / 23);
    const r = p / top.period;
    if ([0.5, 1, 2, 1.5, 2 / 3].some((h) => Math.abs(r / h - 1) < 0.06)) continue;
    others.push(bestPhase(env, p).score);
  }
  others.sort((a, b) => a - b);
  const baseline = others.length ? others[Math.floor(others.length / 2)] : mean;
  const reliability = top.score / Math.max(1e-9, baseline);
  return { bpm: (60 * frameRate) / top.period, period: top.period / frameRate, phase: top.phase / frameRate, reliability };
}

const round3 = (s) => Math.round(s * 1000) / 1000;

/** Analyse complète d'un son déjà décodé : { bpm, beats, strong, drops, duration, reliable }. Temps en secondes. */
export function analyzeSamples(samples, { rate = BEATS.rate, hop = BEATS.hop } = {}) {
  const duration = samples.length / rate;
  const env = onsetEnvelope(samples, { hop, rate });
  const frameRate = rate / hop;
  const tempo = estimateTempo(env, frameRate);
  // A rise is seen as soon as the window reaches the attack: frame time = start of the window + most of its length
  const lag = (BEATS.win * 0.8) / rate;
  if (!tempo) return { bpm: null, beats: [], strong: [], drops: [], duration: round3(duration), reliable: false };
  const beats = [];
  for (let t = tempo.phase + lag; t < duration - 0.05; t += tempo.period) beats.push(round3(t));
  // Strong beats: of the four possible offsets, the one whose beats carry the most attack energy
  let downPhase = 0;
  let downScore = -1;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    for (let i = ph; i < beats.length; i += 4) s += Math.max(at(env, (beats[i] - lag) * frameRate), at(env, (beats[i] - lag) * frameRate + 1));
    if (s > downScore) {
      downScore = s;
      downPhase = ph;
    }
  }
  const strong = [];
  for (let i = downPhase; i < beats.length; i += 4) strong.push(i);
  // Drops: a bar (strong beat to strong beat) much louder than the two before it
  const rms = (a, b) => {
    const i0 = Math.max(0, Math.floor(a * rate));
    const i1 = Math.min(samples.length, Math.floor(b * rate));
    let s = 0;
    for (let i = i0; i < i1; i++) s += samples[i] * samples[i];
    return i1 > i0 ? Math.sqrt(s / (i1 - i0)) : 0;
  };
  const bars = strong.map((bi, k) => rms(beats[bi], k + 1 < strong.length ? beats[strong[k + 1]] : duration));
  const sorted = [...bars].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const candidates = [];
  for (let k = 2; k < bars.length; k++) {
    const before = (bars[k - 1] + bars[k - 2]) / 2;
    if (bars[k] > 1.8 * before && bars[k] >= median) candidates.push({ beat: strong[k], gain: bars[k] / Math.max(1e-9, before) });
  }
  const drops = [];
  for (const c of candidates.sort((a, b) => b.gain - a.gain)) {
    if (drops.length >= 3) break;
    if (drops.every((d) => Math.abs(d - c.beat) >= 16)) drops.push(c.beat);
  }
  drops.sort((a, b) => a - b);
  return {
    bpm: Math.round(tempo.bpm * 10) / 10,
    beats,
    strong,
    drops,
    duration: round3(duration),
    reliable: tempo.reliability >= BEATS.reliableAbove,
    reliability: Math.round(tempo.reliability * 100) / 100,
  };
}

/** Analyse d'un fichier son. */
export async function analyzeFile(file, opts = {}) {
  return analyzeSamples(await decodeMono(file, opts));
}

// --- cache en base ------------------------------------------------------------------------------

const stampOf = async (file) => {
  const st = await fs.stat(file);
  return `${st.size}-${Math.round(st.mtimeMs)}`;
};

// One analysis at a time: decoding is CPU-bound
let chain = Promise.resolve();
const inflight = new Map();

/**
 * Temps forts d'un morceau de la bibliothèque ({ id, path }, voir findTrack dans studio/music.js) : lus en base s'ils
 * correspondent au fichier actuel, sinon calculés puis gardés.
 */
export async function trackBeats(track, { analyze = analyzeFile } = {}) {
  if (!track?.id || !track?.path) throw new Error('Morceau inconnu.');
  const stamp = await stampOf(track.path);
  const { rows } = await pool.query('SELECT stamp, data FROM music_beats WHERE track_id = $1', [track.id]);
  if (rows[0]?.stamp === stamp) return rows[0].data;
  const key = `${track.id}:${stamp}`;
  let p = inflight.get(key);
  if (!p) {
    p = chain = chain.then(async () => {
      try {
        const data = await analyze(track.path);
        await pool.query(
          `INSERT INTO music_beats (track_id, stamp, data) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (track_id) DO UPDATE SET stamp = EXCLUDED.stamp, data = EXCLUDED.data, created_at = now()`,
          [track.id, stamp, JSON.stringify(data)],
        );
        return data;
      } finally {
        inflight.delete(key);
      }
    });
    chain = chain.catch(() => {});
    inflight.set(key, p);
  }
  return p;
}
