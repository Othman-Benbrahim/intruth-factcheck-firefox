# InTruth — Extension Firefox de fact-checking en temps réel

> **Fork Firefox** du projet original [InTruth](https://github.com/rpanigrahi222/intruth-factcheck) de Risha Panigrahi, adapté pour Mozilla Firefox et **largement étendu** : LLM configurable (cloud **ou** local), moteur de recherche enfichable, galaxie de capteurs de données ouvertes, corroboration déterministe des sources, gestion des résultats sportifs, et transcription multilingue.

**InTruth** écoute l'audio capté par le navigateur, le transcrit en direct, détecte les affirmations factuelles au moment où elles sont prononcées, puis affiche des verdicts vérifiés dans un panneau superposé à la page. Utile sur les débats, interviews, conférences de presse, lives et prises de parole.

La plupart des articles de fact-checking paraissent des jours après l'événement. Ici, l'évaluation se fait pendant que la vidéo tourne.

<!-- Ajoutez ici une capture d'écran du panneau en action -->

---

## ⚡ Fonctionnalités

- **Détection d'affirmations en direct** — repère en continu les affirmations factuelles vérifiables dans la parole transcrite.
- **Verdicts en temps réel** — chaque affirmation est classée : `VRAI` · `SUBSTANTIELLEMENT VRAI` · `FAUX` · `TROMPEUR / HORS CONTEXTE` · `INVÉRIFIABLE`.
- **Galaxie de capteurs de données** — au-delà de la recherche web, les verdicts s'appuient sur des sources **structurées, gratuites et illimitées** (encyclopédies, bases scientifiques et médicales, données officielles, actualité, résultats sportifs, fact-checks publiés). Voir plus bas.
- **Corroboration & indépendance des sources** — un score déterministe compte les **voix réellement indépendantes** (pas les URL), détecte le *reporting circulaire* et calibre la confiance du verdict.
- **Recherche web enfichable** — Exa (défaut), Tavily ou Serper, au choix dans le popup (BYOK). Les capteurs gratuits restent le socle même sans clé de recherche.
- **Transcription multilingue** — Deepgram en mode multilingue (français, anglais, etc.).
- **LLM au choix** — Anthropic (Claude) **ou** n'importe quel fournisseur **compatible OpenAI**, cloud ou local (LM Studio, Ollama…), via un menu de préréglages.
- **Support des modèles *reasoning*** — une case dédiée adapte la requête aux modèles qui « réfléchissent » (o-series, DeepSeek-R1, etc.).
- **Résultats sportifs** — capteur ESPN dédié (grandes ligues US + grands championnats de foot), pour éviter les erreurs de la presse en texte libre sur les scores.
- **Attribution aux locuteurs** — suit les intervenants (diarisation Deepgram) et attribue les affirmations.
- **Sources cliquables & filtrées** — seules les sources réellement utilisées pour le verdict sont affichées sur la carte.
- **Export de session** — rapport récapitulatif des verdicts exportable (avec sources et horodatage).
- **Mémorisation des clés** — au choix, clés conservées localement ou gardées uniquement pour la session en cours.
- **Bring-Your-Own-Key (BYOK)** — vous fournissez vos propres clés API ; l'auteur n'y a aucun accès.

---

## 🔧 Comment ça marche

```
Popup (réglages) ──► Background (event page Firefox)
        │
        ▼
Clic « Activer la capture audio » dans le panneau (geste utilisateur requis)
        │
        ▼
Content script : getUserMedia → AudioWorklet 16 kHz → PCM Int16 → fragments audio
        │  (envoyés au background)
        ▼
Background : WebSocket Deepgram → transcription → détection d'affirmations (LLM)
        │
        ▼
Grounding : galaxie de capteurs (web + sources structurées) en parallèle
        │
        ▼
Corroboration déterministe (voix indépendantes, crédibilité) → calibrage
        │
        ▼
LLM : verdict sourcé  ──►  Verdicts renvoyés au panneau superposé (overlay)
```

Le background est **agnostique de la source audio** et **du fournisseur LLM** : changer de modèle ou de moteur de recherche ne demande aucune modification de code, et la capture est isolée dans le content script.

---

## 🌐 La galaxie de capteurs

Le grounding ne repose pas sur un seul moteur payant. Un **routeur** choisit, selon le sujet de l'affirmation, les capteurs pertinents et les interroge **en parallèle** (avec cache court). La plupart sont **gratuits, sans clé et illimités** — ils forment le socle des verdicts, avec ou sans clé de recherche web.

| Capteur | Rôle | Clé requise |
|---|---|---|
| **Recherche web** (Exa / Tavily / Serper) | Résultats web généraux | Oui (BYOK, au choix) |
| **Wikipédia** (FR + EN) | Encyclopédie | Non |
| **Wikidata** | Base de connaissances structurée | Non |
| **GDELT** | Actualité / événements (presse mondiale) | Non |
| **OpenAlex** | Littérature académique | Non |
| **Crossref** | Publications + **détection des rétractations** | Non |
| **Europe PMC** | Biomédical / PubMed | Non |
| **Banque Mondiale** | Indicateurs officiels (pays × indicateur) | Non |
| **Nominatim (OSM)** | Géographie / lieux | Non |
| **ESPN** | Résultats sportifs (grandes ligues) | Non |
| **Google Fact Check Tools** | Fact-checks déjà publiés (AFP, PolitiFact…) | Oui (facultatif) |

> **Sport.** Les affirmations sportives sont routées vers ESPN et **exclues de GDELT** (la presse en texte libre confond pronostics et résultats). Le capteur ESPN privilégie la précision : il ne renvoie un match que si une équipe citée dans l'affirmation y figure.

---

## 🧭 Corroboration & indépendance des sources

Compter des URL ne dit rien : cinq « sources » peuvent n'être qu'une seule dépêche recopiée. InTruth calcule donc, **de façon 100 % déterministe et sans appel LLM supplémentaire** :

- **Voix indépendantes** — les résultats sont regroupés par **domaine enregistrable** (eTLD+1) **et** par **similarité lexicale** (trigrammes + Jaccard). On compte les grappes, pas les liens.
- **Reporting circulaire** — signalé quand plusieurs résultats retombent dans une même voix.
- **Crédibilité par type de source** — pondération par **signaux** (données officielles > publications scientifiques > fact-checks > encyclopédies > presse/web générique), jamais par réputation de média.

Ce score de **robustesse** (`INSUFFISANTE / FAIBLE / MODÉRÉE / SOLIDE`) **calibre** le verdict sans jamais le gonfler :

- corroboration **insuffisante** (aucune voix crédible sur le sujet) → verdict ramené à `INVÉRIFIABLE` ;
- corroboration **faible** (une seule voix générique) → confiance plafonnée ;
- une **source primaire/officielle** seule (ex. Banque Mondiale) n'est jamais pénalisée.

> Inspiré du projet frère **au-crible**. L'objectif n'est pas de trancher plus, mais d'**arrêter d'affirmer avec assurance sur une base fragile**.

---

## 🎙️ La capture audio sous Firefox — à lire avant de tester

Firefox **n'expose pas** d'API permettant de capter directement le son d'un onglet (`tabCapture` n'est pas implémenté, et `getDisplayMedia` ne renvoie aucune piste audio sous Firefox). InTruth capte donc un **périphérique d'entrée audio** via `getUserMedia` (traité par un **AudioWorklet**, hors du thread principal).

