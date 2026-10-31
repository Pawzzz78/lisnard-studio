/**
 * Sons tendance TikTok pour la musique du studio : une fois par semaine, l'acteur Apify « tiktok-trending-sounds-scraper » donne les
 * sons du moment (classés par nombre de vidéos qui les utilisent) ; les 100 premiers sont téléchargés, convertis comme n'importe quel
 * morceau de la bibliothèque (MP3, volume égalisé) et proposés dans la catégorie « Tendances ».
 *
 * Droits : l'exploitant a l'accord de TikTok pour ces sons. Le jeton Apify est dans la variable d'environnement APIFY_TOKEN (jamais dans le dépôt) ;
 * sans jeton, la fonction est simplement inactive.
 *
 * Un son déjà présent n'est pas retéléchargé : seul son rang change. Un son qui sort du classement n'est plus proposé (rang vide) mais son
 * fichier reste `KEEP_DAYS` jours, pour ne pas casser un rendu ou un brouillon en cours, puis il est supprimé.
 */
import { promises as fs } from 'node:fs';
import { pool } from '../db.js';
import { DownloadError, safeDownload } from '../safe-download.js';
import { getSetting, setSetting } from '../settings.js';
import { addTrack, libraryDir, reloadMusic } from './music.js';

const API = 'https://api.apify.com/v2';
export const KEEP_DAYS = 14;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const RETRY_AFTER_ERROR_MS = 6 * 3600 * 1000;
const STALE_RUN_MS = 2 * 3600 * 1000;
const STATE_KEY = 'trending_sounds';

// serveurs de fichiers audio acceptés (https uniquement) ; EXTRA_AUDIO_HOSTS : suffixes supplémentaires séparés par des virgules
const AUDIO_HOSTS = ['apify.com', 'apifyusercontent.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com', 'tiktokv.us', 'byteoversea.com', 'ibytedtos.com', 'ibyteimg.com', 'ttwstatic.com', 'musical.ly'];

export function trendingConfig(env = process.env) {
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  const on = (v, d) => (v === undefined || v === '' ? d : !/^(0|off|false|non)$/i.test(String(v)));
  return {
    token: String(env.APIFY_TOKEN ?? '').trim(),
    off: /^(0|off|false)$/i.test(String(env.TRENDING_SOUNDS ?? '')),
    actor: String(env.APIFY_TRENDING_ACTOR || 's_actors/tiktok-trending-sounds-scraper').replace('/', '~'),
    country: String(env.TRENDING_COUNTRY || 'FR').toUpperCase().slice(0, 2),
    count: num(env.TRENDING_COUNT, 100, 1, 100),
    sampleVideos: num(env.TRENDING_SAMPLE_VIDEOS, 3000, 30, 3000), // vidéos lues pour classer les sons (environ 0,06 $ pour 1 000)
    commercialOnly: on(env.TRENDING_COMMERCIAL_ONLY, true), // seulement les sons que TikTok marque « usage commercial »
    songsOnly: on(env.TRENDING_SONGS_ONLY, true), // pas les « sons originaux » (voix de créateurs) : on veut de la musique
    extraHosts: String(env.EXTRA_AUDIO_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    maxRunMs: 20 * 60 * 1000,
    pollMs: 5000,
  };
}

const hostAllowed = (u, cfg) => u.protocol === 'https:' && [...AUDIO_HOSTS, ...cfg.extraHosts].some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));

// --- état (affiché dans l'admin) ----------------------------------------------------------

export const readState = () => getSetting(STATE_KEY, {});
const writeState = async (patch) => setSetting(STATE_KEY, { ...(await readState()), ...patch });

/** État pour l'admin. */
export async function trendingStatus(cfg = trendingConfig()) {
  const st = await readState();
  const { rows } = await pool.query("SELECT COUNT(*) FILTER (WHERE rank IS NOT NULL)::int AS live, COUNT(*)::int AS kept FROM studio_music WHERE source = 'tiktok'");
  const running = st.status === 'running' && Date.now() - (Date.parse(st.started_at ?? '') || 0) < STALE_RUN_MS;
  return {
    available: Boolean(cfg.token) && !cfg.off,
    reason: cfg.off ? 'désactivé (TRENDING_SOUNDS=off)' : cfg.token ? null : 'jeton Apify absent (variable APIFY_TOKEN)',
    country: cfg.country,
    running,
    last_ok_at: st.last_ok_at ?? null,
    last_error: st.last_error ?? null,
    last_error_at: st.last_error_at ?? null,
    last_result: st.last_result ?? null,
    live: rows[0].live,
    kept: rows[0].kept,
  };
}

