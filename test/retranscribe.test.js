// Retranscription (Grok STT + relecture Haiku) et suivi des coûts API ; la partie base de données demande Postgres
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { planChunks } from '../src/retranscribe/audio.js';
import { faithful, proofreadLines, stripFillers } from '../src/retranscribe/proofread.js';
import { segmentsToLines, transcribeChunk, wordsToLines } from '../src/retranscribe/stt.js';
import { fromOpenRouter } from '../src/usage.js';

const enabled = Boolean(process.env.DATABASE_URL);

test('découpage : morceaux de 8 min au plus, coupés dans la plus longue pause avant la limite', () => {
  assert.deepEqual(planChunks(300, []), [[0, 300]]);
  const c = planChunks(1000, [[470_000, 472_000], [455_000, 455_400]]);
  assert.deepEqual(c.map(([a]) => a), [0, 471, 951]);
  assert.equal(c.at(-1)[1], 1000);
  assert.ok(c.every(([a, b]) => b - a <= 480));
  assert.deepEqual(planChunks(1000, []).map(([a, b]) => [a, b]), [[0, 480], [480, 960], [960, 1000]]);
  assert.deepEqual(planChunks(0, []), []);
});

test('lignes : coupées en fin de phrase, sur une pause ou si trop longues ; horaires décalés du morceau', () => {
  const w = (word, start, end) => ({ word, start, end });
  const lines = wordsToLines([w('Bonjour', 0, 0.4), w('à', 0.5, 0.6), w('tous.', 0.6, 0.9), w('La', 2.0, 2.1), w('France', 2.1, 2.5), w(',', 2.5, 2.5)], 60_000);
  assert.deepEqual(lines.map((l) => l.text), ['Bonjour à tous.', 'La France,']);
  assert.equal(lines[0].start_ms, 60_000);
  assert.equal(lines[1].start_ms, 62_000);
  const long = wordsToLines(Array.from({ length: 30 }, (_, i) => w(`m${i}`, i * 0.3, i * 0.3 + 0.2)));
  assert.ok(long.every((l) => l.text.split(' ').length <= 14));
  assert.deepEqual(segmentsToLines([{ start: 1, end: 3, text: ' Salut  toi ' }, { start: 4, text: '' }], 1000), [{ start_ms: 2000, duration_ms: 2000, text: 'Salut toi' }]);
});

test('hésitations : « euh », « mmh », « bah, » et bégaiements retirés ; « nous nous » gardé ; casse jamais changée', () => {
  assert.equal(stripFillers('euh je pense que, euh, la la France'), 'je pense que, la France');
  assert.equal(stripFillers('Mmh euhhh Ben, voilà.'), 'voilà.');
  assert.equal(stripFillers('Nous nous sommes trompés'), 'Nous nous sommes trompés');
  assert.equal(stripFillers('le euh bénévolat'), 'le bénévolat');
  assert.equal(stripFillers('Ce bénévolat heureux'), 'Ce bénévolat heureux');
});

test('bégaiements avec virgules, « bah » en début de phrase, « ah bah » ; « nous, nous » et « eh bien » gardés', () => {
  assert.equal(stripFillers('Je, je, je crois que je propose'), 'Je crois que je propose');
  assert.equal(stripFillers("c'est, c'est, et tout ce que"), "c'est, et tout ce que");
  assert.equal(stripFillers("Le, le, d'abord, être"), "Le, d'abord, être");
  assert.equal(stripFillers('Bah je sais pas'), 'je sais pas');
  assert.equal(stripFillers('Ah bah, de toute façon'), 'Ah, de toute façon');
  assert.equal(stripFillers('Il a dit bah non.'), 'Il a dit bah non.');
  assert.equal(stripFillers('Le Bahreïn'), 'Le Bahreïn');
  assert.equal(stripFillers('Nous, nous pensons'), 'Nous, nous pensons');
  assert.equal(stripFillers('Eh bien voilà'), 'Eh bien voilà');
});

