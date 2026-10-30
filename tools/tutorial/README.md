# Tutoriels vidéo du studio

Fabrique `public/tutoriels/debutant.mp4` et `avance.mp4` (moins d'une minute chacune, 720 × 1280, 30 images/s, musique libre de droits) en
**filmant le vrai site** : un navigateur parcourt le studio sur un écran de téléphone pendant qu'on capture son écran, puis le montage ajoute
un curseur fluide qui clique, des légendes animées, un zoom de caméra, une introduction et une conclusion.

## Ce qu'il faut

- ffmpeg, Python 3.10+ avec `pip install pillow numpy`, Node 20+ et Playwright : `npm i --no-save playwright-core` (le navigateur est cherché
  dans `/opt/pw-browsers/chromium`, ou dans la variable `CHROMIUM`).
- Une base Postgres (`DATABASE_URL`, comme pour le site).

## Étapes

```bash
# 1. une interview de démonstration (vidéo d'exemple + extraits proposés) : aucune parole réelle
export STORAGE_DIR=/tmp/demo-studio DATABASE_URL=postgres://...
node tools/tutorial/demo-seed.mjs

# 2. le site (rendu ffmpeg compris) sur ce stockage, dans un autre terminal
SESSION_SECRET=... ADMIN_PASSWORD=... STUDIO_RENDERS_PER_HOUR=100 PORT=3996 npm start

# 3. l'enregistrement (un dossier d'images horodatées + events.json), un par niveau
node tools/tutorial/tutorial.mjs debutant /tmp/rec-debutant http://localhost:3996
node tools/tutorial/tutorial.mjs avance   /tmp/rec-avance   http://localhost:3996

# 4. le montage
python3 tools/tutorial/compose.py /tmp/rec-debutant public/tutoriels/debutant.mp4 --config tools/tutorial/debutant.json --steps 7 --poster public/tutoriels/debutant.jpg
python3 tools/tutorial/compose.py /tmp/rec-avance   public/tutoriels/avance.mp4   --config tools/tutorial/avance.json   --steps 8 --poster public/tutoriels/avance.jpg
```

`--steps` est le nombre d'étapes du parcours (7 en débutant, 8 en avancé) : il règle la barre de progression sous la vidéo.

## Comment ça marche

- `recorder.mjs` : capture l'écran en boucle (`Page.captureScreenshot` avec `clip.scale`, plus net que `startScreencast`) et note, dans
  `events.json`, les images avec leur heure, les légendes, les mouvements de curseur, les clics, les accélérés et les coups de caméra.
  Le curseur n'est **pas** dessiné dans la page : la capture est trop lente pour qu'il soit fluide (environ 12 images/s).
- `tutorial.mjs` : le scénario de chaque niveau, avec les vrais boutons du site (si l'interface change, on adapte les sélecteurs ici).
- `compose.py` : reconstruit les 30 images/s : choisit l'image de page la plus récente, applique la caméra (zoom, déplacement), dessine le
  curseur, les ondes de clic, les légendes et la progression, fond les deux images quand la page « saute » (le défilement est instantané),
  accélère les attentes (création de la vidéo), mixe la musique et de petits sons de clic, puis encode en H.264 (`loudnorm` pour le volume).
- Les textes de la vidéo (légendes, introduction, conclusion) sont dans `tutorial.mjs` et `debutant.json` / `avance.json`.

## À refaire quand…

l'interface du studio change (une étape, un bouton, un texte) : relancer les quatre étapes ci-dessus et vérifier la vidéo. Le test
`tutoriels` de `test/studio.test.js` refuse une vidéo de plus d'une minute, non verticale ou trop lourde.
