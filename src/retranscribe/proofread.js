// Micro-relecture d'une transcription : orthographe, ponctuation, noms propres et disfluences, sans jamais reformuler.
import { completeWithOpenRouter, llmConfigured } from '../openrouter.js';
import { normalize } from '../normalize.js';
import { KEYTERMS } from './stt.js';

export const PROOFREAD_MODEL = 'anthropic/claude-haiku-5.5';
const BATCH = 80;

// Pure hesitations: removed everywhere. "bah"/"ben" only as an interjection (start of line or before a comma)
const FILLER = /^(e+u+h+|h+e+u+h*|u+h+m*|h+u+m+|h*m+h+|m{2,}|h+m+|e+h+)$/i;
const FILLER_RE = /(^|[\s(«"'])(?:e+u+h+|h+e+u+h*|u+h+m*|h+u+m+|h*m+h+|m{2,}|h+m+|e+h+)(?:\s*[,.…]+(?=\s|$))?(?=$|[\s,;:!?)»"'])/giu;
const INTERJECTION_RE = /(^|[.!?…]\s+|,\s*)(?:bah|ben|beh)\s*,\s*/giu;
// Legitimate doubled words in French ("nous nous sommes", "vous vous")
const DOUBLE_OK = new Set(['nous', 'vous', 'que', 'si']);

/** Retire les hésitations et les mots bégayés d'une ligne, sans toucher au reste. */
export function stripFillers(text) {
  let s = String(text ?? '');
  s = s.replace(FILLER_RE, '$1').replace(/^[\s,;:]+/, '').replace(INTERJECTION_RE, '$1');
  // "le le", "je je je" -> one word (case-insensitive, punctuation-free repeats only)
  s = s.replace(/(^|\s)([\p{L}'’-]+)(?:\s+\2)+(?=[\s,.;:!?…]|$)/giu, (m, pre, w) => (DOUBLE_OK.has(w.toLowerCase()) ? m : `${pre}${w}`));
  s = s
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])(\s*[,;:])+/g, '$1')
    .replace(/^[\s,;:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s; // never recase: a line is often the middle of a sentence
}

const words = (t) => normalize(t).split(' ').filter((w) => w && !FILLER.test(w));

function lev(a, b) {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * La correction garde-t-elle les mots prononcés ? Hésitations et bégaiements mis à part, les deux lignes doivent avoir les mêmes mots
 * dans le même ordre ; seul un mot très proche (orthographe, mot mal entendu) peut être remplacé. Aucun mot ajouté, retiré ou changé.
 */
export function faithful(orig, fixed) {
  const a = words(stripFillers(orig));
  const b = words(fixed);
  if (a.length !== b.length) return false;
  const near = (x, y) => lev(x, y) <= Math.max(1, Math.floor(Math.max(x.length, y.length) / 3));
  return a.every((w, i) => w === b[i] || near(w, b[i]));
}

const SYSTEM = `Tu relis la transcription automatique d'une interview en français, ligne par ligne. Le texte doit rester fidèle MOT POUR MOT à ce qui a été dit : c'est une citation.

Tu as le droit UNIQUEMENT de :
- corriger l'orthographe, les accords, les accents, les majuscules et la ponctuation ;
- corriger l'écriture des noms propres, en particulier : ${KEYTERMS.join(', ')} ;
- retirer les hésitations (euh, heu, hum, mmh, « bah, » ou « ben, » en interjection) et les mots répétés par bégaiement (« le le » → « le »).

Tu n'as JAMAIS le droit de reformuler, résumer, compléter, remplacer un mot par un synonyme, changer l'ordre des mots, fusionner ou couper des lignes, ni déplacer du texte d'une ligne à une autre. En cas de doute, ne change rien.

Réponds uniquement en JSON : {"fix":[{"i":<numéro de ligne>,"text":"<ligne corrigée>"}]}, en ne listant QUE les lignes que tu modifies.`;

function parseFixes(raw) {
  const s = String(raw).replace(/```(?:json)?/g, '');
  const json = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
  return Array.isArray(json.fix) ? json.fix : [];
}

/**
 * Relit des lignes { start_ms, duration_ms, text } par lots. Chaque correction passe par le garde-fou `faithful` ;
 * une correction refusée, ou un lot que le modèle n'a pas pu relire, garde le texte d'origine, seulement débarrassé des hésitations.
 * Renvoie { lines, changed, rejected, failedBatches, batches }.
 */
export async function proofreadLines(lines, { complete = completeWithOpenRouter, model = PROOFREAD_MODEL } = {}) {
  const out = lines.map((l) => ({ ...l, text: stripFillers(l.text) }));
  const stats = { changed: 0, rejected: 0, failedBatches: 0, batches: 0 };
  if (complete === completeWithOpenRouter && !llmConfigured()) return { lines: out, ...stats, failedBatches: Math.ceil(lines.length / BATCH), batches: Math.ceil(lines.length / BATCH) };
  for (let from = 0; from < lines.length; from += BATCH) {
    stats.batches++;
    const batch = lines.slice(from, from + BATCH);
    let fixes;
    try {
      const raw = await complete(
        { model, system: SYSTEM, user: batch.map((l, k) => `[${k + 1}] ${l.text}`).join('\n'), maxTokens: 6000, feature: 'retranscription_relecture' },
        { maxAttempts: 2, timeoutMs: 120_000 },
      );
      fixes = parseFixes(raw);
    } catch (e) {
      console.error(`Relecture de la transcription (lignes ${from + 1}-${from + batch.length}) : ${e.message}`);
      stats.failedBatches++;
      continue;
    }
    for (const f of fixes) {
      const k = Number(f?.i) - 1;
      if (!Number.isInteger(k) || k < 0 || k >= batch.length || typeof f.text !== 'string') continue;
      const orig = batch[k].text;
      const fixed = stripFillers(f.text);
      if (!fixed || !faithful(orig, fixed)) {
        stats.rejected++;
        continue;
      }
      if (fixed !== out[from + k].text) stats.changed++;
      out[from + k].text = fixed;
    }
  }
  return { lines: out.filter((l) => l.text), ...stats };
}
