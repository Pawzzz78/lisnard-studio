// Thread de travail des visages (lancé par faces.js), trois tâches :
//  - « analyze » : ffmpeg décode la vidéo en petite définition (détection YuNet à chaque image d'analyse, changements de plan sur le
//    même flux), puis, si des photos de référence existent, reconnaissance de la personne dans les plans à plusieurs visages ;
//  - « identify » : seulement la reconnaissance, à partir de visages déjà détectés ;
//  - « reference » : empreinte d'une photo de référence.
// Le thread garde le serveur libre pendant ces calculs longs.
import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';
import { RESCUE, planRescue, runs } from './faces-rescue.js';
import { IdentityError, identifyVideo, referenceFromImage } from './identity.js';
import { loadSface } from './sface.js';
import { loadYunet } from './yunet.js';

const post = (m) => parentPort.postMessage(m);
const r3 = (v) => Math.round(v * 1000) / 1000;
const { mode } = workerData;
let stopped = false;
parentPort.on('message', (m) => {
  if (m === 'stop') stopped = true;
});

/** Définition de travail : le grand côté vaut `side` ; le réseau demande des dimensions multiples de 32 (on complète avec du noir). */
function dims(side) {
  const { aspect } = workerData;
  const w = aspect >= 1 ? side : Math.max(2, Math.round((side * aspect) / 2) * 2);
  const h = aspect >= 1 ? Math.max(2, Math.round(side / aspect / 2) * 2) : side;
  const pw = Math.ceil(w / 32) * 32;
  const ph = Math.ceil(h / 32) * 32;
  return { w, h, pw, ph, frameBytes: pw * ph * 3 };
}

/** Visages détectés → [x, y, largeur, hauteur, score] en fractions de l'image (indépendantes de la définition d'analyse). */
const normalized = (found, w, h) =>
  found
    .map((f) => [r3(Math.max(0, f.x) / w), r3(Math.max(0, f.y) / h), r3(Math.min(f.w, w - Math.max(0, f.x)) / w), r3(Math.min(f.h, h - Math.max(0, f.y)) / h), r3(f.score)])
    .filter((f) => f[2] > 0.01 && f[3] > 0.01);

async function detectVideo() {
  const { file, duration, fps, maxSide, threshold } = workerData;
  const { w, h, pw, ph, frameBytes } = dims(maxSide);
  const net = loadYunet();
  const ff = spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'info', '-nostats', '-i', file, '-an', '-sn',
      '-filter_complex',
      `[0:v]split=2[a][b];[a]fps=${fps},scale=${w}:${h}:flags=area,setsar=1,pad=${pw}:${ph}:0:0:black[o];[b]scale=160:-2:flags=fast_bilinear,select='gt(scene,0.3)',showinfo[n]`,
      '-map', '[o]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
      '-map', '[n]', '-f', 'null', '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const cuts = [];
  let errText = '';
  let partial = '';
  ff.stderr.on('data', (d) => {
    const t = d.toString();
    errText = (errText + t).slice(-2000);
    // Parse whole lines only: a value split across two chunks would be misread
    const lines = (partial + t).split('\n');
    partial = lines.pop().slice(-4000);
    for (const line of lines) for (const m of line.matchAll(/pts_time:([0-9.]+)/g)) cuts.push(Math.round(Number(m[1]) * 100) / 100);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ff.kill('SIGKILL');
  }, Math.max(30 * 60_000, (duration || 0) * 3000));
  const frames = [];
  let pending = Buffer.alloc(0);
  const total = Math.max(1, Math.ceil(duration * fps));
  let lastReport = 0;
  try {
    for await (const chunk of ff.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        const found = net.detect(new Uint8Array(pending.buffer, pending.byteOffset, frameBytes), pw, ph, { threshold });
        frames.push(normalized(found, w, h));
        pending = pending.subarray(frameBytes);
        if (frames.length - lastReport >= 25) {
          lastReport = frames.length;
          post({ progress: Math.min(0.99, frames.length / total), phase: 'detect' });
        }
      }
      if (stopped) throw new Error('Analyse interrompue.');
    }
    const code = await new Promise((resolve) => (ff.exitCode !== null ? resolve(ff.exitCode) : ff.on('close', resolve)));
    if (timedOut) throw new Error('Analyse trop longue : délai dépassé.'); // a truncated analysis must not pass as complete
    if (code !== 0 && !frames.length) throw new Error(`ffmpeg a échoué : ${errText.split('\n').filter(Boolean).pop() ?? code}`);
    return { frames, cuts: [...new Set(cuts)].sort((a, b) => a - b) };
  } catch (e) {
    ff.kill('SIGKILL');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Détecte les visages des images `indices` (rangs dans la liste des images d'analyse) en grande définition (RESCUE.side).
 * Les images consécutives sont décodées d'un seul appel de ffmpeg. Renvoie une Map rang → détections.
 */
async function detectIndices(indices, onRun = () => {}, deadline = Infinity) {
  const { file, fps, threshold } = workerData;
  const { w, h, pw, ph, frameBytes } = dims(RESCUE.side);
  const net = loadYunet();
  const found = new Map();
  for (const { i0, n } of runs(indices, RESCUE.batch)) {
    if (stopped) throw new Error('Analyse interrompue.');
    if (Date.now() > deadline) break; // deuxième passe trop longue : on garde ce qui a été trouvé
    const ff = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(i0 / fps), '-i', file, '-an', '-sn', '-vf', `fps=${fps},scale=${w}:${h}:flags=area,setsar=1,pad=${pw}:${ph}:0:0:black`, '-frames:v', String(n), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const timer = setTimeout(() => ff.kill('SIGKILL'), 120_000);
    let pending = Buffer.alloc(0);
    let k = 0;
    try {
      for await (const chunk of ff.stdout) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= frameBytes && k < n) {
          found.set(i0 + k, normalized(net.detect(new Uint8Array(pending.buffer, pending.byteOffset, frameBytes), pw, ph, { threshold }), w, h));
          pending = pending.subarray(frameBytes);
          k++;
        }
      }
    } finally {
      clearTimeout(timer);
      ff.kill('SIGKILL');
    }
    onRun(n);
  }
  return found;
}

