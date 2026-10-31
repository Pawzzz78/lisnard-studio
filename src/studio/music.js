/**
 * Musiques du studio : les morceaux d'origine (public/music, music.json) et la bibliothèque de l'admin.
 *
 * Les morceaux de la bibliothèque sont déposés par l'admin, convertis en MP3 (volume normalisé pour que tous sonnent pareil sous
 * la voix) et rangés sur le volume : <STORAGE_DIR>/music/<id>.mp3. L'identifiant est choisi par le serveur ; le nom du fichier
 * envoyé n'est jamais utilisé comme chemin.
 *
 * Le catalogue est gardé en mémoire (les rendus le consultent de façon synchrone) et rechargé après chaque modification.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';
import { storageDir } from '../media.js';

const run = promisify(execFile);

export const CATEGORIES = [
  { id: 'motivant', label: 'Motivant' },
  { id: 'epique', label: 'Épique' },
  { id: 'cinematique', label: 'Cinématique' },
  { id: 'autre', label: 'Autres' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
/** Catégorie des sons tendance TikTok : réservée à l'actualisation automatique (l'admin n'y range pas ses morceaux). */
export const TREND_CATEGORY = { id: 'tendance', label: 'Tendances' };
/** Catégories montrées aux visiteurs. */
export const PUBLIC_CATEGORIES = [TREND_CATEGORY, ...CATEGORIES];

export const MUSIC_LIMITS = { minS: 8, maxS: 600, keepS: 300, maxBytes: 40 * 1024 * 1024, maxTracks: 100 };

export const MUSIC_DIR = fileURLToPath(new URL('../../public/music', import.meta.url));
export const libraryDir = () => path.join(storageDir(), 'music');

const builtin = JSON.parse(readFileSync(new URL('./music.json', import.meta.url), 'utf8')).map((m) => ({
  id: m.id,
  title: m.title,
  mood: m.mood,
  category: CATEGORY_IDS.has(m.category) ? m.category : 'autre',
  bpm: m.bpm ?? null,
  duration_s: m.duration_s,
  credit: '',
  license: m.license,
  builtin: true,
  path: path.join(MUSIC_DIR, m.file),
  url: `/music/${m.file}`,
}));

export const BUILTIN_MUSIC = builtin;

let library = [];
let hidden = new Set();
let loaded = false;

const fromRow = (r) => ({
  id: r.id,
  title: r.title,
  mood: '',
  category: r.category,
  bpm: null,
  duration_s: Number(r.duration_s),
  credit: r.credit,
  license: r.source === 'tiktok' ? 'Son tendance TikTok, utilisé avec l’accord de TikTok' : r.credit ? `Utilisé avec l'accord de l'administrateur (${r.credit})` : "Utilisé avec l'accord de l'administrateur",
  builtin: false,
  source: r.source,
  externalId: r.external_id,
  rank: r.rank,
  lastSeenAt: r.last_seen_at,
  enabled: r.enabled,
  size_bytes: Number(r.size_bytes),
  created_at: r.created_at,
  path: path.join(libraryDir(), r.file),
  url: `/api/studio/music/${r.id}`,
});

/** (Re)charge le catalogue depuis la base. */
export async function reloadMusic() {
  const [tracks, hide] = await Promise.all([
    pool.query('SELECT * FROM studio_music ORDER BY created_at DESC, id'),
    pool.query('SELECT id FROM studio_music_hidden'),
  ]);
  library = tracks.rows.map(fromRow);
  hidden = new Set(hide.rows.map((r) => r.id));
  loaded = true;
}

/** À appeler avant de valider une demande de rendu : charge le catalogue une première fois. */
export async function ensureMusic() {
  if (!loaded) await reloadMusic();
}

// un son tendance qui n'est plus dans le classement n'est plus proposé (il reste quelques jours sur le disque pour les rendus en cours)
const available = (t) => (t.builtin ? !hidden.has(t.id) : t.enabled && (t.source !== 'tiktok' || t.rank != null));

/** Morceaux proposés aux visiteurs : bibliothèque d'abord (les ajouts récents en tête), puis les morceaux d'origine. */
export function publicTracks() {
  const trending = library.filter((t) => t.source === 'tiktok').sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return [...trending, ...library.filter((t) => t.source !== 'tiktok'), ...builtin].filter(available).map(({ id, title, mood, category, bpm, duration_s, credit, license, url }) => ({ id, title, mood, category, bpm, duration_s, credit, license, url }));
}

/** Morceau utilisable dans un rendu (fichier sur disque), ou null. */
export function findTrack(id) {
  const t = [...builtin, ...library].find((m) => m.id === id);
  // un son tendance sorti du classement reste utilisable (brouillon ou rendu en cours) tant que son fichier est gardé
  return t && (t.builtin ? !hidden.has(t.id) : t.enabled) ? t : null;
}

/** Tout le catalogue, pour l'admin (y compris les morceaux masqués). */
export function adminTracks() {
  return {
    categories: CATEGORIES,
    library: library.filter((t) => t.source !== 'tiktok').map(({ path: _p, ...t }) => t),
    trending: library.filter((t) => t.source === 'tiktok').sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).map(({ path: _p, ...t }) => t),
    builtin: builtin.map(({ path: _p, ...t }) => ({ ...t, enabled: !hidden.has(t.id) })),
  };
}

/** Fichier de la bibliothèque pour une lecture publique (morceau actif seulement) ou par l'admin (`any`). */
export function libraryFile(id, { any = false } = {}) {
  const t = library.find((m) => m.id === id);
  return t && (any || t.enabled) ? t.path : null;
}