test('garde-fou : un nombre et le même nombre en lettres sont le même mot', () => {
  assert.ok(faithful('on ne reviendra pas au 30 Glorieux', 'on ne reviendra pas aux Trente Glorieuses'));
  assert.ok(faithful("Et bien à l'époque, l'ERN a condamné", "Eh bien à l'époque, le RN a condamné"));
  assert.ok(!faithful('il y a 30 ans', 'il y a 40 ans'));
  assert.ok(!faithful('dans, dans, dans ma ville', 'ma ville'));
});

test('garde-fou : orthographe et noms propres acceptés ; mot changé, ajouté ou retiré refusé', () => {
  assert.ok(faithful('david lisnar a dit que la france', 'David Lisnard a dit que la France.'));
  assert.ok(faithful('euh je pense que la la France', 'Je pense que la France'));
  assert.ok(!faithful('il faut baisser les impôts', 'Il faut augmenter les impôts'));
  assert.ok(!faithful('je pense que la France va mal', 'Je crois que la France va mal'));
  assert.ok(!faithful('le maire de cannes', 'Le maire de Cannes, bien sûr'));
  assert.ok(!faithful('il ne faut pas', 'Il faut'));
});

test('relecture : corrections fidèles appliquées, reformulation refusée, réponse illisible = texte gardé', async () => {
  const lines = [{ start_ms: 0, duration_ms: 1000, text: 'euh david lisnar est maire' }, { start_ms: 1000, duration_ms: 1000, text: 'il faut baisser les impôts' }];
  let seen;
  const complete = async (args) => ((seen = args), '```json\n{"fix":[{"i":1,"text":"David Lisnard est maire."},{"i":2,"text":"Il faut augmenter les impôts."}]}\n```');
  const r = await proofreadLines(lines, { complete });
  assert.deepEqual(r.lines.map((l) => l.text), ['David Lisnard est maire.', 'il faut baisser les impôts']);
  assert.equal(r.changed, 1);
  assert.equal(r.rejected, 1);
  assert.equal(seen.feature, 'retranscription_relecture');
  assert.match(seen.user, /^\[1\] euh david lisnar est maire\n\[2\]/);
  const broken = await proofreadLines(lines, { complete: async () => 'pas du json' });
  assert.equal(broken.failedBatches, 1);
  assert.deepEqual(broken.lines.map((l) => l.text), ['david lisnar est maire', 'il faut baisser les impôts']);
});

const withKey = async (fn) => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('Grok STT : requête OpenRouter bien formée, clé seulement dans l’en-tête ; sans les options facultatives si refusées (400)', async () => {
  await withKey(async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, auth: init.headers.Authorization, body });
      if (body.keyterms) return json({ error: { message: 'keyterms not supported', code: 400 } }, 400);
      return json({ text: 'Bonjour.', words: [{ word: 'Bonjour.', start: 0.1, end: 0.5 }, { word: '[rires]', start: 0.6, end: 0.9, type: 'audio_event' }], usage: { cost: 0.0001, seconds: 1 } });
    };
    const r = await transcribeChunk(Buffer.from('mp3'), { lang: 'fr' }, { fetchImpl, retryDelayMs: 0 });
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/audio/transcriptions');
    assert.equal(calls[0].auth, 'Bearer sk-or-test');
    assert.ok(!calls[0].url.includes('sk-or'));
    assert.deepEqual([calls[0].body.model, calls[0].body.input_audio.format, calls[0].body.input_audio.data, calls[0].body.language, calls[0].body.response_format], ['x-ai/grok-stt-1.0', 'mp3', Buffer.from('mp3').toString('base64'), 'fr', 'verbose_json']);
    assert.ok(calls[0].body.keyterms.includes('Lisnard'));
    assert.equal(calls[1].body.keyterms, undefined);
    assert.deepEqual(r.words.map((w) => w.word), ['Bonjour.']);
    await assert.rejects(transcribeChunk(Buffer.from('x'), {}, { fetchImpl: async () => json({ error: { message: 'no' } }, 401), retryDelayMs: 0 }), /refusée/);
  });
});

test('coûts : usage OpenRouter (chat et transcription) lu tel quel', () => {
  assert.deepEqual(fromOpenRouter({ prompt_tokens: 10, completion_tokens: 5, cost: 0.002 }), { inputTokens: 10, outputTokens: 5, audioSeconds: 0, cost: 0.002 });
  assert.deepEqual(fromOpenRouter({ input_tokens: 3, output_tokens: 2, seconds: 9.2, cost: 0.0005 }), { inputTokens: 3, outputTokens: 2, audioSeconds: 9.2, cost: 0.0005 });
  assert.equal(fromOpenRouter({}).cost, null);
});

