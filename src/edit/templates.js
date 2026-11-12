/**
 * Modèles de montage (section « Edit »), créés et réglés par l'admin : enregistrement, validation, mise en ligne, et aperçu vidéo
 * (rendu en petit avec de vraies photos de la photothèque et de vrais extraits d'interviews), gardé sur le volume :
 *   <STORAGE_DIR>/edit/previews/<id>.mp4
 * Un modèle n'est proposé aux adhérents qu'une fois mis en ligne, et seulement si son son est toujours dans la bibliothèque.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EditError, planEdit, sanitizeTemplate, templateFromRecipe } from '../../public/js/edit-core.js';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';
import { storageDir, videoFilePath } from '../media.js';
import { ensureMusic, findTrack, publicTracks } from '../studio/music.js';
import { FONTS, publicJob } from '../studio/render.js';
import { trackBeats } from './beats.js';
import { imagePath, listImages } from './images.js';
import { enqueueEditRender } from './render.js';

export const previewsDir = () => path.join(storageDir(), 'edit', 'previews');
export const previewPath = (id) => (Number.isInteger(Number(id)) && Number(id) > 0 ? path.join(previewsDir(), `${Number(id)}.mp4`) : null);
// Interviews offered in the studio (same rule as the clipping section)
const CLIPPABLE = `v.clips_enabled AND v.file_name IS NOT NULL AND v.norm_text <> ''`;

/** Valide un modèle ; une erreur de saisie devient une réponse 400 au message clair. */
async function validate(body) {
  await ensureMusic();
  try {
    return sanitizeTemplate(body, { trackIds: publicTracks().map((t) => t.id), fontIds: FONTS.map((f) => f.id) });
  } catch (e) {
    if (e instanceof EditError) throw new HttpError(400, e.message);
    throw e;
  }
}

const present = (r) => {
  const track = findTrack(r.track_id);
  return {
    id: r.id,
    name: r.name,
    track_id: r.track_id,
    track_title: track?.title ?? null,
    track_ok: Boolean(track),
    enabled: r.enabled,
    position: r.position,
    template: r.data,
    has_preview: Boolean(r.preview_at),
    preview_at: r.preview_at,
    updated_at: r.updated_at,
  };
};

/** Modèles (en ligne seulement, sauf `all` pour l'admin), dans l'ordre choisi par l'admin. */
export async function listTemplates({ all = false } = {}) {
  await ensureMusic();
  const { rows } = await pool.query(`SELECT * FROM edit_templates ${all ? '' : 'WHERE enabled'} ORDER BY position, id`);
  const list = rows.map(present);
  // Visitors only see templates whose sound is still there and whose preview matches the current settings
  return all ? list : list.filter((t) => t.track_ok && t.has_preview);
}

export async function getTemplate(id) {
  await ensureMusic();
  const { rows } = await pool.query('SELECT * FROM edit_templates WHERE id = $1', [Number(id) || 0]);
  if (!rows[0]) throw new HttpError(404, 'Modèle introuvable.');
  return present(rows[0]);
}

/**
 * Crée un modèle : soit à partir d'une recette de départ (`recipe_id`, avec `name`, `track_id`, `start_s`, `length_beats`),
 * soit complet (`template`). Il est créé hors ligne : l'admin le règle et génère son aperçu avant de le mettre en ligne.
 */
