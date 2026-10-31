import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { authConfigured } from './auth.js';
import { initDb } from './db.js';
import { ffmpegAvailable, storageDir } from './media.js';
import { requireMember } from './members/session.js';
import { adminRouter } from './routes/admin.js';
import { libraryRouter } from './routes/library.js';
import { membersRouter } from './routes/members.js';
import { publicRouter } from './routes/public.js';
import { studioRouter } from './routes/studio.js';
import { wallRouter } from './routes/wall.js';
import { startStudioCleanup, studioCapabilities } from './studio/render.js';
import { startSummaryScheduler } from './auto-summaries.js';
import { startScheduler } from './sync.js';
import { startWallScheduler } from './wall/wall.js';
import { startLibraryMaintenance } from './library/library.js';
import { startVideoFetcher } from './video-fetch.js';
import { startTrendingScheduler } from './studio/trending.js';

// Origins the pages really use: YouTube (admin player, thumbnails), TikTok (wall), Pixabay/Pexels (stock thumbnails); blob: and data: for the end card photo and the account logo kept in the browser.
// Inline styles stay allowed: the studio injects its @font-face rules and the admin sets style attributes.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com",
  'frame-src https://www.youtube.com https://www.tiktok.com',
  "img-src 'self' blob: data: https://i.ytimg.com https://pixabay.com https://cdn.pixabay.com https://images.pexels.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': CSP,
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  app.use('/api/admin', adminRouter);
  app.use('/api/auth', membersRouter);
  app.use('/api/studio', requireMember, studioRouter);
  app.use('/api/wall', wallRouter);
  app.use('/api/library', libraryRouter);
  app.use('/api', publicRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  // anciennes adresses (recherche, vidéos, tendances, studio) : le site ne propose plus que le studio, à la racine
  app.get(/^\/(videos|tendances|studio)(\/(index\.html)?)?$/, (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.redirect(301, q >= 0 ? `/${req.originalUrl.slice(q)}` : '/');
  });
  app.use(
    express.static(publicDir, {
      extensions: ['html'],
      setHeaders: (res, file) => {
        // Polices : immuables. Le reste (pages, JS, CSS) est revalidé à chaque visite pour que les mises à jour
        // s'affichent tout de suite (réponse 304 sans corps si rien n'a changé).
        res.setHeader('Cache-Control', file.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );

  // Express needs the 4-argument signature to treat this as an error handler
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Erreur interne.' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await initDb();
  if (!authConfigured()) {
    console.warn('ADMIN_PASSWORD / SESSION_SECRET (16+ caractères) manquants ou valeurs d\'exemple (change-me…) : l\'admin est désactivée.');
  }
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Studio Lisnard → http://localhost:${port}`));
  ffmpegAvailable().then(async (ok) => {
    const cap = ok ? await studioCapabilities() : null;
    console.log(`Studio de clips : ffmpeg ${ok ? 'disponible' : 'ABSENT (dépôt de vidéos impossible)'}${cap ? ` · sous-titres (libass) ${cap.ass ? 'oui' : 'NON'} · H.264 ${cap.x264 ? 'oui' : 'NON'} · AAC ${cap.aac ? 'oui' : 'NON'} · zooms et images ${cap.zoom ? 'oui' : 'NON'}` : ''} · stockage ${storageDir()}`);
  });
  startScheduler();
  startSummaryScheduler();
  startStudioCleanup();
  startWallScheduler();
  startLibraryMaintenance();
  startVideoFetcher();
  startTrendingScheduler();
}