// --- Apify ----------------------------------------------------------------------------------

async function apify(cfg, fetchImpl, method, path, body) {
  let res;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error('Apify est injoignable.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('Apify refuse le jeton (vérifie APIFY_TOKEN).');
  if (res.status === 402) throw new Error('Crédit Apify épuisé.');
  if (!res.ok) throw new Error(`Apify a répondu ${res.status}.`);
  return res.json();
}

/** Lance l'acteur, attend la fin, renvoie les sons (liste brute). */
export async function fetchTrending(cfg, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const input = {
    countries: [cfg.country],
    categories: ['All'],
    sampleVideos: cfg.sampleVideos,
    maxSounds: cfg.count,
    commercialOnly: cfg.commercialOnly,
    excludeOriginalSounds: cfg.songsOnly,
    downloadAudio: true,
    monitorName: 'studio-lisnard',
  };
  const started = await apify(cfg, fetchImpl, 'POST', `/acts/${cfg.actor}/runs?memory=1024`, input);
  const run = started?.data;
  if (!run?.id) throw new Error('Apify n’a pas démarré le travail.');
  const deadline = Date.now() + cfg.maxRunMs;
  let cur = run;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(cur.status)) {
    if (Date.now() > deadline) throw new Error('Apify met trop de temps à répondre.');
    await sleep(cfg.pollMs);
    cur = (await apify(cfg, fetchImpl, 'GET', `/actor-runs/${run.id}`))?.data ?? cur;
  }
  if (cur.status !== 'SUCCEEDED') throw new Error(`Le travail Apify a échoué (${cur.status}).`);
  const items = await apify(cfg, fetchImpl, 'GET', `/datasets/${cur.defaultDatasetId}/items?format=json&clean=true&limit=${cfg.count * 3}`);
  if (!Array.isArray(items)) throw new Error('Réponse Apify inattendue.');
  return items;
}

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Sons utilisables, dans l'ordre du classement, sans doublon : { id, title, author, rank, urls }. */
export function normalizeSounds(items, cfg) {
  const out = [];
  const seen = new Set();
  const sorted = [...items].filter((x) => x && typeof x === 'object').sort((a, b) => (Number(a.position) || 1e9) - (Number(b.position) || 1e9));
  for (const it of sorted) {
    const id = text(it.musicId, 40);
    const title = text(it.musicTitle, 80);
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(id) || !title || seen.has(id)) continue;
    if (cfg.commercialOnly && it.musicIsCommercial !== true) continue; // en cas de doute, on n'utilise pas
    if (cfg.songsOnly && it.musicIsOriginal === true) continue;
    const urls = [it.audioFileUrl, it.musicAudioUrl].filter((u) => typeof u === 'string' && u.startsWith('https://'));
    if (!urls.length) continue;
    seen.add(id);
    out.push({ id, title, author: text(it.musicAuthor, 100), rank: out.length + 1, urls });
    if (out.length >= cfg.count) break;
  }
  return out;
}