Au clic sur **« Activer la capture audio »**, Firefox affiche une fenêtre de permission micro **avec un menu déroulant de périphériques**. Le choix de ce périphérique détermine ce qui est transcrit :

| Objectif | Périphérique à choisir |
|---|---|
| **Capter le son de l'onglet proprement** | un périphérique **« Monitor » / loopback** |
| └ Linux (PulseAudio/PipeWire) | « Monitor of … » (déjà présent, rien à installer) |
| └ Windows | « Stereo Mix » (à activer) ou un câble virtuel type VB-Audio Cable |
| └ macOS | un périphérique loopback type BlackHole |
| Test rapide / dépannage | votre micro réel — capte le son des haut-parleurs **+ le bruit ambiant** (qualité médiocre) |

> C'est une limite de Firefox, pas de l'extension. Le son de la vidéo continue de jouer normalement pendant la capture.

---

## 🤖 Modèles LLM pris en charge

InTruth fonctionne avec **Anthropic** nativement, et avec **tout fournisseur exposant l'API `/chat/completions`** (standard OpenAI). Dans le popup, choisissez le fournisseur dans le menu **« Fournisseur (préréglage) »** : l'endpoint se remplit automatiquement. Vous renseignez ensuite le **modèle** et la **clé**.

| Préréglage | Endpoint (URL de base) |
|---|---|
| OpenRouter (290+ modèles, 1 clé) | `https://openrouter.ai/api/v1` |
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
| Personnalisé | (saisie manuelle de l'URL) |

**Modèles *reasoning*.** Si votre modèle « réfléchit » avant de répondre (o-series, DeepSeek-R1, etc.), cochez **« Modèle reasoning »**. InTruth omet alors la `temperature`, utilise `max_completion_tokens` avec un budget élargi, et retire le bloc `<think>…</think>` de la réponse avant l'analyse.

**Modèles locaux.** Les préréglages LM Studio et Ollama pointent vers `localhost` (déjà autorisé). Activez le serveur (LM Studio → onglet *Developer/Server*, ou lancez Ollama), puis renseignez l'identifiant du modèle chargé. La clé peut rester vide en local.

**Autre fournisseur ?** Ajoutez son domaine dans `host_permissions` du `manifest.json` (sinon le `fetch` est bloqué par le CORS) et, si vous voulez, une `<option>` avec son `data-url` dans le popup.

---

## 🔎 Recherche web (moteur enfichable)

La recherche web se choisit **dans le popup** (section « Recherche web »), pas dans le code. Trois moteurs, chacun en BYOK :

| Moteur | Palier gratuit | Notes |
|---|---|---|
| **Exa** (défaut) | ~20 000 requêtes / mois | Recherche neuronale/sémantique ; couverture plus étroite sur le français et le très récent |
| **Tavily** | ~1 000 requêtes / mois | Orienté LLM ; bonne couverture générale, sans carte bancaire |
| **Serper** | crédit de démarrage | Recherche Google ; payant à l'usage ensuite |
| **Aucune** | — | Les capteurs structurés gratuits suffisent comme socle |

> Sur du contenu **francophone**, Exa peut renvoyer peu de résultats → basculez sur **Tavily** ou **Serper** pour une meilleure corroboration. Les paliers gratuits évoluent : vérifiez le vôtre sur le tableau de bord du fournisseur.

---

## 🔑 Clés API & mémorisation

- **Clé LLM** — Anthropic, ou celle de votre fournisseur compatible OpenAI (facultative pour un modèle purement local).
- **Clé Deepgram** — pour la transcription audio.
- **Clé de recherche web** — Exa / Tavily / Serper selon le moteur choisi (facultative : sans elle, les capteurs gratuits assurent le socle).
- **Clé Google Fact Check** — facultative ; renforce les verdicts avec les fact-checks déjà publiés.

**Mémorisation.** La case **« Se souvenir de mes clés sur ce navigateur »** (cochée par défaut) contrôle le stockage :

- **cochée** → clés dans `storage.local` (persistant) ;
- **décochée** → clés en `storage.session` (session courante uniquement, jamais écrites sur le disque).

> ⚠️ **Persistance et module temporaire.** Pour un module chargé via `about:debugging`, Firefox **efface le stockage local au redémarrage du navigateur**. Deux solutions : (1) en dev, passez `extensions.webextensions.keepStorageOnUninstall` **et** `keepUuidOnUninstall` à `true` dans `about:config` ; (2) en usage réel, installez une version empaquetée/signée.

---

## 🚀 Utilisation

1. Ouvrez une vidéo / un live / un débat (ex. YouTube).
2. Cliquez sur l'icône InTruth : choisissez le fournisseur LLM, le moteur de recherche, renseignez le modèle et les clés (LLM + Deepgram).
3. Cliquez sur **Start Fact-Checking** — le panneau apparaît sur la page.
4. Dans le panneau, cliquez **« Activer la capture audio »** et **sélectionnez votre périphérique Monitor/loopback** dans la fenêtre Firefox.
5. Transcriptions, affirmations et verdicts s'affichent en direct. Exportez le rapport en fin de session.

---

## 🎯 Qu'est-ce qu'une affirmation « vérifiable » ?

**Vérifié :** déclarations factuelles précises, statistiques et données chiffrées, événements historiques, bilans et actions gouvernementaux, affirmations scientifiques ou médicales, résultats sportifs, faits documentés.

*Exemples :* « L'inflation a culminé à 9,1 % en 2022. » · « Ce projet de loi a été voté au Sénat en 2021. » · « Le Paraguay a éliminé l'Allemagne. »

**Non vérifié :** opinions, prédictions et promesses, questions rhétoriques, jugements de valeur, descriptions subjectives.

*Exemples :* « Cette politique va détruire l'économie. » · « J'ai le meilleur programme. » · « Si mon adversaire gagne, ce sera un désastre. »

---

## 🖥️ Plateformes prises en charge

Le panneau s'injecte sur : **YouTube**, **Twitch**, **X / Twitter**, **Facebook** (`www` et `web`), **Rumble**, **Kick**, **Instagram**, **TikTok**, **Bluesky**, **Odysee** et **Dailymotion**.

> Pour en ajouter une, complétez `content_scripts.matches` dans `manifest.json`.

---

## 🔒 Permissions Firefox

- `activeTab` — interagir avec l'onglet actif au lancement.
- `scripting` — injecter le panneau de verdicts.
- `storage` — sauvegarder vos clés et préférences localement.
- `host_permissions` — joindre les API utilisées : Anthropic, les fournisseurs compatibles OpenAI pré-autorisés (OpenRouter, Gemini, Groq, Mistral, DeepSeek, xAI, Together, Fireworks, Perplexity), OpenAI, Deepgram, les moteurs de recherche (Exa, Tavily, Serper), les capteurs de données (Wikipédia, Wikidata, GDELT, OpenAlex, Crossref, Europe PMC, Banque Mondiale, Nominatim, ESPN, Google Fact Check), et `localhost`/`127.0.0.1` (modèles locaux).
- **Micro** — l'autorisation d'accès à l'entrée audio est demandée *à l'exécution*, lors du clic sur « Activer la capture audio ».

*(Firefox n'a besoin ni de `offscreen` ni de `tabCapture` : la capture passe par `getUserMedia` et le WebSocket tourne dans le background.)*

---

## 🔐 Confidentialité

- Vous fournissez vos propres identifiants d'API ; l'auteur de l'extension n'y a aucun accès.
- Les fragments de transcription sont envoyés directement aux services que **vous** configurez (Deepgram pour la transcription, votre LLM pour l'analyse, le moteur de recherche choisi).
- Les capteurs de données ouvertes interrogés sont des **API publiques** (Wikipédia, Banque Mondiale, ESPN…).
- Les clés et préférences sont stockées **localement** dans votre navigateur (ou en mémoire de session si la mémorisation est désactivée).

---

## ⚠️ Limites et avertissements

Le fact-checking automatique est imparfait. Les verdicts peuvent être erronés, incomplets ou basés sur des informations datées. En cas de doute, faites vos propres recherches et consultez les sources primaires.

- Les **modèles *reasoning*** sont plus lents : une carte « en attente » expire au bout de 90 s dans le panneau — un modèle local trop lent peut dépasser ce délai.
- La **qualité de la capture audio** dépend du périphérique choisi (voir la section dédiée).
- La **couverture sportive** se limite aux grandes ligues (ESPN, endpoints non officiels susceptibles de changer).
- **Exa** couvre moins bien le français et le très récent ; en corroboration, cela peut ramener certains verdicts à `INVÉRIFIABLE` — préférez Tavily/Serper sur du contenu francophone.

**Cette extension est un outil d'assistance, pas une autorité.**

---

## 💻 Prérequis & installation (mode développeur)

- Mozilla Firefox **140+** (desktop) ou **142+** (Android).
- Une clé Deepgram, et une clé LLM (Anthropic ou fournisseur compatible OpenAI) — sauf modèle 100 % local. Une clé de recherche web (Exa/Tavily/Serper) est recommandée mais facultative.

1. Clonez ce dépôt.
2. Dans Firefox, ouvrez `about:debugging#/runtime/this-firefox`.
3. **Charger un module temporaire…** → sélectionnez le `manifest.json` du dossier `realtime-factcheck/`.
4. Ouvrez une vidéo, cliquez sur l'icône de l'extension, renseignez vos clés, puis **Start**.

> Après chaque modification des fichiers, cliquez sur **Recharger** dans `about:debugging`.

---

## 🤝 Contribution

Remarques, idées et retours sur des cas particuliers bienvenus — ouvrez une *Issue* ou une *Pull Request*.

## 🙏 Crédits

- Projet original **InTruth** par [Risha Panigrahi](https://github.com/rpanigrahi222/intruth-factcheck).
- Fork Firefox, galaxie de capteurs, recherche enfichable et corroboration : ce dépôt.

## 📄 Licence

Licence MIT (voir le fichier `LICENSE`).
