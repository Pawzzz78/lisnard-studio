// Pauses in an interview's audio (ffmpeg silencedetect), found once per video file and kept in the database: subtitles skip them
import { spawn } from 'node:child_process';
import { pool } from '../db.js';

export const VOICE = { noiseDb: -32, minSilenceS: 0.18, timeoutMs: 15 * 60 * 1000 };

/** Silences [[début_ms, fin_ms]] lus dans la sortie de silencedetect. */
export function parseSilences(text) {
  const out = [];
  let start = null;
  for (const line of String(text).split('\n')) {
    const a = /silence_start: (-?[\d.]+)/.exec(line);
    if (a) start = Math.max(0, Number(a[1]));
    const b = /silence_end: ([\d.]+)/.exec(line);
    if (b && start !== null) {
      out.push([Math.round(start * 1000), Math.round(Number(b[1]) * 1000)]);
      start = null;
    }
  }
  // A file ending in silence prints no silence_end: the pause runs to the end
  if (start !== null) out.push([Math.round(start * 1000), 2 ** 31 - 1]);
  return out;
}

function detect(file) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-vn', '-i', file, '-af', `silencedetect=noise=${VOICE.noiseDb}dB:d=${VOICE.minSilenceS}`, '-f', 'null', '-'];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), VOICE.timeoutMs);
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(parseSilences(err));
      else reject(new Error(err.trim().split('\n').pop() || `ffmpeg a échoué (code ${code})`));
    });
  });
}

// One detection at a time: it decodes the whole audio track
let chain = Promise.resolve();
const inflight = new Map();
// A detection that failed is not retried for this file before an hour has passed
const failed = new Map();

/**
 * Silences d'une interview { id, stamp, file, hasAudio } : lus en base s'ils correspondent au fichier actuel, sinon détectés.
 * `wait: false` lance la détection sans l'attendre et renvoie null.
 */
export async function videoSilences(video, { wait = true } = {}) {
  if (!video?.hasAudio) return null;
  const { rows } = await pool.query('SELECT file_stamp, silences FROM video_voice WHERE video_id = $1', [video.id]);
  if (rows[0]?.file_stamp === video.stamp) return rows[0].silences;
  const key = `${video.id}:${video.stamp}`;
  if (Date.now() - (failed.get(key) ?? 0) < 3600_000) return null;
  let p = inflight.get(key);
  if (!p) {
    p = (chain = chain.then(async () => {
      try {
        const silences = await detect(video.file);
        await pool.query(
          `INSERT INTO video_voice (video_id, file_stamp, silences) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (video_id) DO UPDATE SET file_stamp = EXCLUDED.file_stamp, silences = EXCLUDED.silences, created_at = now()`,
          [video.id, video.stamp, JSON.stringify(silences)],
        );
        return silences;
      } catch (e) {
        console.error(`Pauses de la vidéo ${video.id} : ${e.message}`);
        failed.set(key, Date.now());
        return null;
      } finally {
        inflight.delete(key);
      }
    }));
    inflight.set(key, p);
  }
  return wait ? p : null;
}
