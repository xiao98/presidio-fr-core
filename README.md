# presidio-fr-core

Passerelle locale de confidentialité pour les API de modèles de langue. Elle écoute sur `127.0.0.1`, expose les interfaces OpenAI (`/v1/chat/completions`) et Anthropic (`/v1/messages`), masque les données personnelles françaises dans chaque requête avant de la transmettre au fournisseur (Mistral, OpenAI, Anthropic), puis restaure les valeurs d'origine dans la réponse, y compris en streaming. Tout client compatible OpenAI (AnythingLLM, LibreChat, un script, un agent) la prend comme « base URL » et ne change rien d'autre.

C'est le même moteur que l'[extension navigateur](https://github.com/xiao98/presidio-fr-extension) (règles + modèle local nym-pii-multilingual-small + règle noms en capitales), mesuré sur [FR-PII-Bench](https://github.com/xiao98/presidio-fr/tree/main/eval/benchmark) : recall 0,99 / précision 0,97. L'extension couvre « j'utilise ChatGPT dans mon navigateur » ; la passerelle couvre « le cabinet installe un outil » et les intégrations.

```
client ──► 127.0.0.1:8787 ──masque──► api.mistral.ai ──réponse──► restaure ──► client
                │
                └── registre.jsonl (horodatage, modèle, nombre par type ; jamais une valeur)
```

## Démarrer

```bash
npm install
MISTRAL_API_KEY=… npm start            # ou OPENAI_API_KEY / ANTHROPIC_API_KEY ; plusieurs possibles
# presidio-fr-core listening on http://127.0.0.1:8787
```

Puis, dans le client : base URL `http://127.0.0.1:8787/v1`, clé API quelconque (la vraie clé reste dans l'environnement de la passerelle). Le fournisseur est choisi d'après le préfixe du modèle (`mistral-…`, `gpt-…`, `claude-…`) ou l'en-tête `x-pfr-upstream`.

Chaque requête écrit une ligne dans le terminal (fournisseur, modèle, nombre masqué par type). Variables : `PFR_SHOW_MASKED=1` (ajoute le dernier message tel que le fournisseur le reçoit, placeholders seulement), `PFR_PORT` (8787), `PFR_DATA_DIR` (`./data` : registre, clé de dérivation, cache du modèle), `PFR_NER=off` pour les règles seules, `PFR_DEFAULT_UPSTREAM`.

## Application de bureau (un seul installateur)

`npm run desktop` lance l'application : une icône dans la zone de notification, la passerelle démarrée en arrière-plan (processus Node fils, relancé s'il tombe, arrêté avec l'application), et le panneau dans une fenêtre. Fermer la fenêtre la réduit dans la zone de notification ; « Lancer au démarrage » dans le menu de l'icône. Les données (config, registre, clé de dérivation, cache du modèle) vivent dans le dossier utilisateur de l'application, pas dans le dépôt.

`npm run dist` produit `dist/presidio-fr-setup-<version>.exe` (installateur Windows en un clic, non signé pour l'instant) ; `npm run dist:linux` les AppImage/deb. `npm run test:desktop` vérifie le démarrage complet avec Playwright.

## Panneau de contrôle

`http://127.0.0.1:8787/` : vue d'ensemble (état du modèle, compteurs), fournisseurs (base URL + clé par fournisseur, fournisseur par défaut), politique (types masqués un par un, modèle local on/off, note de convention), registre (dernières requêtes, export CSV), licence. Les réglages vivent dans `data/config.json` ; les variables d'environnement ne servent qu'au premier démarrage pour le remplir. Les clés ne sont jamais renvoyées au panneau (seuls les 4 derniers caractères). Les modifications s'appliquent à la requête suivante, sans redémarrage ; activer le modèle depuis le panneau le charge en arrière-plan, et tant qu'il charge les requêtes qui en ont besoin sont refusées (503) plutôt que transmises en clair.

## Ce qui est masqué, et comment

- Feuilles texte des messages (chaîne ou blocs `text`), résultats d'outils, arguments d'appels d'outils ; blocs `thinking` signés, images et autres champs sont rejoués tels quels.
- Placeholders `{{TYPE_xxxxxxxx}}` dérivés par HMAC(clé locale, type, valeur) : la même valeur reçoit le même placeholder à chaque tour sans état côté passerelle (l'historique rejoué par le client reste cohérent et le cache de préfixe du fournisseur n'est pas invalidé). La clé est dans `data/placeholder.key`, jamais transmise ; la supprimer la fait tourner.
- Une note de convention est injectée dans le canal système (« recopiez le marqueur tel quel, ne devinez pas la valeur »).
- Restauration en streaming : un placeholder coupé entre deux événements SSE est retenu jusqu'à l'événement suivant ; les graphies `{{ X }}`, `{{X\_…}}`, `**{{X}}**` sont reconnues.
- **Fermé par défaut** : si le détecteur est indisponible, la requête est refusée (503), jamais transmise en clair.
- Registre : `data/registre.jsonl`, export `GET /registre.csv`.

Design repris de la lecture de [AstrLink](https://github.com/Calcium-Ion/AstrLink) (`core/internal/privacy`) : dérivation HMAC, note de convention, restauration tolérante en streaming, audit sans valeur, fail-closed. Non repris : les « stand-ins naturels » (valeurs factices dans des espaces réservés) et la politique par type / liste blanche.

## Tests

```bash
npm test               # allocation, restauration en flux, parcours OpenAI/Anthropic, passerelle complète contre un faux fournisseur, panneau (validation, masquage des clés, effet de la politique)
npm run test:desktop   # application Electron : passerelle fille, fenêtre, données dans le dossier utilisateur, arrêt propre
npm run sync           # recopie le moteur depuis ../presidio-fr-extension/src
```

## Limites

- Pas de pièces jointes dans l'API (les clients envoient du texte) ; l'extraction PDF/Word/Excel reste dans l'extension.
- Pas de gestion multi-utilisateurs pour l'instant (un panneau, une politique, un registre par poste).
- La passerelle doit tourner sur le poste (ou le réseau) du cabinet ; elle n'est pas un service hébergé.

MIT.
