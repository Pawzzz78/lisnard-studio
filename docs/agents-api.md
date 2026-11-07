# API privée et serveur MCP pour les agents IA

Cette API permet à un agent IA de faire dans le studio tout ce que fait une personne :
- choisir des extraits d'une interview ;
- personnaliser le clip : style des sous-titres, musique, zooms, images, carton de fin ;
- lancer le rendu, puis télécharger le MP4.

Elle n'apparaît nulle part sur le site public. Elle ne sert à rien sans une clé, et seul un admin peut créer une clé.

## 1. Obtenir une clé

1. Demande à un admin du studio de créer une clé.
2. Dans l'admin (`/admin/`), l'admin ouvre l'onglet **Agents IA**, donne un nom à la clé (par exemple « agent TikTok de Paul ») et clique sur **Créer une clé**.
3. La clé (`lsk_…`) s'affiche **une seule fois**, avec la configuration MCP prête à coller. Copie-la tout de suite. La base n'en garde que l'empreinte : personne ne pourra la relire.
4. Garde la clé comme un mot de passe :
   - ne la commite jamais ;
   - ne la colle pas dans un chat ou un ticket ;
   - mets-la dans une variable d'environnement ou dans le gestionnaire de secrets de ton agent.
5. Si une clé est perdue ou a fuité, l'admin clique sur **Révoquer**. Elle est refusée dès la requête suivante. Il crée ensuite une nouvelle clé.

Le tableau de l'onglet montre pour chaque clé :
- son début (`lsk_ab12cd…`) ;
- sa date de création ;
- son dernier usage ;
- son nombre d'appels.

