# InTruth — vérification des faits en direct, pour Firefox

> Fork Firefox du projet [InTruth](https://github.com/rpanigrahi222/intruth-factcheck) de Risha Panigrahi, considérablement étendu : galaxie de capteurs officiels, corroboration déterministe, mémoire de session, analyse du discours et revue de fin de débat.

InTruth écoute l'audio d'un débat, d'une interview ou d'un direct, transcrit la parole, repère les affirmations factuelles au moment où elles sont prononcées, puis affiche un verdict sourcé dans un panneau posé sur la page.

La plupart des articles de fact-checking paraissent des jours après l'événement. Ici, l'évaluation se fait pendant que la vidéo tourne.

<!-- Ajoutez ici une capture d'écran du panneau en action -->

---

## Ce que fait InTruth

- **Détection en direct** des affirmations vérifiables dans la parole transcrite.
- **Verdicts sourcés** : `VRAI` · `SUBSTANTIELLEMENT VRAI` · `FAUX` · `TROMPEUR / HORS CONTEXTE` · `INVÉRIFIABLE`.
- **Sources officielles d'abord** : quinze capteurs, dont douze sans aucune clé — droit français et européen, registre fédéral américain, bases scientifiques et médicales, données de la Banque Mondiale, encyclopédies, actualité, résultats sportifs.
- **Corroboration mesurée** : le nombre de *voix réellement indépendantes* est calculé, la reprise circulaire est détectée, et une affirmation mal étayée est signalée `INVÉRIFIABLE` plutôt qu'affirmée.
- **Prédictions et engagements** relevés à part, sans jamais recevoir de verdict.
- **Revue de session** à la demande : synthèse, constantes observées, procédés rhétoriques cités mot pour mot, affirmations restées sans vérification.
- **Attribution des locuteurs** apprise en cours de session, sans saisie manuelle obligatoire.
- **Multilingue** : verdicts rédigés dans la langue de votre choix (16 langues), quelle que soit la langue parlée.
- **Mémoire de session persistante** : l'historique survit à un rechargement de page et à la mise en veille de l'extension.
- **Export** du rapport complet en Markdown.
- **Vos clés, vos données** (BYOK) : aucune donnée ne transite par un serveur tiers de l'auteur.

---

## Comment ça marche

```
Popup (réglages)  ──►  Background
                          │
Panneau : « Activer la capture audio »  (geste utilisateur requis)
                          │
Content script : getUserMedia → AudioWorklet 16 kHz → PCM
                          │
Background : Deepgram (WebSocket) → transcription multilingue
                          │
              détection des affirmations (LLM, 1 appel)
                          │
        galaxie de capteurs interrogés en parallèle
                          │
     corroboration déterministe : voix indépendantes, crédibilité
                          │
              verdict sourcé (LLM, 1 appel) → panneau
                          │
        mémoire de session (persistée) → export · revue
```

Deux appels au modèle par fenêtre d'analyse, pas davantage. La revue de session est un troisième appel, déclenché uniquement à la demande.

---

## La galaxie de capteurs

Un routeur choisit, selon le sujet de l'affirmation, les capteurs pertinents et les interroge en parallèle, avec un cache court. **Douze sur quinze ne demandent aucune clé** : ils constituent le socle, même sans moteur de recherche configuré.

| Capteur | Domaine | Clé |
|---|---|---|
| **JusticeLibre** | Droit français consolidé (codes, lois, JO) — liens Légifrance | Non |
| **EUR-Lex** | Droit de l'Union européenne (CELEX) | Non |
| **Federal Register** | Décrets et règlements fédéraux américains | Non |
| **Banque Mondiale** | Indicateurs officiels par pays | Non |
| **Crossref** | Publications scientifiques, **détection des rétractations** | Non |
| **OpenAlex** | Littérature académique | Non |
| **Europe PMC** | Biomédical, PubMed | Non |
| **Wikipédia** (FR + EN) | Encyclopédie | Non |
| **Wikidata** | Base de connaissances structurée | Non |
| **GDELT** | Actualité, presse mondiale | Non |
| **Nominatim** | Géographie, lieux | Non |
| **ESPN** | Résultats sportifs (grandes ligues) | Non |
| **Recherche web** | Exa, Tavily ou Serper, au choix | Oui |
| **Google Fact Check** | Fact-checks déjà publiés (AFP, PolitiFact…) | Facultatif |

Chaque capteur est routé, jamais appelé à l'aveugle. Une affirmation sur une directive européenne va vers EUR-Lex, un décret présidentiel américain vers le Federal Register, un score de match vers ESPN — et GDELT en est écarté, la presse en texte libre confondant pronostic et résultat.

Les réponses des capteurs encyclopédiques sont filtrées : un article dont le titre introduit son propre sujet est écarté, même s'il partage un mot avec l'affirmation.

---

## Corroboration : compter des voix, pas des liens

Cinq « sources » peuvent n'être qu'une seule dépêche recopiée. InTruth calcule donc, **sans appel au modèle** :

- les **voix indépendantes**, en regroupant les résultats par domaine enregistrable et par similarité lexicale ;
- la **reprise circulaire**, signalée quand plusieurs résultats retombent dans une même voix ;
- une **crédibilité par type de source**, fondée sur des signaux — données officielles et textes de loi en haut, presse générique en bas — jamais sur la réputation d'un média.

Il en résulte une bande de robustesse (`INSUFFISANTE` · `FAIBLE` · `MODÉRÉE` · `SOLIDE`) qui **calibre le verdict sans jamais le gonfler** : corroboration insuffisante, le verdict devient `INVÉRIFIABLE` ; corroboration faible, la confiance est plafonnée. Une source primaire seule n'est jamais pénalisée.

---

## Prédictions et engagements

Activable dans le tiroir de réglages du panneau. Ces énoncés sont **consignés, jamais jugés** — une prédiction n'est ni vraie ni fausse au moment où elle est prononcée.

Quatre verrous : le prompt interdit de leur attacher un verdict, la séparation se fait avant toute normalisation, l'événement enregistré ne possède pas de champ verdict, et il ne passe jamais par la vérification sourcée.

La forme est vérifiée : une prédiction doit porter une marque de futur, un engagement doit lier le locuteur. « Je voudrais continuer » n'est pas un engagement.

---

## Revue de session

Bouton **⚖ Revue** dans l'en-tête du panneau. Un seul appel au modèle, sur la **liste condensée des événements** — jamais sur le transcript brut, qui dépasserait la fenêtre de contexte d'un débat de deux heures.

Elle produit une synthèse, les constantes observées, les affirmations restées sans vérification, et les procédés rhétoriques relevés — limités à trois formes structurellement identifiables : faux dilemme, contre-accusation, attaque personnelle.

**Un constat n'est retenu que s'il cite un extrait réellement prononcé et nomme le critère structurel qui le fonde.** Sinon il est écarté automatiquement. Une liste vide est une réponse valide et fréquente. Le prompt interdit par ailleurs d'inférer une intention, une sincérité ou une appartenance politique.

---

## La capture audio sous Firefox — à lire avant d'essayer

Firefox n'expose aucune API permettant de capter le son d'un onglet : `tabCapture` n'y est pas implémenté et `getDisplayMedia` ne renvoie pas de piste audio. InTruth capte donc un **périphérique d'entrée**, traité par un AudioWorklet hors du thread principal.

Au clic sur **« Activer la capture audio »**, Firefox affiche une fenêtre de permission avec un menu de périphériques. Ce choix détermine ce qui est transcrit :

| Objectif | Périphérique |
|---|---|
| Capter le son de l'onglet | un périphérique **« Monitor » / loopback** |
| └ Linux (PulseAudio/PipeWire) | « Monitor of … », déjà présent |
| └ Windows | « Stereo Mix », ou un câble virtuel (VB-Audio) |
| └ macOS | un périphérique loopback (BlackHole) |
| Test rapide | votre micro — capte aussi le bruit ambiant |

C'est une limite de Firefox, pas de l'extension. Le son de la vidéo continue de jouer normalement.

---

## Modèles pris en charge

InTruth fonctionne avec **Anthropic** nativement et avec **tout fournisseur exposant `/chat/completions`** (standard OpenAI). Choisissez un préréglage, l'adresse se remplit seule ; il reste à indiquer le modèle et la clé.

| Préréglage | Adresse |
|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `https://api.groq.com/openai/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| DeepSeek | `https://api.deepseek.com` |
| xAI (Grok) | `https://api.x.ai/v1` |
| Together AI | `https://api.together.xyz/v1` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` |
| Perplexity | `https://api.perplexity.ai` |
| LM Studio (local) | `http://localhost:1234/v1` |
| Ollama (local) | `http://localhost:11434/v1` |
| Personnalisé | saisie manuelle |

**Modèles de raisonnement** : cochez la case dédiée. InTruth omet alors la température, élargit le budget de sortie et retire le bloc `<think>` avant analyse.

**Modèles locaux** : lancez le serveur (LM Studio, Ollama), indiquez le modèle chargé. La clé peut rester vide.

**Autre fournisseur** : ajoutez son domaine dans `host_permissions` du manifeste, sinon la requête est bloquée.

---

## Recherche web

Le moteur se choisit dans le popup, pas dans le code.

| Moteur | Palier gratuit | Remarque |
|---|---|---|
| **Exa** (défaut) | ~20 000 requêtes/mois | Recherche sémantique ; couverture plus étroite en français |
| **Tavily** | ~1 000 requêtes/mois | Bonne couverture générale, sans carte bancaire |
| **Serper** | crédit de démarrage | Recherche Google, payante ensuite |
| **Aucun** | — | Les douze capteurs sans clé suffisent comme socle |

Sur du contenu francophone, Tavily ou Serper corroborent souvent mieux qu'Exa. Les paliers évoluent : vérifiez le vôtre chez le fournisseur.

---

## Langue des verdicts

Sélectionnable dans le popup, parmi seize langues. La **transcription reste en détection automatique** : seule la sortie est traduite. Sur une vidéo anglaise avec « Français » choisi, la parole est transcrite en anglais mais les affirmations et explications s'affichent en français.

Les libellés de verdict restent normalisés, et les citations ne sont jamais traduites — traduire un extrait le rendrait introuvable dans le transcript.

---

## Clés et confidentialité

Quatre clés, dont deux seulement sont nécessaires :

- **Modèle** — Anthropic ou fournisseur compatible OpenAI (inutile pour un modèle local).
- **Deepgram** — transcription.
- **Recherche web** — facultative ; sans elle, les capteurs sans clé assurent le socle.
- **Google Fact Check** — facultative.

La case **« Se souvenir de mes clés »** choisit entre un stockage persistant et une conservation limitée à la session en cours.

Vos identifiants ne sont utilisés que pour joindre les services **que vous configurez**. Les fragments de transcription partent vers Deepgram, votre modèle et le moteur de recherche choisi. Les capteurs de données ouvertes sont des API publiques. L'auteur de l'extension n'a accès à rien.

> **Persistance et module temporaire.** Chargée via `about:debugging`, l'extension voit son stockage effacé au redémarrage de Firefox. En développement, passez `extensions.webextensions.keepStorageOnUninstall` et `keepUuidOnUninstall` à `true` dans `about:config`.

---

## Utilisation

1. Ouvrez une vidéo, un direct ou un débat.
2. Icône InTruth : choisissez le modèle, le moteur de recherche, la langue ; renseignez les clés.
3. **Start Fact-Checking** — le panneau apparaît.
4. Dans le panneau, **« Activer la capture audio »**, puis sélectionnez votre périphérique Monitor.
5. Transcription, affirmations et verdicts s'affichent en direct.
6. **⚖ Revue** pour la synthèse, **↓ Export** pour le rapport.

Le tiroir **⚙** règle la taille du panneau et du texte, le filtre d'affichage (tout / problèmes / confirmés), la détection des prédictions et la résolution des pronoms.

Si le panneau disparaît en cours de session, le bouton **« Rouvrir le panneau »** du popup le remonte avec tout son historique.

---

## Qu'est-ce qu'une affirmation vérifiable ?

**Vérifié** : déclarations factuelles précises, statistiques, événements historiques, bilans gouvernementaux, textes de loi, affirmations scientifiques ou médicales, résultats sportifs.

*« L'inflation a culminé à 9,1 % en 2022. » · « Ce projet de loi a été voté au Sénat en 2021. » · « L'article L. 1132-1 interdit la discrimination. »*

**Non vérifié** : opinions, jugements de valeur, questions rhétoriques, descriptions subjectives. Les prédictions et engagements sont relevés à part, sans verdict.

*« Cette politique va détruire l'économie. » · « J'ai le meilleur programme. »*

Les segments mal transcrits — phrases coupées, questions, suites de chiffres sans énoncé — sont écartés avant toute vérification, pour ne pas dépenser un appel sur du bruit.

---

## Plateformes

YouTube · Twitch · X / Twitter · Facebook · Rumble · Kick · Instagram · TikTok · Bluesky · Odysee · Dailymotion

Pour en ajouter une, complétez `content_scripts.matches` dans le manifeste.

---

## Permissions

- `activeTab` — interagir avec l'onglet au lancement
- `scripting` — injecter le panneau
- `storage` — clés, réglages et mémoire de session
- `host_permissions` — joindre les services configurés et les capteurs de données ouvertes
- **Micro** — demandé à l'exécution, au clic sur « Activer la capture audio »

Ni `tabCapture` ni `offscreen` : la capture passe par `getUserMedia` et le WebSocket vit dans le background.

---

## Limites

Le fact-checking automatique est imparfait. En cas de doute, consultez les sources primaires — les liens sont là pour ça.

- La **qualité de la transcription** conditionne tout le reste. Un mot mal reconnu peut transformer une affirmation vraie en affirmation fausse. C'est la limite la plus sérieuse, et elle est en amont de la vérification.
- Le **filtrage des sources est lexical** : il écarte l'essentiel du hors-sujet, pas la totalité.
- L'**attribution des locuteurs** échoue parfois — l'extension affiche alors « Inconnu » plutôt que d'attribuer au hasard.
- La **couverture sportive** se limite aux grandes ligues.
- **JusticeLibre** est une infrastructure associative, pas un service public garanti.
- Les **modèles de raisonnement** sont plus lents : une carte en attente expire au bout de 90 secondes.

**Cet outil assiste le jugement, il ne le remplace pas.**

---

## Installation (mode développeur)

Firefox 140+ (desktop) ou 142+ (Android). Une clé Deepgram et une clé de modèle, sauf modèle entièrement local.

1. Clonez ce dépôt.
2. Ouvrez `about:debugging#/runtime/this-firefox`.
3. **Charger un module temporaire…** → sélectionnez `realtime-factcheck/manifest.json`.
4. Renseignez vos clés dans le popup, puis **Start**.

Après modification des fichiers, cliquez **Recharger** dans `about:debugging`.

---

## Développement

Un filet de tests couvre la logique de décision — routage, corroboration, filtrage des sources, attribution, analyse du discours, revue.

```bash
npm test          # 353 tests, aucune dépendance
npm run test:spec # détail test par test
```

Aucun `npm install` : le lanceur est intégré à Node (20+). L'extension reste en scripts classiques, sans étape de compilation.

Les tests chargent le vrai code de l'extension dans un bac à sable où le réseau est coupé : seule la logique déterministe est vérifiée. Renommer une fonction testée fait échouer le chargement avec un message explicite — c'est voulu.

---

## Crédits

Projet original **InTruth** par [Risha Panigrahi](https://github.com/rpanigrahi222/intruth-factcheck).
Portage Firefox, capteurs, corroboration, mémoire de session et analyse du discours : ce dépôt.

Données ouvertes : DILA, Office des publications de l'UE, Federal Register, Banque Mondiale, Crossref, OpenAlex, Europe PMC, Wikimedia, GDELT, OpenStreetMap, et [JusticeLibre](https://justicelibre.org).

## Licence

MIT — voir le fichier `LICENSE`.
