/**
 * Mur des clips : les vidéos TikTok publiées avec le hashtag suivi (par défaut #lisnard2027), classées par vues, j'aime et commentaires.
 *
 * Les vidéos sont récupérées avec l'acteur Apify « clockworks/tiktok-scraper » (voir apify.js), puis enregistrées dans `wall_clips`
 * (le mur n'appelle jamais Apify : il lit la base). L'actualisation se fait toutes les WALL_REFRESH_HOURS heures et à la demande dans
 * l'admin. Les vignettes sont copiées sur le volume (les adresses de TikTok expirent) ; la vidéo se lit avec le lecteur officiel de
 * TikTok, chargé seulement au clic.
 *
 * Classement : score = vues × a + j'aime × b + commentaires × c (par défaut 1, 10 et 50, réglable avec WALL_WEIGHTS). Le mur ne montre
 * que les 13 meilleurs clips (WALL_MAX) ; les autres tris (vues, j'aime, commentaires) réordonnent ces 13 clips.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';
import { storageDir } from '../media.js';
import { DownloadError, safeDownload } from '../safe-download.js';
import { getSetting, setSetting } from '../settings.js';
import { runActor } from './apify.js';

const run = promisify(execFile);

export const SORTS = { score: 'score DESC', views: 'views DESC', likes: 'likes DESC', comments: 'comments DESC' };
export const PERIODS = { all: null, 30: 30, 7: 7 };

const num = (v, fallback) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));

export function wallConfig() {
  const w = String(process.env.WALL_WEIGHTS ?? '1,10,50').split(',').map((x) => Number(x.trim()));
  return {
    enabled: process.env.WALL_ENABLED !== 'false',
    token: process.env.APIFY_TOKEN ?? '',
    actor: process.env.APIFY_TIKTOK_ACTOR || 'clockworks/tiktok-scraper',
    baseUrl: process.env.APIFY_BASE_URL || 'https://api.apify.com',
    hashtag: String(process.env.WALL_HASHTAG ?? 'lisnard2027').replace(/^#/, '').trim().toLowerCase() || 'lisnard2027',
    max: Math.min(60, Math.max(3, Math.trunc(num(process.env.WALL_MAX, 13)))), // taille du classement : les N meilleurs clips
    results: Math.min(1000, Math.max(10, Math.trunc(num(process.env.WALL_RESULTS, 100)))),
    refreshHours: Math.max(0, num(process.env.WALL_REFRESH_HOURS, 24)), // 0 : seulement à la demande
    weights: w.length === 3 && w.every((x) => Number.isFinite(x) && x >= 0) ? w : [1, 10, 50],
  };
}

// --- lecture d'un élément du jeu de données d'Apify --------------------------------------------------------------------------

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : 0);
const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max);

/**
 * Élément brut de l'acteur → clip du mur, ou { skip: raison }. Les noms de champs sont ceux de l'acteur (id, text, createTimeISO,
 * authorMeta, videoMeta, playCount, diggCount, commentCount, shareCount, collectCount, webVideoUrl, hashtags) ; quelques variantes
 * (statistiques regroupées dans `stats`, champs de l'API de TikTok) sont acceptées pour résister à un changement de l'acteur.
 */
