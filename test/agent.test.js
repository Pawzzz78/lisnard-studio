// API privée des agents IA : clés, routes /v1 du studio, serveur MCP et liens de téléchargement signés (Postgres requis)
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const enabled = Boolean(process.env.DATABASE_URL);
let server;
let base;
let pool;
let K;

before(async () => {
  if (!enabled) return;
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query("DELETE FROM agent_keys WHERE name LIKE 'test-%'");
  K = await import('../src/agent/keys.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!enabled) return;
  await pool.query("DELETE FROM agent_keys WHERE name LIKE 'test-%'");
  server.close();
  await pool.end();
});

const rpc = (key, body, headers = {}) =>
  fetch(`${base}/api/agent/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify(body) });

test('clés : sans clé, clé inconnue ou révoquée → 401 ; clé valide → routes du studio, usage compté', { skip: !enabled }, async () => {
  assert.equal((await fetch(`${base}/api/agent/v1/videos`)).status, 401);
  assert.equal((await fetch(`${base}/api/agent/v1/videos`, { headers: { Authorization: 'Bearer lsk_nope' } })).status, 401);
  const k = await K.createKey('test-agent');
  assert.match(k.key, /^lsk_[\w-]{32}$/);
  const res = await fetch(`${base}/api/agent/v1/videos`, { headers: { 'X-Api-Key': k.key } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).videos));
  const row = (await K.listKeys()).find((r) => r.id === k.id);
  assert.equal(row.uses, 1);
  assert.equal(row.hint, k.key.slice(0, 10));
  assert.ok(!JSON.stringify(row).includes(k.key));
  await K.revokeKey(k.id);
  assert.equal((await fetch(`${base}/api/agent/v1/videos`, { headers: { Authorization: `Bearer ${k.key}` } })).status, 401);
  await assert.rejects(K.createKey('  '), /nom/);
});

test('MCP : initialize, tools/list, appel d’outil, erreurs, notification', { skip: !enabled }, async () => {
  const { key } = await K.createKey('test-mcp');
  const init = await (await rpc(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await rpc(key, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const list = await (await rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ['list_videos', 'get_video', 'get_editor_options', 'search_stock_images', 'create_clip', 'get_clip', 'cancel_clip']);

  const opts = await (await rpc(key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_editor_options', arguments: {} } }, { 'MCP-Protocol-Version': '2026-07-28' })).json();
  assert.ok(opts.result.structuredContent.presets.length > 0);
  assert.equal(JSON.parse(opts.result.content[0].text).limits.maxExtracts, opts.result.structuredContent.limits.maxExtracts);

  const missing = await (await rpc(key, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_clip', arguments: { youtube_id: 'aaaaaaaaaaa', extracts: [{ start_ms: 0, end_ms: 9000 }] } } })).json();
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /pas disponible/);
  const badPreset = await (await rpc(key, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_clip', arguments: { youtube_id: 'x', extracts: [], preset: 'nope' } } })).json();
  assert.match(badPreset.result.content[0].text, /inconnu/);
  const clip = await (await rpc(key, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_clip', arguments: { clip_id: '0'.repeat(24) } } })).json();
  assert.match(clip.result.content[0].text, /introuvable/);

  assert.equal((await (await rpc(key, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'rm_rf' } })).json()).error.code, -32602);
  assert.equal((await (await rpc(key, { jsonrpc: '2.0', id: 8, method: 'resources/list' })).json()).error.code, -32601);
  const batch = await (await rpc(key, [{ jsonrpc: '2.0', id: 9, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }])).json();
  assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 9, result: {} }]);
  assert.equal((await fetch(`${base}/api/agent/mcp`, { headers: { Authorization: `Bearer ${key}` } })).status, 405);
  assert.equal((await rpc('lsk_wrong', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
});

test('liens de téléchargement : signature fausse → 403, signature juste d’un clip expiré → 404, sans clé', { skip: !enabled }, async () => {
  const { fileToken } = await import('../src/routes/agent.js');
  const id = 'ab'.repeat(12);
  assert.equal((await fetch(`${base}/api/agent/files/${id}?t=nope`)).status, 403);
  assert.equal((await fetch(`${base}/api/agent/files/${id}?t=${fileToken('cd'.repeat(12))}`)).status, 403);
  assert.equal((await fetch(`${base}/api/agent/files/${id}?t=${fileToken(id)}`)).status, 404);
});

test('MCP robuste : params null, preset piégé, lot trop gros, origine étrangère', { skip: !enabled }, async () => {
  const { key } = await K.createKey('test-robust');
  assert.equal((await (await rpc(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: null })).json()).error.code, -32602);
  const proto = await (await rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_clip', arguments: { youtube_id: 'x', extracts: [], preset: '__proto__' } } })).json();
  assert.match(proto.result.content[0].text, /inconnu/);
  const big = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
  assert.equal((await rpc(key, big)).status, 400);
  assert.equal((await rpc(key, [])).status, 400);
  assert.equal((await rpc(key, { jsonrpc: '2.0', id: 3, method: 'ping' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/agent/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: '{oops' })).status, 400);
});

test('compatibilité : clé dans l’adresse MCP (ChatGPT), Authorization sans « Bearer » (Grok), annotations des outils', { skip: !enabled }, async () => {
  const { key } = await K.createKey('test-compat');
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const viaUrl = await fetch(`${base}/api/agent/mcp/${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ping) });
  assert.deepEqual(await viaUrl.json(), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal((await fetch(`${base}/api/agent/mcp/lsk_nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ping) })).status, 401);
  const raw = await fetch(`${base}/api/agent/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key }, body: JSON.stringify(ping) });
  assert.equal(raw.status, 200);
  const { result } = await (await rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.equal(result.tools.find((t) => t.name === 'get_video').annotations.readOnlyHint, true);
  assert.equal(result.tools.find((t) => t.name === 'create_clip').annotations.readOnlyHint, false);
});

// Last: exhausts this IP's bad-key allowance
test('clés refusées en rafale : 429 après 30 essais par heure', { skip: !enabled }, async () => {
  let last;
  for (let i = 0; i < 32; i++) last = (await fetch(`${base}/api/agent/v1/videos`, { headers: { Authorization: `Bearer lsk_guess${i}` } })).status;
  assert.equal(last, 429);
});
