// Micro-relecture d'une transcription : orthographe, ponctuation, noms propres et disfluences, sans jamais reformuler.
import { completeWithOpenRouter, llmConfigured } from '../openrouter.js';
import { normalize } from '../normalize.js';
import { KEYTERMS } from './stt.js';

export const PROOFREAD_MODEL = 'anthropic/claude-haiku-5.5';
const BATCH = 80;

// Pure hesitations: removed everywhere. "bah"/"ben" only as an interjection (start of line or before a comma)
const FILLER = /^(e+u+h+|h+e+u+h*|u+h+m*|h+u+m+|h*m+h+|m{2,}|h+m+)$/i;
const FILLER_RE = /(^|[\s(«"'])(?:e+u+h+|h+e+u+h*|u+h+m*|h+u+m+|h*m+h+|m{2,}|h+m+)(?:\s*[,.…]+(?=\s|$))?(?=$|[\s,;:!?)»"'])/giu;
const INTERJECTION_RE = /(^|[.!?…]\s+|,\s*)(?:bah|ben|beh)\s*,\s*/giu;
// Legitimate doubled words in French ("nous nous sommes", "vous vous")
const DOUBLE_OK = new Set(['nous', 'vous', 'que', 'si']);

/** Retire les hésitations et les mots bégayés d'une ligne, sans toucher au reste. */
export function stripFillers(text) {
  let s = String(text ?? '');
  s = s.replace(FILLER_RE, '$1').replace(/^[\s,;:]+/, '').replace(INTERJECTION_RE, '$1');
  // "Ah bah, …" keeps the "ah"; "Bah moi, …" at the start of a sentence loses the "bah", comma or not
  s = s.replace(/(^|\s)(ah)\s+bah(?![\p{L}])/giu, '$1$2').replace(/(^|[.!?…]\s+)bah(?![\p{L}]),?\s*/giu, '$1');
  // "c'est, c'est, c'est insupportable" -> "c'est insupportable" ("nous, nous" is emphasis: kept)
  s = s.replace(/(^|\s)([\p{L}'’-]+)(?:,\s*\2(?![\p{L}'’-]))+/giu, (m, pre, w) => (DOUBLE_OK.has(w.toLowerCase()) ? m : `${pre}${w}`));
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

// Spelled-out numbers count as the same word as their digits ("30" = "trente")
const NUMBERS = { zero: '0', un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5', six: '6', sept: '7', huit: '8', neuf: '9', dix: '10', onze: '11', douze: '12', treize: '13', quatorze: '14', quinze: '15', seize: '16', vingt: '20', trente: '30', quarante: '40', cinquante: '50', soixante: '60', cent: '100', mille: '1000' };
const words = (t) => normalize(t).split(' ').filter((w) => w && !FILLER.test(w)).map((w) => NUMBERS[w] ?? w);

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
 * La correction garde-t-elle les mots prononcés ? Hésitations et bégaiements mis à part, les mêmes mots dans le même ordre ;
 * seul un mot très proche (orthographe, mot mal entendu) peut changer. Un nom du contexte (`terms` : titre, description,
 * noms connus) peut en plus remplacer 1 à 3 mots qui s'en prononcent pareil (« Day Live » → « DLIVE », « Tailleux » → « Retailleau »).
 * Aucun mot ajouté ou retiré, et un nombre ne change jamais.
 */
export function faithful(orig, fixed, terms = []) {
  const a = words(stripFillers(orig));
  const b = words(fixed);
  const known = new Set(terms.flatMap((t) => words(t)));
  const hasDigit = (x) => /\d/.test(x);
  const near = (x, y, loose = false) => !hasDigit(x + y) && lev(x, y) <= Math.max(1, Math.floor(Math.max(x.length, y.length) / (loose ? 2 : 3)));
  // reach[i][j]: the first i words of `a` line up with the first j words of `b`
  const reach = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(false));
  reach[0][0] = true;
  for (let i = 0; i <= a.length; i++) {
    for (let j = 0; j <= b.length; j++) {
      if (!reach[i][j]) continue;
      if (i < a.length && j < b.length && (a[i] === b[j] || near(a[i], b[j], known.has(b[j])))) reach[i + 1][j + 1] = true;
      for (let k = 2; k <= 3; k++) {
        // several heard words -> one context name, or one heard word -> a context name in several words
        if (j < b.length && i + k <= a.length && known.has(b[j]) && near(a.slice(i, i + k).join(''), b[j], true)) reach[i + k][j + 1] = true;
        if (i < a.length && j + k <= b.length && b.slice(j, j + k).every((w) => known.has(w)) && near(a[i], b.slice(j, j + k).join(''), true)) reach[i + 1][j + k] = true;
      }
    }
  }
  return reach[a.length][b.length];
}

const systemPrompt = (terms, context) => `Tu relis la transcription automatique d'une interview en français, ligne par ligne. Le texte doit rester fidèle MOT POUR MOT à ce qui a été dit : c'est une citation.

Tu as le droit UNIQUEMENT de :
- corriger l'orthographe, les accords, les accents, les majuscules et la ponctuation ;
- corriger l'écriture des noms propres, en particulier : ${terms.join(', ')} ;
- retirer les hésitations (euh, heu, hum, mmh, « bah, » ou « ben, » en interjection) et les mots répétés par bégaiement (« le le » → « le »).

Tu n'as JAMAIS le droit de reformuler, résumer, compléter, remplacer un mot par un synonyme, changer l'ordre des mots, fusionner ou couper des lignes, ni déplacer du texte d'une ligne à une autre. En cas de doute, ne change rien.

Le titre et la description de la vidéo te donnent le contexte : nom de l'émission, invités, sujets. Sers-t'en pour écrire correctement les noms que la transcription a mal entendus (par exemple un nom d'émission découpé en deux mots), jamais pour ajouter du texte.
${context}
Réponds uniquement en JSON : {"fix":[{"i":<numéro de ligne>,"text":"<ligne corrigée>"}]}, en ne listant QUE les lignes que tu modifies.`;

const contextBlock = ({ title, description } = {}) =>
  [title ? `\nTitre de la vidéo : ${String(title).slice(0, 200)}` : '', description ? `Description de la vidéo :\n${String(description).slice(0, 1500)}` : ''].filter(Boolean).join('\n');

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
export async function proofreadLines(lines, { complete = completeWithOpenRouter, model = PROOFREAD_MODEL, terms = KEYTERMS, context = {}, videoId = null } = {}) {
  const system = systemPrompt(terms, contextBlock(context));
  const out = lines.map((l) => ({ ...l, text: stripFillers(l.text) }));
  const stats = { changed: 0, rejected: 0, failedBatches: 0, batches: 0 };
  if (complete === completeWithOpenRouter && !llmConfigured()) return { lines: out, ...stats, failedBatches: Math.ceil(lines.length / BATCH), batches: Math.ceil(lines.length / BATCH) };
  for (let from = 0; from < lines.length; from += BATCH) {
    stats.batches++;
    const batch = lines.slice(from, from + BATCH);
    let fixes;
    try {
      const raw = await complete(
        { model, system, user: batch.map((l, k) => `[${k + 1}] ${l.text}`).join('\n'), maxTokens: 6000, feature: 'retranscription_relecture', videoId },
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
      if (!fixed || !faithful(orig, fixed, terms)) {
        stats.rejected++;
        continue;
      }
      if (fixed !== out[from + k].text) stats.changed++;
      out[from + k].text = fixed;
    }
  }
  return { lines: out.filter((l) => l.text), ...stats };
}