export async function createTemplate(body = {}) {
  let raw = body.template;
  if (!raw && body.recipe_id) {
    try {
      raw = templateFromRecipe(String(body.recipe_id), { name: body.name, track_id: body.track_id, start_s: body.start_s ?? 0, length_beats: body.length_beats ?? 32 });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }
  const t = await validate(raw);
  const { rows } = await pool.query(
    `INSERT INTO edit_templates (name, track_id, data, position) VALUES ($1, $2, $3::jsonb, (SELECT COALESCE(MAX(position), 0) + 1 FROM edit_templates)) RETURNING *`,
    [t.name, t.track_id, JSON.stringify(t)],
  );
  return present(rows[0]);
}

/** Remplace le réglage d'un modèle ; son ancien aperçu ne correspond plus : il est supprimé. */
export async function updateTemplate(id, raw) {
  const t = await validate(raw);
  const { rows } = await pool.query(
    'UPDATE edit_templates SET name = $2, track_id = $3, data = $4::jsonb, preview_at = NULL, updated_at = now() WHERE id = $1 RETURNING *',
    [Number(id) || 0, t.name, t.track_id, JSON.stringify(t)],
  );
  if (!rows[0]) throw new HttpError(404, 'Modèle introuvable.');
  await fs.rm(previewPath(id), { force: true });
  return present(rows[0]);
}

/** Met en ligne / hors ligne, ou change la place dans la liste. */
export async function setTemplateState(id, { enabled, position } = {}) {
  const cur = await getTemplate(id);
  if (enabled === true && !cur.track_ok) throw new HttpError(409, 'Le son de ce modèle n’est plus dans la bibliothèque : choisis-en un autre avant de le mettre en ligne.');
  if (enabled === true && !cur.has_preview) throw new HttpError(409, 'Génère d’abord l’aperçu du modèle : c’est lui que verront les adhérents.');
  const sets = [];
  const vals = [Number(id)];
  if (typeof enabled === 'boolean') sets.push(`enabled = $${vals.push(enabled)}`);
  if (Number.isInteger(position)) sets.push(`position = $${vals.push(position)}`);
  if (sets.length) await pool.query(`UPDATE edit_templates SET ${sets.join(', ')} WHERE id = $1`, vals);
  return getTemplate(id);
}

export async function deleteTemplate(id) {
  const { rowCount } = await pool.query('DELETE FROM edit_templates WHERE id = $1', [Number(id) || 0]);
  if (!rowCount) throw new HttpError(404, 'Modèle introuvable.');
  await fs.rm(previewPath(id), { force: true });
}

/**
 * Médias d'exemple pour l'aperçu d'un modèle : les photos actives de la photothèque, et deux extraits proposés de chacune des trois
 * interviews les plus récentes du studio. Renvoie { media, files } (voir planEdit et buildEditArgs), sans la musique.
 */
export async function sampleMedia({ maxPhotos = 8 } = {}) {
  const photos = (await listImages()).slice(0, maxPhotos).map((p) => p.id);
  const { rows } = await pool.query(
    `SELECT v.youtube_id, v.file_name, c.content->'clips' AS clips FROM videos v JOIN clip_suggestions c ON c.video_id = v.id
     WHERE ${CLIPPABLE} AND jsonb_array_length(COALESCE(c.content->'clips', '[]'::jsonb)) > 0 ORDER BY v.published_at DESC NULLS LAST, v.id DESC LIMIT 3`,
  );
  const files = new Map(rows.map((r) => [r.youtube_id, videoFilePath(r.file_name)]));
  const clips = rows.flatMap((r) => (Array.isArray(r.clips) ? r.clips : []).slice(0, 2).map((c) => ({ youtube_id: r.youtube_id, start_ms: c.start_ms, end_ms: c.end_ms })));
  return { media: { clips, photos }, files: { video: (id) => files.get(id), photo: (id) => imagePath(id) } };
}

/** Lance le rendu de l'aperçu d'un modèle (360 × 640) ; une fois prêt, il est gardé et remplace l'ancien. Renvoie l'état du rendu. */
export async function startPreview(id, { ip = 'admin' } = {}) {
  const t = await getTemplate(id);
  const track = findTrack(t.track_id);
  if (!track) throw new HttpError(409, 'Le son de ce modèle n’est plus dans la bibliothèque.');
  const beats = await trackBeats(track);
  const { media, files } = await sampleMedia();
  if (!media.clips.length && !media.photos.length) throw new HttpError(409, 'Ajoute des photos à la photothèque, ou des interviews au studio, pour générer un aperçu.');
  let plan;
  try {
    plan = planEdit({ template: t.template, beats, media });
  } catch (e) {
    if (e instanceof EditError) throw new HttpError(400, e.message);
    throw e;
  }
  const job = await enqueueEditRender({
    plan,
    files: { ...files, music: track.path },
    quality: 'preview',
    ip,
    filename: `apercu-modele-${t.id}`,
    onDone: async (j) => {
      if (j.status !== 'done') return;
      // The template changed while its preview was rendering: that preview no longer matches it
      const { rowCount } = await pool.query("UPDATE edit_templates SET preview_at = now() WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2", [t.id, t.updated_at]);
      if (!rowCount) return;
      await fs.mkdir(previewsDir(), { recursive: true });
      await fs.copyFile(j.out, previewPath(t.id));
    },
  });
  return publicJob(job);
}
