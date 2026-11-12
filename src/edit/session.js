/**
 * Préparation d'un montage demandé par un adhérent (section « Edit ») : modèle en ligne, interviews choisies (ou les plus récentes),
 * extraits proposés de chaque interview (citations Lisnard Play en tête), cadrage vertical sur le visage de David Lisnard,
 * photos de la photothèque et textes de l'adhérent. Renvoie la chronologie et les fichiers à donner au rendu.
 */
import { EDIT, EditError, planEdit } from '../../public/js/edit-core.js';
import { cropXAt } from '../../public/js/framing.js';
import { getClipSuggestions, withPlayQuotes } from '../clip-suggestions.js';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';
import { videoFilePath } from '../media.js';
import { framingForRequest } from '../studio/faces.js';
import { findTrack } from '../studio/music.js';
import { trackBeats } from './beats.js';
import { imagePath, listImages } from './images.js';
import { getTemplate } from './templates.js';

export const SESSION = { maxVideos: 3, autoVideos: 3, clipsPerVideo: 4, maxPhotos: 30 };
const CLIPPABLE = `v.clips_enabled AND v.file_name IS NOT NULL AND v.norm_text <> ''`;
const COLS = 'v.id, v.youtube_id, v.title, v.published_at, v.file_name, v.file_size, v.file_duration_s, v.file_has_audio, v.file_uploaded_at, v.text_hash';
const YT = /^[A-Za-z0-9_-]{11}$/;
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Interviews du montage : celles choisies (au plus 3, toutes disponibles dans le studio), sinon les 3 plus récentes. */
async function videosFor(ids) {
  if (ids !== undefined && ids !== null && !Array.isArray(ids)) throw new HttpError(400, 'Interviews invalides.');
  const wanted = [...new Set((ids ?? []).map(String))];
  if (wanted.length > SESSION.maxVideos) throw new HttpError(400, `${SESSION.maxVideos} interviews au maximum.`);
  if (wanted.some((id) => !YT.test(id))) throw new HttpError(400, 'Interview invalide.');
  if (wanted.length) {
    const { rows } = await pool.query(`SELECT ${COLS} FROM videos v WHERE v.youtube_id = ANY($1) AND ${CLIPPABLE}`, [wanted]);
    if (rows.length !== wanted.length) throw new HttpError(404, 'Une des interviews choisies n’est plus disponible.');
    return wanted.map((id) => rows.find((r) => r.youtube_id === id));
  }
  const { rows } = await pool.query(`SELECT ${COLS} FROM videos v WHERE ${CLIPPABLE} ORDER BY v.published_at DESC NULLS LAST, v.id DESC LIMIT $1`, [SESSION.autoVideos]);
  return rows;
}

/** Position horizontale du cadre (0 à 1) pour un extrait : médiane de la trajectoire qui suit le visage, sinon le centre. */
const medianX = (keys, dur) => {
  if (!keys?.length) return 0.5;
  const xs = Array.from({ length: 9 }, (_, i) => cropXAt(keys, (dur * (i + 0.5)) / 9)).sort((a, b) => a - b);
  return Math.round(xs[4] * 1000) / 1000;
};

/** Extraits d'une interview pour le montage : les extraits proposés (citations Play en tête), cadrés sur le visage. */
async function clipsOf(video) {
  const sg = await withPlayQuotes(video.id, await getClipSuggestions(video.id));
  let clips = (sg?.clips ?? []).slice(0, SESSION.clipsPerVideo).map((c) => ({ start_ms: c.start_ms, end_ms: c.end_ms }));
  // No suggestion yet: the body of the interview (skipping the opening and the closing)
  if (!clips.length && video.file_duration_s > 20) {
    const total = Number(video.file_duration_s) * 1000;
    const start = Math.min(60_000, total * 0.1);
    clips = [{ start_ms: Math.round(start), end_ms: Math.round(Math.min(total - start, start + 10 * 60_000)) }];
  }
  if (!clips.length) return [];
  const framing = await framingForRequest(video, { layout: { fit: 'crop', follow: { on: true, subject: 'lisnard' } }, extracts: clips }).catch(() => null);
  return clips.map((c, i) => ({ youtube_id: video.youtube_id, ...c, crop_x: medianX(framing?.segments?.[i]?.keys, (c.end_ms - c.start_ms) / 1000) }));
}

/** Textes de l'adhérent : ils remplacent ceux du modèle, place par place (une place vide retire ce texte). */
function textsFor(template, texts) {
  if (texts === undefined || texts === null) return template.texts;
  if (!Array.isArray(texts) || texts.length > EDIT.maxTexts) throw new HttpError(400, `${EDIT.maxTexts} textes au maximum.`);
  const beats = template.texts.map((t) => t.beat);
  // A text the template did not plan: on the next free beat, every 8 beats
  for (let b = 0; beats.length < texts.length; b += 8) if (!beats.includes(b) && b < template.length_beats) beats.push(b);
  return texts
    .map((t, i) => ({ text: clean(t, EDIT.maxTextLen), beat: beats[i] }))
    .filter((t) => t.text && Number.isInteger(t.beat))
    .sort((a, b) => a.beat - b.beat);
}

/**
 * Montage demandé : { template_id, youtube_ids?, photos? (false : sans photos), texts? }.
 * Renvoie { plan, files, template, videos }. Les erreurs de saisie deviennent des réponses 400 / 404 au message clair.
 */
export async function buildEdit(body = {}) {
  const t = await getTemplate(Number(body.template_id));
  if (!t.enabled || !t.track_ok || !t.has_preview) throw new HttpError(404, 'Ce modèle n’est plus proposé.');
  const track = findTrack(t.track_id);
  const videos = await videosFor(body.youtube_ids);
  const clips = (await Promise.all(videos.map(clipsOf))).flat();
  const photos = body.photos === false ? [] : (await listImages()).slice(0, SESSION.maxPhotos).map((p) => p.id);
  if (!clips.length && !photos.length) throw new HttpError(409, 'Aucune interview ni photo disponible pour le moment.');
  const template = { ...t.template, texts: textsFor(t.template, body.texts) };
  let plan;
  try {
    plan = planEdit({ template, beats: await trackBeats(track), media: { clips, photos } });
  } catch (e) {
    if (e instanceof EditError) throw new HttpError(400, e.message);
    throw e;
  }
  const files = new Map(videos.map((v) => [v.youtube_id, videoFilePath(v.file_name)]));
  return {
    plan,
    template: t,
    videos,
    files: { video: (id) => files.get(id), photo: (id) => imagePath(id), music: track.path },
  };
}
