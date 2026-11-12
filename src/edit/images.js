/**
 * Photothèque de David Lisnard pour les montages (section « Edit ») : photos déposées par l'admin, qui confirme en avoir les droits.
 * Chaque photo est vérifiée, réduite à 2160 px au plus et convertie en JPEG, avec une vignette de 360 px pour les listes :
 *   <STORAGE_DIR>/edit/images/<id>.jpg et <id>.thumb.jpg
 * L'identifiant est choisi par le serveur ; le nom du fichier envoyé n'est jamais utilisé comme chemin.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';
import { storageDir } from '../media.js';

const run = promisify(execFile);

export const IMAGE_LIMITS = { maxBytes: 25 * 1024 * 1024, maxImages: 300, minSide: 300, maxSide: 2160 };
const ID = /^i[0-9a-f]{12}$/;

export const imagesDir = () => path.join(storageDir(), 'edit', 'images');
/** Chemin d'une photo (`thumb` : sa vignette), ou null si l'identifiant est invalide. */
export const imagePath = (id, { thumb = false } = {}) => (ID.test(String(id)) ? path.join(imagesDir(), `${id}${thumb ? '.thumb' : ''}.jpg`) : null);

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const present = (r) => ({ id: r.id, title: r.title, credit: r.credit, width: r.width, height: r.height, size_bytes: Number(r.size_bytes), enabled: r.enabled, created_at: r.created_at });

/** Photos (actives seulement, sauf `all` pour l'admin), les plus récentes d'abord. */
export async function listImages({ all = false } = {}) {
  const { rows } = await pool.query(`SELECT * FROM edit_images ${all ? '' : 'WHERE enabled'} ORDER BY created_at DESC, id`);
  return rows.map(present);
}

async function probeImage(file) {
  let stdout;
  try {
    ({ stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file], { timeout: 30_000 }));
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(503, "ffmpeg n'est pas installé sur ce serveur.");
    throw new HttpError(422, 'Ce fichier n’est pas une image lisible (JPEG, PNG ou WebP).');
  }
  const s = (JSON.parse(stdout || '{}').streams ?? []).find((x) => x.codec_type === 'video');
  if (!s || !s.width || !s.height) throw new HttpError(422, 'Ce fichier n’est pas une image lisible (JPEG, PNG ou WebP).');
  if (Math.min(s.width, s.height) < IMAGE_LIMITS.minSide) throw new HttpError(422, `Image trop petite (${IMAGE_LIMITS.minSide} px de côté au minimum) : elle serait floue en plein écran.`);
  return s;
}

/** Ajoute une photo (contenu brut). Renvoie la photo créée. */
export async function addImage({ data, title, credit }) {
  if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, 'Aucun fichier reçu.');
  if (data.length > IMAGE_LIMITS.maxBytes) throw new HttpError(413, `Image trop lourde (${Math.round(IMAGE_LIMITS.maxBytes / 1048576)} Mo au maximum).`);
  const { rows: count } = await pool.query('SELECT count(*)::int AS n FROM edit_images');
  if (count[0].n >= IMAGE_LIMITS.maxImages) throw new HttpError(409, `La photothèque est pleine (${IMAGE_LIMITS.maxImages} photos). Supprime-en avant d’en ajouter.`);
  const id = `i${randomBytes(6).toString('hex')}`;
  await fs.mkdir(imagesDir(), { recursive: true });
  const raw = path.join(imagesDir(), `${id}.upload`);
  const out = imagePath(id);
  const thumb = imagePath(id, { thumb: true });
  try {
    await fs.writeFile(raw, data);
    await probeImage(raw);
    const max = IMAGE_LIMITS.maxSide;
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-frames:v', '1', '-vf', `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', out], { timeout: 60_000 });
      await run('ffmpeg', ['-v', 'error', '-y', '-i', out, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', thumb], { timeout: 60_000 });
    } catch {
      throw new HttpError(422, 'Conversion impossible : cette image semble abîmée.');
    }
    const final = await probeImage(out);
    const stat = await fs.stat(out);
    const { rows } = await pool.query(
      'INSERT INTO edit_images (id, title, credit, file, width, height, size_bytes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [id, clean(title, 80), clean(credit, 200), `${id}.jpg`, final.width, final.height, stat.size],
    );
    return present(rows[0]);
  } catch (e) {
    await fs.rm(out, { force: true });
    await fs.rm(thumb, { force: true });
    throw e;
  } finally {
    await fs.rm(raw, { force: true });
  }
}

/** Modifie le titre, le crédit ou la visibilité d'une photo. */
export async function updateImage(id, patch = {}) {
  const sets = [];
  const vals = [String(id)];
  const add = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.title !== undefined) add('title', clean(patch.title, 80));
  if (patch.credit !== undefined) add('credit', clean(patch.credit, 200));
  if (typeof patch.enabled === 'boolean') add('enabled', patch.enabled);
  const { rows } = sets.length
    ? await pool.query(`UPDATE edit_images SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)
    : await pool.query('SELECT * FROM edit_images WHERE id = $1', vals);
  if (!rows[0]) throw new HttpError(404, 'Photo introuvable.');
  return present(rows[0]);
}

/** Supprime une photo (ligne et fichiers). */
export async function deleteImage(id) {
  const { rowCount } = await pool.query('DELETE FROM edit_images WHERE id = $1', [String(id)]);
  if (!rowCount) throw new HttpError(404, 'Photo introuvable.');
  for (const f of [imagePath(id), imagePath(id, { thumb: true })]) if (f) await fs.rm(f, { force: true });
}
