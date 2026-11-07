import express, { Router } from 'express';
import {
  authConfigured,
  checkPassword,
  endSession,
  isAuthenticated,
  loginAllowed,
  recordLogin,
  requireAdmin,
  startSession,
} from '../auth.js';
import { pool, replaceSegments, withTransaction } from '../db.js';
import { HttpError, ah, jsonErrors } from '../http-error.js';
import { clipsAdminRouter } from './clips-admin.js';
import { removeVideoFiles } from '../media.js';
import { facesAdminRouter } from './faces-admin.js';
import { wallAdminRouter } from './wall-admin.js';
import { libraryAdminRouter } from './library-admin.js';
import { musicAdminRouter } from './music-admin.js';
import { cancelAnalysis } from '../studio/faces.js';
import { studioStats } from '../studio/stats.js';
import { syncRouter } from './sync-admin.js';
import { createKey, listKeys, revokeKey } from '../agent/keys.js';
import { YouTubeApiError } from '../youtube.js';
import { fetchLocalized } from '../localize.js';
import { LlmError } from '../openrouter.js';
import { regenerateNow, saveEditedSummary } from '../summaries.js';
import { TranscriptError, parseTranscriptText, supadataConfigured } from '../transcripts.js';
import { TranslationError, baseLang, translateConfigured, translateSegments } from '../translate.js';
import { fetchMetadata, fetchVideoMeta, parseYoutubeId, youtubeApiConfigured } from '../youtube.js';

export const adminRouter = Router();



const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- session ---------------------------------------------------------------

adminRouter.post('/login', express.json({ limit: '1kb' }), (req, res) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: "L'admin n'est pas configurée (ADMIN_PASSWORD / SESSION_SECRET)." });
  }
  if (!loginAllowed(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 minutes.' });
  const ok = checkPassword(req.body?.password ?? '');
  recordLogin(req.ip, ok);
  if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect.' });
  startSession(req, res);
  res.json({ ok: true });
});

adminRouter.post('/logout', (_req, res) => {
  endSession(res);
  res.json({ ok: true });
});

adminRouter.get('/me', (req, res) => res.json({ authenticated: isAuthenticated(req) }));

// Tout ce qui suit demande une session valide.
adminRouter.use(requireAdmin);
// Large bodies (transcripts) are parsed only once the session is checked
adminRouter.use(express.json({ limit: '10mb' }));

adminRouter.get('/config', (_req, res) =>
  res.json({ supadata: supadataConfigured(), translate: translateConfigured(), youtube: youtubeApiConfigured() }),
);

adminRouter.use('/sync', syncRouter);

// Clés API des agents IA
adminRouter.get('/agent-keys', ah(async (_req, res) => res.json({ keys: await listKeys() })));
adminRouter.post('/agent-keys', ah(async (req, res) => res.status(201).json(await createKey(req.body?.name))));
adminRouter.delete('/agent-keys/:id', ah(async (req, res) => {
  if (!/^\d{1,9}$/.test(req.params.id) || !(await revokeKey(req.params.id))) throw new HttpError(404, 'Clé introuvable ou déjà révoquée.');
  res.json({ ok: true });
}));

/** Usage du studio : clips créés, téléchargés, partagés, personnes. */
adminRouter.get(
  '/studio/stats',
  (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    studioStats().then((stats) => res.json(stats), next);
  },
);
adminRouter.use('/library', libraryAdminRouter); // bibliothèque de clips : modération
adminRouter.use('/wall', wallAdminRouter); // mur des clips : actualisation et modération
adminRouter.use('/faces', facesAdminRouter); // photos de référence de la personne à reconnaître
adminRouter.use('/studio/music', musicAdminRouter); // bibliothèque de musiques du studio
adminRouter.use('/videos/:id', clipsAdminRouter); // fichier vidéo, clips autorisés, extraits proposés

// --- vidéos ----------------------------------------------------------------

const LIST_SQL = `
  SELECT v.id, v.youtube_id, v.title, v.channel, v.published_at, v.thumbnail_url,
         v.source, v.edited, v.updated_at, v.sync_status, v.sync_error, v.lang, v.translated, v.original_lang, v.duration_s,
         count(s.id)::int AS segment_count
  FROM videos v LEFT JOIN segments s ON s.video_id = v.id`;

adminRouter.get(
  '/videos',
  ah(async (_req, res) => {
    const { rows } = await pool.query(
      `${LIST_SQL} GROUP BY v.id ORDER BY v.published_at DESC NULLS LAST, v.id DESC`,
    );
    res.json(rows);
  }),
);

