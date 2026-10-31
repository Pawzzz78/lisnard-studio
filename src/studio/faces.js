/**
 * Visages d'une interview, pour le cadrage automatique du mode plein écran.
 *
 * L'admin lance (ou le dépôt de la vidéo lance) une analyse : un thread décode la vidéo en petite définition, détecte les
 * visages cinq fois par seconde et repère les changements de plan ; si des photos de référence existent, il reconnaît aussi la
 * personne (David Lisnard) dans les plans à plusieurs visages. Le résultat est enregistré dans la table `video_faces` ; ensuite
 * chaque clip n'a plus qu'à lire ces données pour calculer la trajectoire du cadre (public/js/framing.js), sans aucun calcul
 * lourd. Une seule tâche tourne à la fois.
 */
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';
import { stampOf, videoFilePath } from '../media.js';
import { FRAMING, framingForClip } from '../../public/js/framing.js';
import { IDENT_ALGO } from './identity.js';
import { referenceSet } from './references.js';

/** Étiquette du jeu de photos et de la méthode utilisés pour une reconnaissance (vide s'il n'y a pas de photo). */
const identTag = (refs) => (refs.count ? `${refs.version}/${IDENT_ALGO}` : '');

// Définition de travail : le grand côté de l'image d'analyse fait maxSide pixels (un visage doit y mesurer ~20 px, soit environ 5 %
// de la largeur de l'image d'origine). Une image toutes les 0,2 s (5 par seconde), une toutes les 0,4 s au-delà d'une heure et demie.
// Qualité 2 : analyse en 640 px (au lieu de 384) et deuxième passe en 1280 px (faces-rescue.js) ; une analyse plus ancienne est « à refaire ».
export const FACES = {
  fps: 5,
  longFps: 2.5,
  longAfterS: 90 * 60,
  maxSide: Number(process.env.STUDIO_FACES_MAX_SIDE) || 640,
  threshold: 0.5,
  quality: 2,
  model: 'yunet-2023mar + sface-2021dec',
};

const MODEL = new URL('./models/face_detection_yunet_2023mar.onnx', import.meta.url);

/** Le cadrage automatique est disponible (STUDIO_FACES=off pour le couper). */
export const facesEnabled = () => process.env.STUDIO_FACES !== 'off' && existsSync(MODEL);


const live = new Map(); // videoId → { status: 'queued' | 'running', progress, phase, kind }
const queue = [];
let running = null;

/** Retire de la file d'attente et arrête la tâche d'une vidéo (fichier supprimé ou remplacé). */
export function cancelAnalysis(videoId) {
  const i = queue.findIndex((j) => j.video.id === videoId);
  if (i >= 0) queue.splice(i, 1);
  live.delete(videoId);
  if (running?.video.id === videoId && running.worker) {
    const { worker } = running;
    worker.postMessage('stop');
    setTimeout(() => worker.terminate(), 3000).unref();
  }
}

async function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  const { video } = job;
  if (!live.get(video.id)) return pump();
  running = { video, worker: null }; // réservé pendant la préparation
  try {
    await launch(job);
  } catch (e) {
    // impossible de démarrer (fichier introuvable…) : la tâche échoue proprement, la suivante démarre
    running = null;
    live.delete(video.id);
    await save(job, { aspect: 16 / 9, fps: FACES.fps, refs: { count: 0 } }, { error: e.message }).catch(() => {});
    pump();
  }
}

