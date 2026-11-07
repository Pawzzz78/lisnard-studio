# Guide de l'agent IA : créer des clips avec le studio Lisnard

Ce guide s'adresse à toi, l'agent IA. On t'a donné deux choses :
- une **clé API** qui commence par `lsk_` ;
- l'**adresse du studio**, par exemple `https://studio.exemple.fr`, notée `<STUDIO>` ci-dessous.

Avec ce guide, tu sais installer l'accès, puis créer, personnaliser et télécharger des clips verticaux (TikTok, Reels, Shorts) à partir des interviews de David Lisnard.

**Règles sur la clé :**
- Garde-la secrète.
- Ne l'écris jamais dans un fichier commité, une réponse publique ou un journal.
- Si elle est refusée (`401`), elle a été révoquée : demande-en une nouvelle à la personne qui te l'a donnée.

---

## 1. Installation

Le serveur MCP est à l'adresse `<STUDIO>/api/agent/mcp`. Il utilise HTTP « streamable », avec des réponses JSON et sans session.

Pour la clé, deux façons au choix :
- **un en-tête** (préféré) : `Authorization: Bearer lsk_…`. `X-Api-Key: lsk_…` marche aussi ;
- **dans l'adresse**, si ton client ne peut pas envoyer d'en-tête : `<STUDIO>/api/agent/mcp/lsk_…`. Cette adresse est aussi secrète que la clé.

Choisis la section qui correspond à ton environnement.

### Claude Code

```bash
claude mcp add --transport http lisnard-studio <STUDIO>/api/agent/mcp --header "Authorization: Bearer lsk_…"
```

Ensuite, `/mcp` doit afficher `lisnard-studio` comme connecté.

### Claude Desktop, Cursor, Windsurf, VS Code

Ajoute un serveur MCP de type HTTP dans la configuration MCP du client :

```json
{
  "mcpServers": {
    "lisnard-studio": {
      "type": "http",
      "url": "<STUDIO>/api/agent/mcp",
      "headers": { "Authorization": "Bearer lsk_…" }
    }
  }
}
```

Si le client ne gère que les serveurs locaux (stdio), passe par `mcp-remote` :

```json
{ "mcpServers": { "lisnard-studio": { "command": "npx", "args": ["-y", "mcp-remote", "<STUDIO>/api/agent/mcp", "--header", "Authorization: Bearer lsk_…"] } } }
```

### ChatGPT (connecteurs, mode développeur)

ChatGPT ne permet pas d'ajouter un en-tête : on utilise l'adresse qui contient la clé.

1. Ouvre **Paramètres → Applications et connecteurs → Paramètres avancés**, puis active le **mode développeur**.
2. Clique sur **Créer** (nouveau connecteur), avec :
   - nom : `Studio Lisnard` ;
   - URL du serveur MCP : `<STUDIO>/api/agent/mcp/lsk_…` ;
   - authentification : **aucune**.
3. Dans une conversation, active le connecteur. ChatGPT demande une confirmation avant `create_clip` et `cancel_clip`, parce que ces outils ne sont pas en lecture seule.

### Grok (API xAI)

Ajoute un outil distant de type MCP dans la liste `tools` de ta requête (SDK xAI, ou API Responses compatible OpenAI) :

```json
{ "type": "mcp", "server_url": "<STUDIO>/api/agent/mcp", "authorization": "Bearer lsk_…" }
```

- Le champ `authorization` est envoyé dans l'en-tête `Authorization`. Le préfixe `Bearer` est facultatif : le serveur accepte aussi la clé seule.
- Dans le SDK Python, les champs portent les mêmes noms (`server_url`, `authorization`).

### Hermes Agent (Nous Research)

Dans `~/.hermes/config.yaml` :

```yaml
mcp_servers:
  lisnard-studio:
    url: "<STUDIO>/api/agent/mcp"
    headers:
      Authorization: "Bearer ${LISNARD_STUDIO_KEY}"
    timeout: 120
```

1. Mets la clé dans la variable d'environnement `LISNARD_STUDIO_KEY`.
2. Lance `/reload-mcp`.

Garde `timeout` à 120 secondes ou plus : `get_clip` peut attendre jusqu'à 50 s.

### Sans MCP (HTTP simple, scripts)

Toutes les actions existent en HTTP sous `<STUDIO>/api/agent/v1/`, avec le même en-tête (voir la section 5).

### Vérifier l'installation

Appelle l'outil `list_videos`. Il doit renvoyer une liste d'interviews.

Sans client MCP, vérifie avec :

```bash
curl -s <STUDIO>/api/agent/mcp -H "Authorization: Bearer lsk_…" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_videos","arguments":{}}}'
```

---

## 2. Les outils