async function getVideo(id) {
  const { rows } = await pool.query(
    `SELECT id, youtube_id, title, channel, published_at, thumbnail_url, lang, source, edited, updated_at,
            translated, original_lang
     FROM videos WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'Vidéo introuvable.');
  return rows[0];
}

const videoId = (req) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Vidéo introuvable.');
  return id;
};

adminRouter.get(
  '/videos/:id',
  ah(async (req, res) => {
    const video = await getVideo(videoId(req));
    const { rows } = await pool.query(
      'SELECT start_ms, duration_ms, text, text_original FROM segments WHERE video_id = $1 ORDER BY position',
      [video.id],
    );
    const { rows: sm } = await pool.query(
      `SELECT s.content, s.created_at, s.edited_at, s.model, s.source_hash, v.text_hash, v.summary_attempts, v.summary_error
       FROM videos v LEFT JOIN video_summaries s ON s.video_id = v.id WHERE v.id = $1`,
      [video.id],
    );
    const x = sm[0];
    const sameText = String(x.source_hash).split(':')[0] === x.text_hash;
    let summary = { status: rows.length ? 'waiting' : 'none' };
    // outdated : la transcription a changé depuis le résumé (qui n'est jamais refait tout seul)
    if (x.edited_at) summary = { status: 'edited', edited_at: x.edited_at, outdated: !sameText };
    else if (x.created_at) summary = { status: 'ready', created_at: x.created_at, model: x.model, outdated: !sameText };
    else if (rows.length && x.summary_attempts >= 5) summary = { status: 'failed', error: x.summary_error, attempts: x.summary_attempts };
    summary.content = x.content ?? ''; // point de départ de l'édition, quel que soit l'état
    res.json({ video, segments: rows, summary });
  }),
);

/**
 * Ajout d'une vidéo.
 * body: { input, lang?, mode: 'supadata' | 'paste' | 'empty', transcript?, title?, channel?, published_at? }
 */
adminRouter.post(
  '/videos',
  ah(async (req, res) => {
    const { input, lang = 'fr', mode = 'supadata', transcript, title, channel, published_at } = req.body ?? {};
    const youtubeId = parseYoutubeId(input);
    if (!youtubeId) throw new HttpError(400, "Ce n'est pas une URL ou un identifiant YouTube valide.");
    if (published_at && !DATE_RE.test(published_at)) throw new HttpError(400, 'Date invalide (AAAA-MM-JJ).');

    const existing = await pool.query('SELECT id FROM videos WHERE youtube_id = $1', [youtubeId]);
    if (existing.rows[0]) {
      throw new HttpError(409, 'Cette vidéo est déjà dans la base.', { id: existing.rows[0].id });
    }

    let segments = [];
    let source = 'manual';
    let usedLang = lang;
    let tr = { translated: false, originalLang: null, untranslated: false };
    if (mode === 'supadata') {
      // Si la langue demandée n'existe pas, on traduit (clé OpenRouter) au lieu de garder une autre langue.
      const t = await fetchLocalized(youtubeId, lang);
      segments = t.segments;
      source = 'supadata';
      usedLang = t.lang;
      tr = t;
    } else if (mode === 'paste') {
      segments = parseTranscriptText(transcript);
      if (!segments.length) throw new HttpError(400, 'Aucune ligne de transcription reconnue.');
    } else if (mode !== 'empty') {
      throw new HttpError(400, 'Mode inconnu.');
    }

    // Avec la clé YouTube : titre, chaîne, date de publication et durée exacts (la date place la vidéo
    // au bon endroit dans « Dernières vidéos »). Sinon : oEmbed (sans date).
    const apiMeta = await fetchVideoMeta(youtubeId).catch(() => null);
    const meta = apiMeta ?? (await fetchMetadata(youtubeId)) ?? {};
    const id = await withTransaction(async (client) => {
      // Ajouter à la main une vidéo précédemment supprimée la sort de la liste d'exclusion.
      await client.query('DELETE FROM excluded_videos WHERE youtube_id = $1', [youtubeId]);
      const { rows } = await client.query(
        `INSERT INTO videos (youtube_id, title, channel, published_at, thumbnail_url, lang, source, channel_id, duration_s)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          youtubeId,
          String(title || meta.title || youtubeId).slice(0, 300),
          String(channel || meta.channel || '').slice(0, 200),
          published_at || meta.published_at || null,
          meta.thumbnail_url ?? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
          usedLang,
          source,
          meta.channel_id ?? null,
          meta.duration_s ?? null,
        ],
      );
      await replaceSegments(client, rows[0].id, segments, {
        translated: tr.translated,
        originalLang: tr.originalLang,
      });
      return rows[0].id;
    });
    res.status(201).json({ id, translated: tr.translated, untranslated: tr.untranslated, lang: usedLang });
  }),
);