async function launch(job) {
  const { video, kind } = job;
  live.get(video.id).status = 'running';
  const refs = await referenceSet();
  const aspect = video.file_width && video.file_height ? video.file_width / video.file_height : 16 / 9;
  const fps = job.content?.fps ?? (video.file_duration_s > FACES.longAfterS ? FACES.longFps : FACES.fps);
  const worker = new Worker(new URL('./faces-worker.js', import.meta.url), {
    workerData: {
      mode: kind,
      file: videoFilePath(video.file_name),
      srcW: video.file_width ?? 1280,
      srcH: video.file_height ?? 720,
      aspect: job.content?.aspect ?? aspect,
      duration: video.file_duration_s,
      fps,
      maxSide: FACES.maxSide,
      threshold: FACES.threshold,
      references: refs.embeddings,
      frames: job.content?.frames,
      cuts: job.content?.cuts,
    },
  });
  running.worker = worker;
  let finished = false;
  const finish = async (result) => {
    if (finished) return;
    finished = true;
    running = null;
    const wasLive = live.delete(video.id);
    try {
      if (wasLive) await save(job, { aspect, fps, refs }, result);
    } catch (e) {
      console.error(`Visages : enregistrement impossible (${e.message})`);
    }
    pump().catch((e) => console.error(`Visages : ${e.message}`));
  };
  worker.on('message', (m) => {
    if (m.progress !== undefined) {
      const s = live.get(video.id);
      if (s) Object.assign(s, { progress: m.progress, phase: m.phase });
    } else finish(m);
  });
  worker.on('error', (e) => finish({ error: e.message }));
  worker.on('exit', (code) => finish({ error: code ? `Analyse interrompue (code ${code}).` : 'Analyse interrompue.' }));
}

async function save(job, { aspect, fps, refs }, result) {
  const { video, kind } = job;
  if (result.error) {
    console.error(`Visages de ${video.youtube_id} : ${result.error}`);
    if (kind === 'identify') return; // la détection reste valable ; l'admin voit « à mettre à jour »
    await pool.query(
      `INSERT INTO video_faces (video_id, status, content, error, file_stamp, analyzed_at, ident, ident_version) VALUES ($1, 'failed', NULL, $2, $3, now(), NULL, NULL)
       ON CONFLICT (video_id) DO UPDATE SET status = 'failed', content = NULL, error = $2, file_stamp = $3, analyzed_at = now(), ident = NULL, ident_version = NULL`,
      [video.id, String(result.error).slice(0, 500), stampOf(video)],
    );
    return;
  }
  const identJson = refs.count ? JSON.stringify(result.ident ?? []) : null;
  const identVersion = refs.count ? identTag(refs) : null;
  if (kind === 'identify') {
    await pool.query('UPDATE video_faces SET ident = $2, ident_version = $3 WHERE video_id = $1 AND status = \'ready\' AND file_stamp = $4', [video.id, identJson, identVersion, stampOf(video)]);
  } else {
    const content = {
      fps, aspect: Math.round(aspect * 1000) / 1000, model: FACES.model, quality: FACES.quality, maxSide: FACES.maxSide,
      cuts: result.cuts, frames: result.frames, stats: { ...detectionStats(result.frames), rescued: result.rescued ?? 0 },
    };
    await pool.query(
      `INSERT INTO video_faces (video_id, status, content, error, file_stamp, analyzed_at, ident, ident_version) VALUES ($1, 'ready', $2, NULL, $3, now(), $4, $5)
       ON CONFLICT (video_id) DO UPDATE SET status = 'ready', content = $2, error = NULL, file_stamp = $3, analyzed_at = now(), ident = $4, ident_version = $5`,
      [video.id, JSON.stringify(content), stampOf(video), identJson, identVersion],
    );
  }
  cache.delete(video.id);
}

/** Qualité de la détection : part du temps où un visage est vu, largeur médiane des visages (fraction de l'image). */
function detectionStats(frames) {
  const widths = frames.flatMap((f) => f.map((d) => d[2])).sort((a, b) => a - b);
  return { share: frames.length ? Math.round((frames.filter((f) => f.length).length / frames.length) * 100) / 100 : 0, median_w: widths.length ? widths[Math.floor(widths.length / 2)] : 0 };
}

function enqueue(video, kind, content = null) {
  if (live.has(video.id)) return false;
  live.set(video.id, { status: 'queued', progress: 0, phase: kind === 'identify' ? 'identify' : 'detect', kind });
  queue.push({ video, kind, content });
  setImmediate(() => pump().catch((e) => console.error(`Visages : ${e.message}`)));
  return true;
}

