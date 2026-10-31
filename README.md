# Studio Lisnard

**Plateforme dédiée à la création de TikTok / Reels** à partir d'extraits des interviews YouTube de David Lisnard : on choisit un extrait
(proposé par l'IA ou libre), on ajoute des sous-titres, de la musique, puis on télécharge la vidéo verticale.
La page d'accueil (`/`) est le studio ; les anciennes adresses `/studio/`, `/videos/` et `/tendances/` y redirigent (301, la requête
`?v=…` est conservée). Il n'y a plus de page publique de recherche, de liste de vidéos ni de tendances.

**Ce qui reste en place derrière le studio** : l'indexation des transcriptions (synchronisation des chaînes, Supadata, Whisper,
traduction, résumés automatiques), l'admin et les statistiques. Les anciennes adresses publiques de recherche, de résumés et de
tendances (`/api/search`, `/api/summary/…`, `/api/trends…`, `/api/latest`, `/api/videos`, `/api/stats`) ont été retirées.

> Le dépôt s'appelle encore `A-t-il-dit-a` et le domaine `lisnardfacts.fr` : seuls le nom affiché et le logotype changent.

*Historique : le site est né comme « Lisnard Facts », un fact-checking qui retrouvait si une phrase avait été prononcée dans une
interview. Ce moteur de recherche public a été retiré.*

## Fonctionnement

- Les transcriptions sont **stockées en base** (Postgres) : le studio s'en sert pour les sous-titres et les extraits proposés.
- Interface **/admin** (protégée par mot de passe) pour :
  - ajouter une vidéo à partir de son URL (transcription récupérée via Supadata, ou collée à la main en SRT / VTT / `[00:12] texte` / texte brut) ;
  - corriger la transcription segment par segment (lecteur YouTube intégré, couper / fusionner / insérer / supprimer, chercher-remplacer, Ctrl+S) ;
  - modifier titre, chaîne, date ; supprimer une vidéo.

## Vidéos sans sous-titres : transcription locale gratuite (Whisper)

Quand YouTube n'a aucun sous-titre pour une vidéo (« Pas de sous-titres disponibles »), Supadata ne peut rien renvoyer. Pour une
vidéo **récente**, la synchro réessaie toute seule (les sous-titres automatiques arrivent parfois après quelques heures). Pour une
vidéo plus ancienne, `tools/transcribe.py` la transcrit **gratuitement sur ton ordinateur** : `yt-dlp` télécharge l'audio,
**Whisper** (via `faster-whisper`, libre) le transcrit en local, et le résultat est envoyé à l'admin du site. Aucun crédit
n'est dépensé, et ça fonctionne même sur des vidéos sans aucun sous-titre.

```bash
pip install -r tools/requirements.txt          # Python 3.10+ ; aucun ffmpeg à installer

# toutes les vidéos « en échec » de la page Synchronisation
python tools/transcribe.py --site https://TON-SITE.up.railway.app --all-failed

# une vidéo précise (ajoutée au site si elle n'y est pas)
python tools/transcribe.py --site https://TON-SITE.up.railway.app https://www.youtube.com/watch?v=XXXXXXXXXXX
```

Le mot de passe de l'admin est lu dans `ADMIN_PASSWORD`, sinon demandé (ne l'écris dans aucun fichier du dépôt).
Options utiles : `--model` (`tiny`, `base`, **`small`** par défaut, `medium`, `large-v3`, `large-v3-turbo` : plus le modèle est gros,
plus c'est précis, mais lent sans carte graphique), `--srt-dir dossier --no-upload` (écrit des fichiers `.srt` sans rien envoyer, à coller
dans l'éditeur si tu préfères), `--cookies-from-browser chrome` (si YouTube refuse le téléchargement), `--prompt` (noms propres à bien
orthographier : « David Lisnard, Cannes, Nouvelle Énergie… » par défaut).

**Si le modèle ne se télécharge pas** (erreurs « connexion fermée » vers `huggingface.co`) : le modèle Whisper est hébergé sur
Hugging Face, que certains réseaux, VPN, antivirus ou pare-feu bloquent. Le script le dit avant de télécharger la moindre vidéo.
Réessaie plus tard ou depuis un autre réseau ; sinon télécharge les fichiers du modèle avec ton navigateur
(<https://huggingface.co/Systran/faster-whisper-small/tree/main> : `config.json`, `preprocessor_config.json`, `model.bin`,
`tokenizer.json`, `vocabulary.txt`) dans un dossier, puis ajoute `--model C:\whisper-small` (le chemin de ce dossier) à la commande.

Garde-fous : une vidéo qui a déjà une transcription n'est **jamais** retouchée (sauf `--overwrite`, à éviter : il écraserait tes
corrections) ; une transcription Whisper n'est pas marquée « corrigée » ; une vidéo en échec passe à « transcrite » ; une vidéo en échec
n'empêche pas les suivantes. À lancer sur **ton ordinateur** et pas sur Railway (calcul lourd, et YouTube bloque les téléchargements depuis
les serveurs). Comme les sous-titres automatiques, la transcription peut contenir des erreurs (noms propres) : corrige-les dans l'éditeur.
Note : télécharger des vidéos YouTube sort du cadre des conditions d'utilisation de la plateforme ; c'est ici un usage personnel pour
vérifier des propos publics, à ta charge.

## Studio de clips TikTok / Reels

Objectif : créer des vidéos verticales à partir des meilleurs extraits d'une interview, avec sous-titres stylés et musique. Les
sous-titres n'ont besoin ni d'IA ni d'API : on dessine le texte de la transcription, déjà horodaté. Le LLM (OpenRouter) ne sert
qu'à choisir les extraits.

