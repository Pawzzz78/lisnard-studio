/**
 * Le mur #projetlisnard (veille) : toutes les publications TikTok et Instagram qui portent le hashtag, et qui les publie.
 *
 * Les publications sont récupérées avec Apify (même jeton APIFY_TOKEN que le mur) : « clockworks/tiktok-scraper » pour TikTok et
 * « apify/instagram-hashtag-scraper » pour Instagram, puis enregistrées dans `hashtag_posts`. La page publique lit la base, jamais Apify.
 * Actualisation toutes les REFRESH_HOURS heures et à la demande dans l'admin ; les vignettes sont copiées sur le volume (les adresses expirent).
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

export const HASHTAG = 'projetlisnard';
const REFRESH_HOURS = 24;
// Apify bills per result: a full catch-up only when a platform has nothing stored yet, then just the newest posts
const RESULTS_FIRST = 300;
const RESULTS = 50;
// Instagram only: the TikTok actor ignores date filters on hashtags (profiles only, per its maintainers)
const INSTAGRAM_NEWER_THAN = '3 days';
export const ACTORS = { tiktok: 'clockworks/tiktok-scraper', instagram: 'apify/instagram-hashtag-scraper' };
export const PLATFORMS = ['tiktok', 'instagram'];
export const SORTS = { recent: 'p.created_at DESC NULLS LAST', views: 'p.views DESC', likes: 'p.likes DESC' };

export const veilleConfig = () => ({
  token: process.env.APIFY_TOKEN ?? '',
  baseUrl: process.env.APIFY_BASE_URL || 'https://api.apify.com',
  hashtag: HASHTAG,
  refreshHours: REFRESH_HOURS,
});

// --- lecture des éléments d'Apify ------------------------------------------------------------------------------------------

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : 0);
const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const AUTHOR = /^[\w.]{1,60}$/;

function isoDate(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' || /^\d{9,13}$/.test(String(raw)) ? Number(raw) : null;
  const d = n !== null ? new Date(String(Math.trunc(n)).length > 11 ? n : n * 1000) : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function hasTag(tags, text, hashtag) {
  const list = (Array.isArray(tags) ? tags : []).map((t) => String(typeof t === 'object' && t ? first(t.name, t.title, t.hashtagName) ?? '' : t).replace(/^#/, '').toLowerCase());
  return list.includes(hashtag) || String(text).toLowerCase().includes(`#${hashtag}`);
}

/** Élément brut de l'acteur TikTok → publication, ou { skip }. */
export function normalizeTiktok(raw, hashtag = HASHTAG) {
  if (!raw || typeof raw !== 'object') return { skip: 'invalid' };
  if (raw.error && !raw.id) return { skip: 'error' }; // e.g. NOT_FOUND while nobody has used the hashtag yet
  const id = String(first(raw.id, raw.videoId, raw.aweme_id) ?? '');
  if (!/^\d{6,25}$/.test(id)) return { skip: 'invalid' };
  if (raw.isAd === true || raw.isSponsored === true) return { skip: 'ad' };
  const meta = raw.authorMeta ?? raw.author ?? {};
  const author = clean(first(meta.name, meta.uniqueId, raw.authorName, raw.authorUniqueId), 60).replace(/^@/, '');
  if (!AUTHOR.test(author)) return { skip: 'invalid' };
  const text = clean(first(raw.text, raw.desc, raw.description), 600);
  if (!hasTag(raw.hashtags, text, hashtag)) return { skip: 'hashtag' };
  const stats = raw.stats ?? raw.statsV2 ?? {};
  const web = String(first(raw.webVideoUrl, raw.videoUrl) ?? '');
  const video = raw.videoMeta ?? {};
  const cover = String(first(video.originalCoverUrl, video.coverUrl, raw.covers?.origin, raw.covers?.default, raw.cover, raw.coverUrl) ?? '');
  return {
    key: `tt_${id}`,
    platform: 'tiktok',
    url: /^https:\/\/(www\.|m\.)?tiktok\.com\/@[\w.]+\/video\/\d+/.test(web) ? web.split('?')[0] : `https://www.tiktok.com/@${author}/video/${id}`,
    author,
    nickname: clean(first(meta.nickName, meta.nickname, meta.name), 80),
    text,
    created_at: isoDate(first(raw.createTimeISO, raw.createTime, raw.create_time)),
    views: count(first(raw.playCount, stats.playCount)),
    likes: count(first(raw.diggCount, stats.diggCount)),
    comments: count(first(raw.commentCount, stats.commentCount)),
    cover_url: /^https:\/\//.test(cover) ? cover : null,
  };
}