/** Lance l'analyse des visages d'une vidéo (sans attendre la fin). Renvoie son état. */
export async function startAnalysis(video) {
  if (!facesEnabled()) throw new HttpError(503, 'Le cadrage automatique est désactivé sur ce serveur.');
  if (!video.file_name) throw new HttpError(409, 'Dépose d’abord le fichier vidéo.');
  if (!live.has(video.id)) {
    await pool.query('DELETE FROM video_faces WHERE video_id = $1', [video.id]);
    cache.delete(video.id);
    enqueue(video, 'analyze');
  }
  return facesStatus(video);
}

/** Relance seulement la reconnaissance (photos de référence modifiées), sans refaire la détection. */
export async function startIdentification(video) {
  if (!facesEnabled()) throw new HttpError(503, 'Le cadrage automatique est désactivé sur ce serveur.');
  const { rows } = await pool.query("SELECT content, file_stamp FROM video_faces WHERE video_id = $1 AND status = 'ready'", [video.id]);
  if (!rows.length || rows[0].file_stamp !== stampOf(video)) throw new HttpError(409, 'Analyse les visages de cette vidéo avant de lancer la reconnaissance.');
  enqueue(video, 'identify', rows[0].content);
  return facesStatus(video);
}

/** Reconnaissance à relancer pour toutes les vidéos dont l'analyse date d'un autre jeu de photos. Renvoie le nombre de vidéos mises en file. */
export async function identifyAll() {
  const refs = await referenceSet();
  if (!facesEnabled() || !refs.count) return 0;
  const { rows } = await pool.query(
    `SELECT v.id, v.youtube_id, v.file_name, v.file_size, v.file_uploaded_at, v.file_duration_s, v.file_width, v.file_height, f.content
     FROM video_faces f JOIN videos v ON v.id = f.video_id
     WHERE f.status = 'ready' AND f.ident_version IS DISTINCT FROM $1 ORDER BY v.id`,
    [identTag(refs)],
  );
  let n = 0;
  for (const r of rows) {
    const { content, ...video } = r;
    if (enqueue(video, 'identify', content)) n++;
  }
  return n;
}

/**
 * Refait l'analyse des visages de toutes les vidéos analysées avec une qualité plus ancienne (voir FACES.quality). L'ancienne analyse reste
 * utilisée jusqu'à la fin de la nouvelle. Renvoie le nombre de vidéos mises en file.
 */
export async function reanalyzeOutdated() {
  if (!facesEnabled()) return 0;
  const { rows } = await pool.query(
    `SELECT v.id, v.youtube_id, v.file_name, v.file_size, v.file_uploaded_at, v.file_duration_s, v.file_width, v.file_height, f.file_stamp
     FROM video_faces f JOIN videos v ON v.id = f.video_id
     WHERE f.status = 'ready' AND v.file_name IS NOT NULL AND COALESCE((f.content->>'quality')::int, 1) < $1 ORDER BY v.id`,
    [FACES.quality],
  );
  let n = 0;
  for (const { file_stamp, ...video } of rows) if (file_stamp === stampOf(video) && enqueue(video, 'analyze')) n++; // une vidéo remplacée depuis est « à refaire » autrement
  return n;
}

/** Même chose pour le dépôt d'une vidéo : jamais d'erreur remontée. */
export function autoAnalyze(video) {
  if (facesEnabled() && video.file_name) startAnalysis(video).catch((e) => console.error(`Visages : ${e.message}`));
}

export async function removeFaces(videoId) {
  cancelAnalysis(videoId);
  cache.delete(videoId);
  await pool.query('DELETE FROM video_faces WHERE video_id = $1', [videoId]);
}

/**
 * { status: 'off' | 'none' | 'queued' | 'running' | 'ready' | 'failed' | 'stale', progress, phase, error, analyzed_at, summary,
 *   ident: { state: 'off' | 'none' | 'stale' | 'ready', samples, matches } }
 */