**Côté admin (éditeur d'une vidéo, panneau « Clips TikTok ») :**

- **Fichier vidéo par vidéo** : tu télécharges la vidéo toi-même (de préférence en 720p) et tu la déposes dans l'éditeur de la
  vidéo, panneau « Clips TikTok ». Le dépôt se fait **par morceaux de 8 Mo** (reprise automatique après une coupure, pas de limite de
  durée de requête). ffprobe vérifie que c'est bien une vidéo (mp4, mov, mkv, webm) et **compare sa durée à celle de la vidéo
  YouTube** : un écart de plus de 3 s signale une autre version, dont les horaires seraient décalés.
- **Stockage** : sur disque, dans `STORAGE_DIR` (sur Railway : volume monté sur `/data`, 5 Go sur ce plan). Le fichier n'est jamais
  servi au public (l'aperçu de l'éditeur exige la session admin) ; il disparaît avec la vidéo ou via « Supprimer le fichier ».
- **Interrupteur « Autoriser les clips pour le public »**, par vidéo : tu choisis ce qui sera exposé, et tu ne dois autoriser que
  des vidéos dont tu peux diffuser des extraits (droits des chaînes d'origine).
- **Extraits proposés par l'IA** : les moments les plus susceptibles de devenir **viraux sur TikTok**, de 15 à 60 s, jusqu'à 20 par
  vidéo, seulement s'ils sont vraiment forts (voir « Qualité » ci-dessous), avec titre factuel, raison et potentiel viral noté de 1
  à 10 ; les 6 premiers sont affichés, le reste sur demande. La consigne du modèle décrit ce qui marche sur TikTok : accroche immédiate,
  moment fort (position tranchée, émotion, punchline, anecdote, chiffre qui surprend, sujet qui parle à beaucoup de monde), idée courte et
  complète, idéalement 20 à 45 s. Le modèle ne choisit que des **numéros de lignes** de la transcription : les horaires viennent de la
  transcription et il ne peut ni inventer ni modifier un mot. **Gros morceaux** : une ligne de plus de 12 s (sous-titres automatiques, texte collé avec peu d'horodatages) est découpée en phrases avant d'être envoyée au modèle, aux horaires estimés comme dans l'éditeur (durée répartie selon la longueur des mots ; sans durée connue, un long texte garde son temps de parole), sinon aucun extrait de 15 à 60 s ne pouvait être choisi. Garde-fou de fidélité conservé : un extrait commence et finit sur une
  phrase entière et ne coupe jamais avant un « mais », une nuance, une réserve ou une condition qui change le sens. Résultats stockés ;
  ils sont signalés comme périmés si la transcription change. Modèle : `CLIP_MODEL`, par défaut `openai/gpt-4.1-mini` (sans raisonnement,
  environ 0,01 $ par interview), indépendant du modèle des résumés. Réglages : `CLIP_MAX_SUGGESTIONS` (20), `CLIP_MIN_S` (15),
  `CLIP_MAX_S` (60), `CLIP_MIN_SCORE` (7) ; certains extraits sont écartés ensuite (durée hors limites, chevauchement avec un mieux noté).
  **Qualité** : le modèle a l'ordre d'être sévère (note de 9-10 réservée à l'exceptionnel), de ne jamais proposer salutations, accueil,
  remerciements, au revoir, transitions, questions de l'intervieweur ni phrases vagues, et de répondre par une liste vide plutôt que de
  remplir. Le code écarte ensuite, sans modèle (`src/clip-quality.js`) : les notes sous `CLIP_MIN_SCORE` (1 pour tout garder), les extraits
  qui saluent dans leurs 12 premiers mots ou prennent congé dans leurs 14 derniers, ceux dont plus de 6 % des mots sont des politesses,
  ceux qui ont moins de 10 mots porteurs de sens, ceux faits surtout de questions (transcription ponctuée), et — pour une interview de
  plus de 5 minutes — ceux des 60 premières ou dernières secondes sauf note de 9 ou plus. Une interview sans passage assez fort donne une
  **liste vide** (conservée : le modèle n'est pas relancé à chaque ouverture) ; le studio propose alors le choix à la main dans la
  transcription. Les extraits déjà générés ne sont pas filtrés après coup : il faut les régénérer depuis l'admin.
- **Description TikTok prête à copier-coller** : le même appel au modèle écrit, pour chaque extrait, une accroche (1–2 phrases, fidèle à
  l'extrait) et **2 à 4 hashtags**. Elle est générée **une seule fois**, avec les extraits, et stockée avec eux (aucun appel de plus quand
  un visiteur ouvre le studio). Les hashtags sont nettoyés côté serveur (2 à 4, sans doublon, repli `#lisnard #politique`). Les
  extraits générés avant cette version n'ont pas de description : il faut les régénérer depuis l'admin.
  Dans l'onglet « Créer », le bloc « Description à copier-coller » reprend la description de l'extrait choisi, suivie de la source et des
  crédits d'images ; elle reste modifiable.
- **Bibliothèque de musiques** (admin → « Musique ») : l'admin dépose ses propres morceaux (MP3, M4A, WAV, OGG, FLAC ; 8 s à 10 min, 40 Mo),
  avec titre, catégorie (motivant, épique, cinématique, autres) et crédit facultatif, et confirme avoir le droit de les utiliser. Le
  serveur vérifie le fichier, le convertit en MP3 stéréo et **égalise le volume** (−16 LUFS, pour que tous sonnent pareil sous la voix ;
  5 minutes conservées), puis le range sur le volume (`<STORAGE_DIR>/music/`, catalogue dans les tables `studio_music` et
  `studio_music_hidden`). Les morceaux apparaissent aussitôt dans l'onglet « Musique » du studio ; on peut les masquer, les renommer, les
  recatégoriser ou les supprimer, et masquer les morceaux d'origine. Les musiques « tendance » de TikTok ne sont pas disponibles : elles
  sont réservées à l'application TikTok (on peut les ajouter à la vidéo dans TikTok, après le partage).
- **Bouton « Publier sur TikTok »** (une fois le clip prêt) : sur téléphone, la vidéo est **préchargée dès qu'elle est prête** (le
  navigateur n'autorise le partage que dans la seconde qui suit le clic : télécharger le fichier après le clic le faisait échouer) ; le
  clic copie la description et ouvre aussitôt la fiche de partage du téléphone, où TikTok apparaît avec la vidéo. Si la fiche ne peut pas
  s'ouvrir, la vidéo est enregistrée et l'appli TikTok est ouverte (lien `snssdk1233://`, avec repli sur le site sous Android). Sur
  ordinateur, le bouton ouvre `tiktok.com/upload`, télécharge la vidéo et copie la description. Le partage fait depuis le téléphone est
  compté par `POST /api/studio/render/:id/used`. La publication **automatique** n'est pas faite : l'API TikTok « Content Posting »
  exige une application TikTok validée (audit) et, sans elle, ne publie qu'en privé.
- **Studio public** (`/studio/`) : les visiteurs choisissent une interview dont l'admin a autorisé les clips, prennent **un extrait** (une
  proposition de l'IA, ou un passage de la transcription : environ 25 s à partir de la ligne touchée ; 90 s au plus), puis habillent le clip :
  - **étapes** : le studio se fait une étape à la fois, avec une barre numérotée en haut (✓ pour les étapes faites) et des boutons
    « Retour » / « Étape suivante » : 1 interview (page d'accueil du studio), 2 niveau, 3 extrait, 4 sous-titres, 5 musique, 6 format
    (cadrage), 7 écran de fin (niveau avancé seulement), 8 créer. Sans niveau choisi on ne passe pas l'étape 2 ; sans extrait, on ne passe
    pas l'étape 3. On peut revenir à n'importe quelle étape déjà ouverte ; les modèles enregistrés (réglages d'habillage) s'affichent à
    partir de l'étape « Sous-titres », en niveau avancé ;
  - **niveaux** (`studio.level.v1` dans le navigateur, modifiable à tout moment par « Changer de niveau ») : **avancé** = tout ce qui est
    décrit ici ; **débutant** = un parcours simple, plus court (7 étapes, sans écran de fin), en plus gros caractères, fait pour des
    personnes peu à l'aise avec les sites (agrandi à partir de l'étape « Extrait » : l'étape « Niveau » a la même taille pour tout le monde) : seulement les extraits proposés par l'IA (en grandes cartes, un seul bouton « Choisir cet
    extrait » ; ni passage libre, ni recherche, ni réglage de bornes), seulement le **style** des sous-titres (ni police, couleurs, contour,
    position ni correction du texte), la musique sans catégories ni volumes, le format sans logo ni miroir, et la création sans choix
    de qualité (HD). Les outils masqués portent l'attribut `data-adv` (masqués en CSS dans `.studio[data-level="debutant"]`) ; leurs
    réglages sont remis à des valeurs simples (`BEGINNER_DEFAULTS` dans `studio-core.js` : ni miroir, ni logo, ni écran de fin, HD,
    musique à 25 %, voix à 100 %) et **rétablis** si la personne repasse en avancé (en mémoire : perdus si elle recharge la page entre
    les deux). Un passage libre choisi en avancé reste affiché (« Ton passage actuel ») mais ne se modifie pas en débutant ;
  - **un extrait, sans réglage des bornes** : l'écran « Extrait » ne propose plus de boutons − / + ni de champs d'instant (trop compliqué).
    Les extraits de l'IA sont des cartes avec un bouton « Utiliser cet extrait » (« ✓ Extrait choisi » une fois pris) ; « Choisir un autre
    passage » cherche un mot dans la transcription et touche une ligne. Choisir un extrait remplace le précédent (les anciens brouillons à
    plusieurs extraits sont ramenés au premier). Une ligne coupée au milieu ne garde que les mots dits dans la partie conservée, à leur
    horaire d'origine ;
  - **5 styles TikTok** : mots en surbrillance, un mot à la fois, karaoké, classique, sur fond sombre ;
  - **réglages** : police (22 polices libres dans `public/fonts/studio/`), taille, couleur du texte et du mot actif, contour
    (épaisseur et couleur), ombre, fond sombre (couleur, opacité et **arrondi**, de l'angle droit aux bords entièrement ronds), majuscules, mots affichés à la fois, largeur, animation « pop » ;
  - **position** : on **glisse les sous-titres** directement sur l'aperçu (ou boutons Haut / Milieu / Bas / Centrer). Pendant le
    glissement, des **repères pointillés** montrent le centre de l'écran ; le bloc s'**aimante** au centre horizontal et vertical, et
    les repères s'allument en rose quand il est exactement centré (petite vibration au toucher) ;
  - **texte des sous-titres** (onglet Sous-titres › Texte) : on corrige les mots mal reconnus ligne par ligne, avec le clip qui se place
    sur la ligne (bouton ▶ avec son horodatage). **L'horodatage d'origine est toujours conservé** : la ligne garde son début et sa fin,
    et les mots corrigés (plus ou moins nombreux) sont répartis sur la même durée. Une ligne vidée n'affiche aucun sous-titre. Les
    corrections ne concernent que ce clip : la transcription du site n'est jamais modifiée (elles sont gardées dans le navigateur, par
    interview, tant que la transcription ne change pas). Un avertissement s'affiche si une ligne s'éloigne beaucoup de la transcription
    (`lineSimilarity` < 60 %, pluriels et accents ignorés) et l'engagement à ne pas déformer les propos couvre les sous-titres corrigés.
    Côté serveur : `edits` = `{ "<début de la ligne en ms>": "texte" }`, 300 lignes et 500 caractères par ligne au maximum ;
  - **musique** : la **bibliothèque de l'admin** (voir ci-dessous) et 10 morceaux originaux libres de droits (`tools/make_studio_music.py`),
    classés par catégorie (motivant, épique, cinématique, autres) avec écoute ▶, volumes de la musique et de la voix ; le crédit d'un
    morceau de la bibliothèque est ajouté à la description à copier ;
  - **cadrage 9:16** : vidéo entière sur fond flou, ou **plein écran** recadré : on **glisse la vidéo** vers la gauche ou la droite sur
    l'aperçu pour recentrer sur la personne (un curseur permet d'affiner). L'aperçu plein écran est la vidéo entière recadrée en direct
    par le navigateur avec la même formule que le rendu (`décalage = (largeur de la vidéo − largeur de l'écran) × position`), donc
    aucun calcul serveur pendant le glissement ;
  - **cadrage automatique sur le visage** (plein écran) : le cadre **suit la personne** au lieu de rester fixe. Les visages sont repérés
    **une fois par interview**, côté serveur (admin → fiche de la vidéo → « Cadrage automatique sur le visage » ; lancé tout seul au dépôt
    de la vidéo, à relancer pour les vidéos déjà déposées). Détecteur YuNet (OpenCV Zoo, licence MIT) : **une image toutes les 0,2 s**
    (une toutes les 0,4 s au-delà d'1 h 30) en 640 px (`STUDIO_FACES_MAX_SIDE`, 384 auparavant), soit environ 0,6 s de calcul par seconde de vidéo (une heure
    d'interview : une demi-heure en arrière-plan) ; un visage doit alors faire au moins ~5 % de la largeur de l'image (6 à 9 % avant : les
    plans larges n'étaient pas suivis). **Deuxième passe** (`src/studio/faces-rescue.js`, `STUDIO_FACES_RESCUE=off` pour la couper) : les images
    **sans visage dans un plan où un visage est vu** (la personne est là, la détection a hésité) sont reprises en 1280 px, et les plans longs
    sans visage sont sondés (une image toutes les 2 s) : si une sonde trouve un visage, tout le plan est repris. Au plus 60 % des images et
    40 minutes de calcul ; le nombre d'images où un visage a été retrouvé est affiché dans l'admin. Seuil de détection abaissé de 0,6 à 0,5 (un
    visage de trois quarts ou en partie caché est mieux gardé ; une fausse détection isolée ne devient pas une personne suivie : il faut au
    moins 2 images et 20 % de présence). Les analyses plus anciennes sont signalées « à refaire » dans l'admin ; le bouton « Refaire les
    analyses anciennes » (onglet « Reconnaissance », `POST /api/admin/faces/reanalyze-all`) les relance une par une, l'ancienne analyse
    restant utilisée jusqu'à la fin de la nouvelle. Les **changements de plan** sont repérés en même temps (ffmpeg, `scene`). Ensuite chaque clip n'a plus qu'à calculer la
    trajectoire (`public/js/framing.js`, module pur partagé avec le navigateur) : un visage suivi par plan (David Lisnard s'il est reconnu,
    sinon le plus gros, ou celui de gauche / de droite au choix), un cadre qui reste immobile tant que le visage reste près du centre puis
    se déplace en douceur (zone morte large : hochements et gestes ne font pas bouger le cadre ; départ et arrivée progressifs, vitesse et accélération bornées), et qui saute directement sur le visage du
    nouveau plan à chaque coupe de montage. Le rendu applique la même courbe image par image (`crop` avec `exact=1`) ; l'aperçu la rejoue
    en direct. Le suivi est **coché au départ** (il ne s'applique que si le visage est assez grand et visible ; le visiteur peut le décocher). Quand le visage est trop petit (moins de 4 % de la largeur de l'image) ou vu sur moins de la moitié de l'extrait, le studio dit que le cadrage automatique n'est pas disponible pour ce clip (ou pour tel extrait) et le cadre manuel s'applique, comme sans analyse ou sans visage trouvé ; une interview où un visage n'est vu que sur moins de 15 % du temps n'offre pas du tout l'option. L'admin voit, pour chaque vidéo, la part du temps où un visage est détecté et sa largeur médiane. Coupure : `STUDIO_FACES=off`. Table `video_faces` (résultat
    par vidéo, invalidé si le fichier est remplacé).
  - **reconnaissance de David Lisnard** : dans l'admin, onglet « Reconnaissance », on donne une vingtaine de photos de lui (une personne par
    photo, visage d'au moins 50 px). Chaque photo est réduite à une **empreinte de 128 nombres** (modèle SFace d'OpenCV Zoo, licence Apache
    2.0) et à une vignette redressée pour vérification ; les photos elles-mêmes ne sont pas conservées. Une photo qui ne ressemble à
    aucune autre est signalée « à vérifier » (mauvaise personne ?). À l'analyse d'une interview, les visages des **plans à plusieurs
    personnes** (journaliste, public) sont comparés aux photos (quelques images de chaque visage, prises dans la vidéo) ; le studio suit
    alors David Lisnard plutôt que le visage le plus gros. Seuil : similarité cosinus 0,363 (valeur recommandée pour SFace) ; la
    ressemblance d'une photo de la vidéo est la moyenne de ses trois meilleures similarités avec les photos de référence ; celle d'un visage suivi est la moyenne du tiers supérieur de ses comparaisons (six images réparties sur tout le plan, pas seulement l'extrait choisi). Un visage est retenu s'il atteint le seuil, ou s'il atteint 0,28 et dépasse nettement (de 0,10) les autres visages du plan. Quand la personne n'est pas reconnue, le studio affiche la ressemblance la plus forte relevée pour expliquer pourquoi. Quand les photos changent, les vidéos déjà
    analysées passent à « reconnaissance à mettre à jour » : le bouton de l'onglet relance seulement la reconnaissance, sans refaire la
    détection. Tables `face_references` et `video_faces.ident`. La détection et la reconnaissance tournent dans un thread séparé, avec un
    petit moteur de réseaux de neurones écrit pour l'occasion (`nn.js`, noyaux WebAssembly SIMD de `tools/kernels.wat` assemblés par
    `tools/build_kernels.mjs`) : aucune bibliothèque native à installer, 7 fois plus rapide que du JavaScript seul, mêmes résultats
    qu'ONNX Runtime (à 10⁻⁶ près, vérifié).
  - **deux panneaux** (plein écran avec suivi du visage) : quand, dans un plan, le visage suivi n'est pas repéré partout (moins de 95 % du
    plan : `FRAMING.splitBelow`) alors qu'une **deuxième personne** est là (vue en même temps que lui, au moins 3 images, et **nettement à côté** :
    ses visages sont séparés d'au moins 1,3 fois la largeur de deux visages qui se touchent, `FRAMING.splitSepMargin` ; jamais deux fois la même
    personne : un visage dédoublé par la détection, ou deux visages qui ressemblent tous les deux à David Lisnard, ne donnent pas deux panneaux),
    le cadre risquerait de se retrouver dans le vide. Chaque panneau est resserré pour ne jamais montrer l'autre personne (moins de 22 % de la
    largeur de la source, `FRAMING.splitHardMinW` : pas de découpe, le cadrage simple reste). L'écran est alors **coupé en deux, pour ce plan seulement** : la personne suivie (David Lisnard s'il est
    reconnu) **en haut**, l'autre personne (le journaliste) **en bas**, chacune dans un panneau 9:8 centré sur son visage et qui le suit
    (fenêtre choisie pour que le visage fasse environ 30 % du panneau, entre 34 % et 60 % de la largeur de la source ; le visage un peu au-dessus
    du milieu). Ailleurs dans l'extrait, le cadrage simple continue ; au plus 8 plans par extrait sont coupés en deux. Dans ces plans le
    visage compte comme « repéré à 100 % » (rien n'est perdu), ce qui évite aussi le repli sur le cadre manuel quand le visage suivi est trop
    peu visible. Rendu : deux `crop` posés par-dessus le cadrage simple (`overlay` avec `enable` sur les plans concernés, `vstack`) ;
    aperçu : la même vidéo dessinée deux fois dans un canevas avec les mêmes fenêtres (`splitAtClip`, `public/js/framing.js`). Pas de
    deuxième personne vue avec la première : le cadrage simple reste (rien à mettre en bas). L'étape « Format » l'explique ;
  - **miroir** : retourne l'image gauche-droite. Il est appliqué après le cadrage et avant l'incrustation : les sous-titres
    ne sont jamais retournés (en revanche les textes visibles dans l'image le sont). Il ne change pas les droits sur la
    vidéo d'origine ;
  - **b-roll** (zooms et images ; **retiré de l'interface** pour simplifier le studio : le serveur sait toujours les rendre si une demande en contient, mais plus aucun écran ne les propose) :
    - **zooms** sur les mots importants : un zoom avant juste avant chaque mot repéré (chiffres, mots longs ou rares, absolus comme
      « jamais », mots repris), un zoom arrière un peu après ; au plus un zoom tous les 6 s, jamais deux collés. « Placer
      automatiquement » les propose, et l'utilisateur les **choisit lui-même** : ajouter un zoom avant / arrière à l'instant de l'aperçu,
      changer l'instant (champ à taper, `0:12,5`) ou le type, en supprimer, régler la force (léger 1,10 / moyen 1,20 / fort 1,32) et
      cliquer sur l'aperçu pour choisir le **point de zoom** (par défaut à hauteur de visage). Les sous-titres et les images ne zooment pas ;
    - **mouvement sans saccade** : le zoom est une courbe en S continue (vitesse nulle au départ et à l'arrivée) décrite par des événements
      qui s'enchaînent toujours à partir du niveau atteint. Le rendu n'utilise **pas** le filtre `zoompan` de ffmpeg (il déplace sa
      fenêtre par pas entiers de pixels : saccades connues) mais `perspective`, dont les coins de fenêtre sont des nombres décimaux
      (interpolation au sous-pixel, 4 coins évalués à chaque image à partir du compteur d'images, sans dérive). Mesuré sur de vraies
      images : écart avec la courbe idéale < 0,2 px, contre plusieurs pixels et une irrégularité 10 fois plus forte avec `zoompan`
      (test `studio.test.js`). Le filtre n'est actif (`enable`) que pendant les zooms : le reste du clip n'est pas retraité (le filtre
      coûte environ 0,4 s de calcul par seconde de vidéo 1080 × 1920) ;
    - **aperçu identique** : le navigateur calcule la même courbe (`zoomAt` dans `studio-core.js`, partagé avec le rendu) et l'applique
      en `transform` à la vidéo seule ; écart avec le MP4 final de 2 à 3 px mesuré ;
    - **images** libres de droits (**Pixabay** ou Pexels) : recherche (mots du clip proposés), un appui ajoute l'image à l'instant de
      l'aperçu (2,5 s par défaut, 1 à 8 s, début et durée modifiables, 8 images au plus, sans chevauchement). Image plein écran par-dessus la
      vidéo pendant que la voix continue, fondu de 0,18 s et très léger zoom lent (même technique). Les crédits des auteurs sont
      ajoutés au texte « Source à citer ». Il faut une clé gratuite : `PIXABAY_API_KEY` (https://pixabay.com/api/docs/, ouverte à tous
      après inscription) ou `PEXELS_API_KEY` (Pexels a suspendu l'ouverture de nouvelles clés) ; sans clé, la section images est
      désactivée. Pixabay est choisi s'il a une clé (`STOCK_PROVIDER=pexels` pour forcer l'autre). La clé reste sur le serveur, qui
      interroge le fournisseur ; le navigateur ne donne qu'un **numéro** de photo, jamais une adresse. Le serveur retrouve l'adresse
      auprès du fournisseur, vérifie qu'elle est en https sur ses serveurs d'images (`pixabay.com`, `cdn.pixabay.com`,
      `images.pexels.com` ; les redirections sont suivies une à une et vérifiées, jamais vers un autre site), contrôle type et taille
      (15 Mo), garde le fichier dans `STORAGE_DIR/stock` (supprimé après une heure). Les vignettes des résultats sont l'adresse
      temporaire fournie (valable 24 h, usage prévu par Pixabay) ; les images utilisées sont téléchargées par le serveur, jamais
      appelées en direct. Recherches et téléchargements sont limités par visiteur (`STOCK_SEARCHES_PER_HOUR`,
      `STOCK_DOWNLOADS_PER_HOUR`). Licences : gratuit, y compris en usage commercial, crédit non obligatoire ;
  - **téléphone** : l'aperçu reste collé en haut de l'écran pendant qu'on règle (44 % de la hauteur, avec la barre de lecture à côté), et un
    bouton « Agrandir » le montre presque plein écran pour vérifier le rendu. Le titre de l'interview est dans le bandeau bleu (jamais coupé,
    même sur plusieurs lignes) et le texte d'accueil est masqué dans l'éditeur pour ne pas repousser l'aperçu. La mise en page du
    navigateur d'ordinateur n'est pas modifiée (breakpoint 900 px) ;
  - **aperçu en direct** : la vidéo (cadrage seul, 360 × 640) vient du serveur, les sous-titres sont dessinés par le navigateur avec
    le **même code** que le rendu (`public/js/studio-core.js`) : horaires des mots, groupes, tailles, réduction des mots trop
    longs. Vérifié image par image contre le MP4 final.
    Quand l'extrait change, l'aperçu s'arrête tout de suite, **revient à zéro** (curseur et temps compris) et affiche un grand rond qui
    tourne avec « Préparation de l'aperçu… » et « Il se passe quelque chose… » jusqu'à ce que le nouveau soit prêt ; un simple changement de format garde la position de lecture.
- **Rendu** : ffmpeg sur le serveur, sous-titres incrustés (ASS/libass), musique mixée sous la voix, MP4 H.264 + AAC en 1080 × 1920
  (ou 720 × 1280). **File d'attente** (`STUDIO_CONCURRENCY` clips à la fois, 1 par défaut ; `STUDIO_MAX_QUEUE`), limites par visiteur
  (2 clips en cours, `STUDIO_RENDERS_PER_HOUR` par heure, `STUDIO_PREVIEWS_PER_HOUR` aperçus), progression, annulation. Les clips
  sont **supprimés une heure** après leur création. Le fichier vidéo d'origine n'est jamais servi : seuls ces extraits sortent.
- **Statistiques** (admin → « Studio ») : clips créés, **téléchargés** (clic sur « Télécharger »), partagés (partage depuis le téléphone) et
  personnes ayant récupéré leur clip, pour aujourd'hui, 7 jours, 30 jours et depuis le début, avec la courbe des 14 derniers jours et les
  interviews les plus utilisées (table `studio_events`). Un clip compte une fois par type, même téléchargé plusieurs fois ; la lecture du
  clip dans la page n'est pas un téléchargement (le lien porte `?use=download`, le partage `?use=share`). Les personnes sont comptées
  avec une empreinte irréversible de l'adresse IP (HMAC avec `SESSION_SECRET`) : l'adresse n'est jamais stockée, l'empreinte est effacée
  après 90 jours (les compteurs restent) ; c'est une approximation (même connexion = une personne). Les mentions légales le décrivent.
- **Garde-fous** : la vidéo n'affiche plus de bandeau « Source » (choix de l'éditeur : la source va dans la description de la publication) ;
  l'onglet Créer prépare ce texte (« Source : titre · date — lien de l'interview ») avec un bouton Copier. Les sous-titres sont ceux
  de la transcription (corrections éventuelles signalées si elles s'en éloignent), et il faut cocher un engagement à ne pas
  déformer les propos avant de créer.
- **Fond des sous-titres** : libass ne sait pas arrondir son fond rectangulaire, et il le double de teinte là où deux lignes se
  chevauchent. Le fond est donc **dessiné** (tracé vectoriel ASS, un seul tracé pour toutes les lignes, une seule teinte) d'après la
  position de chaque ligne, **mesurée par libass lui-même** : `src/studio/box-probe.js` fait rendre chaque groupe de mots sur un fond
  noir avec un fond blanc rectangulaire de 1 px de marge, puis lit les largeurs de ligne sur l'image (mêmes polices, même mise à la
  ligne, même crénage que le clip). Aucune largeur de police n'est estimée. La mesure se fait dans la file d'attente, juste avant le
  rendu (environ 0,2 s). L'aperçu dessine le même tracé (SVG) à partir des mots tels que le navigateur les a placés ; le rayon du coin
  est `arrondi × (moitié de la hauteur d'une ligne de fond)`.
- **Taille des sous-titres** : la « taille » d'un style est une taille d'em (comme une `font-size`). libass dessine un texte de taille
  ASS N avec une em de N × `unitsPerEm / (winAscent + winDescent)` (mesuré, écart < 1 %) : `buildAss` convertit par police grâce à
  `em_ratio` (dans `src/studio/fonts.json`, calculé par `tools/fetch_studio_fonts.py`).
- **Limites connues** : les horaires des mots sont estimés (la durée de chaque ligne est répartie selon la longueur des mots) car
  nos transcriptions n'ont pas d'horaires au mot ; le karaoké remplit mot par mot dans l'aperçu et progressivement dans le MP4 ;
  l'état des clips est en mémoire (un redémarrage du serveur annule les créations en cours).
- **Sur Railway** : le volume est monté sur `/data` (`STORAGE_DIR=/data/storage`) et ffmpeg est installé dans l'image grâce à la
  variable `NIXPACKS_APT_PKGS=ffmpeg` (le constructeur réellement utilisé est Nixpacks, comme l'indique `railway.json`).

## Résumés automatiques

Chaque vidéo indexée a son **résumé, rédigé automatiquement** par un modèle (OpenRouter) à partir de la transcription : un
« En bref », puis des sections avec repères de temps, des puces et les mots importants en gras. Les résumés sont stockés en base
et se consultent dans l'admin.

- **Génération en arrière-plan** : toutes les 2 minutes, le serveur résume les vidéos indexées qui n'ont pas encore de résumé
  (les plus récentes d'abord, 5 par passe), quelle que soit l'origine de la transcription (synchro de la chaîne, ajout manuel,
  import, Whisper, correction à la main). Un délai de grâce de 3 minutes après la dernière modification évite de résumer pendant
  que tu corriges la transcription. `SUMMARY_AUTO=false` désactive ce travail.
- **Le public ne déclenche rien** : aucune route publique n'appelle le modèle, donc le trafic du site ne coûte rien en IA.
- **Une seule fois par vidéo** : seules les vidéos qui n'ont **pas encore** de résumé sont traitées. Un résumé existant n'est
  jamais refait automatiquement, ni si la transcription est corrigée ensuite, ni si les consignes de rédaction évoluent. Dans
  l'admin, l'éditeur signale simplement « la transcription a été modifiée depuis » ; pour refaire un résumé, il faut cliquer sur
  « Régénérer avec l'IA » (avec confirmation).
- **Échecs** : nouvelle tentative après 30 min, 1 h, 2 h, 4 h, puis abandon au bout de 5 essais (visible dans l'admin, bouton
  « Réessayer »). Clé refusée ou crédits épuisés : tout est suspendu 3 h (clé) ou 1 h (crédits) au lieu d'insister ; trois échecs
  d'affilée arrêtent aussi la passe.
- **Coût borné** : plafond de `SUMMARY_DAILY_CAP` résumés par jour (500 par défaut) et `SUMMARY_PER_CYCLE` par passe (5). Le
  premier déploiement résume tout le catalogue existant, vidéo après vidéo : compte quelques centimes par vidéo selon le modèle.
  Mise en pause possible à tout moment depuis **Admin → Synchronisation → Résumés automatiques**.
- **Admin** : compteurs (prêts / en attente / en échec), pause et reprise, « Lancer maintenant », liste des échecs.
- **Corriger un résumé à la main** : dans l'éditeur d'une vidéo, le panneau « Résumé IA » contient le texte du résumé (même format :
  `## En bref`, `## [12:34] Titre` pour un repère de temps cliquable, `- puce`, `**gras**`). Après « Enregistrer le résumé », il
  est marqué « généré par IA puis corrigé à la main » et reste tel quel (comme tout résumé
  existant, il n'est jamais refait automatiquement). Tu peux aussi l'écrire entièrement toi-même. Seul « Régénérer avec l'IA » le
  remplace, après confirmation. Le texte est nettoyé comme celui de l'IA (HTML et liens retirés).
- Fidélité : le modèle ne doit utiliser que le texte ; les repères de temps inexistants sont supprimés, le HTML retiré, la
  taille bornée. Une mention rappelle que le résumé est généré par IA et peut contenir des erreurs. Vidéos très longues : notes
  par partie, puis synthèse. Modèle : `SUMMARY_MODEL`, par défaut GPT (`openai/gpt-4.1-mini`, comme les extraits du studio) ; la traduction garde son propre modèle (`TRANSLATE_MODEL`). Les résumés déjà faits ne sont jamais refaits.

## Traduction automatique

Supadata renvoie la première langue disponible quand la langue demandée (champ « Langue », `fr` par défaut)
n'existe pas pour la vidéo. Si `OPENROUTER_API_KEY` est configurée, la transcription est alors **traduite par un modèle économique via OpenRouter**
(horodatages conservés, texte d'origine gardé sous chaque segment dans l'éditeur). Sans clé, le texte d'origine est
conservé et signalé (badge « langue : en »), et un bouton « Traduire en français » apparaît dans l'éditeur.

Une traduction n'est pas ce qui a été dit : sur le site, une phrase trouvée uniquement dans une transcription traduite
n'est jamais affichée comme « Oui, il l'a dit » mais comme **« Trouvé dans une traduction »**, avec un avertissement.

Modèle : `google/gemini-2.5-flash-lite` par défaut ; change-le avec `TRANSLATE_MODEL` (identifiant OpenRouter, cf. https://openrouter.ai/models). Un identifiant invalide suspend le traitement avec un message explicite au lieu de faire échouer chaque vidéo.

## Synchronisation automatique des chaînes

Page **/admin/#/sync**. On y ajoute une chaîne YouTube ; le site :

1. liste tout son historique (API YouTube Data) et met les vidéos en **file d'attente** ;
2. récupère leurs transcriptions petit à petit (25 par passe, une passe toutes les 5 minutes) ;
3. vérifie ensuite **chaque jour** si de nouvelles vidéos sont sorties et les ajoute.

**Shorts.** Seules les vidéos longues sont importées : une vidéo est un Short si elle dure 60 s ou moins, ou si elle figure
dans la liste des Shorts de YouTube pour la chaîne (nécessaire car un Short peut durer jusqu'à 3 min ; cette liste repose sur
une playlist interne de YouTube non documentée officiellement, avec repli sur la durée si elle est introuvable). Option
« Exclure les Shorts » par chaîne (activée par défaut). Le bouton **Retirer les Shorts…** supprime ceux déjà importés, après un
aperçu et une confirmation ; les Shorts supprimés sont mémorisés et ne reviennent jamais. Le bouton **Durée minimale…** écarte aussi les vidéos plus courtes qu'un seuil (181 s retire tous les Shorts, même de
1 à 3 min) ; « Retirer les Shorts… » applique ce seuil aux vidéos déjà importées. La durée est affichée sur l'accueil et
dans l'admin, et l'accueil masque toute vidéo de 60 s ou moins. Les vidéos ajoutées à la main et celles
corrigées à la main ne sont jamais supprimées.

Garde-fous :
- le traitement démarre **en pause** : rien n'est facturé tant qu'on n'a pas cliqué sur « Démarrer » ;
- seuls les sous-titres existants sont demandés (`mode=native`, 1 crédit Supadata par vidéo), jamais de transcription générée par IA ;
- **les vidéos déjà présentes ne sont jamais modifiées** : une transcription n'est posée que sur une vidéo créée par la synchro, encore en attente, sans aucun segment et jamais éditée (sous verrou de ligne). Les corrections manuelles sont donc toujours préservées ;
- une vidéo supprimée à la main est mémorisée et n'est jamais ré-ajoutée ;
- sous-titres absents : nouvel essai (6 h, 12 h, 24 h, 48 h) pour une vidéo récente, abandon immédiat pour une ancienne ; les vidéos en échec se relancent ou se saisissent à la main ;
- crédits ou clé refusés : le traitement se suspend (1 h / 6 h) au lieu de boucler.

Variables : `YOUTUBE_API_KEY` (liste des vidéos) et `SUPADATA_API_KEY` (transcriptions).

## Lancer en local

```bash
cp .env.example .env     # puis adapter (ou exporter les variables)
npm install
npm start                # http://localhost:3000  — admin : /admin/
npm test
```

Il faut un Postgres accessible via `DATABASE_URL` (les tables sont créées au démarrage).

## Déployer sur Railway

1. Créer un projet Railway, y ajouter un **service Postgres** et un service depuis ce dépôt GitHub.
2. Dans les **Variables** du service web :

   | Variable | Valeur |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (référence au plugin) |
   | `ADMIN_PASSWORD` | mot de passe de `/admin` |
   | `SESSION_SECRET` | chaîne aléatoire de 32+ caractères (`openssl rand -hex 32`) |
   | `SUPADATA_API_KEY` | clé Supadata (optionnelle tant que tu colles les transcriptions à la main) |
   | `OPENROUTER_API_KEY` | clé OpenRouter (traduction automatique des transcriptions, optionnelle) |
   | `TRANSLATE_MODEL` | modèle de traduction OpenRouter (optionnel) |
   | `YOUTUBE_API_KEY` | clé YouTube Data API v3 (pour la synchronisation automatique des chaînes) |

3. Générer un domaine public (Settings → Networking). Le healthcheck est `/api/health`.

Le site public ne contient aucun lien vers l'admin : accède-y directement par `/admin/` (mets l'adresse en favori).
La page **/mentions-legales/** (lien dans le pied de page) est un fichier statique, `public/mentions-legales/index.html` : éditeur
anonyme (particulier, identité communiquée à l'hébergeur, LCEN art. 6 III 2°), hébergeur, contact par e-mail, fonctionnement du
site, sources et données personnelles. Elle est rédigée d'après le fonctionnement réel du site ; à faire relire et à mettre à jour
si celui-ci change (cookies, statistiques, publicité…).

## Charte graphique

Reprise de https://www.unenouvelleenergie.fr/ : bleu `#1d257a`, chamois `#b0ad85`, rose `#d0165f`,
police Montserrat (fichiers dans `public/fonts/`). Le logo officiel n'est volontairement pas utilisé : le site a son propre logotype « Lisnard
*Studio* » (police Fraunces, fichiers dans `public/fonts/`, licence OFL ; « Lisnard » en bleu, « Studio » en rose italique).
Tout est dans [`public/css/theme.css`](public/css/theme.css) ; `app.css` et `admin.css` n'utilisent que ces variables.


## Téléchargement automatique des vidéos

Pour que le studio n'attende plus un dépôt à la main, le site peut **télécharger lui-même les interviews** (yt-dlp, outil libre) : `AUTO_DOWNLOAD=on`. Désactivé par défaut.

- **Quelles vidéos** : celles trouvées par la synchronisation des chaînes, **déjà transcrites** (traitement démarré dans l'admin), de **10 min ou plus** (`AUTO_DOWNLOAD_MIN_S`, format long seulement) et publiées depuis moins de 90 jours. Les vidéos ajoutées à la main ne sont jamais téléchargées ni touchées. Les plus récentes d'abord, une vidéo par passage (toutes les 5 min).
- **Fichier** : 720 p au plus (`AUTO_DOWNLOAD_MAX_HEIGHT`), MP4, rangé sur le volume (`<STORAGE_DIR>/videos`), pas dans la base. Mêmes contrôles qu'un dépôt à la main (ffprobe, durée comparée à celle de YouTube : un fichier de durée différente est écarté). Un fichier déposé à la main pendant le téléchargement n'est jamais remplacé.
- **Ensuite, tout est automatique** : détection des visages (cadrage), clips **autorisés** (une seule fois : si l'admin les désactive, le choix est respecté ; `AUTO_ENABLE_CLIPS=off` pour garder la main) et extraits proposés par le modèle.
- **Conservation** : les fichiers téléchargés par le site sont supprimés **après 90 jours** (`VIDEO_RETENTION_DAYS`, d'après la date de publication) ; la transcription, les clips et leurs réglages restent. Les fichiers déposés à la main ne sont jamais supprimés. Un clip de la bibliothèque dont l'interview n'est plus disponible ne peut plus être recréé ni modifié (message explicite) ; il reste téléchargeable tant que sa vidéo est gardée.
- **Place** : pas de téléchargement sous `AUTO_DOWNLOAD_MIN_FREE_MB` (1 500 Mo) d'espace libre ; vidéos plus grosses que `MAX_VIDEO_MB` refusées. Nettoyage toutes les 6 h.
- **Pannes** : échec = nouvelle tentative après 2 h, 4 h, 8 h, 16 h puis 24 h (5 essais) ; vidéo indisponible (privée, supprimée) = abandon ; **YouTube qui bloque le serveur** (contrôle « robot », fréquent depuis un hébergeur) = pause de 3 h sans compter d'essai. Dans ce cas, `YTDLP_PROXY` (proxy) ou `YTDLP_COOKIES_FILE` (fichier de cookies sur le volume) sont les remèdes ; sinon, télécharger sur un ordinateur et déposer le fichier comme avant. L'admin (page Synchronisation) montre l'état, l'espace, la dernière erreur, « Télécharger maintenant » et « Réessayer les échecs ».
- **yt-dlp** : l'exécutable officiel est téléchargé une fois sur le volume (`<STORAGE_DIR>/bin/yt-dlp`, somme SHA-256 vérifiée) puis mis à jour chaque jour (`yt-dlp -U`), car YouTube change souvent. `YTDLP_PATH` impose un exécutable précis (alors pas de mise à jour automatique). Node sert de moteur JavaScript à yt-dlp (`YTDLP_JS_RUNTIME`, `off` pour le retirer).
- **Droits** : télécharger des vidéos YouTube demande l'accord de leurs auteurs (celui de Nouvelle Énergie pour ses chaînes et celle de David Lisnard ; pas pour des chaînes tierces).
- **Tests** : `test/video-fetch.test.js` (faux yt-dlp qui copie une vraie vidéo : choix des vidéos, succès, échecs, garde-fous, conservation, installation vérifiée).

## Accès réservé aux adhérents Nouvelle Énergie

Le studio (`/` et `/api/studio/*`) peut être réservé aux adhérents grâce au **SSO de Nouvelle Énergie** (OpenID Connect, Keycloak ; doc : espace adhérents → Initiatives → Connexion). **Le mur (`/mur/`) reste public.** L'admin garde son mot de passe, à part.

- **Activation** : variable `MEMBERS_ONLY=on` (voir `.env.example`). Sans elle, le studio reste ouvert, comme avant. Avec `MEMBERS_ONLY=on` mais sans `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET` (16+ caractères), l'API du studio répond 503 : rien ne s'ouvre par oubli.
- **Parcours** : « Me connecter » → `/api/auth/login` → SSO (Authorization Code + PKCE S256, scopes `openid adherent`) → la personne saisit son e-mail et reçoit un code à 6 chiffres → `/api/auth/callback` : échange du code (client confidentiel, secret en en-tête Basic), vérification du jeton (signature RS256 par les clés publiques du SSO, émetteur, audience, expiration, nonce) → cookie de session. L'adhésion est vérifiée par le SSO à chaque connexion.
- **Session** : cookie signé `mbr` (HttpOnly, SameSite=Lax, Secure en HTTPS, 7 jours par défaut), **rien en base**. Il contient `sub`, le prénom (affichage « Bonjour Camille » seulement) et le jeton d'identité (nécessaire à la déconnexion SSO ; il porte aussi les claims envoyées par le SSO, donc la session est lisible dans le navigateur de la personne, pas ailleurs). Règles d'usage des données du SSO respectées : le scope `email` n'est pas demandé et l'e-mail éventuellement présent est ignoré, rien du profil (prénom, département, ville, pays) n'est enregistré côté serveur ; aucune liste d'adhérents.
- **Erreurs** : `membership_not_found` (propose d'adhérer), `membership_unavailable`, `code_throttled`, `code_send_failed` expliquées sur l'écran de connexion ; tout autre échec est affiché de façon neutre avec un bouton « Réessayer ».
- **Déconnexion** : `POST /api/auth/logout` efface le cookie puis renvoie vers la fin de session SSO (`id_token_hint` + `post_logout_redirect_uri` = `PUBLIC_URL/`), sinon la personne serait reconnectée sans rien saisir.
- **Demande d'accès** (une fois, auprès de l'équipe numérique de NE) : nom et description de l'app, porteur du projet joignable, serveur capable de garder un secret, redirect URI exacte `PUBLIC_URL/api/auth/callback` (un client `-dev` séparé pour les essais), URL de retour après déconnexion `PUBLIC_URL/`, claims utilisées : `sub` et `given_name` seulement. Les mentions légales décrivent ce traitement.
- **Tests** : `test/members.test.js` (faux SSO local qui signe de vrais jetons RS256 et vérifie secret et PKCE).

## Le mur des clips

Deuxième section du site, `/mur/` : un mur des meilleurs TikToks publiés avec le hashtag **#lisnard2027** (réglable), dans la charte du site.

- **Source** : l'acteur Apify **clockworks/tiktok-scraper** (variable `APIFY_TOKEN`, jeton personnel Apify). Le serveur lance l'exécution
  (`POST /v2/acts/clockworks~tiktok-scraper/runs`, entrée `hashtags` et `resultsPerPage`, sans téléchargement de vidéos), attend la fin, lit le jeu de
  données et l'enregistre dans la table `wall_clips` (`src/wall/apify.js`, `src/wall/wall.js`). **Le mur ne parle jamais à Apify** : les visiteurs lisent
  la base. Sont écartés : les publicités, les vidéos sans le hashtag, les éléments d'erreur de l'acteur. Un clip déjà connu voit ses compteurs mis à jour.
- **Actualisation** : automatique toutes les `WALL_REFRESH_HOURS` heures (**24** par défaut, 0 pour seulement à la demande), et à la demande dans l'admin
  (onglet « Mur », au plus une toutes les 2 minutes). Un échec n'efface rien : le mur garde ses clips et l'admin voit l'erreur ; on réessaie au bout
  d'une heure. Coût indicatif (1,70 $ pour 1 000 résultats) : 100 vidéos par jour reviennent à environ 5 $ par mois ; l'admin l'affiche.
- **Classement** : `score = vues × 1 + j'aime × 10 + commentaires × 50` (`WALL_WEIGHTS="1,10,50"`), calculé à la lecture. **Le mur ne montre que les 13 meilleurs clips** (`WALL_MAX`, 13 par défaut) : les 100 vidéos récupérées servent à les choisir. Le visiteur peut
  réordonner ces 13 par vues, j'aime, ou commentaires (sans nouvel appel au serveur : un seul chargement par période), ou choisir les 13 meilleurs des 7 derniers jours (**période affichée par défaut**), des 30 derniers jours ou depuis le début (s'il n'y a aucun clip récent, un bouton propose de voir depuis le début) ; les trois premiers du classement forment le podium. Adresses partageables :
  `/mur/?tri=vues&periode=30` (la période par défaut, 7 jours, n'apparaît pas dans l'adresse ; `periode=tout` pour depuis le début).
- **Affichage** : un collage d'affiches, dans la charte du site (bleu, rose, chamois, Montserrat, Fraunces pour les chiffres du rang comme pour le logotype) : chaque clip est une affiche de papier blanc **aux bords déchirés**, un peu penchée, tenue par un morceau de scotch, avec une pastille de rang collée sur le coin ; le podium (1er au centre, plus grand) puis le reste en vrac ; la bannière et la bande d'appel ont elles aussi un bord déchiré. Le découpage et l'inclinaison sont tirés au hasard **à partir de l'identifiant du clip** (stables d'une visite à l'autre, `public/js/wall.js`). Chaque affiche montre la vignette verticale, l'auteur et les vues / j'aime / commentaires. Au clic, une fenêtre charge le **lecteur officiel de
  TikTok** (`tiktok.com/embed/v2/…`, seulement à ce moment-là, avec un avis sur les cookies de TikTok) et un lien « Ouvrir sur TikTok ». Les vignettes sont
  copiées sur le volume (`<STORAGE_DIR>/wall/covers`, JPEG de 360 px) parce que les adresses de TikTok expirent ; seules les adresses de TikTok et d'Apify
  en HTTPS sont téléchargées. **Vignettes délavées** : certaines vidéos commencent par un fondu blanc, leur image d'accueil est alors grisâtre (la carte paraît « déjà vue » ; le site ne garde aucun suivi de lecture). Une vignette sans vrai noir et à faible contraste (10ᵉ centile de luminance ≥ 150 et écart 10ᵉ–90ᵉ centile < 70, mesurés avec ffmpeg `signalstats`) est étirée avec `normalize` à l'enregistrement, et celles déjà enregistrées sont corrigées sur place 90 s après le démarrage et à chaque actualisation ; les images sombres (scène de nuit) ou claires mais contrastées ne sont pas touchées.
- **Modération** (admin → « Mur ») : masquer un clip ou tous les clips d'un auteur ; le masquage survit aux actualisations. Les légendes sont affichées
  en texte brut.
- Tables : `wall_clips`, `wall_hidden_authors` ; dernière actualisation dans `settings` (`wall_last_run`). Tests : `test/wall.test.js` (Apify simulé).

### Logo du compte

- Onglet « Format », facultatif : le visiteur ajoute le logo de son compte (PNG, JPG, WebP ou SVG, réduit à 512 px en PNG dans le navigateur),
  le place sur une grille de 9 positions (marges : 5 % sur les côtés, 7 % en haut, 20 % en bas pour éviter les boutons de TikTok), règle sa taille
  (8 à 40 % de la largeur) et son opacité ; l'aperçu le montre en direct. Le logo et ses réglages restent **dans le navigateur** (`studio.logo.v1`).
- Au rendu, il est envoyé en PNG (`POST /api/studio/logo`, vérifié avec ffprobe, gardé le temps du rendu) ; ffmpeg produit en une passe **deux
  fichiers** : la vidéo avec le logo (téléchargée et partagée par le visiteur) et la vidéo sans logo, **la seule publiée dans la bibliothèque**. Le
  réglage du logo n'est pas gardé avec le clip (« Modifier » et « Recréer » ne le reprennent pas). Le logo n'apparaît pas sur l'écran de fin.

### Modèles et écran de fin

- **Modèles** : barre « Modèles » en haut de l'éditeur. « Enregistrer mes réglages » garde sous un nom le style des sous-titres, la musique et
  les volumes, le format (fond flou ou plein écran, qualité, miroir, suivi du visage) et l'écran de fin ; pas les extraits,
  les corrections ni les images, qui dépendent de l'interview. Jusqu'à 20 modèles, gardés **dans le navigateur** (`studio.models.v1`), rien sur
  le serveur. Appliquer un modèle peut être annulé ; une police ou une musique disparue est ignorée.
- **Écran de fin** (onglet « Écran de fin », désactivé par défaut) : un visuel de 2 à 5 s (3 par défaut) ajouté **après** le clip, hors limite de 90 s, dans l'esprit
  des visuels PostLisnard. Modèles « Une idée forte », « Citation », « Un chiffre » (avec sa source), « Événement » (date, heure, lieu), « Image +
  message » et « Appel à l'action » ; couleurs bleu, blanc ou kaki ; photo du visiteur (JPG, PNG, WebP, 10 Mo) en grand ou en fond assombri ; centré
  ou aligné à gauche, majuscules, logo Projet Lisnard, citation de l'interview. Le visuel est **dessiné dans le navigateur** (canvas 1080 × 1920,
  `public/js/endcard.js`) puis envoyé en JPEG (`POST /api/studio/endcard`, vérifié avec ffprobe, gardé une heure dans `<STORAGE_DIR>/cards`) ;
  ffmpeg l'ajoute tel quel, la voix et la musique continuent. Publié dans la bibliothèque, le visuel est gardé avec le clip (`<id>.card.jpg`) pour
  « Recréer » et « Modifier », et le clip se télécharge avec ou sans écran de fin.

## Bibliothèque de clips

Troisième section du site, `/bibliotheque/` : les clips créés dans le studio, partagés par la communauté.

- **Publication** : sur l'écran « vidéo prête » du studio, la case « Publier dans la bibliothèque » (cochée par défaut, mémorisée) publie le clip,
  public par défaut ; il peut passer en privé (visible seulement dans « Mes clips ») ou être retiré. Pas de validation préalable : l'admin masque après coup.
- **Réutilisation** : télécharger le MP4, **Republier** (le clip apparaît dans « Mes clips », sans copie du fichier), **Modifier** (ouvre
  l'éditeur avec les réglages du clip : extraits, style, musique, cadrage, corrections ; la nouvelle version est liée à l'original). Note de 1 à 5 étoiles
  (une par personne, pas sur son propre clip), nombre de téléchargements (une fois par personne), tri récents / plus téléchargés / mieux notés
  (moyenne bayésienne), filtre par interview. Chaque clip affiche sa source.
- **Vidéos uniques pour les algorithmes** : un clip n'est jamais distribué tel quel à tout le monde. Quand sa fiche s'ouvre dans la bibliothèque,
  le serveur prépare pour la personne qui l'ouvre une **deuxième passe** ffmpeg rapide (quelques secondes) avec des micro-transforms
  imperceptibles : couleur très légèrement modifiée (luminosité/contraste/gamma/saturation/teinte), micro-recadrage centré (zoom total ≤ 3 %),
  léger grain, amputation des 1 à 3 premières frames (image et audio coupées ensemble), hauteur de l'audio décalée de ±10 cents au plus
  (±17 en `medium`), EQ subtil.
  Le seed est tiré de la paire **(clip, personne)** : la même personne re-télécharge toujours le même fichier (mis en cache sur le volume),
  une autre personne obtient un autre fichier — chaque dépôt sur un réseau social est donc unique pour les algorithmes, tandis que la vidéo
  reste **identique pour le spectateur** (aucun retournement, aucune rotation, aucun changement de vitesse : les sous-titres incrustés restent
  lisibles et synchrones). Les valeurs sont tirées au hasard dans des bandes calibrées (inspirées du profil « soft » de
  https://github.com/Hostlife22/video-uniquifier, renforcées par mesure : en `gentle`, couleur ≤ 2,5 % ; en `medium`, plus marqué,
  jusqu'à 4,5 % de saturation) ; niveau `gentle` par défaut, `medium` possible. Les versions préparées sont
  dans `<STORAGE_DIR>/library/variants/` : `LIBRARY_UNIQ_MAX_PER_CLIP` par clip (25, les plus anciennes partent), supprimées avec le clip,
  comptées dans le budget de stockage de la bibliothèque. La préparation suit la lecture du clip (la personne regarde l'aperçu pendant que sa
  version se prépare) ; au clic sur « Télécharger », si la version n'est pas encore prête, un court délai l'annonce. Si la deuxième passe
  échoue, la personne est prévenue (motif affiché, bouton « Réessayer ») et reçoit la version standard — **un téléchargement n'échoue jamais**.
  Les réessais sont bornés (3 tentatives, 5 s d'écart ; un échec est oublié après 15 min). Si elle est impossible (file pleine,
  ffmpeg absent), la version standard est servie avec un message. Les versions d'un clip archivé ou supprimé partent avec son fichier.
  `LIBRARY_UNIQ=off` la désactive. La « personne » est identifiée par sa clé d'adhérente ou, anonyme, par l'empreinte de sa connexion — la même
  approximation que pour les compteurs de téléchargements.
- **Propriétaire, sans compte** : adhérent connecté (empreinte de son identifiant SSO) ou, si le studio est ouvert à tous, un cookie signé `own`
  posé à la première action. Seule une empreinte HMAC (`OWNER_KEY_SECRET`, sinon `SESSION_SECRET`) est stockée ; elle n'est jamais renvoyée au public.
  En mode adhérents, consulter et télécharger restent ouverts à tous ; publier, noter, republier et signaler demandent la connexion.
- **Stockage** : `<STORAGE_DIR>/library/<id>.mp4` (lien physique vers le rendu, sans copie) et une affiche JPEG. La vidéo est gardée
  `LIBRARY_RETENTION_DAYS` jours (**30**), puis archivée : seuls les réglages restent, et « Recréer » refait la vidéo (mêmes limites qu'un rendu du
  studio ; refusé si l'interview a été remplacée, « Modifier » est alors proposé). Plafonds : `LIBRARY_MAX_MB` au total (1 500 Mo), espace libre minimal
  du volume, `LIBRARY_MAX_PER_OWNER` vidéos par personne (30), publications par heure, volume téléchargé par connexion et par heure.
- **Modération** (admin → « Bibliothèque ») : signalements (un par personne, masquage automatique à `LIBRARY_AUTOHIDE_REPORTS`, 0 pour jamais),
  masquer un clip ou tous les clips d'un auteur, archiver la vidéo, supprimer. « Effacer mes données » (onglet « Mes clips ») supprime tout ce qui se
  rattache à la personne.
- Tables : `library_clips`, `library_downloads`, `library_ratings`, `library_reports`, `library_hidden_owners` (les variantes n'ont pas de
  table : fichiers + sidecars suivis par readdir, comme les aperçus). Code : `src/library/` (+ `src/library/uniq.js`), `src/studio/uniquify.js`,
  `src/routes/library.js`, `public/js/library.js`. Tests : `test/library.test.js`, `test/library-uniq.test.js` (e2e, base + ffmpeg),
  `test/uniq.test.js` (cycle de vie des variantes, ffmpeg), `test/uniquify.test.js` (paramètres, pur).

## Structure

```
src/
  server.js          app Express
  db.js, schema.sql  Postgres : vidéos + segments (index de recherche recalculé à chaque sauvegarde)
  normalize.js       normalisation du texte (indexation)
  transcripts.js     Supadata + parseurs SRT/VTT/texte
tools/transcribe.py  transcription locale gratuite (yt-dlp + Whisper) des vidéos sans sous-titres, envoyée au site
  openrouter.js      client OpenRouter minimal (traduction, résumés, extraits)
  summarize.js       résumé d'une transcription (repères de temps, 2 étapes si très long, nettoyage)
  studio/            studio public : rendu ffmpeg (render.js), détection et reconnaissance des visages (faces.js, faces-worker.js, yunet.js, sface.js, identity.js, references.js, nn.js), mesure du fond des sous-titres (box-probe.js), images libres de droits Pixabay / Pexels (stock.js), polices (fonts.json), musiques d'origine et bibliothèque de l'admin (music.json, music.js)
  wall/              mur des clips : client Apify (apify.js), classement, vignettes, actualisation planifiée (wall.js)
  media.js           fichiers vidéo du studio : dépôt par morceaux, ffprobe, stockage
  clip-suggestions.js  extraits proposés par le LLM (numéros de lignes, horaires issus de la transcription)
  summaries.js       résumés stockés en base : génération, anti-doublons
  auto-summaries.js  génération automatique en arrière-plan (file, délai de grâce, reprises, plafonds, pause)
  budget.js          plafonds d'appels par visiteur / par jour
  ip.js              clé de limitation par visiteur (IPv6 regroupée par /64)
  translate.js       traduction des segments via OpenRouter
  localize.js        récupère la transcription dans la langue demandée (traduit si besoin)
  sync.js            synchronisation : découverte des vidéos, file d'attente, planificateur
  youtube.js         extraction d'ID, métadonnées oEmbed
  auth.js            session admin (cookie signé HMAC), limiteur de tentatives
  routes/            API du studio (/api/studio/…), du mur (/api/wall/…), santé (/api/health) et admin (/api/admin/…)
public/              studio (index.html), mur (mur/), mentions-legales/ et admin (admin/)
test/                tests unitaires + test d'intégration (si DATABASE_URL défini)
```

## Contribuer

Voir [CONTRIBUTING.md](CONTRIBUTING.md).
