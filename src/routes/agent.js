/**
 * API privée des agents IA, protégée par une clé (Authorization: Bearer lsk_…) :
 * - /api/agent/v1/… : exactement les routes du studio (vidéos, éléments de l'éditeur, aperçu, rendu, téléchargement) ;
 * - /api/agent/mcp (ou /api/agent/mcp/<clé> pour les clients sans en-tête, comme ChatGPT) : serveur MCP (HTTP « streamable », réponses JSON, sans session) qui expose les mêmes actions en outils ;
 * - /api/agent/files/:id?t=… : lien de téléchargement signé d'un clip prêt, utilisable sans la clé.
 */
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { findKey, keyFromRequest } from '../agent/keys.js';
import { originHost } from '../auth.js';
import { HttpError } from '../http-error.js';
import { createLimiter, ipKey } from '../ip.js';
import { PRESETS } from '../../public/js/studio-core.js';
import { cancelJob, publicJob } from '../studio/render.js';
import { searchPhotos } from '../studio/stock.js';
import { jobOr404, listStudioVideos, startRender, studioAssets, studioRouter, videoDetail } from './studio.js';

export const agentRouter = Router();

const SERVER = { name: 'lisnard-studio', version: '1.0.0' };
const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_BATCH = 20;
const failures = createLimiter(); // bad keys per IP and per hour
const MAX_FAILURES = 30;
const fallbackSecret = crypto.randomBytes(32);
const secret = () => ((process.env.SESSION_SECRET ?? '').length >= 16 ? process.env.SESSION_SECRET : fallbackSecret);
export const fileToken = (id) => crypto.createHmac('sha256', secret()).update(`agent-file|${id}`).digest('base64url').slice(0, 32);

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/** Lien signé vers le fichier d'un clip (valable tant que le clip existe, une heure). */
export const downloadUrl = (req, id) => `${req.protocol}://${req.get('host')}/api/agent/files/${id}?t=${fileToken(id)}`;

// Signed link: no key needed, served by the studio route (same per-clip byte cap)
agentRouter.get('/files/:id', (req, res, next) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{24}$/.test(id) || !safeEqual(req.query.t ?? '', fileToken(id))) return res.status(403).json({ error: 'Lien invalide.' });
  req.url = `/render/${id}/file?use=download`;
  req.query = { use: 'download' };
  studioRouter(req, res, next);
});

async function requireKey(req, res, next) {
  try {
    const raw = keyFromRequest(req);
    const key = raw ? await findKey(raw) : null;
    if (!key) {
      if (!failures.take(`agent-key:${ipKey(req.ip)}`, MAX_FAILURES)) return res.status(429).json({ error: 'Trop de clés refusées : réessaie dans une heure.' });
      return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Clé API manquante, invalide ou révoquée.' });
    }
    req.agent = key;
    // Studio rate limits are per IP: give each key its own bucket
    Object.defineProperty(req, 'ip', { value: `agent-${key.id}`, configurable: true });
    next();
  } catch (e) {
    next(e);
  }
}

agentRouter.use('/v1', requireKey, studioRouter);

// --- MCP ------------------------------------------------------------------------------------------

const clipInput = {
  type: 'object',
  required: ['youtube_id', 'extracts'],
  properties: {
    youtube_id: { type: 'string', description: 'Identifiant YouTube de la vidéo (voir list_videos).' },
    extracts: {
      type: 'array',
      description: "Extraits mis bout à bout, en millisecondes de la vidéo d'origine (repère-toi sur `lines` et `suggestions` de get_video).",
      items: { type: 'object', required: ['start_ms', 'end_ms'], properties: { start_ms: { type: 'integer' }, end_ms: { type: 'integer' } } },
    },
    preset: { type: 'string', description: 'Style prêt à l’emploi (identifiants dans get_editor_options.presets) ; `style` le complète.' },
    style: { type: 'object', description: 'Style des sous-titres et du titre, même forme que get_editor_options.default_style.' },
    layout: { type: 'object', description: "{ fit: 'blur'|'crop', cropX: 0..1, quality: 'hd'|'fast', mirror: bool, follow: { on: bool, subject: 'auto'|'left'|'right'|'lisnard' } }" },
    music: { type: 'object', description: '{ id (get_editor_options.music), volume: 0..1 }' },
    voice: { type: 'number', description: 'Volume de la voix, 0 à 1,5 (1 par défaut).' },
    zoom: { type: 'object', description: 'Zooms, même forme que dans le studio.' },
    broll: { type: 'array', description: '[{ id (search_stock_images), start, dur }] en secondes du clip.' },
    edits: { type: 'object', description: 'Corrections des sous-titres, même forme que dans le studio.' },
    end_card: { type: 'object', description: 'Carton de fin, même forme que dans le studio.' },
  },
};

