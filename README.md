# InTruth — Extension Firefox de fact-checking en temps réel

> **Fork Firefox** du projet original [InTruth](https://github.com/rpanigrahi222/intruth-factcheck) (fact-checking en direct), adapté pour Mozilla Firefox et étendu : LLM configurable (cloud **ou** local), support des modèles *reasoning*, et mémorisation des clés.

**InTruth** écoute l'audio capté par le navigateur, le transcrit en direct, détecte les affirmations factuelles au moment où elles sont prononcées, puis affiche des verdicts de vérification dans un panneau superposé à la page. Utile sur les débats, interviews, conférences de presse, lives et prises de parole.

La plupart des articles de fact-checking paraissent des jours après l'événement. Ici, l'évaluation se fait pendant que la vidéo tourne.

---

## ⚡ Fonctionnalités

- **Détection d'affirmations en direct** — repère en continu les affirmations factuelles vérifiables dans la parole transcrite.
- **Verdicts en temps réel** — chaque affirmation est classée :
  - `VRAI`
  - `SUBSTANTIELLEMENT VRAI`
  - `FAUX`
  - `TROMPEUR / HORS CONTEXTE`
  - `INVÉRIFIABLE`
- **Transcription multilingue** — Deepgram Nova-3 en mode `language=multi` (français, anglais, etc.).
- **LLM au choix** — Anthropic (Claude) **ou** n'importe quel fournisseur **compatible OpenAI**, cloud ou local (LM Studio, Ollama…), via un menu de préréglages.
- **Support des modèles *reasoning*** — une case dédiée adapte la requête aux modèles qui « réfléchissent » (o-series, DeepSeek-R1, etc.).
- **Attribution aux locuteurs** — suit les intervenants (diarisation Deepgram) et attribue les affirmations.
- **Mémorisation des clés** — option pour conserver vos clés localement, ou les garder uniquement pour la session en cours.
- **Export de session** — récapitulatif des verdicts exportable.
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
Content script : getUserMedia → AudioContext 16 kHz → PCM Int16 → fragments audio
        │  (envoyés au background)
        ▼
Background : WebSocket Deepgram → transcription → détection d'affirmations
        │
        ▼
LLM (Anthropic ou compatible OpenAI) [+ recherche web Serper, optionnelle]
        │
        ▼
Verdicts renvoyés au panneau superposé (overlay)
```

Le background est **agnostique de la source audio** et **du fournisseur LLM** : changer de modèle ne demande aucune modification de code, et la capture est isolée dans le content script.

---

## 🎙️ La capture audio sous Firefox — à lire avant de tester

Firefox **n'expose pas** d'API permettant de capter directement le son d'un onglet (`tabCapture` n'est pas implémenté, et `getDisplayMedia` ne renvoie aucune piste audio sous Firefox). InTruth capte donc un **périphérique d'entrée audio** via `getUserMedia`.

Concrètement, au clic sur **« Activer la capture audio »**, Firefox affiche une fenêtre de permission micro **avec un menu déroulant de périphériques**. Le choix de ce périphérique détermine ce qui est transcrit :

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

**Modèles *reasoning*.** Si votre modèle « réfléchit » avant de répondre (o-series, DeepSeek-R1, etc.), cochez **« Modèle reasoning »**. InTruth omet alors la `temperature`, utilise `max_completion_tokens` avec un budget élargi, et retire le bloc de réflexion `<think>…</think>` de la réponse avant l'analyse.

**Modèles locaux.** Les préréglages LM Studio et Ollama pointent vers `localhost` (déjà autorisé). Activez le serveur dans LM Studio (onglet *Developer/Server*) ou lancez Ollama, puis renseignez l'identifiant du modèle chargé. La clé API peut rester vide en local.

**Autre fournisseur ?** Ajoutez son domaine dans `host_permissions` du `manifest.json` (sinon le `fetch` est bloqué par le CORS) et, si vous voulez, une `<option>` avec son `data-url` dans le popup.

---

## 🔑 Clés API et mémorisation

InTruth a besoin de **deux clés** :

1. **Clé LLM** — votre clé Anthropic, ou celle de votre fournisseur compatible OpenAI (facultative pour un modèle purement local comme LM Studio).
2. **Clé Deepgram** — pour la transcription audio.

> Une recherche web (Serper) peut renforcer les verdicts. La clé Serper se règle dans le code (`SERPER_KEY` dans le service worker) ; sans elle, les verdicts reposent sur les seules connaissances du modèle.

**Mémorisation.** La case **« Se souvenir de mes clés sur ce navigateur »** (cochée par défaut) contrôle le stockage :

- **cochée** → clés enregistrées dans `storage.local` (persistant) ;
- **décochée** → clés gardées uniquement pour la session courante (`storage.session`), jamais écrites sur le disque.

> ⚠️ **Persistance et module temporaire.** Pour un module chargé via `about:debugging` (temporaire), Firefox **efface le stockage local au redémarrage du navigateur** — vos clés disparaissent alors même si la case est cochée. Deux solutions :
> 1. **En dev** — dans `about:config`, passez `extensions.webextensions.keepStorageOnUninstall` **et** `extensions.webextensions.keepUuidOnUninstall` à `true`.
> 2. **En usage réel** — installez une version empaquetée/signée : le stockage persiste alors normalement.

---

## 🚀 Utilisation

1. Ouvrez une vidéo / un live / un débat (ex. YouTube).
2. Cliquez sur l'icône InTruth, choisissez le fournisseur, renseignez le modèle et les clés (LLM + Deepgram).
3. Cliquez sur **Start Fact-Checking** — le panneau apparaît sur la page.
4. Dans le panneau, cliquez **« Activer la capture audio »** et **sélectionnez votre périphérique Monitor/loopback** dans la fenêtre Firefox.
5. Les transcriptions, affirmations et verdicts s'affichent en direct.

---

## 🎯 Qu'est-ce qu'une affirmation « vérifiable » ?

**Vérifié :** déclarations factuelles précises, statistiques et données chiffrées, événements historiques, bilans et actions gouvernementaux, affirmations scientifiques ou médicales, faits documentés.

*Exemples :* « L'inflation a culminé à 9,1 % en 2022. » · « Ce projet de loi a été voté au Sénat en 2021. » · « Le taux de chômage est inférieur à 5 %. »

**Non vérifié :** opinions, prédictions et promesses, questions rhétoriques, jugements de valeur, descriptions subjectives.

*Exemples :* « Cette politique va détruire l'économie. » · « J'ai le meilleur programme. » · « Si mon adversaire gagne, ce sera un désastre. »

---

## 🔒 Permissions Firefox

- `activeTab` — interagir avec l'onglet actif au lancement.
- `scripting` — injecter le panneau de verdicts.
- `storage` — sauvegarder vos clés et préférences localement.
- `host_permissions` — joindre les API utilisées : Anthropic, les fournisseurs compatibles OpenAI pré-autorisés (OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Fireworks, Perplexity), OpenAI, Deepgram, Serper, polices Google, et `localhost`/`127.0.0.1` (modèles locaux).
- **Micro** — l'autorisation d'accès à l'entrée audio est demandée *à l'exécution*, lors du clic sur « Activer la capture audio ».

*(Firefox n'a pas besoin de la permission `offscreen` ni de `tabCapture` : la capture passe par `getUserMedia` et le WebSocket tourne dans le background.)*

---

## 🔐 Confidentialité

- Vous fournissez vos propres identifiants d'API ; l'auteur de l'extension n'y a aucun accès.
- Les fragments de transcription sont envoyés directement aux services que **vous** configurez (Deepgram pour la transcription, votre LLM pour l'analyse).
- Les clés et préférences sont stockées **localement** dans votre navigateur (ou en mémoire de session si la mémorisation est désactivée).

---

## ⚠️ Limites et avertissements

Le fact-checking automatique est imparfait. Les verdicts peuvent être erronés, incomplets ou basés sur des informations datées. En cas de doute, faites vos propres recherches et consultez les sources primaires.

- Les **modèles *reasoning*** sont plus lents : une carte de verdict « en attente » expire au bout de 90 s dans le panneau — un modèle local trop lent peut dépasser ce délai.
- La **qualité de la capture audio** dépend du périphérique choisi (voir la section dédiée).

**Cette extension est un outil d'assistance, pas une autorité.**

---

## 💻 Prérequis & installation (mode développeur)

- Mozilla Firefox **140+** (desktop) ou **142+** (Android).
- Une clé Deepgram, et une clé LLM (Anthropic ou fournisseur compatible OpenAI) — sauf modèle 100 % local.

1. Clonez ce dépôt.
2. Dans Firefox, ouvrez `about:debugging#/runtime/this-firefox`.
3. **Charger un module temporaire…** → sélectionnez le `manifest.json` du dossier `realtime-factcheck/`.
4. Ouvrez une vidéo, cliquez sur l'icône de l'extension, renseignez vos clés, puis **Start**.

> Après chaque modification des fichiers, cliquez sur **Recharger** dans `about:debugging` pour reprendre en compte le nouveau code/manifeste.

---

## 🤝 Contribution

Remarques, idées et retours sur des cas particuliers bienvenus — ouvrez une *Issue* ou une *Pull Request*.

## 📄 Licence

Licence MIT (voir le fichier `LICENSE`).

