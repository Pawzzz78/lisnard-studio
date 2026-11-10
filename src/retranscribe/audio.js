// Audio d'une interview pour la retranscription : découpé en morceaux de quelques minutes, coupés dans des silences.
import { spawn } from 'node:child_process';

export const AUDIO = {
  maxChunkS: 8 * 60, // ~2 MB of 32 kb/s mp3: well under the 25 MB request cap, and quick enough for the provider timeout
  searchS: 45, // look this far back from a chunk's limit for a pause to cut in
  minPauseMs: 300,
  timeoutMs: 5 * 60 * 1000,
};

/**
 * Bornes [début_s, fin_s] des morceaux : au plus `maxChunkS` chacun, coupés au milieu de la plus longue pause trouvée
 * dans les `searchS` secondes avant la limite (sinon à la limite). `silences` : [[début_ms, fin_ms]].
 */
export function planChunks(durationS, silences = [], { maxChunkS = AUDIO.maxChunkS, searchS = AUDIO.searchS, minPauseMs = AUDIO.minPauseMs } = {}) {
  const total = Number(durationS);
  if (!(total > 0)) return [];
  const chunks = [];
  let start = 0;
  while (total - start > maxChunkS) {
    const limit = start + maxChunkS;
    let cut = limit;
    let best = 0;
    for (const [a, b] of silences) {
      const len = Math.min(b, limit * 1000) - Math.max(a, (limit - searchS) * 1000);
      if (len >= minPauseMs && len > best && b - a >= minPauseMs) {
        best = len;
        cut = (Math.max(a, (limit - searchS) * 1000) + Math.min(b, limit * 1000)) / 2000;
      }
    }
    if (cut <= start + 1) cut = limit;
    chunks.push([round(start), round(cut)]);
    start = cut;
  }
  chunks.push([round(start), round(total)]);
  return chunks;
}

const round = (s) => Math.round(s * 1000) / 1000;

/** Morceau [start_s, end_s] du fichier en mp3 mono 16 kHz 32 kb/s, en mémoire. */
export function audioChunk(file, startS, endS, { spawnImpl = spawn, timeoutMs = AUDIO.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-ss', String(startS), '-t', String(Math.max(0.1, endS - startS)), '-i', file,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', '-f', 'mp3', 'pipe:1'];
    const p = spawnImpl('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length) resolve(buf);
      else reject(new Error(`Extraction audio impossible : ${err.trim().split('\n').pop() || `ffmpeg a échoué (code ${code})`}`));
    });
  });
}