// --- dépôt -------------------------------------------------------------------------------

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Titre proposé d'après le nom du fichier : « Mon_morceau-épique.mp3 » devient « Mon morceau épique ». */
export function titleFromFilename(name) {
  return clean(String(name ?? '').replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[_-]+/g, ' '), 80);
}

async function probeAudio(file) {
  let stdout;
  try {
    ({ stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 }));
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(503, "ffmpeg n'est pas installé sur ce serveur.");
    throw new HttpError(422, "Ce fichier n'est pas un son lisible (MP3, M4A, WAV, OGG, FLAC…).");
  }
  const info = JSON.parse(stdout || '{}');
  const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audio) throw new HttpError(422, 'Ce fichier ne contient pas de piste audio.');
  const duration = Number(info.format?.duration) || Number(audio.duration) || 0;
  if (!(duration > 0)) throw new HttpError(422, 'Durée du morceau introuvable.');
  return duration;
}

/**
 * Ajoute un morceau : vérifie le contenu, le convertit en MP3 stéréo à volume normalisé (EBU R128, -16 LUFS) et l'enregistre.
 * `data` : contenu brut du fichier envoyé. Renvoie le morceau créé.
 */
export async function addTrack({ data, title, category, credit, filename, source = 'admin', externalId = null, rank = null }) {
  if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, 'Aucun fichier reçu.');
  if (data.length > MUSIC_LIMITS.maxBytes) throw new HttpError(413, `Fichier trop lourd (${Math.round(MUSIC_LIMITS.maxBytes / 1048576)} Mo au maximum).`);
  await ensureMusic();
  if (source !== 'tiktok' && library.filter((t) => t.source !== 'tiktok').length >= MUSIC_LIMITS.maxTracks) throw new HttpError(409, `La bibliothèque est pleine (${MUSIC_LIMITS.maxTracks} morceaux). Supprime-en avant d'en ajouter.`);
  const name = clean(title, 80) || titleFromFilename(filename);
  if (!name) throw new HttpError(400, 'Donne un titre au morceau.');
  const cat = source === 'tiktok' ? TREND_CATEGORY.id : CATEGORY_IDS.has(category) ? category : 'autre';

  const id = `m${randomBytes(5).toString('hex')}`;
  const dir = libraryDir();
  await fs.mkdir(dir, { recursive: true });
  const raw = path.join(dir, `${id}.upload`);
  const out = path.join(dir, `${id}.mp3`);
  try {
    await fs.writeFile(raw, data);
    const duration = await probeAudio(raw);
    if (duration < MUSIC_LIMITS.minS) throw new HttpError(422, `Morceau trop court (${MUSIC_LIMITS.minS} secondes au minimum).`);
    if (duration > MUSIC_LIMITS.maxS) throw new HttpError(422, `Morceau trop long (${MUSIC_LIMITS.maxS / 60} minutes au maximum).`);
    try {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-vn', '-map', '0:a:0', '-t', String(MUSIC_LIMITS.keepS), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '160k', out], { timeout: 5 * 60_000 });
    } catch {
      throw new HttpError(422, 'Conversion impossible : ce fichier audio semble abîmé.');
    }
    const stat = await fs.stat(out);
    const kept = Math.min(duration, MUSIC_LIMITS.keepS);
    const { rows } = await pool.query(
      `INSERT INTO studio_music (id, title, category, credit, duration_s, size_bytes, file, source, external_id, rank, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $8 = 'tiktok' THEN now() END) RETURNING *`,
      [id, name, cat, clean(credit, 200), Math.round(kept * 10) / 10, stat.size, `${id}.mp3`, source, externalId, rank],
    );
    await reloadMusic();
    return library.find((t) => t.id === rows[0].id);
  } catch (e) {
    await fs.rm(out, { force: true });
    throw e;
  } finally {
    await fs.rm(raw, { force: true });
  }
}

/** Modifie un morceau de la bibliothèque (titre, catégorie, crédit, visibilité) ou masque / réaffiche un morceau d'origine. */
export async function updateTrack(id, patch) {
  await ensureMusic();
  const own = library.find((t) => t.id === id);
  const orig = builtin.find((t) => t.id === id);
  if (!own && !orig) throw new HttpError(404, 'Morceau introuvable.');
  if (orig) {
    if (typeof patch.enabled === 'boolean') {
      if (patch.enabled) await pool.query('DELETE FROM studio_music_hidden WHERE id = $1', [id]);
      else await pool.query('INSERT INTO studio_music_hidden (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    }
  } else {
    const sets = [];
    const vals = [id];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.title !== undefined) {
      const t = clean(patch.title, 80);
      if (!t) throw new HttpError(400, 'Le titre ne peut pas être vide.');
      add('title', t);
    }
    if (patch.category !== undefined) {
      if (!CATEGORY_IDS.has(patch.category)) throw new HttpError(400, 'Catégorie inconnue.');
      add('category', patch.category);
    }
    if (patch.credit !== undefined) add('credit', clean(patch.credit, 200));
    if (typeof patch.enabled === 'boolean') add('enabled', patch.enabled);
    if (sets.length) await pool.query(`UPDATE studio_music SET ${sets.join(', ')} WHERE id = $1`, vals);
  }
  await reloadMusic();
  return adminTracks();
}

export async function deleteTrack(id) {
  await ensureMusic();
  const t = library.find((m) => m.id === id);
  if (!t) throw new HttpError(404, 'Morceau introuvable (les morceaux d\'origine se masquent, ils ne se suppriment pas).');
  await pool.query('DELETE FROM studio_music WHERE id = $1', [id]);
  await fs.rm(t.path, { force: true });
  await reloadMusic();
  return adminTracks();
}
