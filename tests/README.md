# Filet de tests — InTruth

Tests de non-régression sur les **fonctions pures** de l'extension.
Aucune dépendance : lanceur intégré à Node (`node:test`), aucun build, aucun `npm install`.

## Lancer

```bash
npm test          # exécution complète
npm run test:spec # sortie détaillée, test par test
npm run test:watch # relance à chaque modification
```

Node 20 ou plus récent.

## Ce qui est couvert

| Fichier | Portée |
|---|---|
| `corroboration.test.mjs` | indépendance des sources, voix, reporting circulaire, garde-fou de confiance |
| `routing.test.mjs` | routage des capteurs, frontière sport / politique, juridictions |
| `legal-sensors.test.mjs` | EUR-Lex (marqueurs, actes notoires, SPARQL), Federal Register |
| `discourse.test.mjs` | résolution des tournures indirectes, conviction du locuteur, lexique |
| `sources.test.mjs` | déduplication, filtre de pertinence, sources citées |
| `overlay.test.mjs` | horodatage cliquable, filtre d'affichage, couleurs, dissonance |
| `language.test.mjs` | langues de sortie et localisation de recherche |

## Comment ça charge le code

`helpers/load.mjs` enveloppe `service-worker.js` et `overlay.js` dans une fonction
dont les paramètres portent les API navigateur bouchonnées, puis évalue le tout
dans le realm courant. Les scripts de l'extension restent des **scripts
classiques** — aucun `import`/`export` n'y est introduit, donc aucune étape de
build n'est nécessaire.

Conséquences utiles :

- **le réseau est coupé** dans les tests (`fetch` rejette) : on ne teste que du déterministe ;
- **renommer une fonction testée fait échouer le chargement** avec un message explicite — c'est voulu.

## Ajouter un test

1. Exposer le symbole dans `SW_EXPORTS` ou `OVERLAY_EXPORTS` (`helpers/load.mjs`).
2. Créer ou compléter un `*.test.mjs` avec `describe` / `test` de `node:test`.
3. Vérifier que le test **échoue** si on casse volontairement le comportement,
   avant de le considérer comme acquis.

## Portée volontairement limitée

Ne sont pas couverts : les appels réseau (capteurs, LLM), la capture audio, le
DOM réel. Ce filet protège la **logique de décision** — routage, corroboration,
sélection des sources, filtres d'affichage — c'est-à-dire ce qui casse en
silence lors d'un refactor.