/** Élément brut de l'acteur Instagram → publication, ou { skip }. */
export function normalizeInstagram(raw, hashtag = HASHTAG) {
  if (!raw || typeof raw !== 'object') return { skip: 'invalid' };
  if (raw.error && !raw.shortCode) return { skip: 'error' }; // e.g. no_items while nobody has used the hashtag yet
  const short = String(first(raw.shortCode, raw.shortcode, raw.code) ?? (/instagram\.com\/(?:p|reel|tv)\/([\w-]+)/.exec(String(raw.url ?? ''))?.[1] ?? ''));
  if (!/^[\w-]{5,40}$/.test(short)) return { skip: 'invalid' };
  const author = clean(first(raw.ownerUsername, raw.owner?.username, raw.username), 60).replace(/^@/, '');
  if (!AUTHOR.test(author)) return { skip: 'invalid' };
  const text = clean(first(raw.caption, raw.text), 600);
  if (!hasTag(raw.hashtags, text, hashtag)) return { skip: 'hashtag' };
  const cover = String(first(raw.displayUrl, raw.thumbnailUrl, raw.images?.[0]) ?? '');
  const url = String(raw.url ?? '');
  return {
    key: `ig_${short}`,
    platform: 'instagram',
    url: /^https:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+/.test(url) ? url.split('?')[0] : `https://www.instagram.com/p/${short}/`,
    author,
    nickname: clean(first(raw.ownerFullName, raw.owner?.full_name), 80),
    text,
    created_at: isoDate(first(raw.timestamp, raw.takenAtTimestamp, raw.taken_at)),
    views: count(first(raw.videoViewCount, raw.videoPlayCount, raw.playCount)),
    likes: count(first(raw.likesCount, raw.likeCount)),
    comments: count(first(raw.commentsCount, raw.commentCount)),
    cover_url: /^https:\/\//.test(cover) ? cover : null,
  };
}

/** Éléments bruts → { posts, skipped } (une publication par clé). */
export function normalizeItems(items, platform, hashtag = HASHTAG) {
  const norm = platform === 'instagram' ? normalizeInstagram : normalizeTiktok;
  const byKey = new Map();
  const skipped = {};
  for (const raw of items) {
    const p = norm(raw, hashtag);
    if (p.skip) skipped[p.skip] = (skipped[p.skip] ?? 0) + 1;
    else byKey.set(p.key, p);
  }
  return { posts: [...byKey.values()], skipped };
}

// --- base de données ------------------------------------------------------------------------------------------------------

/** Enregistre les publications (compteurs mis à jour ; une publication masquée le reste). Renvoie le nombre de nouvelles. */
export async function savePosts(posts) {
  let added = 0;
  for (const p of posts) {
    const { rows } = await pool.query(
      `INSERT INTO hashtag_posts (key, platform, url, author, nickname, text, created_at, views, likes, comments, cover_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (key) DO UPDATE SET url = $3, author = $4, nickname = $5, text = $6, created_at = COALESCE($7, hashtag_posts.created_at),
         views = GREATEST($8, hashtag_posts.views), likes = GREATEST($9, hashtag_posts.likes), comments = GREATEST($10, hashtag_posts.comments),
         cover_url = COALESCE($11, hashtag_posts.cover_url), last_seen = now()
       RETURNING (xmax = 0) AS inserted`,
      [p.key, p.platform, p.url, p.author, p.nickname, p.text, p.created_at, p.views, p.likes, p.comments, p.cover_url],
    );
    if (rows[0]?.inserted) added++;
  }
  return added;
}