Il n'y a aucune variable d'environnement à régler côté serveur. En revanche, `SESSION_SECRET` doit être défini (c'est déjà le cas en prod) pour que les liens de téléchargement restent valables après un redémarrage.

## 2. Installer le serveur MCP

Adresse du serveur : `https://<domaine-du-studio>/api/agent/mcp`. Le transport est HTTP « streamable », avec des réponses JSON et sans session.

### Claude Code

```bash
claude mcp add --transport http lisnard-studio https://<domaine-du-studio>/api/agent/mcp --header "Authorization: Bearer lsk_…"
```

Tu peux aussi ajouter le serveur dans le fichier `.mcp.json` du projet. Utilise alors une variable d'environnement pour ne pas commiter la clé :

```json
{
  "mcpServers": {
    "lisnard-studio": {
      "type": "http",
      "url": "https://<domaine-du-studio>/api/agent/mcp",
      "headers": { "Authorization": "Bearer ${LISNARD_STUDIO_KEY}" }
    }
  }
}
```

### Claude Desktop, Cursor et autres clients MCP

Ajoute un serveur MCP « HTTP » ou « streamable HTTP » :
- **adresse** : `https://<domaine-du-studio>/api/agent/mcp` ;
- **en-tête** : `Authorization: Bearer lsk_…`.

Si ton client ne gère que les serveurs locaux, passe par `mcp-remote` :

```json
{
  "mcpServers": {
    "lisnard-studio": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<domaine-du-studio>/api/agent/mcp", "--header", "Authorization: Bearer lsk_…"]
    }
  }
}
```

### Vérifier que ça marche

```bash
curl -s https://<domaine-du-studio>/api/agent/mcp \
  -H "Authorization: Bearer $LISNARD_STUDIO_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

La réponse doit lister 7 outils. Si tu reçois `401`, la clé est fausse ou révoquée.

## 3. Utiliser les outils MCP

| Outil | À quoi il sert |
|---|---|
| `list_videos` | Liste les interviews disponibles, les plus récentes d'abord. |
| `get_video` | Donne les extraits proposés (titre, début et fin en ms) et la transcription ligne par ligne `[start_ms, end_ms, texte]`. |
| `get_editor_options` | Donne les styles prêts à l'emploi (`presets`), le style par défaut, les polices, les musiques et les limites (durée maximale, nombre d'extraits…). |
| `search_stock_images` | Cherche des images libres de droits à insérer pendant le clip. |
| `create_clip` | Lance le rendu. Renvoie un identifiant de clip. |
| `get_clip` | Donne l'état du clip. Avec `wait_s` (jusqu'à 50), l'outil attend que le clip soit prêt. Une fois prêt, il renvoie `download_url`. |
| `cancel_clip` | Annule un clip en attente ou en cours. |

Démarche habituelle : `list_videos` → `get_video` → `get_editor_options` → `create_clip` → `get_clip` avec `wait_s: 50`, à répéter jusqu'à `status: "done"` → télécharger `download_url`.

### Exemple d'arguments pour `create_clip`

```json
{
  "youtube_id": "dQw4w9WgXcQ",
  "extracts": [{ "start_ms": 61200, "end_ms": 84900 }, { "start_ms": 130000, "end_ms": 142500 }],
  "preset": "karaoke",
  "layout": { "fit": "crop", "follow": { "on": true, "subject": "lisnard" }, "quality": "hd" },
  "music": { "id": "<id venant de get_editor_options>", "volume": 0.2 },
  "broll": [{ "id": "<id venant de search_stock_images>", "start": 4, "dur": 3 }]
}
```

- `extracts` : les extraits sont mis bout à bout. Les temps sont en millisecondes de la vidéo d'origine. Cale-les sur les lignes de la transcription pour ne pas couper une phrase.
- `preset` : un style prêt à l'emploi. `style` le complète ou le remplace champ par champ (même forme que `default_style`).
- `layout` :
  - `fit` vaut `blur` (vidéo entière sur un fond flou) ou `crop` (plein écran) ;
  - `follow.on` fait suivre le visage ;
  - `quality` vaut `hd` ou `fast`.
- `music` : un `id` pris dans `get_editor_options`, et un `volume` de 0 à 1.
- `voice` : le volume de la voix, de 0 à 1,5.
- `zoom`, `edits`, `end_card` : ils ont la même forme que dans le studio web.
- Limites : le serveur vérifie toujours les extraits (3 s minimum chacun), la durée totale et le nombre d'extraits. Les valeurs sont dans `limits`.

## 4. API HTTP (sans MCP)

Toutes les routes du studio web sont disponibles sous `/api/agent/v1/`, avec le même en-tête `Authorization: Bearer lsk_…` (ou `X-Api-Key: lsk_…`).

| Route | Rôle |
|---|---|
| `GET /api/agent/v1/videos` | Liste des interviews |
| `GET /api/agent/v1/videos/:youtubeId` | Extraits proposés et transcription |
| `GET /api/agent/v1/assets` | Styles, polices, musiques, limites |
| `GET /api/agent/v1/stock/search?q=…` | Images libres de droits |
| `POST /api/agent/v1/preview` | Aperçu rapide en 360p |
| `POST /api/agent/v1/render` | Lance le rendu (corps identique à `create_clip`, sans `preset`) → `202` avec l'`id` |
| `GET /api/agent/v1/render/:id` | État du rendu |
| `GET /api/agent/v1/render/:id/file` | Télécharge le MP4 |
| `DELETE /api/agent/v1/render/:id` | Annule le rendu |
| `POST /api/agent/v1/logo` (PNG), `POST /api/agent/v1/endcard` (JPEG) | Dépose un logo ou une photo de carton de fin |

```bash
curl -s -X POST https://<domaine-du-studio>/api/agent/v1/render \
  -H "Authorization: Bearer $LISNARD_STUDIO_KEY" -H "Content-Type: application/json" \
  -d '{"youtube_id":"dQw4w9WgXcQ","extracts":[{"start_ms":61200,"end_ms":84900}]}'
```

## 5. Téléchargement

- `download_url` est un lien signé (`/api/agent/files/<id>?t=…`). Il marche **sans la clé**, ce qui permet de le donner directement à un outil de téléchargement.
- Il est valable tant que le clip existe, c'est-à-dire **une heure** après le rendu.
- Comme pour un visiteur, le nombre de téléchargements d'un même clip est plafonné. Au-delà, il faut recréer le clip.

## 6. Erreurs

- **Outils MCP** : une erreur renvoie `isError: true`, avec un message en français qui explique quoi corriger. Exemples :
  - « Un extrait doit durer au moins 3 secondes. »
  - « Cette vidéo n'est pas disponible dans le studio. »
  - « Musique inconnue. »
- **Protocole** : une erreur renvoie un code JSON-RPC :
  - `-32600` : requête invalide, lot de plus de 20 messages ou origine refusée ;
  - `-32601` : méthode inconnue ;
  - `-32602` : outil inconnu ;
  - `-32700` : JSON illisible.

| Code HTTP | Signification |
|---|---|
| `401` | Clé manquante, invalide ou révoquée. |
| `403` | Lien de téléchargement invalide, ou appel venant d'une page d'un autre site. |
| `404` | Vidéo absente du studio, ou clip expiré ou créé avec une autre clé. |
| `409` | Le clip n'est pas encore prêt. |
| `429` | Plafond atteint. Les causes possibles : 2 clips en cours à la fois par clé, quotas d'aperçus et de cadrage, ou trop de clés refusées depuis la même adresse (30 par heure). |
| `500` | Erreur interne. Elle est écrite dans les logs du serveur, sans détail renvoyé à l'agent. |

## 7. Sécurité, pour les devs

- **Clés** : 192 bits aléatoires. La base ne garde que l'empreinte SHA-256 et un début de 10 caractères pour les reconnaître. La révocation est immédiate.
- **Ce qu'une clé permet** : exactement ce que permet le studio web. Elle ne donne accès ni à l'admin, ni aux fichiers vidéo d'origine, ni à la bibliothèque. Les clips des agents n'y sont pas rangés.
- **Limites** : chaque clé a ses propres limites, comme un visiteur. Les clés refusées sont limitées à 30 par adresse et par heure.
- **Clips** : avec MCP, une clé ne voit et n'annule que ses propres clips. Les routes `/v1/render/:id` restent, comme dans le studio web, accessibles avec l'identifiant du clip (96 bits aléatoires).
- **Navigateurs** : le serveur MCP refuse les appels qui viennent d'une page d'un autre site (en-tête `Origin`). La clé passe dans un en-tête : un site tiers ne peut pas s'en servir depuis un navigateur.
- **Où on voit l'API** : le site public n'en parle pas. L'onglet « Agents IA » n'apparaît qu'aux admins connectés. Le dépôt GitHub est public : le code et cette doc y sont lisibles, mais sans clé l'API répond `401`.
- **Révocation** : une clé révoquée ne peut plus rien lancer. Les clips déjà prêts restent téléchargeables par leur lien jusqu'à leur expiration (une heure).