adminRouter.patch(
  '/videos/:id',
  ah(async (req, res) => {
    const id = videoId(req);
    await getVideo(id);
    const { title, channel, published_at, lang } = req.body ?? {};
    if (published_at && !DATE_RE.test(published_at)) throw new HttpError(400, 'Date invalide (AAAA-MM-JJ).');
    await pool.query(
      `UPDATE videos SET
         title = COALESCE($2, title), channel = COALESCE($3, channel),
         published_at = CASE WHEN $4::boolean THEN $5::date ELSE published_at END,
         lang = COALESCE($6, lang), updated_at = now()
       WHERE id = $1`,
      [
        id,
        title == null ? null : String(title).slice(0, 300),
        channel == null ? null : String(channel).slice(0, 200),
        published_at !== undefined,
        published_at || null,
        lang == null ? null : String(lang).slice(0, 10),
      ],
    );
    res.json(await getVideo(id));
  }),
);

/** Enregistre un résumé corrigé à la main : il n'est plus jamais régénéré automatiquement. */
adminRouter.put(
  '/videos/:id/summary',
  ah(async (req, res) => {
    const id = videoId(req);
    await getVideo(id);
    if (typeof req.body?.markdown !== 'string') throw new HttpError(400, 'Résumé manquant.');
    res.json({ ok: true, ...(await saveEditedSummary(id, req.body.markdown)) });
  }),
);

/** Régénère tout de suite le résumé IA (remplace aussi un résumé corrigé à la main). Peut durer une minute. */
adminRouter.post(
  '/videos/:id/summary',
  ah(async (req, res) => {
    const id = videoId(req);
    await getVideo(id);
    try {
      const s = await regenerateNow(id);
      res.json({ ok: true, model: s.model, created_at: s.created_at });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof LlmError) throw new HttpError(502, `Résumé impossible : ${e.message}`);
      console.error(e);
      throw new HttpError(502, 'Résumé impossible pour le moment : réessaie plus tard.');
    }
  }),
);

/** Remplace titre, chaîne, date de publication, miniature et durée par les données de YouTube. */
adminRouter.post(
  '/videos/:id/refresh-meta',
  ah(async (req, res) => {
    const id = videoId(req);
    const video = await getVideo(id);
    if (!youtubeApiConfigured()) throw new HttpError(503, "YOUTUBE_API_KEY n'est pas configurée.");
    const meta = await fetchVideoMeta(video.youtube_id);
    if (!meta) throw new HttpError(404, 'Vidéo introuvable sur YouTube (privée ou supprimée ?).');
    await pool.query(
      `UPDATE videos SET title = $2, channel = $3, published_at = COALESCE($4, published_at),
         thumbnail_url = COALESCE($5, thumbnail_url), duration_s = COALESCE($6, duration_s),
         channel_id = COALESCE($7, channel_id), updated_at = now()
       WHERE id = $1`,
      [id, meta.title.slice(0, 300), meta.channel.slice(0, 200), meta.published_at, meta.thumbnail_url, meta.duration_s, meta.channel_id],
    );
    res.json(await getVideo(id));
  }),
);

adminRouter.put(
  '/videos/:id/segments',
  ah(async (req, res) => {
    const id = videoId(req);
    await getVideo(id);
    const segments = req.body?.segments;
    if (!Array.isArray(segments) || segments.length > 20000) throw new HttpError(400, 'Segments invalides.');
    const count = await withTransaction((client) => replaceSegments(client, id, segments, { edited: true }));
    res.json({ ok: true, segment_count: count });
  }),
);

adminRouter.post(
  '/videos/:id/refetch',
  ah(async (req, res) => {
    const id = videoId(req);
    const video = await getVideo(id);
    const t = await fetchLocalized(video.youtube_id, req.body?.lang || video.lang || 'fr');
    await withTransaction(async (client) => {
      await replaceSegments(client, id, t.segments, {
        edited: false,
        source: 'supadata',
        translated: t.translated,
        originalLang: t.originalLang,
      });
      await client.query('UPDATE videos SET lang = $2 WHERE id = $1', [id, t.lang]);
    });
    res.json({ ok: true, segment_count: t.segments.length, translated: t.translated, untranslated: t.untranslated });
  }),
);

const TRANSCRIPT_SOURCES = new Set(['whisper', 'supadata', 'manual']);

/**
 * Reçoit une transcription déjà prête sous forme de segments (script local Whisper, outil externe).
 * N'écrase JAMAIS une transcription existante, sauf `overwrite: true`. Le texte n'est pas marqué « corrigé ».
 * Une vidéo en attente ou en échec de la synchro passe à « transcrite ».
 */