const VISIBLE = `NOT p.hidden AND NOT EXISTS (SELECT 1 FROM hashtag_hidden_authors a WHERE a.platform = p.platform AND a.author = lower(p.author))`;
const present = (r) => ({
  key: r.key,
  platform: r.platform,
  url: r.url,
  author: r.author,
  nickname: r.nickname,
  text: r.text,
  created_at: r.created_at,
  views: Number(r.views),
  likes: Number(r.likes),
  comments: Number(r.comments),
  cover: r.has_cover ? `/api/veille/cover/${r.key}` : null,
});

/** Page publique : publications visibles (filtrées, triées, paginées), auteurs et totaux. */
export async function listVeille({ platform = null, sort = 'recent', author = null, limit = 48, offset = 0 } = {}) {
  const lim = Math.min(96, Math.max(1, Math.trunc(Number(limit)) || 48));
  const off = Math.max(0, Math.trunc(Number(offset)) || 0);
  const where = [VISIBLE];
  const args = [];
  if (platform) where.push(`p.platform = $${args.push(platform)}`);
  if (author) where.push(`lower(p.author) = $${args.push(String(author).toLowerCase())}`);
  const cond = where.join(' AND ');
  const [posts, total, authors, totals] = await Promise.all([
    pool.query(`SELECT p.* FROM hashtag_posts p WHERE ${cond} ORDER BY ${SORTS[sort]}, p.key DESC LIMIT ${lim} OFFSET ${off}`, args),
    pool.query(`SELECT count(*)::int AS n FROM hashtag_posts p WHERE ${cond}`, args),
    pool.query(
      `SELECT p.platform, min(p.author) AS author, max(p.nickname) AS nickname, count(*)::int AS posts, sum(p.views)::bigint AS views, sum(p.likes)::bigint AS likes, max(p.created_at) AS last_at
       FROM hashtag_posts p WHERE ${VISIBLE} ${platform ? 'AND p.platform = $1' : ''}
       GROUP BY p.platform, lower(p.author) ORDER BY posts DESC, views DESC LIMIT 50`,
      platform ? [platform] : [],
    ),
    pool.query(
      `SELECT count(*)::int AS posts, count(DISTINCT (p.platform, lower(p.author)))::int AS authors, COALESCE(sum(p.views), 0)::bigint AS views,
              count(*) FILTER (WHERE p.platform = 'tiktok')::int AS tiktok, count(*) FILTER (WHERE p.platform = 'instagram')::int AS instagram
       FROM hashtag_posts p WHERE ${VISIBLE}`,
    ),
  ]);
  const t = totals.rows[0];
  return {
    posts: posts.rows.map(present),
    total: total.rows[0].n,
    authors: authors.rows.map((r) => ({ platform: r.platform, author: r.author, nickname: r.nickname, posts: r.posts, views: Number(r.views), likes: Number(r.likes), last_at: r.last_at })),
    totals: { posts: t.posts, authors: t.authors, views: Number(t.views), tiktok: t.tiktok, instagram: t.instagram },
  };
}

// --- vignettes ------------------------------------------------------------------------------------------------------------

export const coversDir = () => path.join(storageDir(), 'veille', 'covers');
export const coverPath = (key) => path.join(coversDir(), `${key}.jpg`);
export const KEY = /^(tt_\d{6,25}|ig_[\w-]{5,40})$/;
const COVER_HOSTS = {
  tiktok: ['tiktokcdn.com', 'tiktokcdn-eu.com', 'tiktokcdn-us.com', 'tiktokv.com', 'tiktokv.us', 'tiktok.com', 'byteoversea.com', 'ibytedtos.com', 'ttwstatic.com', 'apify.com', 'apifyusercontent.com'],
  instagram: ['cdninstagram.com', 'fbcdn.net', 'apify.com', 'apifyusercontent.com'],
};

/** Vignette chez la plateforme ou Apify, en HTTPS ? (aucune autre adresse n'est appelée) */
export function coverUrlAllowed(url, platform) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && (COVER_HOSTS[platform] ?? []).some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