| Outil | Ce qu'il fait | Lecture seule |
|---|---|---|
| `list_videos` | Liste les interviews disponibles, les plus récentes d'abord : `youtube_id`, titre, chaîne, date, durée, nombre d'extraits proposés. | oui |
| `get_video` | Pour une interview (`youtube_id`), renvoie : les **extraits proposés** (`suggestions` : titre, `start_ms`, `end_ms`, raison) ; la **transcription** (`lines` : `[start_ms, end_ms, texte]`) ; la disponibilité du cadrage automatique sur le visage (`faces`). | oui |
| `get_editor_options` | Renvoie les styles prêts à l'emploi (`presets`), le style par défaut (`default_style`), les polices, les musiques (avec leur `id`) et les **limites** (`limits` : durée totale maximale, nombre d'extraits, durée minimale d'un extrait…). | oui |
| `search_stock_images` | Cherche des images libres de droits à insérer (`query`, `page` facultatif). Renvoie leurs `id`. | oui |
| `create_clip` | Lance la fabrication du clip. Renvoie son `id` et `status` (`queued` ou `running`). | non |
| `get_clip` | Donne l'état d'un clip (`clip_id`). Avec `wait_s` (jusqu'à 50), il attend que le clip soit prêt. Quand `status` vaut `done`, il renvoie `download_url`. | oui |
| `cancel_clip` | Annule un clip en attente ou en cours. | non |

---

## 3. Démarche pour faire un clip

1. **Choisir l'interview** : appelle `list_videos`. Prends celle qui correspond à la demande (sujet, date, chaîne). Sans précision, prends la plus récente.
2. **Choisir le passage** : appelle `get_video`.
   - Commence par les `suggestions` : ce sont des passages déjà repérés comme forts, avec un titre.
   - Pour un sujet précis, cherche dans `lines` les phrases qui en parlent.
   - Cale toujours le début sur le `start_ms` d'une ligne et la fin sur le `end_ms` d'une ligne, pour ne jamais couper une phrase.
3. **Connaître les options** : appelle `get_editor_options` une fois. Tu y trouves les `presets`, les `id` de musique et les limites.
4. **Créer** : appelle `create_clip` (voir la section 4).
5. **Attendre** : appelle `get_clip` avec `wait_s: 50`, et répète tant que `status` vaut `queued` ou `running`. Un clip prend en général de 20 s à 2 min. `position` indique la place dans la file d'attente.
6. **Livrer** : quand `status` vaut `done`, donne `download_url` à la personne ou télécharge le fichier.
   - Le lien marche sans la clé.
   - Il expire **une heure** après le rendu.
   - Si `status` vaut `failed`, lis `error`, corrige et recommence.

**Conseils pour un bon clip :**
- **Durée** : 20 à 60 s pour TikTok ou Reels.
- **Contenu** : une idée forte par clip. Commence directement par la phrase qui accroche.
- **Plusieurs extraits** : tu peux en mettre bout à bout (une question, puis la réponse), dans la limite de `limits.maxTotalS` au total.
- **Cadrage** : `layout.fit: "crop"` avec `follow.on: true` donne un plein écran qui suit le visage, quand `faces.ready` est vrai. Sinon, garde `fit: "blur"`, qui montre la vidéo entière sur un fond flou.
- **Musique** : basse, avec un `volume` entre 0,1 et 0,25, pour que la voix reste claire.
- **Brouillon** : utilise `quality: "fast"` pour un essai rapide, et `"hd"` (par défaut) pour la version finale.

---

## 4. Paramètres de `create_clip`

```json
{
  "youtube_id": "AbCdEfGhIjK",
  "extracts": [
    { "start_ms": 61200, "end_ms": 84900 },
    { "start_ms": 130000, "end_ms": 142500 }
  ],
  "preset": "karaoke",
  "style": {},
  "layout": { "fit": "crop", "follow": { "on": true, "subject": "lisnard" }, "quality": "hd" },
  "music": { "id": "<id de get_editor_options.music>", "volume": 0.2 },
  "voice": 1,
  "broll": [{ "id": "<id de search_stock_images>", "start": 4, "dur": 3 }]
}
```

| Champ | Obligatoire | Description |
|---|---|---|
| `youtube_id` | oui | L'interview, prise dans `list_videos`. |
| `extracts` | oui | Les passages, en **millisecondes de la vidéo d'origine**. Ils sont mis bout à bout dans l'ordre donné. Chaque extrait dure au moins `limits.minExtractS` secondes ; le total ne dépasse pas `limits.maxTotalS`. |
| `preset` | non | Un style prêt à l'emploi : un `id` de `get_editor_options.presets` (par exemple `hormozi`, `karaoke`, `classique`…). |
| `style` | non | Les réglages des sous-titres, champ par champ, sur le modèle de `default_style`. Ils s'appliquent par-dessus le `preset`. |
| `layout.fit` | non | `blur` (par défaut) : la vidéo entière sur un fond flou. `crop` : plein écran vertical. |
| `layout.cropX` | non | En mode `crop` sans suivi, la position horizontale du cadre, de 0 (gauche) à 1 (droite). |
| `layout.follow` | non | `{ "on": true, "subject": "auto" \| "left" \| "right" \| "lisnard" }` : le cadre suit un visage. `lisnard` suit David Lisnard quand la reconnaissance est disponible (`faces.identified`). |
| `layout.quality` | non | `hd` (par défaut) ou `fast` (rendu plus rapide, pour un brouillon). |
| `layout.mirror` | non | `true` retourne l'image de gauche à droite. Les sous-titres ne sont pas retournés. |
| `music` | non | `{ "id", "volume" }`, avec un volume de 0 à 1. |
| `voice` | non | Le volume de la voix, de 0 à 1,5 (1 par défaut). |
| `broll` | non | Des images insérées : `[{ "id", "start", "dur" }]`. `start` et `dur` sont en **secondes du clip**. Chaque image dure de 1 à 8 s, et deux images ne se chevauchent pas. |
| `zoom`, `edits`, `end_card` | non | Les zooms, les corrections de sous-titres et le carton de fin. Ils ont la même forme que dans le studio web. Laisse-les de côté si tu n'en as pas besoin. |

---

## 5. Équivalent HTTP (sans MCP)

Toutes les routes prennent l'en-tête `Authorization: Bearer lsk_…`.

| Action | Requête |
|---|---|
| Lister les interviews | `GET <STUDIO>/api/agent/v1/videos` |
| Détail d'une interview | `GET <STUDIO>/api/agent/v1/videos/<youtube_id>` |
| Options de l'éditeur | `GET <STUDIO>/api/agent/v1/assets` |
| Chercher des images | `GET <STUDIO>/api/agent/v1/stock/search?q=<mots>` |
| Créer un clip | `POST <STUDIO>/api/agent/v1/render`, avec un corps JSON comme `create_clip` mais sans `preset` (mets le style complet dans `style`). Réponse `202` avec l'`id`. |
| État du clip | `GET <STUDIO>/api/agent/v1/render/<id>`. Interroge-le toutes les 3 à 5 s. |
| Télécharger le clip | `GET <STUDIO>/api/agent/v1/render/<id>/file` |
| Annuler le clip | `DELETE <STUDIO>/api/agent/v1/render/<id>` |

---

## 6. Erreurs et quoi faire

Quand un outil échoue, il renvoie `isError: true` avec un message en français. Lis le message, corrige et réessaie.

| Message ou code | Ce que ça veut dire | Quoi faire |
|---|---|---|
| `401` « Clé API manquante, invalide ou révoquée » | La clé n'est pas envoyée, est fausse ou a été révoquée. | Vérifie l'en-tête ou l'adresse. Sinon, demande une nouvelle clé. |
| `429` « Trop de clés refusées » | Trop d'essais avec une mauvaise clé. | Attends une heure. |
| « Tu as déjà des clips en cours de création » | 2 clips au maximum sont fabriqués en même temps par clé. | Attends qu'un clip soit prêt avec `get_clip`, puis relance. |
| « Cette vidéo n'est pas disponible dans le studio » | Le `youtube_id` est faux ou la vidéo a été retirée. | Reprends un identifiant dans `list_videos`. |
| « Un extrait doit durer au moins … secondes », « dépasse la durée de la vidéo », « Le clip ne peut pas dépasser … secondes » | Les extraits sortent des limites. | Corrige `extracts` d'après `limits`. |
| « Musique inconnue », « Style prêt à l'emploi inconnu » | L'`id` n'existe pas. | Reprends un `id` dans `get_editor_options`. |
| « Clip introuvable ou expiré » | Le clip a plus d'une heure, ou il a été créé avec une autre clé. | Recrée le clip. |
| `status: "failed"` | Le rendu a échoué : la raison est dans `error`. | Corrige et relance. Si ça recommence, réessaie avec un réglage plus simple (sans images, sans zooms). |
| « Ce clip a déjà été téléchargé de nombreuses fois » | Le plafond de téléchargements de ce clip est atteint. | Recrée le clip. |
| « Erreur interne » | Problème côté serveur. | Réessaie une fois. Si ça recommence, préviens la personne. |

---

## 7. Ce que tu peux et ne peux pas faire

**Tu peux :**
- lire la liste des interviews et leurs transcriptions ;
- créer des clips, les personnaliser et les télécharger ;
- annuler tes propres clips.

**Tu ne peux pas :**
- modifier les vidéos ou les transcriptions ;
- accéder à l'administration ;
- télécharger la vidéo d'origine en entier ;
- voir les clips des autres clés.
