// Interview de démonstration pour enregistrer les tutoriels : une vidéo d'exemple (dégradé aux couleurs du site, créée avec ffmpeg),
// une transcription qui explique le studio et quatre extraits proposés. Rien de réel : aucune parole attribuée à une personne.
// Usage : STORAGE_DIR=<dossier> DATABASE_URL=<base> node tools/tutorial/demo-seed.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const storage = path.resolve(process.env.STORAGE_DIR ?? 'data');
const YT = 'TUTOdemo_01';
mkdirSync(path.join(storage, 'videos'), { recursive: true });
execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=1280x720:c0=0x1d257a:c1=0xb0ad85:c2=0xd0165f:n=3:speed=0.04:duration=60:rate=25', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', path.join(storage, 'videos', `${YT}.mp4`)]);

const db = await import('../../src/db.js');
await db.initDb();
const { pool } = db;
await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
const { rows } = await pool.query(
  `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
   VALUES ($1, 'Interview d’exemple', 'Chaîne', '2026-09-12', 'manual', 'fr', 60, $2, 1000, 60, 1280, 720, FALSE, now(), TRUE) RETURNING id`,
  [YT, `${YT}.mp4`],
);
const id = rows[0].id;
const lines = [
  'Voici un exemple de phrase prononcée dans une interview.',
  'Les sous-titres apparaissent mot après mot, comme sur TikTok.',
  'Chaque extrait raconte une idée complète, du début à la fin.',
  'Tu peux choisir le passage qui te plaît le plus.',
  'La musique donne du rythme à ta vidéo.',
  'En quelques touches, ta vidéo est prête à publier.',
];
await db.withTransaction((c) => db.replaceSegments(c, id, Array.from({ length: 20 }, (_, i) => ({ start_ms: i * 3000, duration_ms: 2900, text: lines[i % lines.length] }))));
const titles = [['Un passage fort et clair', 9, 3], ['Une idée expliquée simplement', 8, 15], ['Le moment que tout le monde retient', 8, 30], ['Une phrase qui marque', 7, 42]];
const clips = titles.map(([title, score, s]) => ({ start_ms: s * 1000, end_ms: (s + 12) * 1000, duration_s: 12, title, why: 'Un passage court, clair et facile à comprendre.', score, text: lines.slice(0, 4).join(' '), description: `${title} : à voir jusqu’au bout.\n\n#exemple #studio` }));
const { rows: v } = await pool.query('SELECT text_hash FROM videos WHERE id = $1', [id]);
await pool.query(
  `INSERT INTO clip_suggestions (video_id, content, model, text_hash) VALUES ($1, $2::jsonb, 'demo', $3)
   ON CONFLICT (video_id) DO UPDATE SET content = EXCLUDED.content, text_hash = EXCLUDED.text_hash`,
  [id, JSON.stringify({ clips }), v[0].text_hash],
);
await pool.end();
console.log(`interview de démonstration prête : /?v=${YT}`);