const TOOLS = [
  { name: 'list_videos', annotations: { readOnlyHint: true, openWorldHint: false }, description: 'Liste les interviews disponibles dans le studio (les plus récentes d’abord), avec le nombre d’extraits proposés.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'get_video', annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'Détail d’une interview : extraits proposés (titres, début et fin en ms) et transcription ligne par ligne [start_ms, end_ms, texte].',
    inputSchema: { type: 'object', required: ['youtube_id'], properties: { youtube_id: { type: 'string' } } },
  },
  { name: 'get_editor_options', annotations: { readOnlyHint: true, openWorldHint: false }, description: 'Styles prêts à l’emploi, style par défaut, polices, musiques et limites (durée maximale, nombre d’extraits…).', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'search_stock_images', annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'Cherche des images libres de droits à insérer (b-roll) ; renvoie leurs identifiants.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, page: { type: 'integer' } } },
  },
  { name: 'create_clip', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: 'Lance la création du clip vertical (MP4). Renvoie son identifiant : suis-le avec get_clip.', inputSchema: clipInput },
  {
    name: 'get_clip', annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'État d’un clip ; quand il est prêt, `download_url` donne le MP4 (lien valable une heure). `wait_s` attend jusqu’à 50 s qu’il soit prêt.',
    inputSchema: { type: 'object', required: ['clip_id'], properties: { clip_id: { type: 'string' }, wait_s: { type: 'integer', minimum: 0, maximum: 50 } } },
  },
  { name: 'cancel_clip', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: 'Annule un clip en attente ou en cours.', inputSchema: { type: 'object', required: ['clip_id'], properties: { clip_id: { type: 'string' } } } },
];

function clipView(req, job) {
  const view = publicJob(job);
  return view.status === 'done' ? { ...view, download_url: downloadUrl(req, job.id) } : view;
}

async function waitDone(job, seconds) {
  const until = Date.now() + Math.min(50, Math.max(0, Number(seconds) || 0)) * 1000;
  while ((job.status === 'queued' || job.status === 'running') && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
}

/** Clip créé avec cette clé ; ceux des autres clés et du studio restent introuvables. */
function ownJob(req, id) {
  const job = jobOr404(String(id ?? ''));
  if (job.ip !== ipKey(req.ip)) throw new HttpError(404, 'Clip introuvable ou expiré (les clips sont conservés une heure).');
  return job;
}

const handlers = {
  list_videos: async () => ({ videos: await listStudioVideos() }),
  get_video: (_req, a) => videoDetail(a.youtube_id),
  get_editor_options: () => studioAssets(),
  search_stock_images: (req, a) => searchPhotos(a.query, { page: a.page, ip: req.ip }),
  create_clip: async (req, a) => {
    const { preset, ...body } = a;
    if (preset != null && !Object.hasOwn(PRESETS, String(preset))) throw new HttpError(400, 'Style prêt à l’emploi inconnu (voir get_editor_options).');
    const own = body.style && typeof body.style === 'object' && !Array.isArray(body.style) ? body.style : {};
    if (preset) body.style = { ...PRESETS[preset].style, ...own };
    return clipView(req, await startRender(body, { ip: req.ip }));
  },
  get_clip: async (req, a) => {
    const job = ownJob(req, a.clip_id);
    await waitDone(job, a.wait_s);
    return clipView(req, job);
  },
  cancel_clip: async (req, a) => {
    await cancelJob(ownJob(req, a.clip_id));
    return { ok: true };
  },
};

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleRpc(req, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Requête JSON-RPC invalide.');
  if (msg.id === undefined) return null; // notification: nothing to answer
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return { jsonrpc: '2.0', id, result: { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: SERVER, instructions: INSTRUCTIONS } };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const fn = Object.hasOwn(handlers, String(params.name)) ? handlers[params.name] : null; // not `constructor`, `toString`, `__proto__`…
      if (!fn) return rpcError(id, -32602, `Outil inconnu : ${params.name}`);
      try {
        const data = await fn(req, params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data } };
      } catch (e) {
        if (!(e instanceof HttpError)) console.error(e);
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e instanceof HttpError ? e.message : 'Erreur interne.' }] } };
      }
    }
    default:
      return rpcError(id, -32601, `Méthode inconnue : ${method}`);
  }
}

const INSTRUCTIONS =
  'Studio de clips de David Lisnard. Démarche : list_videos → get_video (extraits proposés et transcription) → get_editor_options → ' +
  'create_clip (extraits en ms, style, musique…) → get_clip avec wait_s jusqu’à `done` → télécharge `download_url`.';

const mcpPaths = ['/mcp', '/mcp/:urlKey'];
agentRouter.post(mcpPaths, requireKey, express.json({ limit: '200kb' }), async (req, res, next) => {
  try {
    // Browsers may only call from the site itself (DNS rebinding); agents send no Origin
    const origin = req.get('origin');
    if (origin && originHost(origin) !== req.get('host')) return res.status(403).json(rpcError(null, -32600, 'Origine refusée.'));
    const batch = Array.isArray(req.body);
    if (batch && (!req.body.length || req.body.length > MAX_BATCH)) return res.status(400).json(rpcError(null, -32600, `Lot vide ou de plus de ${MAX_BATCH} messages.`));
    const answers = (await Promise.all((batch ? req.body : [req.body]).map((m) => handleRpc(req, m)))).filter(Boolean);
    if (!answers.length) return res.status(202).end();
    res.set('Cache-Control', 'no-store').json(batch ? answers : answers[0]);
  } catch (e) {
    next(e);
  }
});
// No server-initiated stream: GET and DELETE are not offered
agentRouter.all(mcpPaths, requireKey, (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Utilise POST.' }));

agentRouter.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json(rpcError(null, -32700, 'JSON illisible.'));
  next(err);
});
