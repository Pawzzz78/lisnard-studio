# Tutoriels vidéo du studio

Fabrique `public/tutoriels/debutant.mp4` et `avance.mp4` (une trentaine de secondes chacune, 720 × 1280, 30 images/s, musique libre de droits).

**Principe : rien n'est filmé en direct.** Une capture d'écran en direct d'un navigateur ne dépasse pas une dizaine d'images par seconde,
ce qui donne une vidéo qui saccade. À la place :

1. `shoot.mjs` parcourt le **vrai site** (écran de téléphone) et garde des **images fixes** nettes (avant et après chaque clic), la position
   des boutons touchés, et le **vrai extrait** tel que le studio le crée (rendu rapide 720 × 1280, sous-titres compris).
2. `compose.py` anime tout à 30 images par seconde : caméra qui zoome sur le bouton, anneau autour du bouton, curseur qui glisse et clique
   (ondes de clic), fondu entre l'avant et l'après d'un clic, volet entre deux étapes, **extrait qui se joue dans l'écran du téléphone**,
   légendes animées, barre de progression, introduction, conclusion, musique et petits sons de clic.

## Ce qu'il faut

- ffmpeg, Python 3.10+ avec `pip install pillow numpy`, Node 20+, Playwright (`npm i --no-save playwright-core`) ; le navigateur est cherché
  dans `/opt/pw-browsers/chromium`, ou dans la variable `CHROMIUM`.
- Une base Postgres (`DATABASE_URL`, comme pour le site).

## Étapes

```bash
# 1. une interview de démonstration : vidéo d'exemple (silhouette), transcription qui explique le studio, extraits proposés.
#    Aucune parole réelle n'y est attribuée à une personne.
export STORAGE_DIR=/tmp/demo-studio DATABASE_URL=postgres://...
node tools/tutorial/demo-seed.mjs

# 2. le site sur ce stockage, dans un autre terminal. STUDIO_PREVIEW_FORMAT=webm : le navigateur de prise de vues n'a pas H.264.
SESSION_SECRET=... ADMIN_PASSWORD=... STUDIO_RENDERS_PER_HOUR=100 STUDIO_PREVIEWS_PER_HOUR=1000 STUDIO_PREVIEW_FORMAT=webm PORT=3000 npm start

# 3. les prises de vues, une par niveau
node tools/tutorial/shoot.mjs debutant /tmp/rec-debutant http://localhost:3000
node tools/tutorial/shoot.mjs avance   /tmp/rec-avance   http://localhost:3000

# 4. le montage
python3 tools/tutorial/compose.py /tmp/rec-debutant public/tutoriels/debutant.mp4 --config tools/tutorial/debutant.json --steps 7 --poster public/tutoriels/debutant.jpg
python3 tools/tutorial/compose.py /tmp/rec-avance   public/tutoriels/avance.mp4   --config tools/tutorial/avance.json   --steps 8 --poster public/tutoriels/avance.jpg
```

`--steps` est le nombre d'étapes du parcours (7 en débutant, 8 en avancé) : il règle la barre de progression sous la vidéo.

## Avec une vraie interview

La vidéo d'exemple est volontairement neutre. Pour montrer une vraie interview, remplace la vidéo de `STORAGE_DIR/videos/TUTOdemo_01.mp4` par
un extrait de **moins d'une minute** et fais correspondre les lignes de la transcription (`lines` dans `demo-seed.mjs`, 3 s par ligne) à ce
qui s'y dit : les sous-titres des vidéos viennent de la transcription, pas de la bande son.

## À refaire quand…

l'interface du studio change (une étape, un bouton, un texte) : relancer les étapes 3 et 4 et vérifier la vidéo. Les scènes et leurs légendes
sont dans `shoot.mjs` (si l'interface change, on adapte les sélecteurs) ; l'introduction, la conclusion et la musique dans
`debutant.json` / `avance.json`. Le test `tutoriels` de `test/studio.test.js` refuse une vidéo de plus d'une minute, non verticale ou trop lourde.