adminRouter.post(
  '/videos/:id/transcript',
  ah(async (req, res) => {
    const id = videoId(req);
    await getVideo(id);
    const { segments, source = 'whisper', lang, overwrite = false } = req.body ?? {};
    if (!Array.isArray(segments) || !segments.length || segments.length > 20000) throw new HttpError(400, 'Segments invalides.');
    if (!segments.every((s) => s && typeof s.text === 'string' && Number.isFinite(Number(s.start_ms)))) {
      throw new HttpError(400, 'Chaque segment doit avoir un texte et un début (start_ms).');
    }
    if (!TRANSCRIPT_SOURCES.has(source)) throw new HttpError(400, 'Source inconnue.');
    if (lang !== undefined && !/^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(String(lang))) throw new HttpError(400, 'Langue invalide.');
    const count = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT (SELECT count(*) FROM segments WHERE video_id = $1)::int AS n FROM videos WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (rows[0].n > 0 && !overwrite) throw new HttpError(409, 'Cette vidéo a déjà une transcription (overwrite: true pour la remplacer).');
      const n = await replaceSegments(client, id, segments, { edited: false, source, translated: false, originalLang: null });
      if (lang) await client.query('UPDATE videos SET lang = $2 WHERE id = $1', [id, lang]);
      return n;
    });
    if (!count) throw new HttpError(400, 'Aucun segment non vide.');
    res.json({ ok: true, segment_count: count });
  }),
);

adminRouter.post(
  '/videos/:id/import',
  ah(async (req, res) => {
    const id = videoId(req);
    await getVideo(id);
    const segments = parseTranscriptText(req.body?.transcript);
    if (!segments.length) throw new HttpError(400, 'Aucune ligne de transcription reconnue.');
    await withTransaction((client) =>
      replaceSegments(client, id, segments, { edited: true, source: 'manual', translated: false, originalLang: null }),
    );
    res.json({ ok: true, segment_count: segments.length });
  }),
);

/** Traduit la transcription actuelle (texte d'origine conservé). Écrase le texte affiché, corrections comprises. */
adminRouter.post(
  '/videos/:id/translate',
  ah(async (req, res) => {
    const id = videoId(req);
    const video = await getVideo(id);
    const to = baseLang(req.body?.lang || 'fr');
    const from = baseLang(video.lang);
    if (!to || !/^[a-z]{2,3}$/.test(to)) throw new HttpError(400, 'Langue invalide.');
    if (!from) throw new HttpError(400, "La langue d'origine de la vidéo est inconnue : renseigne-la d'abord.");
    if (from === to) throw new HttpError(400, `La transcription est déjà en « ${to} ».`);
    const { rows } = await pool.query(
      'SELECT start_ms, duration_ms, text, text_original FROM segments WHERE video_id = $1 ORDER BY position',
      [id],
    );
    if (!rows.length) throw new HttpError(400, 'Aucune transcription à traduire.');
    const segments = await translateSegments(rows, { from, to });
    await withTransaction(async (client) => {
      await replaceSegments(client, id, segments, { translated: true, originalLang: video.original_lang || from });
      await client.query('UPDATE videos SET lang = $2 WHERE id = $1', [id, to]);
    });
    res.json({ ok: true, segment_count: segments.length });
  }),
);

adminRouter.delete(
  '/videos/:id',
  ah(async (req, res) => {
    const id = videoId(req);
    cancelAnalysis(id); // une analyse des visages en cours s'arrête avec la vidéo
    // On mémorise l'exclusion pour que la synchronisation ne la remette pas demain.
    const found = await withTransaction(async (client) => {
      const { rows } = await client.query('DELETE FROM videos WHERE id = $1 RETURNING youtube_id', [id]);
      if (!rows[0]) return null;
      await client.query(
        `INSERT INTO excluded_videos (youtube_id, reason) VALUES ($1, 'deleted') ON CONFLICT DO NOTHING`,
        [rows[0].youtube_id],
      );
      return rows[0].youtube_id;
    });
    if (!found) throw new HttpError(404, 'Vidéo introuvable.');
    await removeVideoFiles(found).catch((e) => console.warn(`Fichiers de ${found} non supprimés : ${e.message}`)); // le fichier vidéo du studio part avec la vidéo
    res.json({ ok: true });
  }),
);

adminRouter.use(
  jsonErrors({
    tooLarge: 'Morceau trop gros.',
    map: (err) => {
      if (err instanceof TranscriptError) return [err.status, err.message];
      if (err instanceof TranslationError) return [err.code === 'config' ? 503 : 502, err.message];
      if (err instanceof YouTubeApiError) return [502, err.message];
      if (err.code === '23505') return [409, 'Cet élément existe déjà (ajout simultané ?).']; // unique violation
      return null;
    },
  }),
);
