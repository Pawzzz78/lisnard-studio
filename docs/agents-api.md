# API des agents IA : documentation pour les devs

Cette page s'adresse aux **devs et admins**. Le guide à donner à un agent IA, avec sa clé, est [agent-guide.md](agent-guide.md). Il contient l'installation pour chaque client, les outils, la démarche et les erreurs.

## Vue d'ensemble

Un agent IA qui a une clé API peut faire dans le studio ce que fait un visiteur :
- lister les interviews ;
- choisir les extraits ;
- personnaliser le clip : style, musique, cadrage, images, zooms, carton de fin ;
- lancer le rendu, puis télécharger le MP4.

Le site public n'en parle pas. Seuls les admins connectés voient l'onglet « Agents IA ».

| Point d'entrée | Rôle |
|---|---|
| `POST /api/agent/mcp` | Serveur MCP. La clé passe dans l'en-tête `Authorization`, avec ou sans `Bearer`, ou dans `X-Api-Key`. |
| `POST /api/agent/mcp/<clé>` | Même serveur, avec la clé dans l'adresse. C'est pour les clients qui ne peuvent pas envoyer d'en-tête (ChatGPT). |
| `/api/agent/v1/…` | Les routes de `/api/studio/…`, à l'identique, derrière la clé. |
| `GET /api/agent/files/<id>?t=<hmac>` | Lien signé vers le MP4 d'un clip prêt. Il marche sans la clé et vit une heure. |

**Fichiers concernés :**
- `src/agent/keys.js` : les clés ;
- `src/routes/agent.js` : le routeur, le serveur MCP et les liens signés ;
- `src/routes/studio.js` : fonctions partagées `studioAssets`, `listStudioVideos`, `videoDetail`, `startRender`, `jobOr404` ;
- onglet « Agents IA » de `public/admin/admin.js` ;
- table `agent_keys` dans `src/schema.sql` ;
- tests dans `test/agent.test.js`.

## Donner l'accès à un agent

1. **Créer la clé.** Dans l'admin, onglet **Agents IA** : donne un nom (qui l'utilise, pour quoi) puis clique sur **Créer une clé**.
2. **Copier.** La clé `lsk_…` s'affiche une seule fois. L'écran montre aussi :
   - l'adresse du serveur MCP ;
   - l'adresse secrète pour ChatGPT ;
   - une configuration MCP prête à coller.
3. **Transmettre** à l'agent, ou à la personne qui le configure, par un canal privé :
   - la clé ;
   - l'adresse du studio ;
   - le fichier [agent-guide.md](agent-guide.md).
4. **Suivre.** Le tableau de l'onglet montre pour chaque clé son dernier usage et son nombre d'appels.
5. **Révoquer.** Si la clé a fuité ou ne sert plus, clique sur **Révoquer**. Le refus est immédiat. Pour remplacer une clé, crée-en une nouvelle.

Aucune variable d'environnement n'est à ajouter. `SESSION_SECRET` doit seulement être défini, ce qui est déjà le cas en prod : il signe les liens de téléchargement. Sans lui, un secret aléatoire est tiré à chaque démarrage, et les liens déjà donnés cessent de marcher après un redémarrage.

## Compatibilité des clients MCP

Le serveur MCP n'utilise ni session ni flux du serveur vers le client : `GET` et `DELETE` répondent `405`. Il gère :
- les messages `initialize`, `ping`, `tools/list` et `tools/call` ;
- les notifications, auxquelles il répond `202` ;
- les lots de 20 messages au plus.

Il répond avec la version du protocole demandée si elle fait partie de celles qu'il connaît (2025-03-26 à 2026-07-28), sinon avec 2026-07-28.

Chaque outil porte des annotations (`readOnlyHint`). Les clients s'en servent pour demander une confirmation avant `create_clip` et `cancel_clip`.

