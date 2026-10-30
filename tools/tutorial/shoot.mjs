// Prise de vues des tutoriels : parcourt le vrai site (viewport téléphone) et garde, pour chaque scène, des IMAGES FIXES du site avant et
// après chaque clic (nettes, 1080 x 2160), la position des boutons touchés, et le vrai extrait tel que le studio le crée (rendu rapide,
// sous-titres compris). Le curseur, les zooms, les transitions et la lecture de l'extrait dans le téléphone sont animés au montage
// (compose.py) à 30 images par seconde : rien n'est filmé en direct, donc rien ne saccade.
// Usage : node shoot.mjs <debutant|avance> <dossier-de-sortie> [url]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const level = process.argv[2];
const OUT = process.argv[3];
const BASE = process.argv[4] ?? 'http://localhost:3000';
if (!['debutant', 'avance'].includes(level) || !OUT) throw new Error('usage : node shoot.mjs <debutant|avance> <dossier> [url]');
const easy = level === 'debutant';
const VIDEO = 'TUTOdemo_01';
const VP = { width: 360, height: 720 };
const SCALE = 3;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'clips'), { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: SCALE, locale: 'fr-FR', acceptDownloads: true });
await ctx.addInitScript((l) => localStorage.setItem('studio.level.v1', l), level);
const page = await ctx.newPage();
page.on('download', (d) => d.cancel().catch(() => {}));
let lastPreview = null;
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().endsWith('/api/studio/preview')) lastPreview = r.postData();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
};
/** Défilement instantané : la cible à `y` px du haut de la fenêtre (le montage fond l'avant et l'après). */
const view = async (sel, y = 440) => {
  const b = await rect(sel);
  await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'instant' }), b.y + b.h / 2 - y);
  await sleep(200);
};
/** La page est au repos : plus d'aperçu en préparation, plus de transition. */
const settle = async () => {
  await sleep(600);
  await page.waitForFunction(() => { const b = document.querySelector('.ph-busy'); return !b || b.hidden; }, null, { timeout: 60000 }).catch(() => {});
  await sleep(500);
};
let n = 0;
const snap = async () => {
  const file = path.join('stills', `${String(n++).padStart(3, '0')}.jpg`);
  await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 93 });
  return file;
};

