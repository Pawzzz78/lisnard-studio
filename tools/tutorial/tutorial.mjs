// Scénario des tutoriels : pilote le vrai site (voir tools/tutorial/README.md) pendant que l'enregistreur capture l'écran.
// Usage : node tutorial.mjs <debutant|avance> <dossier-de-sortie> [url]
import { createRecorder } from './recorder.mjs';

const level = process.argv[2];
const OUT = process.argv[3];
const BASE = process.argv[4] ?? 'http://localhost:3996';
if (!['debutant', 'avance'].includes(level) || !OUT) throw new Error('usage : node tutorial.mjs <debutant|avance> <dossier> [url]');
const easy = level === 'debutant';

const rec = await createRecorder({ outDir: OUT, base: easy ? 1.0 : 1.2 }); // débutant : cadence posée ; avancé : plus vive
const { page, sleep } = rec;
page.on('download', (d) => d.cancel().catch(() => {}));

// --- petites aides de mise en scène (coordonnées en px du téléphone 360 x 720)
const PREVIEW = [80, 124]; // l'aperçu reste collé en haut à gauche
const wide = (y = 265, dur = 0.6) => rec.camera(180, y, 1, dur); // l'aperçu et le réglage en même temps
const near = (y, z = 1.25, dur = 0.6) => rec.camera(180, y, z, dur);
const onPreview = (z = 1.85, dur = 0.7) => rec.camera(PREVIEW[0], PREVIEW[1], z, dur);
const step = async (num, title, hint) => {
  rec.cut();
  rec.caption({ num, title, hint });
  wide(265, 0);
};
const nextStep = async () => {
  await rec.reveal('.st-next', 440);
  near(440, 1.3);
  await rec.click('.st-next', { ms: 700, after: 350 });
};
const previewReady = () => rec.fast(() => page.waitForFunction(() => document.querySelector('.ph-video')?.getAttribute('src')?.includes('/api/studio/preview/'), null, { timeout: 40000 }), 4);
/** Attend que l'aperçu soit recalculé après un réglage (sinon il montre « Préparation de l'aperçu… »). */
const settle = async () => {
  await sleep(750);
  await rec.fast(() => page.waitForFunction(() => { const b = document.querySelector('.ph-busy'); return !b || b.hidden; }, null, { timeout: 60000 }), 4);
};
const playPreview = async (hold = 1700) => {
  await rec.click('.ph-play', { ms: 650, after: 100 });
  await sleep(hold);
  await rec.click('.ph-play', { ms: 300, after: 150 }); // remet l'aperçu en pause : les plans suivants montrent une image fixe
};

await page.goto(BASE + '/');
await page.waitForSelector('.st-video');
await sleep(300);
await rec.start();

// 1 — interview
rec.camera(180, 300, 1, 0);
rec.caption({ num: 1, title: 'Choisis ton interview', hint: 'Touche celle qui t’intéresse.' });
await sleep(900);
await rec.reveal('.st-video', 400);
near(400, 1.1, 0.5);
await rec.click('.st-video', { ms: 800, after: 250 });

// 2 — niveau
await page.waitForSelector('.st-level');
await sleep(450);
rec.cut();
rec.caption({ num: 2, title: 'Choisis ton niveau', hint: easy ? 'Débutant : un parcours simple, pas à pas.' : 'Avancé : tous les réglages pour personnaliser ta vidéo.' });
wide(300, 0);
await sleep(600);
const card = `label.st-level:has-text("${easy ? 'Débutant' : 'Avancé'}")`;
await rec.reveal(card, 400);
near(380, 1.05, 0.4);
await rec.click(card, { ms: 800, after: 500 });
await rec.reveal('.st-next', 440);
near(440, 1.3);
await rec.click('.st-next', { ms: 650, after: 350 });

