/**
 * Statistiques du studio, pour l'admin : combien de clips créés, téléchargés ou partagés, et par combien de personnes.
 *
 *  - Un événement par clip et par type (créé, téléchargé, partagé) : recharger la page ou télécharger deux fois le même clip ne gonfle pas
 *    les chiffres.
 *  - Les personnes sont comptées avec une empreinte irréversible de l'adresse IP (HMAC avec le secret du serveur) : l'adresse n'est
 *    jamais stockée, et l'empreinte est effacée après 90 jours. C'est une approximation (deux personnes derrière la même connexion
 *    comptent pour une ; une personne qui change de réseau compte pour deux).
 *  - Jamais bloquant : une erreur d'enregistrement n'empêche pas de télécharger son clip.
 */
import crypto from 'node:crypto';
import { pool } from '../db.js';

export const VISITOR_RETENTION_DAYS = 90;
// edit, edit_download, edit_share: the « Edit » section (beat-synced montages), counted apart from clips
const KINDS = new Set(['render', 'download', 'share', 'edit', 'edit_download', 'edit_share']);

const secret = () => process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
// Without a server secret the hash would be reversible, so people are not counted
export const visitorHash = (ip) => {
  const key = secret();
  return key ? crypto.createHmac('sha256', key).update(`studio|${ip ?? ''}`).digest('hex').slice(0, 16) : null;
};

/** Enregistre un événement (une seule fois par clip et par type). Ne lève jamais d'erreur. */
export async function recordEvent(kind, { jobId, youtubeId, ip }) {
  if (!KINDS.has(kind) || !/^[0-9a-f]{24}$/.test(String(jobId))) return false;
  try {
    const { rowCount } = await pool.query(
      'INSERT INTO studio_events (kind, job_id, youtube_id, visitor) VALUES ($1, $2, $3, $4) ON CONFLICT (job_id, kind) DO NOTHING',
      [kind, jobId, youtubeId ?? null, visitorHash(ip)],
    );
    return rowCount > 0;
  } catch (e) {
    console.error(`Statistiques du studio : ${e.message}`);
    return false;
  }
}

/** Efface les empreintes de plus de 90 jours (les compteurs restent). */
export async function purgeVisitors() {
  await pool.query(`UPDATE studio_events SET visitor = NULL WHERE visitor IS NOT NULL AND created_at < now() - make_interval(days => $1::int)`, [VISITOR_RETENTION_DAYS]);
  await pool.query(`DELETE FROM library_downloads WHERE who LIKE 'v:%' AND created_at < now() - make_interval(days => $1::int)`, [VISITOR_RETENTION_DAYS]);
  await pool.query(`UPDATE library_reports SET visitor = NULL WHERE visitor IS NOT NULL AND created_at < now() - make_interval(days => $1::int)`, [VISITOR_RETENTION_DAYS]);
}

const PERIODS = {
  today: "created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris'",
  d7: "created_at >= now() - interval '7 days'",
  d30: "created_at >= now() - interval '30 days'",
  all: 'TRUE',
};

/** Chiffres pour l'admin : périodes, courbe des 14 derniers jours (heure de Paris) et interviews les plus utilisées. */
export async function studioStats() {
  const periods = {};
  await Promise.all(
    Object.entries(PERIODS).map(async ([name, where]) => {
      const { rows } = await pool.query(
        `SELECT count(*) FILTER (WHERE kind = 'render')::int AS created,
                count(*) FILTER (WHERE kind = 'download')::int AS downloaded,
                count(*) FILTER (WHERE kind = 'share')::int AS shared,
                count(DISTINCT job_id) FILTER (WHERE kind IN ('download', 'share'))::int AS retrieved,
                count(DISTINCT visitor) FILTER (WHERE kind IN ('download', 'share'))::int AS people_downloaded,
                count(DISTINCT visitor) FILTER (WHERE kind = 'render')::int AS people_created
         FROM studio_events WHERE ${where}`,
      );
      periods[name] = rows[0];
    }),
  );
  const { rows: daily } = await pool.query(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
            count(e.*) FILTER (WHERE e.kind = 'render')::int AS created,
            count(e.*) FILTER (WHERE e.kind = 'download')::int AS downloaded,
            count(e.*) FILTER (WHERE e.kind = 'share')::int AS shared,
            count(DISTINCT e.job_id) FILTER (WHERE e.kind IN ('download', 'share'))::int AS retrieved
     FROM generate_series((now() AT TIME ZONE 'Europe/Paris')::date - 13, (now() AT TIME ZONE 'Europe/Paris')::date, interval '1 day') d
     LEFT JOIN studio_events e ON (e.created_at AT TIME ZONE 'Europe/Paris')::date = d::date
     GROUP BY d ORDER BY d`,
  );
  const { rows: videos } = await pool.query(
    `SELECT e.youtube_id, max(v.title) AS title,
            count(*) FILTER (WHERE e.kind = 'render')::int AS created,
            count(*) FILTER (WHERE e.kind IN ('download', 'share'))::int AS downloaded,
            count(DISTINCT e.job_id) FILTER (WHERE e.kind IN ('download', 'share'))::int AS retrieved
     FROM studio_events e LEFT JOIN videos v ON v.youtube_id = e.youtube_id
     WHERE e.youtube_id IS NOT NULL GROUP BY e.youtube_id ORDER BY downloaded DESC, created DESC LIMIT 10`,
  );
  return { periods, daily, videos, retention_days: VISITOR_RETENTION_DAYS };
}
