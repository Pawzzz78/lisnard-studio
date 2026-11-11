/**
 * Client minimal pour OpenRouter (API compatible OpenAI) : une seule fonction, sans SDK.
 * Utilisé pour la traduction des transcriptions et la compréhension des questions de recherche.
 */

import { fromOpenRouter, recordUsage } from './usage.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Modèle par défaut : à vérifier sur https://openrouter.ai/models ; se change avec TRANSLATE_MODEL.
export const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';

// Modèle GPT des tâches de rédaction fine (résumés, choix des extraits) : sans raisonnement, suit bien des consignes détaillées,
// JSON fiable, peu cher. Indépendant de TRANSLATE_MODEL, qui peuvent être des modèles « à raisonnement ».
export const GPT_MODEL = 'openai/gpt-4.1-mini';

export const llmConfigured = () => Boolean(process.env.OPENROUTER_API_KEY);

/** code : 'config' | 'auth' | 'quota' | 'upstream' (mêmes valeurs que TranscriptError, pour la synchro) */
export class LlmError extends Error {
  constructor(message, code = 'upstream') {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Texte d'un message : chaîne simple, ou liste de parties (certains fournisseurs). */
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('')
      : '';

/** Explique une réponse vide : le plus souvent un modèle « à raisonnement » à court de budget, ou un filtre de contenu. */
function emptyResponseError(choice, model) {
  const finish = choice?.finish_reason ?? choice?.native_finish_reason ?? 'inconnue';
  if (choice?.message?.refusal || /content_filter|safety|blocked|prohibited/i.test(String(finish))) {
    return new LlmError(`Réponse bloquée par le filtre du modèle « ${model} » (${choice?.message?.refusal ? 'refus' : finish}). Essaie un autre modèle.`);
  }
  if (finish === 'length') {
    return new LlmError(
      `Le modèle « ${model} » a épuisé son budget sans écrire de réponse (finish_reason=length) : typique d'un modèle « à raisonnement ». Choisis un modèle sans raisonnement.`,
      'config',
    );
  }
  return new LlmError(`Réponse vide du modèle « ${model} » (finish_reason=${finish}).`);
}

/**
 * Une requête de complétion vers OpenRouter. Renvoie le texte de la réponse.
 * Réessaie (1 s, 2 s, 4 s, jusqu'à `maxAttempts`) sur 429 et 5xx ; les autres erreurs sont classées pour la synchro.
 * Réponse vide parce que le budget de mots a été épuisé (modèle « à raisonnement ») : un réessai immédiat avec 4× plus
 * de budget et un raisonnement réduit. Réponse vide à cause d'un filtre de contenu : erreur explicite, sans réessai.
 * `feature` : tâche à laquelle le coût est imputé dans le suivi des coûts (voir usage.js).
 */
export async function completeWithOpenRouter(
  { model, system, user, maxTokens = 8000, feature = 'autre', videoId = null },
  { fetchImpl = fetch, retryDelayMs = 1000, timeoutMs = 120_000, maxAttempts = 4 } = {},
) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new LlmError("OPENROUTER_API_KEY n'est pas configurée.", 'config');
  try {
    return await attemptAll();
  } catch (e) {
    await recordUsage({ feature, provider: 'openrouter', model, videoId, error: true, calls: 0 }); // failed task; billed attempts are already counted
    throw e;
  }

  async function attemptAll() {
    const makeBody = (boosted) =>
      JSON.stringify({
        model,
        temperature: 0, // résultat reproductible
        max_tokens: boosted ? Math.min(maxTokens * 4, 32_000) : maxTokens,
        ...(boosted ? { reasoning: { effort: 'low' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });

    let boosted = false;
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt) await sleep(retryDelayMs * 2 ** (attempt - 1));
      let res;
      try {
        res = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Studio Lisnard' },
          body: makeBody(boosted),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        lastError = new LlmError(`OpenRouter injoignable : ${e.message}`);
        continue;
      }
      const json = await res.json().catch(() => ({}));
      // Every answered request is billed, even an empty or failed one
      if (json.usage) await recordUsage({ feature, provider: 'openrouter', model, videoId, ...fromOpenRouter(json.usage) });
      // OpenRouter peut aussi répondre 200 avec un objet `error` quand le fournisseur en amont échoue.
      const apiError = json.error ?? (res.ok ? null : { message: res.statusText });
      if (apiError) {
        const detail = apiError.message ?? JSON.stringify(apiError);
        const status = res.ok ? Number(apiError.code) || 502 : res.status;
        if (status === 401 || status === 403) throw new LlmError(`Clé OpenRouter refusée (${detail}).`, 'auth');
        if (status === 402) throw new LlmError(`Crédits OpenRouter insuffisants (${detail}).`, 'quota');
        if (status === 400 || status === 404) {
          const code = /model/i.test(detail) ? 'config' : 'upstream';
          throw new LlmError(code === 'config' ? `Modèle refusé : vérifie TRANSLATE_MODEL / SUMMARY_MODEL (${detail}).` : `Requête refusée (${detail}).`, code);
        }
        lastError = new LlmError(`OpenRouter : ${detail}`, status === 429 ? 'quota' : 'upstream');
        continue; // 429, 5xx, erreurs en amont : on réessaie
      }
      const choice = json.choices?.[0];
      const text = textOf(choice?.message?.content);
      if (!text.trim()) {
        const err = emptyResponseError(choice, model);
        if (choice?.finish_reason === 'length' && !boosted) {
          boosted = true;
          attempt--; // ce réessai ne compte pas : même tentative, avec plus de budget
          continue;
        }
        if (/filtre/.test(err.message) || choice?.finish_reason === 'length') throw err; // inutile d'insister
        lastError = err;
        continue;
      }
      return text;
    }
    throw lastError ?? new LlmError('Réponse impossible.');
  }
}
