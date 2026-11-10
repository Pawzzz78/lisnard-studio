// Transcription d'un morceau d'audio par Grok STT via OpenRouter, et regroupement des mots horodatés en lignes de sous-titres.
import { LlmError } from '../openrouter.js';
import { fromOpenRouter, recordUsage } from '../usage.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions';
export const STT_MODEL = 'x-ai/grok-stt-1.0';
// Proper nouns the model should spell right (same list as tools/transcribe.py)
export const KEYTERMS = ['David Lisnard', 'Lisnard', 'Cannes', 'Nouvelle Énergie', 'Association des maires de France', 'AMF'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Transcrit un mp3 (Buffer). Renvoie { text, words: [{ word, start, end }] (secondes), segments, durationS }.
 * Réessaie sur 429 / 5xx ; sur 400, une fois sans les options facultatives (mots, termes clés) que le fournisseur peut refuser.
 */
export async function transcribeChunk(buf, { lang = 'fr', keyterms = KEYTERMS, model = STT_MODEL } = {}, { fetchImpl = fetch, retryDelayMs = 2000, timeoutMs = 120_000, maxAttempts = 3 } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new LlmError("OPENROUTER_API_KEY n'est pas configurée.", 'config');
  let lean = false;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt) await sleep(retryDelayMs * 2 ** (attempt - 1));
    const body = {
      model,
      input_audio: { data: buf.toString('base64'), format: 'mp3' },
      language: lang,
      response_format: 'verbose_json',
      ...(lean ? {} : { timestamp_granularities: ['word', 'segment'], keyterms }),
    };
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Studio Lisnard' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastError = new LlmError(`OpenRouter injoignable : ${e.message}`);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (json.usage) await recordUsage({ feature: 'retranscription_stt', provider: 'openrouter', model, ...fromOpenRouter(json.usage) });
    const apiError = json.error ?? (res.ok ? null : { message: res.statusText });
    if (apiError) {
      const detail = apiError.message ?? JSON.stringify(apiError);
      const status = res.ok ? Number(apiError.code) || 502 : res.status;
      if (status === 401 || status === 403) throw new LlmError(`Clé OpenRouter refusée (${detail}).`, 'auth');
      if (status === 402) throw new LlmError(`Crédits OpenRouter insuffisants (${detail}).`, 'quota');
      if (status === 400 && !lean) {
        lean = true;
        attempt--; // same attempt, without the optional fields
        continue;
      }
      if (status === 400 || status === 404 || status === 413) throw new LlmError(`Transcription refusée (${detail}).`, 'config');
      lastError = new LlmError(`Transcription : ${detail}`, status === 429 ? 'quota' : 'upstream');
      continue;
    }
    return {
      text: String(json.text ?? ''),
      words: (Array.isArray(json.words) ? json.words : []).filter((w) => w && w.type !== 'audio_event' && String(w.word ?? '').trim() && Number.isFinite(Number(w.start))),
      segments: Array.isArray(json.segments) ? json.segments : [],
      durationS: Number(json.duration ?? json.usage?.seconds) || null,
    };
  }
  await recordUsage({ feature: 'retranscription_stt', provider: 'openrouter', model, error: true, calls: 0 });
  throw lastError ?? new LlmError('Transcription impossible.');
}

export const LINE = { maxWords: 14, maxMs: 7000, pauseMs: 700 };

/**
 * Mots horodatés (secondes, relatifs au morceau) → lignes { start_ms, duration_ms, text } en temps de la vidéo.
 * Nouvelle ligne après une fin de phrase, une pause, ou quand la ligne devient trop longue.
 */
export function wordsToLines(words, offsetMs = 0, { maxWords = LINE.maxWords, maxMs = LINE.maxMs, pauseMs = LINE.pauseMs } = {}) {
  const lines = [];
  let cur = null;
  const flush = () => {
    if (cur?.words.length) lines.push({ start_ms: cur.start, duration_ms: Math.max(200, cur.end - cur.start), text: cur.words.join(' ').replace(/\s+([,.?!…;:])/g, '$1').trim() });
    cur = null;
  };
  for (const w of words) {
    const start = offsetMs + Math.round(Number(w.start) * 1000);
    const end = offsetMs + Math.round(Number(w.end ?? w.start) * 1000);
    const word = String(w.word).trim();
    if (cur && (start - cur.end > pauseMs || cur.words.length >= maxWords || end - cur.start > maxMs)) flush();
    if (!cur) cur = { start, end, words: [] };
    cur.words.push(word);
    cur.end = Math.max(cur.end, end);
    if (/[.?!…]["»)]?$/.test(word)) flush();
  }
  flush();
  return lines;
}

/** Repli sans mots horodatés : les segments du fournisseur (secondes) → lignes. */
export function segmentsToLines(segments, offsetMs = 0) {
  return segments
    .filter((s) => String(s?.text ?? '').trim() && Number.isFinite(Number(s.start)))
    .map((s) => ({
      start_ms: offsetMs + Math.round(Number(s.start) * 1000),
      duration_ms: Math.max(200, Math.round((Number(s.end ?? s.start) - Number(s.start)) * 1000)),
      text: String(s.text).replace(/\s+/g, ' ').trim(),
    }));
}