async function saveCover(post, fetchImpl) {
  let buf;
  try {
    buf = await safeDownload(post.cover_url, { allowed: (u) => coverUrlAllowed(u.href, post.platform), accept: /^image\//i, maxBytes: 6 * 1024 * 1024, fetchImpl, timeoutMs: 20_000 });
  } catch (e) {
    throw new Error(`vignette : ${e instanceof DownloadError ? e.message : e.message}`);
  }
  await fs.mkdir(coversDir(), { recursive: true });
  const tmp = `${coverPath(post.key)}.tmp`;
  const src = `${tmp}.src`;
  await fs.writeFile(src, buf);
  try {
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', '-f', 'image2', tmp], { timeout: 30_000 });
    await fs.rename(tmp, coverPath(post.key));
  } finally {
    await fs.rm(src, { force: true });
    await fs.rm(tmp, { force: true });
  }
  await pool.query('UPDATE hashtag_posts SET has_cover = TRUE WHERE key = $1', [post.key]);
}

// --- actualisation --------------------------------------------------------------------------------------------------------

let running = null;
export const veilleBusy = () => Boolean(running);
/** Attend la fin de l'actualisation en cours (tests). */
export const veilleIdle = () => running?.catch(() => {}) ?? Promise.resolve();
export const lastRun = () => getSetting('veille_last_run', null);

/** Lance une actualisation en arrière-plan : { started } ou { started: false, reason }. */
export async function startVeilleRefresh({ trigger = 'admin', fetchImpl = fetch, minGapMs = 0 } = {}) {
  const cfg = veilleConfig();
  if (!cfg.token) return { started: false, reason: 'APIFY_TOKEN manquant : ajoute le jeton Apify aux variables du serveur.' };
  if (running) return { started: false, reason: 'Une actualisation est déjà en cours.' };
  // Each run costs Apify credit: the admin button cannot fire twice in a row
  const last = minGapMs ? await lastRun() : null;
  const since = last?.started_at ? Date.now() - Date.parse(last.started_at) : Infinity;
  if (since < minGapMs) return { started: false, reason: `Actualisation récente : réessaie dans ${Math.ceil((minGapMs - since) / 60000)} min.` };
  if (running) return { started: false, reason: 'Une actualisation est déjà en cours.' };
  running = doRefresh(cfg, { trigger, fetchImpl }).finally(() => {
    running = null;
  });
  running.catch(() => {});
  return { started: true };
}

/** Entrée de l'acteur : rattrapage complet si rien n'est encore stocké pour la plateforme, sinon seulement les plus récentes. */
export function actorInput(platform, hashtag, firstRun) {
  const results = firstRun ? RESULTS_FIRST : RESULTS;
  if (platform === 'tiktok') return { results, input: { hashtags: [hashtag], resultsPerPage: results, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false } };
  return { results, input: { hashtags: [hashtag], resultsLimit: results, ...(firstRun ? {} : { onlyPostsNewerThan: INSTAGRAM_NEWER_THAN }) } };
}

async function doRefresh(cfg, { trigger, fetchImpl }) {
  const record = { trigger, started_at: new Date().toISOString(), status: 'running', platforms: {} };
  await setSetting('veille_last_run', record);
  // One platform failing (actor change, no credit) must not drop the other one's results
  for (const platform of PLATFORMS) {
    try {
      const { rows: stored } = await pool.query('SELECT 1 FROM hashtag_posts WHERE platform = $1 LIMIT 1', [platform]);
      const { results, input } = actorInput(platform, cfg.hashtag, !stored.length);
      const { items, run: apifyRun } = await runActor({ token: cfg.token, actor: ACTORS[platform], baseUrl: cfg.baseUrl, maxItems: results, fetchImpl, input });
      const { posts, skipped } = normalizeItems(items, platform, cfg.hashtag);
      const added = await savePosts(posts);
      const sample = items.find((x) => x && typeof x === 'object');
      record.platforms[platform] = { status: 'ok', requested: results, received: items.length, kept: posts.length, added, skipped, sample_keys: sample ? Object.keys(sample).slice(0, 40) : [], cost_usd: Number.isFinite(apifyRun.usageTotalUsd) ? apifyRun.usageTotalUsd : null };
    } catch (e) {
      console.error(`veille ${platform} : ${e.message}`);
      record.platforms[platform] = { status: 'failed', error: String(e.message).slice(0, 300) };
    }
  }
  const { rows: need } = await pool.query('SELECT key, platform, cover_url FROM hashtag_posts WHERE NOT has_cover AND cover_url IS NOT NULL ORDER BY first_seen DESC LIMIT 300');
  let covers = 0;
  for (const p of need) {
    try {
      await saveCover(p, fetchImpl);
      covers++;
    } catch (e) {
      console.warn(`veille : vignette ${p.key} : ${e.message}`);
    }
  }
  const ok = Object.values(record.platforms).some((p) => p.status === 'ok');
  const done = { ...record, status: ok ? 'ok' : 'failed', finished_at: new Date().toISOString(), covers };
  await setSetting('veille_last_run', done);
  if (ok) await setSetting('veille_last_ok', done.finished_at);
  return done;
}

/** Actualisation planifiée due ? (jamais faite, dernière réussie trop vieille, ou dernier échec il y a plus d'une heure) */
export function refreshDue(last, hours = REFRESH_HOURS, now = Date.now()) {
  if (!last) return true;
  if (last.status === 'running') return now - Date.parse(last.started_at) > 30 * 60_000;
  return now - Date.parse(last.finished_at ?? last.started_at) >= (last.status === 'ok' ? hours * 3_600_000 : 3_600_000);
}

export function startVeilleScheduler() {
  const tick = async () => {
    if (!veilleConfig().token || running) return;
    if (refreshDue(await lastRun())) await startVeilleRefresh({ trigger: 'schedule' });
  };
  const safe = () => tick().catch((e) => console.error(`veille : ${e.message}`));
  setTimeout(safe, 2 * 60_000).unref();
  setInterval(safe, 10 * 60_000).unref();
}

// --- modération (admin) ---------------------------------------------------------------------------------------------------

export async function setPostHidden(key, hidden) {
  const { rowCount } = await pool.query('UPDATE hashtag_posts SET hidden = $2 WHERE key = $1', [String(key), Boolean(hidden)]);
  if (!rowCount) throw new HttpError(404, 'Publication introuvable.');
}

export async function setAuthorHidden(platform, author, hidden) {
  const a = String(author ?? '').replace(/^@/, '').trim().toLowerCase();
  if (!PLATFORMS.includes(platform) || !AUTHOR.test(a)) throw new HttpError(400, 'Auteur invalide.');
  if (hidden) await pool.query('INSERT INTO hashtag_hidden_authors (platform, author) VALUES ($1, $2) ON CONFLICT DO NOTHING', [platform, a]);
  else await pool.query('DELETE FROM hashtag_hidden_authors WHERE platform = $1 AND author = $2', [platform, a]);
}

export async function veilleOverview() {
  const [last, posts, authors] = await Promise.all([
    lastRun(),
    pool.query(
      `SELECT p.*, EXISTS (SELECT 1 FROM hashtag_hidden_authors a WHERE a.platform = p.platform AND a.author = lower(p.author)) AS author_hidden
       FROM hashtag_posts p ORDER BY p.created_at DESC NULLS LAST LIMIT 300`,
    ),
    pool.query('SELECT platform, author FROM hashtag_hidden_authors ORDER BY platform, author'),
  ]);
  return {
    hashtag: HASHTAG,
    actors: ACTORS,
    has_token: Boolean(veilleConfig().token),
    refresh_hours: REFRESH_HOURS,
    busy: veilleBusy(),
    last_run: last,
    posts: posts.rows.map((r) => ({ ...present(r), hidden: r.hidden, author_hidden: r.author_hidden })),
    hidden_authors: authors.rows,
  };
}