/**
 * Deuxième chance (voir faces-rescue.js) : reprend en grande définition les images sans visage dans les plans où un visage a été vu,
 * et sonde les plans longs sans visage. Complète `frames` sur place ; renvoie le nombre d'images où un visage a été retrouvé.
 */
async function rescue(frames, cuts) {
  if (process.env.STUDIO_FACES_RESCUE === 'off') return 0;
  const { fps } = workerData;
  const deadline = Date.now() + RESCUE.maxMs;
  const plan = planRescue(frames, fps, cuts);
  let left = plan.limit;
  let rescued = 0;
  let done = 0;
  const planned = Math.max(1, Math.min(plan.limit, plan.lost.length + plan.probes.reduce((n, p) => n + p.idx.length, 0)));
  const report = (n) => {
    done += n;
    post({ progress: Math.min(0.99, done / planned), phase: 'rescue' });
  };
  const apply = (found) => {
    for (const [i, dets] of found) {
      if (dets.length && !frames[i].length) {
        frames[i] = dets;
        rescued++;
      }
    }
  };
  const lost = plan.lost.slice(0, left);
  apply(await detectIndices(lost, report, deadline));
  left -= lost.length;
  const probeIdx = plan.probes.flatMap((p) => p.idx).slice(0, Math.max(0, left));
  const probed = await detectIndices(probeIdx, report, deadline);
  left -= probeIdx.length;
  apply(probed);
  for (const p of plan.probes) {
    if (left <= 0) break;
    if (!p.idx.some((i) => probed.get(i)?.length)) continue; // aucune sonde n'a trouvé de visage : plan sans visage
    const rest = [];
    for (let i = p.shot.i0; i <= p.shot.i1 && rest.length < left; i++) if (!frames[i].length) rest.push(i);
    apply(await detectIndices(rest, report, deadline));
    left -= rest.length;
  }
  return rescued;
}

async function identify({ frames, cuts }) {
  const { file, srcW, srcH, fps, aspect, duration, references } = workerData;
  if (!references?.length) return [];
  return identifyVideo({
    file, srcW, srcH, frames, cuts, fps, aspect, duration, references,
    yunet: loadYunet(), sface: loadSface(),
    onProgress: (p) => post({ progress: Math.min(0.99, p), phase: 'identify' }),
    cancelled: () => stopped,
  });
}

try {
  if (mode === 'reference') {
    const r = await referenceFromImage(workerData.file, { yunet: loadYunet(), sface: loadSface() });
    post({ done: true, reference: { embedding: r.embedding, thumb: r.thumb, score: r.score, facePx: r.facePx } });
  } else if (mode === 'identify') {
    post({ done: true, ident: await identify({ frames: workerData.frames, cuts: workerData.cuts }) });
  } else {
    const { frames, cuts } = await detectVideo();
    const rescued = await rescue(frames, cuts);
    post({ progress: 0.995, phase: 'identify' });
    post({ done: true, frames, cuts, rescued, ident: await identify({ frames, cuts }) });
  }
} catch (e) {
  post({ error: e.message, user: e instanceof IdentityError });
}
parentPort.close(); // sans cela l'écoute des messages « stop » garderait le thread en vie
