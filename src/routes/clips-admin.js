/**
 * Studio de clips, côté admin : dépôt du fichier vidéo d'une vidéo (par morceaux), interrupteur « clips autorisés »
 * et propositions d'extraits par le LLM. Monté sur /api/admin/videos/:id (donc protégé par la session admin).
 */
import express, { Router } from 'express';
import { generateClipSuggestions, getClipSuggestions, withPlayQuotes } from '../clip-suggestions.js';
import { pool } from '../db.js';
import { HttpError, ah } from '../http-error.js';
import {
  CHUNK_BYTES,
  DURATION_TOLERANCE_S,
  MAX_CHUNK_BYTES,
  appendChunk,
  ffmpegAvailable,
  finishUpload,
  maxVideoBytes,
  removeVideoFiles,
  startUpload,
  videoFilePath,
} from '../media.js';
import { LlmError, llmConfigured } from '../openrouter.js';
import { autoAnalyze, facesStatus, removeFaces, startAnalysis, startIdentification } from '../studio/faces.js';
import { studioCapabilities } from '../studio/render.js';

export const clipsAdminRouter = Router({ mergeParams: true });


async function loadVideo(req) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Vidéo introuvable.');
  const { rows } = await pool.query(
    `SELECT id, youtube_id, duration_s, norm_text <> '' AS has_text, clips_enabled,
            file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at
     FROM videos WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'Vidéo introuvable.');
  return rows[0];
}

const fileInfo = (v) =>
  v.file_name
    ? {
        name: v.file_name,
        size: Number(v.file_size),
        duration_s: v.file_duration_s,
        width: v.file_width,
        height: v.file_height,
        has_audio: v.file_has_audio,
        uploaded_at: v.file_uploaded_at,
        youtube_duration_s: v.duration_s ?? null,
        // le fichier n'est pas la même version que la vidéo YouTube : les horaires de la transcription seraient décalés
        duration_mismatch: v.duration_s != null && Math.abs(v.file_duration_s - v.duration_s) > DURATION_TOLERANCE_S,
      }
    : null;

async function state(v) {
  return {
    file: fileInfo(v),
    enabled: v.clips_enabled,
    has_text: v.has_text,
    suggestions: await withPlayQuotes(v.id, await getClipSuggestions(v.id)),
    ffmpeg: await ffmpegAvailable(),
    render_ready: (await ffmpegAvailable()) ? (await studioCapabilities()).ready : false, // sous-titres + H.264 + AAC disponibles pour créer les clips
    llm: llmConfigured(),
    max_mb: Math.round(maxVideoBytes() / 1024 / 1024),
    chunk_bytes: CHUNK_BYTES,
    faces: await facesStatus(v), // détection des visages (cadrage automatique en plein écran)
  };
}

clipsAdminRouter.get(
  '/clips',
  ah(async (req, res) => res.json(await state(await loadVideo(req)))),
);

// --- dépôt par morceaux -------------------------------------------------------------

clipsAdminRouter.post(
  '/file/start',
  ah(async (req, res) => {
    const v = await loadVideo(req);
    res.json(await startUpload(v.youtube_id, req.body?.size));
  }),
);

clipsAdminRouter.put(
  '/file/chunk',
  express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }),
  ah(async (req, res) => {
    const v = await loadVideo(req);
    const offset = Number(req.query.offset);
    const total = Number(req.query.total);
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'Position invalide.');
    res.json(await appendChunk(v.youtube_id, offset, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), Number.isFinite(total) ? total : undefined));
  }),
);

clipsAdminRouter.post(
  '/file/finish',
  ah(async (req, res) => {
    const v = await loadVideo(req);
    const meta = await finishUpload(v.youtube_id, req.body?.size);
    // une nouvelle vidéo remplace l'ancienne : les extraits restent valables (ils viennent de la transcription)
    await pool.query(
      `UPDATE videos SET file_name = $2, file_size = $3, file_duration_s = $4, file_width = $5, file_height = $6,
         file_has_audio = $7, file_uploaded_at = now() WHERE id = $1`,
      [v.id, meta.name, meta.size, meta.duration_s, meta.width, meta.height, meta.has_audio],
    );
    const fresh = await loadVideo(req);
    await removeFaces(fresh.id); // l'ancienne analyse ne correspond plus au fichier
    autoAnalyze(fresh);
    res.json(await state(fresh));
  }),
);

/** Lecture du fichier par l'admin (aperçu dans l'éditeur) : Range géré, jamais mis en cache ni exposé au public. */
clipsAdminRouter.get(
  '/file',
  ah(async (req, res) => {
    const v = await loadVideo(req);
    if (!v.file_name) throw new HttpError(404, 'Aucun fichier vidéo.');
    res.sendFile(videoFilePath(v.file_name), { acceptRanges: true, headers: { 'Cache-Control': 'private, no-store' } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Fichier introuvable sur le serveur.' });
    });
  }),
);

/** Détection des visages (cadrage automatique) : lance ou relance l'analyse, ou efface son résultat. */
clipsAdminRouter.post(
  '/faces',
  ah(async (req, res) => {
    const v = await loadVideo(req);
    await startAnalysis(v);
    res.json(await state(await loadVideo(req)));
  }),
);

clipsAdminRouter.post(
  '/faces/identify',
  ah(async (req, res) => {
    const v = await loadVideo(req);
    await startIdentification(v);
    res.json(await state(await loadVideo(req)));
  }),
);

clipsAdminRouter.delete(
  '/faces',
  ah(async (req, res) => {
    const v = await loadVideo(req);
    await removeFaces(v.id);
    res.json(await state(v));
  }),
);

clipsAdminRouter.delete(
  '/file',
  ah(async (req, res) => {
    const v = await loadVideo(req);
    await removeVideoFiles(v.youtube_id);
    await removeFaces(v.id);
    await pool.query(
      `UPDATE videos SET file_name = NULL, file_size = NULL, file_duration_s = NULL, file_width = NULL, file_height = NULL,
         file_has_audio = NULL, file_uploaded_at = NULL, clips_enabled = FALSE WHERE id = $1`,
      [v.id],
    );
    res.json(await state(await loadVideo(req)));
  }),
);

// --- clips autorisés et extraits proposés ----------------------------------------------

const llmError = (e) => {
  if (e instanceof HttpError) return e;
  if (e instanceof LlmError) return new HttpError(e.code === 'config' || e.code === 'auth' ? 503 : 502, `Extraits impossibles : ${e.message}`);
  return e;
};

clipsAdminRouter.put(
  '/clips',
  ah(async (req, res) => {
    const v = await loadVideo(req);
    const enabled = req.body?.enabled === true;
    let suggestionsError = null;
    if (enabled) {
      if (!v.file_name) throw new HttpError(409, "Dépose d'abord le fichier vidéo.");
      if (!v.has_text) throw new HttpError(409, "Cette vidéo n'a pas de transcription.");
      if (!(await getClipSuggestions(v.id)) && llmConfigured()) {
        try {
          await generateClipSuggestions(v.id);
        } catch (e) {
          suggestionsError = llmError(e).message; // on autorise quand même : les extraits pourront être relancés
        }
      }
    }
    await pool.query('UPDATE videos SET clips_enabled = $2 WHERE id = $1', [v.id, enabled]);
    res.json({ ...(await state(await loadVideo(req))), suggestions_error: suggestionsError });
  }),
);

clipsAdminRouter.post(
  '/clips/suggest',
  ah(async (req, res) => {
    const v = await loadVideo(req);
    try {
      await generateClipSuggestions(v.id);
    } catch (e) {
      throw llmError(e);
    }
    res.json(await state(await loadVideo(req)));
  }),
);