const scenes = [];
const scene = (num, title, hint) => {
  const sc = { num, title, hint, states: [], ops: [] };
  scenes.push(sc);
  return sc;
};
const state = async (sc) => {
  sc.states.push(await snap());
  return sc.states.length - 1;
};
/** Touche un élément : image avant (déjà prise), clic réel, attente, image après. */
const click = async (sc, sel, after) => {
  const target = await rect(sel);
  const from = sc.states.length - 1;
  await page.locator(sel).first().click();
  if (after) await after();
  await settle();
  const to = await state(sc);
  sc.ops.push({ op: 'click', state: from, target, to });
};
/** Le vrai extrait : la même demande que l'aperçu, rendue par le studio (720 x 1280, sous-titres compris). */
const clip = async (sc, name) => {
  await page.waitForFunction(() => document.querySelector('.ph-video')?.getAttribute('src')?.includes('/api/studio/preview/'), null, { timeout: 60000 });
  await settle();
  const phone = await rect('.ph-screen');
  const body = JSON.parse(lastPreview);
  body.layout = { ...body.layout, quality: 'fast' };
  const res = await fetch(`${BASE}/api/studio/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const job = await res.json();
  if (!res.ok) throw new Error(`rendu refusé : ${JSON.stringify(job)}`);
  for (;;) {
    const j = await (await fetch(`${BASE}/api/studio/render/${job.id}`)).json();
    if (j.status === 'done') break;
    if (['failed', 'error', 'cancelled'].includes(j.status)) throw new Error(`rendu échoué : ${JSON.stringify(j)}`);
    await sleep(500);
  }
  const file = path.join('clips', `${name}.mp4`);
  fs.writeFileSync(path.join(OUT, file), Buffer.from(await (await fetch(`${BASE}/api/studio/render/${job.id}/file`)).arrayBuffer()));
  sc.ops.push({ op: 'clip', file, phone, state: sc.states.length - 1 });
};
const next = async (selector) => {
  await page.locator('.st-next').click();
  await page.waitForSelector(selector);
  await settle();
};

await page.goto(`${BASE}/?v=${VIDEO}`);
await page.waitForSelector('.st-level');
await page.waitForTimeout(800);
await page.locator('.st-next').click(); // niveau déjà choisi : on arrive sur « Extrait »

// ---------------------------------------------------------------- extrait
if (easy) {
  await page.waitForSelector('.st-easy-card');
  await settle();
  const sc = scene(3, 'Choisis ton extrait', 'Touche celui que tu veux.');
  await view('.st-easy-card:nth-child(2) .st-easy-pick');
  await state(sc);
  await click(sc, '.st-easy-card:nth-child(2) .st-easy-pick');
  await clip(sc, 'extrait');
} else {
  await page.waitForSelector('.st-exlist');
  await settle();
  const sc = scene(3, 'Choisis ton passage', 'Réglé à la seconde, ou n’importe où dans l’interview.');
  await view('button[aria-label^="Finir plus tard"]', 420);
  await state(sc);
  await click(sc, 'button[aria-label^="Finir plus tard"]');
  await clip(sc, 'passage');
}

// ---------------------------------------------------------------- sous-titres
await next('.st-preset');
{
  const sc = scene(4, easy ? 'Choisis tes sous-titres' : 'Personnalise tes sous-titres', easy ? 'Touche le style que tu préfères.' : 'Style, police, couleurs, position…');
  if (easy) {
    await view('.st-preset[data-preset="karaoke"]');
    await state(sc);
    await click(sc, '.st-preset[data-preset="karaoke"]');
  } else {
    await view('.st-font >> nth=1');
    await state(sc);
    await click(sc, '.st-font >> nth=1');
  }
  await clip(sc, 'sous-titres');
}

// ---------------------------------------------------------------- musique
await next('.st-track');
{
  const sc = scene(5, easy ? 'Ajoute de la musique' : 'Choisis ta musique', easy ? 'Facultatif : touche le nom d’un morceau.' : 'Par catégorie, avec les volumes.');
  if (easy) {
    await view('.st-track:nth-child(4) .st-trackname');
    await state(sc);
    await click(sc, '.st-track:nth-child(4) .st-trackname');
  } else {
    await view('.st-chip:has-text("Épique")');
    await state(sc);
    await click(sc, '.st-chip:has-text("Épique")');
  }
}

// ---------------------------------------------------------------- format
await next('.st-opt');
{
  const sc = scene(6, easy ? 'Choisis le format' : 'Règle le format', easy ? 'Vidéo entière, ou plein écran.' : 'Plein écran, logo, miroir…');
  await view('.st-opt:nth-child(2)');
  await state(sc);
  await click(sc, '.st-opt:nth-child(2)');
  await clip(sc, 'format');
}

// ---------------------------------------------------------------- écran de fin (avancé)
if (!easy) {
  await next('#st-p-fin .st-check');
  const sc = scene(7, 'Ajoute un écran de fin', 'Un visuel de quelques secondes après ton clip.');
  await view('#st-p-fin .st-check', 420);
  await state(sc);
  // un message est obligatoire quand l'écran de fin est coché : on l'écrit tout de suite
  await click(sc, '#st-p-fin .st-check', async () => {
    await page.locator('#st-p-fin textarea').fill('Merci d’avoir regardé !');
    await page.evaluate(() => window.scrollBy({ top: 0 }));
  });
}

// ---------------------------------------------------------------- créer
await next('.st-check.pledge');
{
  const last = easy ? 7 : 8;
  const sc = scene(last, 'Crée ta vidéo', 'Coche la case, puis touche « Créer ».');
  await view('.st-check.pledge', 330);
  await state(sc);
  await click(sc, '.st-check.pledge');
  await click(sc, '#st-p-creer .btn:has-text("Créer la vidéo")');
  await page.waitForSelector('.st-job-actions a:has-text("Télécharger")', { timeout: 180000 });
  await settle();
  await view('.st-job-actions a:has-text("Télécharger")', 440);
  const from = sc.states.length - 1;
  const to = await state(sc);
  sc.ops.push({ op: 'wait', state: from, to, dur: 0.8, caption: { num: last, title: 'Ta vidéo est prête !', hint: 'Touche « Télécharger » : elle est dans ton téléphone.' } });
  sc.ops.push({ op: 'click', state: to, target: await rect('.st-job-actions a:has-text("Télécharger")'), to: null });
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ viewport: VP, scale: SCALE, level, scenes }, null, 1));
await browser.close();
console.log('prises de vues :', OUT, `(${n} images, ${scenes.length} scènes)`);
