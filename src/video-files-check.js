/**
 * Vérifie que les fichiers vidéo annoncés par la base sont bien sur le disque : une interview dont le fichier a disparu (supprimé à la main,
 * volume vidé ou remplacé) ne doit plus apparaître dans le studio, sinon on pourrait l'ouvrir et le clip échouerait.
 *
 * Prudence : un fichier n'est déclaré perdu que s'il manque à deux passages de suite ; rien n'est touché si le dossier des vidéos n'existe pas
 * (volume pas monté) ou si TOUS les fichiers manquent (volume probablement absent : une fois remonté, les fichiers reviennent) ; un fichier
 * déposé ou téléchargé depuis moins de 10 minutes est ignoré. Les vidéos téléchargées par le site (file_source = 'auto') sont ensuite retéléchargées
 * par le téléchargement automatique s'il est activé ; celles déposées à la main doivent être déposées de nouveau.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pool } from './db.js';
import { storageDir, videoFilePath } from './media.js';
import { removeFaces } from './studio/faces.js';

const GRACE_MS = 10 * 60 * 1000;
let missingBefore = new Set(); // vidéos dont le fichier manquait déjà au passage précédent

const present = async (name) => {
  try {
    const st = await fs.stat(videoFilePath(name));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
};

/** Un passage. Renvoie { checked, missing, reset, skipped }. `now` : pour les tests. */
export async function checkVideoFiles({ now = Date.now() } = {}) {
  const { rows } = await pool.query('SELECT id, youtube_id, title, file_name, file_uploaded_at FROM videos WHERE file_name IS NOT NULL ORDER BY id');
  const out = { checked: 0, missing: 0, reset: 0, skipped: null };
  if (!(await fs.stat(path.join(storageDir(), 'videos')).then((s) => s.isDirectory(), () => false))) {
    out.skipped = 'dossier des vidéos absent (volume pas monté ?)';
    return out;
  }
  const lost = [];
  for (const v of rows) {
    if (v.file_uploaded_at && now - new Date(v.file_uploaded_at).getTime() < GRACE_MS) continue;
    out.checked++;
    if (!(await present(v.file_name))) lost.push(v);
  }
  out.missing = lost.length;
  if (out.checked >= 3 && lost.length === out.checked) {
    out.skipped = 'tous les fichiers manquent (volume absent ?) : rien n\'est modifié';
    missingBefore = new Set();
    return out;
  }
  const confirmed = lost.filter((v) => missingBefore.has(v.id));
  missingBefore = new Set(lost.map((v) => v.id));
  for (const v of confirmed) {
    await removeFaces(v.id);
    const { rowCount } = await pool.query(
      `UPDATE videos SET file_name = NULL, file_size = NULL, file_duration_s = NULL, file_width = NULL, file_height = NULL, file_has_audio = NULL,
         file_uploaded_at = NULL, file_source = NULL, clips_enabled = FALSE, auto_enabled_at = NULL WHERE id = $1 AND file_name = $2`,
      [v.id, v.file_name],
    );
    if (rowCount) {
      out.reset++;
      console.warn(`Fichier vidéo introuvable, interview retirée du studio : ${v.youtube_id} (${v.title})`);
    }
  }
  return out;
}

/** Vérification toutes les 30 minutes (que le téléchargement automatique soit activé ou non). */
export function startVideoFilesCheck() {
  const tick = () => checkVideoFiles().catch((e) => console.error(`Fichiers vidéo : ${e.message}`));
  setTimeout(tick, 2 * 60_000).unref();
  setInterval(tick, 30 * 60_000).unref();
}

export const resetMissingMemory = () => {
  missingBefore = new Set();
};
