/**
 * Récupération (Supadata) et import manuel (SRT / VTT / texte horodaté) de transcriptions.
 * Un segment = { start_ms, duration_ms, text }.
 */
import { recordUsage } from './usage.js';

// mode=native : on ne récupère que les sous-titres existants (1 crédit). Le mode par défaut
// (« auto ») générerait une transcription par IA, bien plus chère, pour les vidéos sans sous-titres.
const SUPADATA_URL = 'https://api.supadata.ai/v1/transcript';

/** code : 'unavailable' (pas de sous-titres) | 'quota' | 'auth' | 'config' | 'upstream' */
export class TranscriptError extends Error {
  constructor(message, status = 502, code = 'upstream') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function supadataConfigured() {
  return Boolean(process.env.SUPADATA_API_KEY);
}

export async function fetchTranscript(youtubeId, lang = 'fr') {
  const key = process.env.SUPADATA_API_KEY;
  if (!key) throw new TranscriptError("SUPADATA_API_KEY n'est pas configurée.", 503, 'config');

  const url = new URL(SUPADATA_URL);
  url.searchParams.set('url', `https://www.youtube.com/watch?v=${youtubeId}`);
  url.searchParams.set('mode', 'native');
  url.searchParams.set('text', 'false');
  if (lang) url.searchParams.set('lang', lang);

  let res;
  try {
    res = await fetch(url, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(90_000) });
  } catch (e) {
    throw new TranscriptError(`Supadata injoignable : ${e.message}`);
  }
  // Supadata bills in credits: count the call, no dollar amount
  await recordUsage({ feature: 'transcriptions_youtube', provider: 'supadata', model: 'youtube', error: !res.ok || res.status === 206 });
  const body = await res.json().catch(() => ({}));
  const detail = body.message || body.details || body.error || res.statusText;
  // Supadata répond 206 « transcript-unavailable » (et facture 1 crédit) quand il n'y a pas de sous-titres.
  if (res.status === 206 || body.error === 'transcript-unavailable') {
    throw new TranscriptError('Pas de sous-titres disponibles pour cette vidéo.', 404, 'unavailable');
  }
  if (res.status === 202) throw new TranscriptError('Réponse Supadata asynchrone inattendue.', 502, 'upstream');
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new TranscriptError(`Clé Supadata refusée (${detail}).`, 502, 'auth');
    if (res.status === 402 || res.status === 429) throw new TranscriptError(`Quota ou crédits Supadata épuisés (${detail}).`, 429, 'quota');
    if (res.status === 404) throw new TranscriptError(`Vidéo introuvable ou privée (${detail}).`, 404, 'unavailable');
    throw new TranscriptError(`Supadata a répondu ${res.status} : ${detail}`, 502, 'upstream');
  }
  if (!Array.isArray(body.content)) {
    throw new TranscriptError('Réponse Supadata inattendue (pas de segments).', 502, 'upstream');
  }
  const segments = body.content
    .map((c) => ({
      start_ms: Math.max(0, Math.round(Number(c.offset) || 0)),
      duration_ms: c.duration != null ? Math.max(0, Math.round(Number(c.duration))) : null,
      text: cleanText(c.text),
    }))
    .filter((s) => s.text);
  if (!segments.length) throw new TranscriptError('Transcription vide.', 404, 'unavailable');
  return { segments, lang: body.lang ?? lang };
}

function cleanText(t) {
  return String(t ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "01:02:03,500" | "1:02" | "62.5" -> millisecondes (null si illisible). */
export function parseTimestamp(str) {
  const m = String(str).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) {
    const s = String(str).trim().match(/^(\d+)(?:[.,](\d{1,3}))?$/);
    if (!s) return null;
    return Number(s[1]) * 1000 + Number((s[2] ?? '0').padEnd(3, '0'));
  }
  const [, h = '0', mi, se, ms = '0'] = m;
  return ((Number(h) * 60 + Number(mi)) * 60 + Number(se)) * 1000 + Number(ms.padEnd(3, '0'));
}

export function formatTimestamp(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const CUE_RE = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}|\d{1,2}:\d{2}(?::\d{2})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]?\d{0,3})/;

function parseCues(raw) {
  const blocks = raw.replace(/\r/g, '').split(/\n{2,}/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    const i = lines.findIndex((l) => CUE_RE.test(l));
    if (i === -1) continue;
    const [, a, b] = lines[i].match(CUE_RE);
    const start = parseTimestamp(a);
    const end = parseTimestamp(b);
    const text = cleanText(lines.slice(i + 1).join(' '));
    if (start == null || !text) continue;
    segments.push({ start_ms: start, duration_ms: end != null ? Math.max(0, end - start) : null, text });
  }
  // Les VTT "auto-générés" répètent chaque ligne : on retire les doublons consécutifs.
  return segments.filter((s, i) => i === 0 || s.text !== segments[i - 1].text);
}

const LINE_TS_RE = /^\s*[[(]?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\])]?\s*[-–—:]?\s*(.*)$/;

/**
 * Formats acceptés :
 *  - SRT / VTT
 *  - lignes horodatées : "[00:12] texte", "1:02:03 texte"
 *  - texte brut (un segment par paragraphe/ligne, horodatage à 0)
 */
export function parseTranscriptText(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '');
  if (!text.trim()) return [];
  if (CUE_RE.test(text)) return parseCues(text);

  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const stamped = lines.filter((l) => LINE_TS_RE.test(l) && LINE_TS_RE.exec(l)[2]);
  if (stamped.length >= Math.max(2, lines.length * 0.5)) {
    const out = [];
    for (const line of lines) {
      const m = line.match(LINE_TS_RE);
      const ts = m ? parseTimestamp(m[1]) : null;
      if (m && ts != null && m[2]) out.push({ start_ms: ts, duration_ms: null, text: cleanText(m[2]) });
      else if (out.length) out[out.length - 1].text = cleanText(`${out[out.length - 1].text} ${line}`);
    }
    return out;
  }
  return lines.map((l) => ({ start_ms: 0, duration_ms: null, text: cleanText(l) })).filter((s) => s.text);
}
