// Suivi des appels aux API payantes (OpenRouter, Apify, Supadata…) : une ligne par jour, tâche, fournisseur et modèle.
import { pool } from './db.js';

/** Libellés des tâches, pour l'admin. */
export const FEATURES = {
  extraits: 'Extraits proposés',
  resumes: 'Résumés',
  traduction: 'Traduction',
  titres_play: 'Titres des citations Play',
  retranscription_stt: 'Retranscription (écoute)',
  retranscription_relecture: 'Retranscription (relecture)',
  mur: 'Le mur (Apify)',
  transcriptions_youtube: 'Transcriptions YouTube (Supadata)',
  images: 'Images libres de droits',
  autre: 'Autre',
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Ajoute un appel au compteur du jour. Ne lève jamais : un souci de comptage ne doit pas casser l'appel d'origine.
 * `cost` : coût réel en dollars quand le fournisseur le donne (null sinon : l'appel est compté sans montant).
 */
export async function recordUsage({ feature = 'autre', provider, model = '', calls = 1, error = false, inputTokens = 0, outputTokens = 0, audioSeconds = 0, cost = null }) {
  if (!process.env.DATABASE_URL) return; // unit tests without a database
  try {
    await pool.query(
      `INSERT INTO api_usage (day, feature, provider, model, calls, errors, input_tokens, output_tokens, audio_seconds, cost_usd, priced_calls)
       VALUES (CURRENT_DATE, $1, $2, $3, $10, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (day, feature, provider, model) DO UPDATE SET
         calls = api_usage.calls + EXCLUDED.calls, errors = api_usage.errors + EXCLUDED.errors,
         input_tokens = api_usage.input_tokens + EXCLUDED.input_tokens, output_tokens = api_usage.output_tokens + EXCLUDED.output_tokens,
         audio_seconds = api_usage.audio_seconds + EXCLUDED.audio_seconds, cost_usd = api_usage.cost_usd + EXCLUDED.cost_usd,
         priced_calls = api_usage.priced_calls + EXCLUDED.priced_calls`,
      [String(feature).slice(0, 40), String(provider).slice(0, 40), String(model ?? '').slice(0, 120), error ? 1 : 0, Math.round(num(inputTokens)), Math.round(num(outputTokens)), num(audioSeconds), num(cost), cost == null ? 0 : 1, calls],
    );
  } catch (e) {
    console.error('Suivi des coûts API :', e.message);
  }
}

/** Usage OpenRouter (chat ou transcription) → champs de recordUsage. */
export const fromOpenRouter = (usage = {}) => ({
  inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
  outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
  audioSeconds: usage.seconds ?? 0,
  cost: Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : null,
});

const isoDay = (d) => d.toISOString().slice(0, 10);

/** Résumé pour l'admin : totaux par période, détail tâche × modèle sur [from, to], et coût par jour sur 30 jours. */
export async function usageReport({ from, to } = {}) {
  // The database's date, not Node's: rows are dated with CURRENT_DATE
  const { rows: [d] } = await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
  const today = d.today;
  const valid = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) ? s : null);
  const monthStart = `${today.slice(0, 7)}-01`;
  const range = { from: valid(from) ?? monthStart, to: valid(to) ?? today };
  const prev = new Date(`${monthStart}T00:00:00Z`);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const prevStart = isoDay(prev);
  const { rows: [t] } = await pool.query(
    `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE day = $1::date), 0) AS today,
            COALESCE(SUM(cost_usd) FILTER (WHERE day > $1::date - 7), 0) AS last7,
            COALESCE(SUM(cost_usd) FILTER (WHERE day >= $2::date), 0) AS month,
            COALESCE(SUM(cost_usd) FILTER (WHERE day >= $3::date AND day < $2::date), 0) AS prev_month
     FROM api_usage WHERE day >= $3::date`,
    [today, monthStart, prevStart],
  );
  const { rows } = await pool.query(
    `SELECT feature, provider, model, SUM(calls)::int AS calls, SUM(errors)::int AS errors, SUM(input_tokens)::bigint AS input_tokens,
            SUM(output_tokens)::bigint AS output_tokens, SUM(audio_seconds)::float AS audio_seconds, SUM(cost_usd)::float AS cost_usd,
            SUM(priced_calls)::int AS priced_calls
     FROM api_usage WHERE day BETWEEN $1 AND $2 GROUP BY feature, provider, model ORDER BY SUM(cost_usd) DESC, SUM(calls) DESC`,
    [range.from, range.to],
  );
  const { rows: days } = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, SUM(cost_usd)::float AS cost_usd, SUM(calls)::int AS calls
     FROM api_usage WHERE day > $1::date - 30 GROUP BY day ORDER BY day`,
    [today],
  );
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  return {
    range,
    totals: { today: Number(t.today), last7: Number(t.last7), month: Number(t.month), prev_month: Number(t.prev_month) },
    rows: rows.map((r) => ({
      ...r,
      label: FEATURES[r.feature] ?? r.feature,
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      share: total > 0 ? r.cost_usd / total : 0,
      unpriced: Math.max(0, r.calls - r.priced_calls), // calls without a cost from the provider (credits, free APIs)
    })),
    total,
    days,
  };
}
