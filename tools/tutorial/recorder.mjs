// Enregistreur du tutoriel : pilote le vrai site dans un navigateur (viewport téléphone) et capture ses images avec leur horodatage.
// Le curseur, ses clics, les légendes et les mouvements de caméra ne sont PAS dessinés dans la page : ils sont notés dans events.json
// (positions, instants) et dessinés au montage (compose.py), ce qui les rend fluides à 30 images par seconde même si la capture est plus lente.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

export async function createRecorder({ outDir, viewport = { width: 360, height: 720 }, scale = 2, quality = 88, base = 1.2 }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true, locale: 'fr-FR' });
  const page = await ctx.newPage();
  const events = [];
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  // Capture en boucle : Page.captureScreenshot avec un `clip.scale` rend la page à `scale` fois sa taille (nette), contrairement à
  // Page.startScreencast qui reste à l'échelle 1.
  let capturing = false;
  let loop = Promise.resolve();
  let writing = Promise.resolve();
  const capture = async () => {
    while (capturing) {
      const t0 = now();
      // `clip` est en coordonnées du document : on y ajoute le défilement courant pour capturer ce que voit la fenêtre
      const m = await cdp.send('Page.getLayoutMetrics').catch(() => null);
      const vv = m?.cssVisualViewport ?? { pageX: 0, pageY: 0 };
      const clip = { x: vv.pageX, y: vv.pageY, width: viewport.width, height: viewport.height, scale };
      const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: true, clip }).catch(() => null);
      if (!r) continue;
      const t = (t0 + now()) / 2;
      const file = path.join('frames', `${String(frames.length).padStart(6, '0')}.jpg`);
      frames.push({ t, file });
      const buf = Buffer.from(r.data, 'base64');
      writing = writing.then(() => fs.promises.writeFile(path.join(outDir, file), buf));
    }
  };
  const log = (e) => events.push({ ...e, t: now() });
  let pos = { x: viewport.width * 0.55, y: viewport.height * 0.8 };

  const rec = {
    page,
    events,
    sleep,
    log,
    start: async () => {
      capturing = true;
      loop = capture();
      log({ type: 'start', x: pos.x, y: pos.y });
      log({ type: 'speed', factor: base }); // cadence générale du montage : un peu plus vive que la scène jouée
    },
    /** Légende affichée sous la vidéo à partir de maintenant : { num, title, hint }. */
    caption: (c) => log({ type: 'caption', ...c }),
    /** Mouvement de caméra vers un point (px du viewport) et un zoom, en `dur` secondes. */
    camera: (cx, cy, zoom, dur = 0.8) => log({ type: 'camera', cx, cy, zoom, dur }),
    /** Coup d'accent au changement d'étape. */
    cut: () => log({ type: 'cut' }),
    /** Vitesse de lecture à partir de maintenant (pour passer les attentes). */
    speed: (factor) => log({ type: 'speed', factor: factor * base }),
    /** Défile en douceur pour amener la cible à `y` px du haut de la fenêtre. */
    reveal: async (target, y = 470, ms = 350) => {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      const b = await loc.boundingBox();
      const by = b.y + b.height / 2;
      await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'instant' }), by - y);
      log({ type: 'jump' }); // le défilement est instantané ; le montage fond les deux images (la capture est trop lente pour un défilement fluide)
      await sleep(ms);
      const a = await loc.boundingBox();
      return a;
    },
    /** Attend une condition sans la montrer à l'écran à vitesse normale : le montage accélère cette attente. */
    fast: async (fn, factor = 4) => {
      log({ type: 'speed', factor: factor * base });
      try {
        return await fn();
      } finally {
        log({ type: 'speed', factor: base });
      }
    },
    /** Fait glisser le curseur jusqu'au centre de la cible. */
    move: async (target, { ms = 750, dx = 0, dy = 0 } = {}) => {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      const b = await loc.boundingBox();
      const x = b.x + b.width / 2 + dx;
      const y = b.y + b.height / 2 + dy;
      log({ type: 'move', x0: pos.x, y0: pos.y, x1: x, y1: y, dur: ms / 1000 });
      await sleep(ms);
      await page.mouse.move(x, y);
      pos = { x, y };
      return { x, y, box: b };
    },
    click: async (target, { ms = 750, before = 130, after = 450, dx = 0, dy = 0 } = {}) => {
      const p = await rec.move(target, { ms, dx, dy });
      await sleep(before);
      log({ type: 'click', x: p.x, y: p.y });
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();
      await sleep(after);
      return p;
    },
    pos: () => pos,
    close: async () => {
      log({ type: 'end' });
      await sleep(300);
      capturing = false;
      await loop;
      await writing;
      fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify({ viewport, scale, frames, events }));
      await browser.close();
    },
  };
  return rec;
}