if (easy) {
  // 3 — extrait : uniquement les extraits de l'IA
  await page.waitForSelector('.st-easy-card');
  await step(3, 'Choisis ton extrait', 'L’intelligence artificielle a repéré les meilleurs passages.');
  await sleep(800);
  await rec.reveal('.st-easy-card:nth-child(2) .st-easy-pick', 430);
  wide(300);
  await sleep(300);
  await rec.click('.st-easy-card:nth-child(2) .st-easy-pick', { ms: 800, after: 300 });
  await previewReady();
  onPreview();
  await sleep(1100);
  await nextStep();

  // 4 — sous-titres : les styles
  await page.waitForSelector('.st-preset');
  await step(4, 'Choisis tes sous-titres', 'Touche le style que tu préfères.');
  await sleep(500);
  await rec.reveal('.st-preset[data-preset="karaoke"]', 430);
  wide(300);
  await rec.click('.st-preset[data-preset="karaoke"]', { ms: 800, after: 200 });
  await settle();
  onPreview();
  await playPreview(1700);
  wide(300);
  await nextStep();

  // 5 — musique
  await page.waitForSelector('.st-track');
  await step(5, 'Ajoute de la musique', 'Facultatif. Écoute avec le bouton rond, puis touche le nom.');
  await sleep(500);
  await rec.reveal('.st-track:nth-child(4)', 430);
  near(380, 1.15);
  await rec.click('.st-track:nth-child(4) .st-playtrack', { ms: 750, after: 900 });
  await rec.click('.st-track:nth-child(4) .st-trackname', { ms: 550, after: 600 });
  await nextStep();

  // 6 — format
  await page.waitForSelector('.st-opt');
  await step(6, 'Choisis le format', 'Vidéo entière sur fond flou, ou plein écran.');
  await sleep(500);
  await rec.reveal('.st-opt:nth-child(2)', 430);
  near(380, 1.1);
  await rec.click('.st-opt:nth-child(2)', { ms: 750, after: 200 });
  await settle();
  onPreview();
  await sleep(1100);
  await nextStep();
} else {
  // 3 — extrait : proposé par l'IA, réglé à la seconde, ou n'importe quel passage de la transcription
  await page.waitForSelector('.st-exlist');
  await step(3, 'Choisis ton passage', 'Un extrait de l’IA, réglé comme tu veux, ou un passage libre.');
  await sleep(500);
  await rec.reveal('button[aria-label^="Commencer plus tôt"]', 420);
  near(380, 1.2);
  await rec.click('button[aria-label^="Commencer plus tôt"]', { ms: 700, after: 120 });
  await rec.click('button[aria-label^="Commencer plus tôt"]', { ms: 180, after: 120 });
  await rec.click('button[aria-label^="Finir plus tard"]', { ms: 420, after: 350 });
  await rec.reveal('.st-search', 430);
  wide(300);
  await rec.click('.st-search', { ms: 650, after: 100 });
  rec.speed(1);
  await page.keyboard.type('musique', { delay: 60 });
  await sleep(300);
  await rec.click('.st-lines li:first-child button', { ms: 600, after: 450 });
  await nextStep();

  // 4 — sous-titres : style, police, couleur
  await page.waitForSelector('.st-preset');
  await step(4, 'Personnalise tes sous-titres', 'Style, police, couleurs, position… tout se règle.');
  await sleep(400);
  await rec.reveal('.st-preset[data-preset="un-mot"]', 430);
  wide(300);
  await rec.click('.st-preset[data-preset="un-mot"]', { ms: 700, after: 300 });
  await rec.reveal('.st-font >> nth=1', 430);
  near(380, 1.1);
  await rec.click('.st-font >> nth=1', { ms: 650, after: 300 });
  await rec.reveal('.st-sw[title="Jaune"] >> nth=0', 430);
  near(380, 1.1);
  await rec.click('.st-sw[title="Jaune"] >> nth=0', { ms: 650, after: 200 });
  await settle();
  onPreview();
  await playPreview(1500);
  wide(300);
  await nextStep();

  // 5 — musique : catégories et volumes
  await page.waitForSelector('.st-track');
  await step(5, 'Choisis ta musique', 'Par catégorie, avec le volume de la musique et de la voix.');
  await sleep(400);
  await rec.reveal('.st-chip:has-text("Épique")', 430);
  near(380, 1.1);
  await rec.click('.st-chip:has-text("Épique")', { ms: 700, after: 350 });
  await rec.click('.st-track:nth-child(2) .st-trackname', { ms: 550, after: 300 });
  await rec.reveal('#st-vol-music', 430);
  near(380, 1.15);
  await rec.click('#st-vol-music', { ms: 600, after: 400, dx: 55 });
  await nextStep();

  // 6 — format : plein écran, logo, miroir
  await page.waitForSelector('.st-opt');
  await step(6, 'Règle le format', 'Plein écran, ton logo, miroir…');
  await sleep(400);
  await rec.reveal('.st-opt:nth-child(2)', 430);
  near(380, 1.1);
  await rec.click('.st-opt:nth-child(2)', { ms: 700, after: 350 });
  await rec.reveal('.st-check:has-text("miroir")', 430);
  near(380, 1.15);
  await rec.click('.st-check:has-text("miroir")', { ms: 700, after: 200 });
  await settle();
  onPreview();
  await sleep(900);
  await nextStep();

  // 7 — écran de fin
  await page.waitForSelector('#st-p-fin .st-check');
  await step(7, 'Ajoute un écran de fin', 'Un visuel de quelques secondes après ton clip.');
  await sleep(500);
  await rec.reveal('#st-p-fin .st-check', 430);
  near(380, 1.15);
  await rec.click('#st-p-fin .st-check', { ms: 650, after: 350 });
  await rec.reveal('#st-p-fin textarea', 430);
  near(380, 1.1);
  await page.evaluate(() => { document.querySelector('#st-p-fin textarea').spellcheck = false; });
  await rec.click('#st-p-fin textarea', { ms: 650, after: 100 });
  await page.keyboard.type('Merci d’avoir regardé !', { delay: 50 });
  await sleep(200);
  await rec.click('#st-p-fin button[aria-label="Blanc"]', { ms: 600, after: 500 });
  await nextStep();
}

// dernière étape — créer
const last = easy ? 7 : 8;
await page.waitForSelector('.st-check.pledge');
await step(last, 'Crée ta vidéo', 'Coche la case, puis touche « Créer la vidéo ».');
await sleep(500);
await rec.reveal('.st-check.pledge', 430);
near(380, 1.1);
await rec.click('.st-check.pledge', { ms: 750, after: 350 });
await rec.reveal('#st-p-creer .btn:has-text("Créer la vidéo")', 440);
near(440, 1.3);
await rec.click('#st-p-creer .btn:has-text("Créer la vidéo")', { ms: 700, after: 300 });
wide(300, 0.8);
await rec.fast(() => page.waitForSelector('.st-job-actions a:has-text("Télécharger")', { timeout: 120000 }).catch(async (e) => {
  console.error('JOB:', await page.locator('.st-job').innerText().catch(() => '?'), '| msg:', await page.locator('.st-msg').allInnerTexts().catch(() => '?'));
  throw e;
}), 8);
rec.caption({ num: last, title: 'Ta vidéo est prête !', hint: 'Touche « Télécharger » : elle est dans ton téléphone.' });
await rec.reveal('.st-job-actions a:has-text("Télécharger")', 430);
near(430, 1.3);
await sleep(300);
await rec.click('.st-job-actions a:has-text("Télécharger")', { ms: 750, after: 1100 });
await rec.close();
console.log('enregistré :', OUT);
