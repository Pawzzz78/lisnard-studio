// New interventions listed on Lisnard Play (its public tRPC API): their YouTube videos join the sync queue like a followed channel's
import { pool } from './db.js';
import { SHORT_MAX_S } from './constants.js';
import { getSetting, setSetting } from './settings.js';
import { fetchVideoMeta, youtubeApiConfigured } from './youtube.js';

export const playConfig = () => ({
  enabled: !/^(off|false|0|non)$/i.test(process.env.PLAY_ENABLED ?? 'on'),
  base: (process.env.PLAY_URL || 'https://play.projetlisnard.fr').replace(/\/+$/, ''),
  refreshMinutes: Math.max(5, Number(process.env.PLAY_REFRESH_MINUTES) || 60),
  maxPages: Math.max(1, Number(process.env.PLAY_MAX_PAGES) || 5),
});

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const SEEN_MAX = 3000;

/** Identifiant YouTube d'une adresse (embed, watch, youtu.be, miniature ytimg), ou null. */
export function youtubeIdOf(url) {
  const m = /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:[^#]*&)?v=|shorts\/|live\/)|youtu\.be\/|ytimg\.com\/vi(?:_webp)?\/)([A-Za-z0-9_-]{11})/.exec(String(url ?? ''));
  return m && YT_ID.test(m[1]) ? m[1] : null;
}

async function trpc(base, procedure, input) {
  const url = `${base}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!res.ok) throw new Error(`Lisnard Play : réponse ${res.status} pour ${procedure}`);
  const text = await res.text();
  if (text.length > 3_000_000) throw new Error('Lisnard Play : réponse trop volumineuse');
  const data = JSON.parse(text)?.result?.data;
  if (!data) throw new Error(`Lisnard Play : réponse inattendue pour ${procedure}`);
  return data;
}

/**
 * Une passe : parcourt les interventions passées, des plus récentes aux plus anciennes, jusqu'à retomber sur des déjà vues.
 * `deps` : { fetchMeta } pour les tests. Renvoie { scanned, found, added }.
 */
export async function importFromPlay(deps = {}) {
  const cfg = playConfig();
  // Without the YouTube API nothing can be checked (Shorts, lives): fail loudly rather than mark everything as seen
  if (!deps.fetchMeta && !youtubeApiConfigured()) throw new Error('YOUTUBE_API_KEY manquante : impossible de vérifier les vidéos de Lisnard Play.');
  const fetchMeta = deps.fetchMeta ?? fetchVideoMeta;
  const seen = new Set(await getSetting('play_seen', []));
  const newlySeen = [];
  // Live, upcoming or not yet public videos are checked again on later passes, for two weeks at most
  const retryBefore = Date.now() - 14 * 86400_000;
  const retry = (await getSetting('play_retry', [])).filter((r) => YT_ID.test(r?.yt) && Date.parse(r.since) > retryBefore);
  const later = [];
  let scanned = 0;
  let found = 0;
  let added = 0;
  const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
  async function consider(ytId, it, since) {
    const { rows } = await pool.query(
      'SELECT 1 FROM videos WHERE youtube_id = $1 UNION ALL SELECT 1 FROM excluded_videos WHERE youtube_id = $1',
      [ytId],
    );
    if (rows.length) return;
    const meta = await fetchMeta(ytId);
    if (!meta || meta.live) {
      later.push({ yt: ytId, title: str(it.title, 300), outlet: str(it.outlet, 200), date: str(it.date, 40) || null, since });
      return;
    }
    if (meta.duration_s > 0 && meta.duration_s <= SHORT_MAX_S) return;
    const { rowCount } = await pool.query(
      `INSERT INTO videos (youtube_id, title, channel, published_at, thumbnail_url, lang, source, sync_status, sync_next_at, channel_id, duration_s)
       SELECT $1, $2, $3, $4, $5, 'fr', 'supadata', 'pending', now(), $6, $7
       WHERE NOT EXISTS (SELECT 1 FROM excluded_videos WHERE youtube_id = $1)
       ON CONFLICT (youtube_id) DO NOTHING`,
      [ytId, String(meta.title || str(it.title, 300) || ytId).slice(0, 300), String(meta.channel || str(it.outlet, 200)).slice(0, 200), meta.published_at ?? (/^\d{4}-\d{2}-\d{2}/.test(str(it.date, 40)) ? str(it.date, 10) : null),
        meta.thumbnail_url ?? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`, meta.channel_id ?? null, meta.duration_s || null],
    );
    added += rowCount;
  }
  for (const r of retry) await consider(r.yt, r, r.since);
  // Newest first; an unfinished backlog (first run, long outage) resumes from the saved cursor on later passes
  const backlog = await getSetting('play_cursor', null);
  let cursor;
  let resume = backlog;
  let fromBacklog = false;
  for (let page = 0; page < cfg.maxPages; page++) {
    const data = await trpc(cfg.base, 'interventions.list', cursor ? { status: 'past', cursor } : { status: 'past' });
    const items = Array.isArray(data.items) ? data.items : [];
    const fresh = items.filter((it) => typeof it?.id === 'string' && !seen.has(it.id));
    for (const it of fresh) {
      scanned++;
      let ytId = youtubeIdOf(it.thumbnailUrl);
      // Press articles about a TV show have no video: only video-like kinds are worth a detail request
      if (!ytId && ['tv', 'radio', 'stream', 'video', 'podcast'].includes(it.kind)) {
        const detail = await trpc(cfg.base, 'interventions.byId', { id: it.id });
        ytId = detail?.media?.provider === 'youtube' ? youtubeIdOf(detail.media.embedUrl) : youtubeIdOf(detail?.url);
      }
      newlySeen.push(it.id);
      if (!ytId) continue;
      found++;
      await consider(ytId, it, new Date().toISOString());
    }
    if (!data.nextCursor) {
      resume = null;
      break;
    }
    if (!fresh.length) {
      if (fromBacklog || !backlog) {
        if (fromBacklog) resume = null;
        break;
      }
      cursor = backlog; // caught up with the newest items: continue the older backlog, with its own page budget
      fromBacklog = true;
      page = -1;
      continue;
    }
    cursor = data.nextCursor;
    if (page === cfg.maxPages - 1) resume = data.nextCursor;
  }
  await setSetting('play_seen', [...newlySeen, ...seen].slice(0, SEEN_MAX));
  await setSetting('play_retry', later.slice(0, 200));
  await setSetting('play_cursor', resume);
  return { scanned, found, added };
}

let running = null;
export async function runPlayImport(deps = {}) {
  if (running) return running;
  running = (async () => {
    const at = new Date().toISOString();
    try {
      const r = await importFromPlay(deps);
      await setSetting('play_last_run', { at, ok: true, ...r });
      return r;
    } catch (e) {
      await setSetting('play_last_run', { at, ok: false, error: String(e.message).slice(0, 300) }).catch(() => {});
      throw e;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function startPlayImport() {
  const cfg = playConfig();
  if (!cfg.enabled) return;
  const tick = () => runPlayImport().catch((e) => console.error(`Lisnard Play : ${e.message}`));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, cfg.refreshMinutes * 60_000).unref();
}
