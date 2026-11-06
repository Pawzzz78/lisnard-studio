/**
 * Client minimal de l'API Apify (https://docs.apify.com/api/v2) pour lancer un « acteur » et lire son résultat.
 *
 *   POST /v2/acts/{acteur}/runs                       lance l'exécution avec l'entrée JSON (réponse : run.id, run.defaultDatasetId)
 *   GET  /v2/actor-runs/{id}?waitForFinish=60         attend (jusqu'à 60 s par appel) que l'exécution se termine
 *   GET  /v2/datasets/{id}/items?clean=true           lit les résultats (par pages)
 *
 * Le jeton (APIFY_TOKEN) est envoyé dans l'en-tête Authorization, jamais dans l'adresse.
 */
export class ApifyError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Message clair pour une réponse d'erreur d'Apify. */
async function failure(res, what) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? '';
  } catch {
    /* corps vide ou illisible */
  }
  if (res.status === 401) return new ApifyError('Jeton Apify refusé : vérifie APIFY_TOKEN.');
  if (res.status === 402) return new ApifyError('Crédit Apify épuisé (ou limite de dépense atteinte) : vérifie ton compte Apify.');
  if (res.status === 403) return new ApifyError(`Apify refuse l’accès (${what})${detail ? ` : ${detail}` : ''}. Vérifie le jeton et les droits sur l’acteur.`);
  if (res.status === 404) return new ApifyError(`${what} introuvable chez Apify${detail ? ` (${detail})` : ''} : vérifie le nom de l’acteur.`);
  if (res.status === 400) return new ApifyError(`Apify a refusé les paramètres${detail ? ` : ${detail}` : ''}.`);
  if (res.status === 429) return new ApifyError('Apify limite le nombre d’appels : réessaie dans quelques minutes.');
  return new ApifyError(`Apify a répondu par une erreur ${res.status}${detail ? ` : ${detail}` : ''}.`);
}

/**
 * Lance `actor` avec `input`, attend la fin (au plus `maxWaitMs`) et renvoie { items, run } : les éléments du jeu de données et
 * l'exécution (statut, coût en dollars dans `run.usageTotalUsd`).
 */
export async function runActor({ token, actor, input, baseUrl = 'https://api.apify.com', maxItems = 1000, maxWaitMs = 12 * 60_000, fetchImpl = fetch }) {
  if (!token) throw new ApifyError('APIFY_TOKEN manquant : ajoute le jeton Apify aux variables du serveur.', 503);
  const api = `${baseUrl.replace(/\/$/, '')}/v2`;
  const headers = { Authorization: `Bearer ${token}` };
  const call = async (url, init, what) => {
    let res;
    try {
      res = await fetchImpl(url, { ...init, headers: { ...headers, ...init?.headers }, signal: AbortSignal.timeout(90_000) });
    } catch (e) {
      throw new ApifyError(`Apify ne répond pas (${e.name === 'TimeoutError' ? 'délai dépassé' : e.message}).`);
    }
    if (!res.ok) throw await failure(res, what);
    return res.json().catch(() => {
      throw new ApifyError('Réponse illisible d’Apify.');
    });
  };

  const started = await call(`${api}/acts/${encodeURIComponent(actor.replace('/', '~'))}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, 'L’acteur');
  let run = started.data;
  if (!run?.id) throw new ApifyError('Réponse inattendue d’Apify : pas d’identifiant d’exécution.');
  const t0 = Date.now();
  while (['READY', 'RUNNING', 'ABORTING', 'TIMING-OUT'].includes(run.status)) {
    if (Date.now() - t0 > maxWaitMs) throw new ApifyError('L’acteur Apify est trop long : l’exécution continue chez Apify, réessaie plus tard.');
    const polled = await call(`${api}/actor-runs/${encodeURIComponent(run.id)}?waitForFinish=${process.env.APIFY_WAIT_SECONDS ?? 60}`, {}, 'L’exécution');
    run = polled.data ?? run;
    if (['READY', 'RUNNING'].includes(run.status) && process.env.APIFY_POLL_MS) await sleep(Number(process.env.APIFY_POLL_MS)); // tests : pas d'attente longue
  }
  if (run.status !== 'SUCCEEDED') throw new ApifyError(`L’exécution Apify a échoué (${run.status}${run.statusMessage ? ` : ${run.statusMessage}` : ''}).`);

  const items = [];
  const page = 500;
  for (let offset = 0; offset < maxItems; offset += page) {
    const rows = await call(`${api}/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&format=json&offset=${offset}&limit=${Math.min(page, maxItems - offset)}`, {}, 'Le jeu de résultats');
    if (!Array.isArray(rows)) throw new ApifyError('Résultats inattendus d’Apify.');
    items.push(...rows);
    if (rows.length < Math.min(page, maxItems - offset)) break;
  }
  return { items, run };
}