async function downloadAudio(sound, cfg, fetchImpl) {
  // le jeton n'est envoyé qu'à Apify, jamais à un autre serveur
  const withAuth = (url, init) => fetchImpl(url, url.hostname === 'api.apify.com' ? { ...init, headers: { Authorization: `Bearer ${cfg.token}` } } : init);
  let last;
  for (const url of sound.urls) {
    try {
      return await safeDownload(url, { allowed: (u) => hostAllowed(u, cfg), accept: /audio|video|octet-stream|binary/i, maxBytes: 30 * 1024 * 1024, fetchImpl: withAuth, timeoutMs: 60_000 });
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof DownloadError ? new Error(`${last.message} (${last.code})`) : last;
}

// --- actualisation ------------------------------------------------------------------------

let running = false;

/**
 * Actualise les sons tendance. Renvoie { added, kept, removed, failed, total } ou lève une erreur (l'ancien classement reste alors en place).
 * `deps` : pour les tests (fetchImpl, sleep).
 */
export async function refreshTrending({ cfg = trendingConfig(), fetchImpl = fetch, sleep } = {}) {
  if (!cfg.token || cfg.off) throw new Error('Les sons tendance ne sont pas activés sur ce serveur.');
  if (running) throw new Error('Une actualisation est déjà en cours.');
  running = true;
  const startedAt = new Date().toISOString();
  await writeState({ status: 'running', started_at: startedAt });
  try {
    const sounds = normalizeSounds(await fetchTrending(cfg, { fetchImpl, sleep }), cfg);
    if (sounds.length < 5) throw new Error(`Apify n’a renvoyé que ${sounds.length} son${sounds.length > 1 ? 's' : ''} utilisable${sounds.length > 1 ? 's' : ''} : classement conservé.`);
    const { rows: existing } = await pool.query("SELECT id, external_id FROM studio_music WHERE source = 'tiktok'");
    const have = new Map(existing.map((r) => [r.external_id, r.id]));
    let added = 0;
    let failed = 0;
    const ranked = [];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const s = sounds[next++];
        if (!s) return;
        if (have.has(s.id)) {
          ranked.push(s);
          continue;
        }
        try {
          const data = await downloadAudio(s, cfg, fetchImpl);
          await addTrack({ data, title: s.title, category: 'tendance', credit: s.author, filename: `${s.id}.audio`, source: 'tiktok', externalId: s.id, rank: s.rank });
          added++;
          ranked.push(s);
        } catch (e) {
          failed++;
          console.warn(`Sons tendance : « ${s.title} » ignoré : ${e.message}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (!ranked.length) throw new Error('Aucun son n’a pu être téléchargé : classement conservé.');
    // classement : rangs 1, 2, 3… dans l'ordre d'Apify, uniquement pour les sons réellement disponibles
    ranked.sort((a, b) => a.rank - b.rank);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE studio_music SET rank = NULL WHERE source = 'tiktok'");
      for (const [i, s] of ranked.entries()) {
        await client.query("UPDATE studio_music SET rank = $2, last_seen_at = now() WHERE source = 'tiktok' AND external_id = $1", [s.id, i + 1]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    const removed = await purgeOldTrending();
    await reloadMusic();
    const result = { added, total: ranked.length, failed, removed, at: new Date().toISOString() };
    await writeState({ status: 'ok', last_ok_at: result.at, last_result: result, last_error: null, last_error_at: null });
    return result;
  } catch (e) {
    await writeState({ status: 'error', last_error: e.message, last_error_at: new Date().toISOString() }).catch(() => {});
    throw e;
  } finally {
    running = false;
  }
}

/** Supprime les sons sortis du classement depuis plus de KEEP_DAYS jours (ligne et fichier). */
export async function purgeOldTrending() {
  const { rows } = await pool.query("DELETE FROM studio_music WHERE source = 'tiktok' AND rank IS NULL AND last_seen_at < now() - make_interval(days => $1) RETURNING file", [KEEP_DAYS]);
  await Promise.all(rows.map((r) => fs.rm(`${libraryDir()}/${r.file}`, { force: true })));
  return rows.length;
}

/** Faut-il actualiser maintenant ? (jamais fait ou plus d'une semaine ; après une erreur, on réessaie au bout de 6 h). */
export async function dueNow(cfg = trendingConfig(), now = Date.now()) {
  if (!cfg.token || cfg.off) return false;
  const st = await readState();
  if (st.status === 'running' && now - (Date.parse(st.started_at ?? '') || 0) < STALE_RUN_MS) return false;
  if (st.last_ok_at && now - (Date.parse(st.last_ok_at) || 0) < WEEK_MS) return false;
  if (st.last_error_at && now - (Date.parse(st.last_error_at) || 0) < RETRY_AFTER_ERROR_MS) return false;
  return true;
}

/** Vérifie toutes les 30 minutes si l'actualisation hebdomadaire est due (le calendrier est dans la base : un redémarrage ne la déclenche pas). */
export function startTrendingScheduler() {
  const tick = async () => {
    try {
      if (!(await dueNow())) return;
      await reloadMusic();
      const r = await refreshTrending();
      console.log(`Sons tendance : ${r.total} sons (${r.added} nouveaux, ${r.failed} ignorés, ${r.removed} supprimés).`);
    } catch (e) {
      console.warn(`Sons tendance : ${e.message}`);
    }
  };
  setTimeout(tick, 90_000).unref();
  setInterval(tick, 30 * 60_000).unref();
}
