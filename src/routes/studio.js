/**
 * Studio de clips public : liste des vidéos dont l'admin a autorisé les clips, éléments de l'éditeur (polices, musiques,
 * styles), aperçu du cadrage, rendu du MP4 en arrière-plan (file d'attente) et téléchargement.
 * Le fichier vidéo d'origine n'est jamais servi : seuls des extraits (aperçu 360p, rendu final) en sortent.
 */
import express, { Router } from 'express';
import { getClipSuggestions, prepareSegments, CLIP_LIMITS } from '../clip-suggestions.js';
import { pool } from '../db.js';
import { HttpError, ah, jsonErrors } from '../http-error.js';
import { DEFAULT_STYLE, LIMITS, PRESETS } from '../../public/js/studio-core.js';
import { cancelJob, saveCard, saveLogo, config as studioConfig, createPreview, enqueueRender, FONTS, framingAllowed, getJob, normalizeRequest, previewFile, publicJob } from '../studio/render.js';
import { CATEGORIES, ensureMusic, libraryFile, publicTracks } from '../studio/music.js';
import { facesStatus, framingForRequest } from '../studio/faces.js';
import { recordEvent } from '../studio/stats.js';
import { ensureImage, searchPhotos, stockEnabled, stockProvider } from '../studio/stock.js';
import { parseYoutubeId } from '../youtube.js';
import { ensureOwner, libraryConfigured } from '../library/owner.js';

export const studioRouter = Router();
studioRouter.use(express.json({ limit: '100kb' }));


export const CLIPPABLE = `v.clips_enabled AND v.file_name IS NOT NULL AND v.norm_text <> ''`;
export const COLS = `v.id, v.youtube_id, v.title, v.channel, v.published_at, v.thumbnail_url, v.file_name, v.file_size,
  v.file_duration_s, v.file_has_audio, v.file_width, v.file_height, v.file_uploaded_at, v.text_hash`;

async function loadVideo(youtubeId) {
  const id = parseYoutubeId(String(youtubeId ?? ''));
  const { rows } = id ? await pool.query(`SELECT ${COLS} FROM videos v WHERE v.youtube_id = $1 AND ${CLIPPABLE}`, [id]) : { rows: [] };
  if (!rows[0]) throw new HttpError(404, "Cette vidéo n'est pas disponible dans le studio.");
  return rows[0];
}

const presentVideo = (v) => ({
  youtube_id: v.youtube_id,
  title: v.title,
  channel: v.channel,
  published_at: v.published_at,
  thumbnail_url: v.thumbnail_url,
  duration_s: v.file_duration_s,
});

/** Éléments de l'éditeur : styles, polices, musiques et limites. */
studioRouter.get(
  '/assets',
  ah(async (_req, res) => {
    await ensureMusic();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, hint: p.hint, style: p.style })),
      default_style: DEFAULT_STYLE,
      fonts: FONTS.map(({ id, label, category, file, em_ratio, cap_em }) => ({ id, label, category, file, em_ratio, cap_em })),
      music: publicTracks(),
      music_categories: CATEGORIES,
      limits: { ...LIMITS, suggestionMinS: CLIP_LIMITS.minS, suggestionMaxS: CLIP_LIMITS.maxS },
      stock: { enabled: stockEnabled(), provider: stockProvider() },
    });
  }),
);

/** Morceau de la bibliothèque (lecture dans l'éditeur) : Range géré pour pouvoir se déplacer dans le morceau. */
studioRouter.get(
  '/music/:id',
  ah(async (req, res) => {
    await ensureMusic();
    const file = libraryFile(String(req.params.id));
    if (!file) throw new HttpError(404, 'Morceau introuvable.');
    res.sendFile(file, { acceptRanges: true, headers: { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'audio/mpeg' } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Morceau introuvable.' });
    });
  }),
);

/** Recherche d'images libres de droits (b-roll). La clé du fournisseur reste sur le serveur. */
studioRouter.get(
  '/stock/search',
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await searchPhotos(req.query.q, { page: req.query.page, ip: req.ip }));
  }),
);

/** Image b-roll pour l'aperçu : téléchargée une fois par le serveur (jamais d'adresse donnée par le visiteur). */
studioRouter.get(
  '/stock/image/:id',
  ah(async (req, res) => {
    const file = await ensureImage(req.params.id, 'preview', { ip: req.ip });
    res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'image/jpeg' } });
  }),
);