// --- base de données ---

let pool;
let R;
let U;
let db;
const VID = 'RETXtest001';

before(async () => {
  if (!enabled) return;
  db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1', ['RETXtest%']);
  await pool.query("DELETE FROM api_usage WHERE feature LIKE 'test_%'");
  await pool.query("DELETE FROM settings WHERE key = 'retx_settings'");
  R = await import('../src/retranscribe/retranscribe.js');
  U = await import('../src/usage.js');
});

after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id LIKE $1', ['RETXtest%']);
  await pool.query("DELETE FROM api_usage WHERE feature LIKE 'test_%'");
  await pool.query("DELETE FROM settings WHERE key = 'retx_settings'");
  await pool.end();
});

async function makeVideo(ytId, { segments = [['Texte de départ euh.', 0, 2000]], edited = false, publishedAt = '2026-11-01' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO videos (youtube_id, title, published_at, file_name, file_duration_s, file_has_audio, file_size, lang)
     VALUES ($1, $1, $2, $3, 120, TRUE, 1000, 'fr') RETURNING id`,
    [ytId, publishedAt, `${ytId}.mp4`],
  );
  const id = rows[0].id;
  if (segments.length) {
    await db.withTransaction((c) => db.replaceSegments(c, id, segments.map(([text, start_ms, duration_ms]) => ({ text, start_ms, duration_ms })), { edited, source: 'supadata' }));
  }
  return id;
}
const textOf = async (id) => (await pool.query('SELECT string_agg(text, \' | \' ORDER BY position) AS t FROM segments WHERE video_id = $1', [id])).rows[0].t;
const stateOf = async (id) => (await pool.query('SELECT source, edited, retx_status, retx_attempts, retx_error FROM videos WHERE id = $1', [id])).rows[0];
const goodBuild = async () => ({ lines: [{ start_ms: 0, duration_ms: 1500, text: 'Nouveau texte.' }, { start_ms: 1500, duration_ms: 1000, text: 'Bien relu.' }], stats: { chunks: 1, lines: 2, changed: 1, rejected: 0, failedBatches: 0 } });

test('retranscription : texte remplacé, ancien sauvegardé, extraits refaits ; « Restaurer » remet l’ancien à l’identique', { skip: !enabled }, async () => {
  const id = await makeVideo(`${VID}a`);
  const before = await textOf(id);
  let suggested = 0;
  const r = await R.retranscribeVideo(id, { deps: { build: goodBuild, suggest: async () => suggested++ } });
  assert.equal(r.status, 'done');
  assert.equal(await textOf(id), 'Nouveau texte. | Bien relu.');
  assert.equal((await stateOf(id)).source, 'grok');
  assert.equal(suggested, 1);
  assert.equal(await R.restoreTranscript(id), true);
  assert.equal(await textOf(id), before);
  const st = await stateOf(id);
  assert.deepEqual([st.source, st.retx_status], ['supadata', 'restored']);
  assert.equal(await R.restoreTranscript(id), false);
});

test('échec : une seule nouvelle tentative, puis méthode initiale sans perdre le texte ; sans texte, sous-titres YouTube', { skip: !enabled }, async () => {
  const id = await makeVideo(`${VID}b`);
  const before = await textOf(id);
  const boom = async () => {
    throw new Error('Grok indisponible');
  };
  assert.equal((await R.retranscribeVideo(id, { deps: { build: boom } })).status, 'retry');
  assert.equal((await stateOf(id)).retx_status, 'retry');
  assert.equal(await textOf(id), before);
  assert.equal((await R.retranscribeVideo(id, { deps: { build: boom } })).status, 'initial');
  const st = await stateOf(id);
  assert.deepEqual([st.retx_status, st.retx_attempts, st.source], ['initial', 2, 'supadata']);
  assert.match(st.retx_error, /Grok indisponible/);
  assert.equal(await textOf(id), before);

  const empty = await makeVideo(`${VID}c`, { segments: [] });
  let asked = 0;
  const fetchFn = async () => ((asked++), { segments: [{ start_ms: 0, duration_ms: 1000, text: 'Sous-titres YouTube.' }], lang: 'fr', translated: false });
  await R.retranscribeVideo(empty, { deps: { build: boom } });
  await R.retranscribeVideo(empty, { deps: { build: boom, fetchFn } });
  assert.equal(asked, 1);
  assert.equal(await textOf(empty), 'Sous-titres YouTube.');
});

test('jamais sur un texte corrigé à la main ; abandon si le texte change pendant la retranscription', { skip: !enabled }, async () => {
  const edited = await makeVideo(`${VID}d`, { edited: true });
  assert.equal((await R.retranscribeVideo(edited, { deps: { build: goodBuild } })).status, 'skipped');
  const id = await makeVideo(`${VID}e`);
  const build = async (v) => {
    await db.withTransaction((c) => db.replaceSegments(c, v.id, [{ start_ms: 0, duration_ms: 1000, text: 'Corrigé à la main pendant ce temps.' }], { edited: true }));
    return goodBuild();
  };
  assert.equal((await R.retranscribeVideo(id, { deps: { build } })).status, 'skipped');
  assert.equal(await textOf(id), 'Corrigé à la main pendant ce temps.');
});

test('passages : la plus récente d’abord, pause et plafond d’heures par jour respectés', { skip: !enabled }, async () => {
  // Far-future dates: these come before any real video of the database
  const older = await makeVideo(`${VID}f`, { publishedAt: '2099-01-01' });
  const newer = await makeVideo(`${VID}g`, { publishedAt: '2099-06-01' });
  await R.saveRetxSettings({ paused: true });
  assert.deepEqual(await R.runRetranscribeCycle({ deps: { build: goodBuild } }), { skipped: 'paused' });
  await R.saveRetxSettings({ paused: false, dailyHours: 10 });
  const first = await R.runRetranscribeCycle({ deps: { build: goodBuild, suggest: async () => {} } });
  assert.equal(first.id, newer);
  await R.saveRetxSettings({ dailyHours: 0 });
  assert.deepEqual(await R.runRetranscribeCycle({ deps: { build: goodBuild } }), { skipped: 'daily-cap' });
  assert.equal((await stateOf(older)).source, 'supadata');
  const o = await R.retxOverview();
  assert.ok(o.done >= 1 && o.todo >= 1);
});

test('coûts : appels cumulés par jour, tâche et modèle ; rapport par tâche × modèle', { skip: !enabled }, async () => {
  await U.recordUsage({ feature: 'test_a', provider: 'openrouter', model: 'm1', inputTokens: 100, outputTokens: 10, cost: 0.01 });
  await U.recordUsage({ feature: 'test_a', provider: 'openrouter', model: 'm1', inputTokens: 50, cost: 0.02 });
  await U.recordUsage({ feature: 'test_a', provider: 'openrouter', model: 'm1', error: true, calls: 0 });
  await U.recordUsage({ feature: 'test_b', provider: 'supadata', model: 'youtube' });
  const rep = await U.usageReport();
  const a = rep.rows.find((r) => r.feature === 'test_a');
  assert.deepEqual([a.calls, a.errors, a.input_tokens, a.output_tokens, a.priced_calls], [2, 1, 150, 10, 2]);
  assert.ok(Math.abs(a.cost_usd - 0.03) < 1e-9);
  const b = rep.rows.find((r) => r.feature === 'test_b');
  assert.deepEqual([b.calls, b.priced_calls, b.unpriced], [1, 0, 1]);
  assert.ok(rep.totals.today >= 0.03 - 1e-9);
  await U.recordUsage({ feature: 'x'.repeat(100), provider: null });
});

test('jamais deux retranscriptions de la même vidéo en même temps', { skip: !enabled }, async () => {
  const id = await makeVideo(`${VID}h`);
  let release;
  const slow = () => new Promise((r) => (release = () => r(goodBuild())));
  const first = R.retranscribeVideo(id, { manual: true, deps: { build: slow, suggest: async () => {} } });
  await new Promise((r) => setTimeout(r, 50));
  const second = await R.retranscribeVideo(id, { manual: true, deps: { build: goodBuild } });
  assert.equal(second.status, 'skipped');
  release();
  assert.equal((await first).status, 'done');
});

test('contexte : noms tirés du titre et de la description (sigles, noms à majuscules, hashtags), sans doublon', async () => {
  const { contextTerms } = await import('../src/retranscribe/context.js');
  const t = contextTerms({ title: 'DLIVE', description: 'Ce soir, DLIVE avec Bruno Retailleau. Rejoignez Nouvelle Énergie ! #Lisnard2027 https://x.com/AbC' });
  for (const x of ['DLIVE', 'Bruno Retailleau', 'Lisnard2027', 'Lisnard']) assert.ok(t.includes(x), x);
  assert.ok(!t.includes('Rejoignez') && !t.includes('Ce'));
  assert.equal(t.filter((x) => x === 'Nouvelle Énergie').length, 1);
});

test('garde-fou avec contexte : « Day Live » → « DLIVE » et « Tailleux » → « Retailleau » acceptés ; sans contexte ou avec ajout, refusés', () => {
  const T = ['DLIVE', 'Bruno Retailleau'];
  assert.ok(faithful('bienvenue pour ces Day Live', 'bienvenue pour ce DLIVE', T));
  assert.ok(faithful('des Bruno Tailleux', 'des Bruno Retailleau', T));
  assert.ok(!faithful('bienvenue pour ces Day Live', 'bienvenue pour ce DLIVE'));
  assert.ok(!faithful('pour ces Day Live ce soir', 'pour ce DLIVE', T));
  assert.ok(!faithful('il faut baisser', 'il faut augmenter', T));
});

test('retranscription : titre et description donnés à Grok et à Haiku ; description récupérée une fois ; coûts comptés par vidéo', { skip: !enabled }, async () => {
  const id = await makeVideo('RETXtestCtx'); // 11 characters: a valid file name
  await pool.query("UPDATE videos SET title = 'DLIVE' WHERE id = $1", [id]);
  let described = 0;
  const seen = {};
  const deps = {
    describe: async () => ((described++), 'Le DLIVE avec Bruno Retailleau'),
    silencesOf: async () => [],
    chunkAudio: async () => Buffer.from('x'),
    transcribe: async (_b, o) => ((seen.stt = o), { text: 'x', words: [{ word: 'Bonsoir.', start: 0, end: 1 }], segments: [] }),
    proofread: async (lines, o) => ((seen.pr = o), { lines, changed: 0, rejected: 0, failedBatches: 0, batches: 1 }),
    suggest: async () => {},
  };
  const v = (await pool.query('SELECT * FROM videos WHERE id = $1', [id])).rows[0];
  await R.buildTranscript(v, deps);
  assert.ok(seen.stt.keyterms.includes('DLIVE') && seen.stt.keyterms.includes('Bruno Retailleau'));
  assert.equal(seen.stt.videoId, id);
  assert.deepEqual(seen.pr.context, { title: 'DLIVE', description: 'Le DLIVE avec Bruno Retailleau' });
  assert.equal((await pool.query('SELECT description FROM videos WHERE id = $1', [id])).rows[0].description, 'Le DLIVE avec Bruno Retailleau');
  await R.buildTranscript((await pool.query('SELECT * FROM videos WHERE id = $1', [id])).rows[0], deps);
  assert.equal(described, 1);

  await U.recordUsage({ feature: 'retranscription_stt', provider: 'openrouter', model: 'x-ai/grok-stt-1.0', videoId: id, audioSeconds: 60, cost: 0.002 });
  await U.recordUsage({ feature: 'retranscription_stt', provider: 'openrouter', model: 'x-ai/grok-stt-1.0', videoId: id, audioSeconds: 60, cost: 0.002 });
  await U.recordUsage({ feature: 'retranscription_relecture', provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', videoId: id, cost: 0.001 });
  await U.recordUsage({ feature: 'retranscription_stt', provider: 'openrouter', model: 'm', videoId: 999999999, cost: 1 });
  const c = await U.videoCosts(id);
  assert.equal(c.rows.length, 2);
  assert.equal(c.rows[0].calls, 2);
  assert.equal(c.rows[0].audio_seconds, 120);
  assert.ok(Math.abs(c.total - 0.005) < 1e-9);
});
