// Clés API des agents IA : seule l'empreinte SHA-256 est gardée en base ; la clé en clair n'est montrée qu'à sa création.
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';

const PREFIX = 'lsk_';
const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

/** Crée une clé ; renvoie { id, name, key } (la clé en clair n'est plus jamais lisible ensuite). */
export async function createKey(name) {
  const label = String(name ?? '').trim().slice(0, 80);
  if (!label) throw new HttpError(400, 'Donne un nom à la clé.');
  const key = PREFIX + crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query('INSERT INTO agent_keys (name, hint, hash) VALUES ($1, $2, $3) RETURNING id, name, created_at', [label, key.slice(0, 10), hash(key)]);
  return { ...rows[0], key };
}

export async function listKeys() {
  const { rows } = await pool.query('SELECT id, name, hint, created_at, last_used_at, uses, revoked_at FROM agent_keys ORDER BY revoked_at IS NOT NULL, created_at DESC');
  return rows.map((r) => ({ ...r, uses: Number(r.uses) }));
}

export async function revokeKey(id) {
  const { rowCount } = await pool.query('UPDATE agent_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [Number(id)]);
  return rowCount > 0;
}

/** Clé active correspondant au texte donné, ou null ; compte l'utilisation. */
export async function findKey(raw) {
  const key = String(raw ?? '').trim();
  if (!key.startsWith(PREFIX) || key.length > 80) return null;
  const { rows } = await pool.query(
    'UPDATE agent_keys SET last_used_at = now(), uses = uses + 1 WHERE hash = $1 AND revoked_at IS NULL RETURNING id, name',
    [hash(key)],
  );
  return rows[0] ?? null;
}

/** Clé lue dans `Authorization` (avec ou sans « Bearer », pour Grok), `X-Api-Key`, ou l'adresse MCP secrète (ChatGPT). */
export function keyFromRequest(req) {
  const auth = req.get('authorization') ?? '';
  const m = /^(?:Bearer\s+)?(lsk_\S+)$/i.exec(auth.trim());
  return m ? m[1] : (req.get('x-api-key') ?? req.params?.urlKey ?? null);
}