studioRouter.get(
  '/videos',
  ah(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT ${COLS}, COALESCE(jsonb_array_length(c.content->'clips'), 0) AS suggestions
       FROM videos v LEFT JOIN clip_suggestions c ON c.video_id = v.id
       WHERE ${CLIPPABLE} ORDER BY v.published_at DESC NULLS LAST, v.id DESC`,
    );
    res.json({ videos: rows.map((v) => ({ ...presentVideo(v), suggestions: Number(v.suggestions) })) });
  }),
);

/** Ce que le studio a besoin de savoir des visages d'une vidéo. */
async function publicFaces(v) {
  const f = await facesStatus(v);
  // détection trop pauvre (visages trop petits ou rarement vus dans toute l'interview) : le cadrage automatique est indisponible
  const poor = f.status === 'ready' && f.summary?.share !== null && f.summary?.share !== undefined && f.summary.share < 0.15;
  return { ready: f.status === 'ready' && !poor, poor, identified: f.status === 'ready' && !poor && f.ident.state === 'ready' };
}

/** Une vidéo du studio : extraits proposés et lignes de la transcription (pour ajuster le début et la fin ligne par ligne). */
studioRouter.get(
  '/videos/:youtubeId',
  ah(async (req, res) => {
    const v = await loadVideo(req.params.youtubeId);
    const { rows } = await pool.query('SELECT start_ms, duration_ms, text FROM segments WHERE video_id = $1 ORDER BY position', [v.id]);
    const lines = prepareSegments(rows).map((s) => [s.start_ms, s.end_ms, s.text]);
    const sg = await getClipSuggestions(v.id);
    res.json({
      video: { ...presentVideo(v), width: v.file_width, height: v.file_height, has_audio: v.file_has_audio },
      suggestions: (sg?.clips ?? []).map(({ start_ms, end_ms, duration_s, title, why, score, text, description }) => ({ start_ms, end_ms, duration_s, title, why, score, text, description: description ?? null })),
      lines,
      faces: await publicFaces(v), // cadrage automatique possible ; reconnaissance de la personne de référence disponible
    });
  }),
);

/** Lignes de la transcription ({ start_ms, end_ms, text }) d'une vidéo. */
export async function linesOf(videoId) {
  const { rows } = await pool.query('SELECT start_ms, duration_ms, text FROM segments WHERE video_id = $1 ORDER BY position', [videoId]);
  return prepareSegments(rows);
}

/**
 * Trajectoire du cadre qui suit le visage (mode plein écran), pour l'aperçu en direct :
 * { segments: [{ t0, t1, keys }], faces, coverage } ; `segments` vaut null si le suivi n'est pas disponible pour ce clip.
 */
studioRouter.post(
  '/framing',
  ah(async (req, res) => {
    if (!framingAllowed(req.ip)) throw new HttpError(429, 'Trop de calculs de cadrage : réessaie dans quelques minutes.');
    const v = await loadVideo(req.body?.youtube_id);
    const request = normalizeRequest({ ...req.body, layout: { ...req.body?.layout, fit: 'crop', follow: { on: true, subject: req.body?.subject } } }, v);
    const clip = await framingForRequest(v, request);
    res.set('Cache-Control', 'no-store');
    const usable = clip?.segments.some((seg) => seg.keys);
    res.json({
      segments: usable ? clip.segments : null,
      faces: usable ? clip.faces : 0,
      coverage: usable ? clip.coverage : 0,
      split: usable ? clip.split : 0, // part du clip où l'écran est coupé en deux (la personne suivie en haut, l'autre en bas)
      crowded: usable ? clip.crowded : 0,
      recognized: usable ? clip.recognized : 0,
      ident_best: usable ? clip.identBest : null,
      // pourquoi le cadrage automatique manque, en tout ou pour certains extraits : « small » (visage trop petit), « rare » (trop peu visible), « none »
      reason: clip ? clip.reason : 'none',
      missing: clip ? clip.missing : request.extracts.length,
    });
  }),
);

studioRouter.post(
  '/endcard',
  express.raw({ type: 'image/jpeg', limit: '6mb' }),
  ah(async (req, res) => {
    res.json({ id: await saveCard(req.body, req.ip) });
  }),
);

studioRouter.post(
  '/logo',
  express.raw({ type: 'image/png', limit: '2mb' }),
  ah(async (req, res) => {
    res.json({ id: await saveLogo(req.body, req.ip) });
  }),
);

studioRouter.post(
  '/preview',
  ah(async (req, res) => {
    const v = await loadVideo(req.body?.youtube_id);
    await ensureMusic();
    const request = normalizeRequest(req.body, v);
    const { key, ext, duration_s } = await createPreview({ video: v, req: request, ip: req.ip });
    res.json({ url: `/api/studio/preview/${key}.${ext}`, duration_s });
  }),
);

studioRouter.get(
  '/preview/:file',
  ah(async (req, res) => {
    const found = await previewFile(String(req.params.file).replace(/\.(mp4|webm)$/, ''));
    if (!found) throw new HttpError(404, 'Aperçu expiré : il sera recalculé.');
    await loadVideo(found.youtube_id); // l'autorisation de la vidéo peut avoir été retirée depuis
    res.sendFile(found.file, { acceptRanges: true, headers: { 'Cache-Control': 'private, max-age=3600', 'Content-Type': found.ext === 'webm' ? 'video/webm' : 'video/mp4' } });
  }),
);

studioRouter.post(
  '/render',
  ah(async (req, res) => {
    const v = await loadVideo(req.body?.youtube_id);
    await ensureMusic();
    const request = normalizeRequest(req.body, v);
    request.framing = await framingForRequest(v, request);
    const owner = libraryConfigured() ? ensureOwner(req, res) : null;
    const job = await enqueueRender({ video: v, req: request, lines: await linesOf(v.id), ip: req.ip, owner: owner?.key ?? null });
    await recordEvent('render', { jobId: job.id, youtubeId: v.youtube_id, ip: req.ip });
    res.status(202).json(publicJob(job));
  }),
);

const jobOr404 = (id) => {
  const job = getJob(String(id));
  if (!job) throw new HttpError(404, 'Clip introuvable ou expiré (les clips sont conservés une heure).');
  return job;
};

studioRouter.get('/render/:id', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(publicJob(jobOr404(req.params.id)));
  } catch (e) {
    next(e);
  }
});

studioRouter.get('/render/:id/file', async (req, res, next) => {
  try {
    const job = jobOr404(req.params.id);
    if (job.status !== 'done') throw new HttpError(409, "Le clip n'est pas encore prêt.");
    // Cap the bytes actually sent per clip (seeking in <video> only costs what is transferred)
    if ((job.bytesServed ?? 0) >= (job.sizeServed ?? job.size ?? 0) * studioConfig().fileServeFactor) {
      throw new HttpError(429, 'Ce clip a déjà été téléchargé de nombreuses fois : crée-le à nouveau si besoin.');
    }
    const socket = req.socket;
    const sentBefore = socket.bytesWritten;
    res.on('close', () => {
      job.bytesServed = (job.bytesServed ?? 0) + Math.max(0, socket.bytesWritten - sentBefore);
    });
    // `?use=download` : le bouton « Télécharger » ; `?use=share` : le partage depuis le téléphone. La lecture dans la page (sans
    // paramètre) n'est pas un téléchargement.
    const use = req.query.use === 'download' ? 'download' : req.query.use === 'share' ? 'share' : null;
    if (use && req.method === 'GET') await recordEvent(use, { jobId: job.id, youtubeId: job.youtube_id, ip: req.ip });
    res.set('Cache-Control', 'no-store');
    // The visitor gets the version with their logo; the library only ever receives the clean one
    res.download(job.outLogo ?? job.out, job.filename, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Clip expiré.' });
    });
  } catch (e) {
    next(e);
  }
});

/** Le visiteur a récupéré son clip sans passer par le téléchargement du fichier (partage depuis le téléphone, fichier préchargé). */
studioRouter.post(
  '/render/:id/used',
  ah(async (req, res) => {
    const job = jobOr404(req.params.id);
    if (job.status !== 'done') throw new HttpError(409, "Le clip n'est pas encore prêt.");
    const use = req.body?.use === 'download' ? 'download' : req.body?.use === 'share' ? 'share' : null;
    if (!use) throw new HttpError(400, 'Usage inconnu.');
    await recordEvent(use, { jobId: job.id, youtubeId: job.youtube_id, ip: req.ip });
    res.status(204).end();
  }),
);

studioRouter.delete(
  '/render/:id',
  ah(async (req, res) => {
    await cancelJob(jobOr404(req.params.id));
    res.json({ ok: true });
  }),
);

studioRouter.use(jsonErrors());