export async function facesStatus(video) {
  if (!facesEnabled()) return { status: 'off', ident: { state: 'off' } };
  const refs = await referenceSet();
  const l = live.get(video.id);
  if (l) return { status: l.status, kind: l.kind, progress: Math.round(l.progress * 100) / 100, phase: l.phase, ident: { state: refs.count ? 'none' : 'off' } };
  const { rows } = await pool.query(
    `SELECT status, error, file_stamp, analyzed_at, ident_version,
            jsonb_array_length(content->'frames') AS frames, jsonb_array_length(content->'cuts') AS cuts, (content->>'fps')::float AS fps, content->'stats' AS stats,
            COALESCE((content->>'quality')::int, 1) AS quality, (content->>'maxSide')::int AS max_side,
            jsonb_array_length(COALESCE(ident, '[]'::jsonb)) AS samples,
            (SELECT count(*) FROM jsonb_array_elements(COALESCE(ident, '[]'::jsonb)) e WHERE (e->>2)::float >= $2)::int AS matches
     FROM video_faces WHERE video_id = $1`,
    [video.id, FRAMING.samePerson],
  );
  if (!rows.length) return { status: 'none', ident: { state: refs.count ? 'none' : 'off' } };
  const r = rows[0];
  if (r.file_stamp !== stampOf(video)) return { status: 'stale', ident: { state: 'off' } }; // la vidéo a été remplacée depuis
  if (r.status === 'failed') return { status: 'failed', error: r.error, analyzed_at: r.analyzed_at, ident: { state: 'off' } };
  const identState = !refs.count ? 'off' : r.ident_version === identTag(refs) ? 'ready' : r.ident_version ? 'stale' : 'none';
  return {
    status: 'ready',
    analyzed_at: r.analyzed_at,
    summary: { seconds: Math.round(r.frames / (r.fps || 1)), cuts: r.cuts, fps: r.fps, share: r.stats?.share ?? null, median_w: r.stats?.median_w ?? null, max_side: r.max_side ?? 384, rescued: r.stats?.rescued ?? 0 },
    outdated: r.quality < FACES.quality, // analysée avec une définition plus faible : à refaire pour mieux repérer les visages
    ident: { state: identState, samples: r.samples, matches: r.matches },
  };
}

const cache = new Map(); // videoId → { stamp, version, data }

/** Données de visages d'une vidéo (null si pas analysée, ou si l'analyse ne correspond plus au fichier). */
export async function loadFaces(video) {
  if (!facesEnabled()) return null;
  const stamp = stampOf(video);
  const refs = await referenceSet();
  const hit = cache.get(video.id);
  if (hit?.stamp === stamp && hit.version === identTag(refs)) return hit.data;
  const { rows } = await pool.query("SELECT content, ident, ident_version, file_stamp FROM video_faces WHERE video_id = $1 AND status = 'ready'", [video.id]);
  if (!rows.length || rows[0].file_stamp !== stamp) return null;
  const r = rows[0];
  // la reconnaissance n'est utilisée que si elle date du jeu de photos actuel
  const ident = r.ident && refs.count && r.ident_version === identTag(refs) ? new Map(r.ident.map(([fi, di, sim]) => [`${fi}:${di}`, sim])) : null;
  const data = { ...r.content, ident };
  cache.set(video.id, { stamp, version: identTag(refs), data });
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return data;
}

/**
 * Cadrage automatique d'une demande de clip (mode plein écran, suivi activé) :
 * { segments, faces, coverage, crowded, recognized, reason, missing } ; les extraits sans visage fiable ont `keys: null` (cadre manuel).
 * null si la vidéo n'a pas été analysée.
 */
export async function framingForRequest(video, req) {
  if (req.layout.fit !== 'crop' || !req.layout.follow?.on) return null;
  const data = await loadFaces(video);
  if (!data) return null;
  return framingForClip({ frames: data.frames, fps: data.fps, aspect: data.aspect, extracts: req.extracts, subject: req.layout.follow.subject, cuts: data.cuts, ident: data.ident });
}