| Client | Comment il se connecte | Remarque |
|---|---|---|
| Claude Code, Claude Desktop, Cursor, VS Code | URL + en-tête `Authorization: Bearer` | Pour les clients limités au stdio, passer par `mcp-remote`. |
| ChatGPT (connecteur, mode développeur) | `/api/agent/mcp/<clé>`, réglé sur « aucune authentification » | ChatGPT ne propose que OAuth ou aucune authentification, pas d'en-tête personnalisé. |
| Grok (API xAI, outil distant `mcp`) | `server_url` + `authorization` | Le serveur accepte la clé avec ou sans `Bearer`. |
| Hermes Agent | `mcp_servers.<nom>.url` + `headers` dans `~/.hermes/config.yaml` | Garder `timeout` à 120 s ou plus, car `get_clip` peut attendre 50 s. |

**Clé dans l'adresse (ChatGPT) :** l'adresse devient aussi secrète que la clé. Elle peut apparaître dans les journaux d'accès d'un proxy ou d'un hébergeur, ce que ne fait pas un en-tête. Donne donc une clé dédiée à chaque usage ChatGPT, pour pouvoir la révoquer seule.

**OAuth :** non implémenté. Si l'on veut un jour des connecteurs ChatGPT publics ou une connexion en un clic, il faudra un serveur d'autorisation OAuth 2.1 (découverte, enregistrement dynamique, PKCE).

## Sécurité

- **Clés** :
  - 24 octets aléatoires (192 bits), préfixe `lsk_` ;
  - la base ne garde que l'empreinte SHA-256 et un début de 10 caractères pour reconnaître la clé ;
  - la clé en clair n'existe que dans la réponse de création.
- **Ce qu'une clé permet** : exactement ce que permet le studio web. Elle ne donne accès ni à l'admin, ni aux fichiers vidéo d'origine, ni aux transcriptions en écriture. Les clips des agents ne sont pas rangés dans la bibliothèque.
- **Limites** : chaque clé a ses propres limites, comme un visiteur : 2 clips en cours à la fois, et les mêmes quotas d'aperçus, de cadrage et de recherche d'images.
- **Clés devinées** : après 30 clés refusées par adresse et par heure, l'API répond `429`.
- **Isolement** : avec MCP, une clé ne voit et n'annule que ses propres clips. Les routes `/v1/render/:id` restent, comme dans le studio web, accessibles avec l'identifiant du clip (96 bits aléatoires).
- **Navigateurs** : le serveur MCP refuse les appels dont l'en-tête `Origin` désigne un autre site. La clé ne passe pas par un cookie : une page tierce ne peut pas s'en servir.
- **Entrées** : tout passe par la validation du studio (`normalizeRequest`). `params`, `style` et `preset` mal formés sont refusés proprement, y compris `__proto__`.
- **Révocation** : une clé révoquée ne lance plus rien. Les clips déjà prêts restent téléchargeables par leur lien signé jusqu'à leur expiration (une heure).
- **Dépôt public** : le code et cette doc sont lisibles par tous. Sans clé, l'API répond `401`.

## Gestion des erreurs

- **Erreurs métier** (une `HttpError` du studio) : en MCP, le résultat porte `isError: true` avec le message en français ; en HTTP, la réponse porte le code et `{ error }`.
- **Erreurs inattendues** : elles sont écrites dans les logs du serveur avec `console.error`. L'agent ne reçoit que « Erreur interne. ».
- **Protocole** :
  - `-32700` : JSON illisible ;
  - `-32600` : requête invalide, lot vide ou trop gros, ou origine refusée ;
  - `-32601` : méthode inconnue ;
  - `-32602` : outil inconnu.

## Tester en local

```bash
node --env-file=.env --test test/agent.test.js
```

Les tests ont besoin de Postgres (`DATABASE_URL`).

Pour un essai de bout en bout :
1. Crée une clé dans l'admin locale.
2. Appelle `tools/call` → `create_clip` sur une vidéo dont les clips sont autorisés.
3. Appelle `get_clip` avec `wait_s: 50`.
4. Télécharge `download_url`.

## Points ouverts

- Faut-il limiter aussi `/v1/render/:id` aux clips de la clé ? Aujourd'hui, ces routes se comportent comme le studio web.
- Faut-il ajouter OAuth, pour ChatGPT sans clé dans l'adresse ?
- Faut-il fixer une durée de vie aux clés ? Aujourd'hui, une clé reste valable jusqu'à sa révocation.