export function normalizeItem(raw, hashtag) {
  if (!raw || typeof raw !== 'object') return { skip: 'invalid' };
  if (raw.error && !raw.id) return { skip: 'error' }; // l'acteur signale un échec par un élément { error }
  const id = String(first(raw.id, raw.videoId, raw.aweme_id) ?? '');
  if (!/^\d{6,25}$/.test(id)) return { skip: 'invalid' };
  if (raw.isAd === true || raw.isSponsored === true) return { skip: 'ad' };
  const authorMeta = raw.authorMeta ?? raw.author ?? {};
  const author = clean(first(authorMeta.name, authorMeta.uniqueId, raw.authorName, raw.authorUniqueId), 60).replace(/^@/, '');
  if (!/^[\w.]{1,60}$/.test(author)) return { skip: 'invalid' };
  const text = clean(first(raw.text, raw.desc, raw.description), 600);
  const tags = (Array.isArray(raw.hashtags) ? raw.hashtags : []).map((t) => String(typeof t === 'object' ? first(t.name, t.title, t.hashtagName) ?? '' : t).replace(/^#/, '').toLowerCase()).filter(Boolean);
  const wanted = hashtag.toLowerCase();
  if (!tags.includes(wanted) && !text.toLowerCase().includes(`#${wanted}`)) return { skip: 'hashtag' };
  const stats = raw.stats ?? raw.statsV2 ?? {};
  const webUrl = String(first(raw.webVideoUrl, raw.videoUrl) ?? '');
  const url = /^https:\/\/(www\.|m\.)?tiktok\.com\/@[\w.]+\/video\/\d+/.test(webUrl) ? webUrl.split('?')[0] : `https://www.tiktok.com/@${author}/video/${id}`;
  const rawDate = first(raw.createTimeISO, raw.createTime, raw.create_time);
  let createdAt = null;
  if (rawDate !== undefined) {
    const d = typeof rawDate === 'number' || /^\d{9,13}$/.test(String(rawDate)) ? new Date(Number(rawDate) * (String(rawDate).length > 11 ? 1 : 1000)) : new Date(String(rawDate));
    if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
  }
  const video = raw.videoMeta ?? {};
  const cover = String(first(video.originalCoverUrl, video.coverUrl, raw.covers?.origin, raw.covers?.default, raw.cover, raw.coverUrl) ?? '');
  return {
    id,
    url,
    author,
    nickname: clean(first(authorMeta.nickName, authorMeta.nickname, authorMeta.name), 80),
    text,
    hashtags: [...new Set(tags)].slice(0, 30),
    created_at: createdAt,
    views: count(first(raw.playCount, stats.playCount, raw.views)),
    likes: count(first(raw.diggCount, stats.diggCount, raw.likes)),
    comments: count(first(raw.commentCount, stats.commentCount, raw.comments)),
    shares: count(first(raw.shareCount, stats.shareCount)),
    saves: count(first(raw.collectCount, stats.collectCount)),
    duration_s: Number.isFinite(Number(video.duration)) && Number(video.duration) > 0 ? Math.round(Number(video.duration)) : null,
    cover_url: /^https?:\/\//.test(cover) ? cover : null,
  };
}

/** Éléments bruts → { clips, skipped: { raison: nombre } } (un seul clip par identifiant). */
export function normalizeItems(items, hashtag) {
  const byId = new Map();
  const skipped = {};
  for (const raw of items) {
    const c = normalizeItem(raw, hashtag);
    if (c.skip) skipped[c.skip] = (skipped[c.skip] ?? 0) + 1;
    else byId.set(c.id, c);
  }
  return { clips: [...byId.values()], skipped };
}

// --- base de données -------------------------------------------------------------------------------------------------------------

/** Enregistre les clips (met à jour les compteurs de ceux qu'on connaît déjà ; un clip masqué le reste). Renvoie le nombre de nouveaux. */
export async function saveClips(clips) {
  let added = 0;
  for (const c of clips) {
    const { rows } = await pool.query(
      `INSERT INTO wall_clips (id, url, author, nickname, text, hashtags, created_at, views, likes, comments, shares, saves, duration_s, cover_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET url = $2, author = $3, nickname = $4, text = $5, hashtags = $6, created_at = COALESCE($7, wall_clips.created_at),
         views = $8, likes = $9, comments = $10, shares = $11, saves = $12, duration_s = COALESCE($13, wall_clips.duration_s),
         cover_url = COALESCE($14, wall_clips.cover_url), last_seen = now()
       RETURNING (xmax = 0) AS inserted`,
      [c.id, c.url, c.author, c.nickname, c.text, JSON.stringify(c.hashtags), c.created_at, c.views, c.likes, c.comments, c.shares, c.saves, c.duration_s, c.cover_url],
    );
    if (rows[0].inserted) added++;
  }
  return added;
}

const present = (r, rank) => ({
  id: r.id,
  url: r.url,
  author: r.author,
  nickname: r.nickname,
  text: r.text,
  hashtags: r.hashtags,
  created_at: r.created_at,
  views: Number(r.views),
  likes: Number(r.likes),
  comments: Number(r.comments),
  shares: Number(r.shares),
  duration_s: r.duration_s,
  score: Number(r.score),
  rank,
  cover: r.has_cover ? `/api/wall/cover/${r.id}` : null,
});

const VISIBLE = `NOT c.hidden AND NOT EXISTS (SELECT 1 FROM wall_hidden_authors a WHERE a.author = lower(c.author))`;

/**
 * Le mur : les `max` (13) meilleurs clips visibles sur la période, d'après le score, puis réordonnés selon `sort` (`score` par défaut) ;
 * par pages de `limit`.
 */
export async function listWall({ sort = 'score', period = 'all', limit = 24, offset = 0 } = {}) {
  const order = SORTS[sort] ?? SORTS.score;
  const days = PERIODS[period] ?? null;
  const cfg = wallConfig();
  const [a, b, c] = cfg.weights;
  const lim = Math.min(60, Math.max(1, Math.trunc(Number(limit)) || 24));
  const off = Math.max(0, Math.trunc(Number(offset)) || 0);
  const { rows } = await pool.query(
    `WITH best AS (
       SELECT c.*, (c.views * $2::numeric + c.likes * $3::numeric + c.comments * $4::numeric)::bigint AS score
       FROM wall_clips c
       WHERE ${VISIBLE} AND ($1::int IS NULL OR c.created_at >= now() - make_interval(days => $1::int))
       ORDER BY score DESC, c.id DESC LIMIT $5
     )
     SELECT * FROM best c ORDER BY ${order}, c.id DESC LIMIT $6 OFFSET $7`,
    [days, a, b, c, cfg.max, lim, off],
  );
  const { rows: total } = await pool.query(
    `SELECT least(count(*), $2::int)::int AS n FROM wall_clips c WHERE ${VISIBLE} AND ($1::int IS NULL OR c.created_at >= now() - make_interval(days => $1::int))`,
    [days, cfg.max],
  );
  return { clips: rows.map((r, i) => present(r, off + i + 1)), total: total[0].n, max: cfg.max };
}

// --- vignettes ----------------------------------------------------------------------------------------------------------------------

export const coversDir = () => path.join(storageDir(), 'wall', 'covers');
export const coverPath = (id) => path.join(coversDir(), `${id}.jpg`);
const COVER_HOSTS = ['tiktokcdn.com', 'tiktokcdn-eu.com', 'tiktokcdn-us.com', 'tiktokv.com', 'tiktokv.us', 'tiktok.com', 'byteoversea.com', 'ibytedtos.com', 'ttwstatic.com', 'apify.com', 'apifyusercontent.com'];
const MAX_COVER_BYTES = 6 * 1024 * 1024;

/** Cette adresse de vignette est-elle chez TikTok ou Apify, en HTTPS ? (aucune autre adresse n'est jamais appelée) */
export function coverUrlAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const extra = String(process.env.WALL_COVER_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean); // tests : serveur local
  if (u.protocol !== 'https:' && !(process.env.WALL_ALLOW_HTTP === '1' && extra.includes(u.hostname))) return false;
  return extra.includes(u.hostname) || COVER_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

async function downloadCover(url, fetchImpl) {
  try {
    return await safeDownload(url, { allowed: (u) => coverUrlAllowed(u.href), accept: /^image\//i, maxBytes: MAX_COVER_BYTES, fetchImpl, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof DownloadError) throw new Error(`vignette : ${e.message}`);
    throw e;
  }
}

// Certaines vidéos commencent par un fondu blanc : leur vignette est alors délavée (grisâtre, sans vrai noir) et la carte paraît « déjà vue ».
// On la reconnaît à ses tons sombres absents (10e centile de luminance très clair) et à son faible écart de contraste, puis on étire ses tons.
const WASHED_MIN_DARK = 150; // luminance (0-255) du 10e centile au-delà de laquelle il n'y a plus de vrai noir
const WASHED_MAX_SPREAD = 70; // écart entre le 90e et le 10e centile en dessous duquel l'image est plate
const STRETCH = 'normalize=independence=0:smoothing=0';

/** Vignette délavée ? (jamais d'erreur : en cas de doute, ou sans ffmpeg, l'image reste telle quelle) */
export async function washedOut(file) {
  try {
    const { stdout } = await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { timeout: 30_000 });
    const num = (key) => Number(new RegExp(`signalstats\\.${key}=([\\d.]+)`).exec(stdout)?.[1]);
    const low = num('YLOW');
    const high = num('YHIGH');
    return Number.isFinite(low) && Number.isFinite(high) && low >= WASHED_MIN_DARK && high - low < WASHED_MAX_SPREAD;
  } catch {
    return false;
  }
}

/** Copie la vignette d'un clip sur le volume, réduite en JPEG de 360 px de large (tons étirés si elle est délavée). Renvoie true si elle est en place. */
export async function saveCover(clip, fetchImpl = fetch) {
  if (!clip.cover_url) return false;
  const buf = await downloadCover(clip.cover_url, fetchImpl);
  await fs.mkdir(coversDir(), { recursive: true });
  const tmp = `${coverPath(clip.id)}.tmp`;
  const src = `${tmp}.src`;
  await fs.writeFile(src, buf);
  try {
    const filters = (await washedOut(src)) ? `scale=360:-2,${STRETCH}` : 'scale=360:-2';
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', filters, '-q:v', '4', '-f', 'image2', tmp], { timeout: 30_000 });
    await fs.rename(tmp, coverPath(clip.id));
  } finally {
    await fs.rm(src, { force: true });
    await fs.rm(tmp, { force: true });
  }
  await pool.query('UPDATE wall_clips SET has_cover = TRUE WHERE id = $1', [clip.id]);
  return true;
}

/** Corrige sur place les vignettes déjà enregistrées qui sont délavées. Renvoie leur nombre. */
export async function enhanceStoredCovers() {
  let fixed = 0;
  for (const name of await fs.readdir(coversDir()).catch(() => [])) {
    if (!/^\d+\.jpg$/.test(name)) continue;
    const file = path.join(coversDir(), name);
    if (!(await washedOut(file))) continue;
    const tmp = `${file}.tmp`;
    try {
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', STRETCH, '-q:v', '3', '-f', 'image2', tmp], { timeout: 30_000 });
      await fs.rename(tmp, file);
      fixed++;
    } catch (e) {
      console.warn(`mur : vignette ${name} : ${e.message}`);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  return fixed;
}

// --- actualisation ------------------------------------------------------------------------------------------------------------------

let running = null; // { promise, trigger, startedAt } pendant une actualisation

export const wallBusy = () => (running ? { trigger: running.trigger, started_at: running.startedAt } : null);
/** Attend la fin de l'actualisation en cours (tests). */
export const wallIdle = () => running?.promise.catch(() => {}) ?? Promise.resolve();

const STALE_RUNNING_MS = 30 * 60_000;
export async function lastRun() {
  const last = await getSetting('wall_last_run', null);
  if (last?.status === 'running' && !running && Date.now() - Date.parse(last.started_at) > STALE_RUNNING_MS) {
    return { ...last, status: 'failed', finished_at: last.started_at, error: 'Actualisation interrompue.' };
  }
  return last;
}
export const lastOkAt = () => getSetting('wall_last_ok', null);

/**
 * Lance une actualisation en arrière-plan. Renvoie { started: true } ou { started: false, reason } (déjà en cours, pas de jeton, trop tôt).
 * `fetchImpl` : tests.
 */
export async function startWallRefresh({ trigger = 'admin', fetchImpl = fetch, minGapMs = 0 } = {}) {
  const cfg = wallConfig();
  if (!cfg.enabled) return { started: false, reason: 'Le mur est désactivé (WALL_ENABLED=false).' };
  if (!cfg.token) return { started: false, reason: 'APIFY_TOKEN manquant : ajoute le jeton Apify aux variables du serveur.' };
  if (running) return { started: false, reason: 'Une actualisation est déjà en cours.' };
  const startedAt = new Date().toISOString();
  // Reserve before any await so concurrent requests cannot both start
  const slot = { promise: Promise.resolve(), trigger, startedAt };
  running = slot;
  let last;
  try {
    last = await getSetting('wall_last_run', null);
  } catch (e) {
    running = null;
    throw e;
  }
  if (minGapMs && last?.started_at && Date.now() - Date.parse(last.started_at) < minGapMs) {
    running = null;
    return { started: false, reason: `Actualisation récente : réessaie dans ${Math.ceil((minGapMs - (Date.now() - Date.parse(last.started_at))) / 60000)} min.` };
  }
  const promise = doRefresh(cfg, { trigger, startedAt, fetchImpl }).finally(() => {
    if (running === slot) running = null;
  });
  slot.promise = promise;
  promise.catch(() => {});
  return { started: true };
}

async function doRefresh(cfg, { trigger, startedAt, fetchImpl }) {
  const record = { trigger, started_at: startedAt, status: 'running', hashtag: cfg.hashtag };
  await setSetting('wall_last_run', record);
  try {
    const { items, run: apifyRun } = await runActor({
      token: cfg.token,
      actor: cfg.actor,
      baseUrl: cfg.baseUrl,
      maxItems: cfg.results,
      fetchImpl,
      input: {
        hashtags: [cfg.hashtag],
        resultsPerPage: cfg.results,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
      },
    });
    const { clips, skipped } = normalizeItems(items, cfg.hashtag);
    const added = await saveClips(clips);
    // vignettes : celles qui manquent encore (un échec n'arrête rien : la carte affichera un fond uni)
    const { rows: need } = await pool.query('SELECT id, cover_url FROM wall_clips WHERE NOT has_cover AND cover_url IS NOT NULL ORDER BY views DESC LIMIT 200');
    let covers = 0;
    for (const c of need) {
      try {
        if (await saveCover(c, fetchImpl)) covers++;
      } catch (e) {
        console.warn(`mur : vignette ${c.id} : ${e.message}`);
      }
    }
    await enhanceStoredCovers().catch((e) => console.warn(`mur : vignettes délavées : ${e.message}`));
    // champs du premier élément reçu : si le format de l'acteur change, l'admin voit tout de suite ce qu'il contient
    const sample = items.find((x) => x && typeof x === 'object');
    const done = { ...record, status: 'ok', finished_at: new Date().toISOString(), received: items.length, kept: clips.length, added, skipped, covers, sample_keys: sample ? Object.keys(sample).slice(0, 40) : [], cost_usd: Number.isFinite(apifyRun.usageTotalUsd) ? apifyRun.usageTotalUsd : null };
    await setSetting('wall_last_run', done);
    await setSetting('wall_last_ok', done.finished_at);
    return done;
  } catch (e) {
    console.error(`mur : ${e.message}`);
    await setSetting('wall_last_run', { ...record, status: 'failed', finished_at: new Date().toISOString(), error: String(e.message).slice(0, 400) });
    throw e;
  }
}

/** L'actualisation planifiée est-elle due ? (jamais faite, ou la dernière réussie date de plus de `hours` heures, ou la dernière a échoué il y a plus d'une heure) */
export function refreshDue(last, hours, now = Date.now()) {
  if (!hours) return false;
  if (!last) return true;
  if (last.status === 'running') return now - Date.parse(last.started_at) > STALE_RUNNING_MS;
  const at = Date.parse(last.finished_at ?? last.started_at);
  return now - at >= (last.status === 'ok' ? hours * 3_600_000 : 3_600_000);
}

export function startWallScheduler() {
  const tick = async () => {
    const cfg = wallConfig();
    if (!cfg.enabled || !cfg.token) return;
    if (refreshDue(await lastRun(), cfg.refreshHours)) await startWallRefresh({ trigger: 'schedule' });
  };
  const safe = () => tick().catch((e) => console.error(`mur : ${e.message}`));
  setTimeout(safe, 60_000).unref();
  setInterval(safe, 10 * 60_000).unref();
  setTimeout(() => enhanceStoredCovers().catch((e) => console.warn(`mur : vignettes délavées : ${e.message}`)), 90_000).unref(); // vignettes déjà enregistrées
}

// --- modération et vue d'ensemble pour l'admin ----------------------------------------------------------------------------

export async function setClipHidden(id, hidden) {
  const { rowCount } = await pool.query('UPDATE wall_clips SET hidden = $2 WHERE id = $1', [String(id), Boolean(hidden)]);
  if (!rowCount) throw new HttpError(404, 'Clip introuvable.');
}

export async function setAuthorHidden(author, hidden) {
  const a = String(author ?? '').replace(/^@/, '').trim().toLowerCase();
  if (!/^[\w.]{1,60}$/.test(a)) throw new HttpError(400, 'Nom d’auteur invalide.');
  if (hidden) await pool.query('INSERT INTO wall_hidden_authors (author) VALUES ($1) ON CONFLICT DO NOTHING', [a]);
  else await pool.query('DELETE FROM wall_hidden_authors WHERE author = $1', [a]);
}

/** État pour l'admin : réglages, dernière actualisation, compteurs, clips (y compris masqués), auteurs masqués. */
export async function wallOverview() {
  const cfg = wallConfig();
  const [a, b, c] = cfg.weights;
  const [last, counts, clips, authors] = await Promise.all([
    lastRun(),
    pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE hidden)::int AS hidden, count(*) FILTER (WHERE has_cover)::int AS covers, max(last_seen) AS last_seen FROM wall_clips`),
    pool.query(
      `SELECT c.*, (c.views * $1::numeric + c.likes * $2::numeric + c.comments * $3::numeric)::bigint AS score,
              EXISTS (SELECT 1 FROM wall_hidden_authors a WHERE a.author = lower(c.author)) AS author_hidden
       FROM wall_clips c ORDER BY score DESC, c.id DESC LIMIT 300`,
      [a, b, c],
    ),
    pool.query('SELECT author FROM wall_hidden_authors ORDER BY author'),
  ]);
  return {
    config: { enabled: cfg.enabled, has_token: Boolean(cfg.token), actor: cfg.actor, hashtag: cfg.hashtag, results: cfg.results, refresh_hours: cfg.refreshHours, weights: cfg.weights, max: cfg.max },
    busy: wallBusy(),
    last_run: last,
    counts: counts.rows[0],
    clips: clips.rows.map((r) => ({ ...present(r, null), hidden: r.hidden, author_hidden: r.author_hidden })),
    hidden_authors: authors.rows.map((r) => r.author),
  };
}
