# InTruth — Extension Firefox de fact-checking en temps réel

**InTruth** est une extension Firefox qui transcrit l’audio d’une vidéo en direct, détecte les affirmations factuelles, puis affiche des verdicts de vérification directement sur la page.

Elle peut être utilisée sur des vidéos, débats, interviews, conférences, lives ou prises de parole politiques.

Cette version fonctionne avec :

- **Deepgram** pour la transcription audio ;
- un **LLM** pour analyser les phrases et produire des verdicts ;
- des fournisseurs compatibles **Anthropic** ou **OpenAI-compatible** ;
- des modèles locaux comme **LM Studio** ;
- des fournisseurs cloud de test comme **FantasyAI**.

---

## Ce que fait l’extension

Quand vous lancez InTruth sur une page vidéo :

1. l’extension capture l’audio de l’onglet ;
2. Deepgram transforme l’audio en texte ;
3. le texte est découpé en petits blocs ;
4. le LLM cherche des affirmations factuelles ;
5. l’extension affiche les claims et les verdicts dans un overlay.

Exemple :

```txt
Phrase entendue :
"La capitale de la France est Paris."

Résultat attendu :
Claim détecté → La capitale de la France est Paris.
Verdict → TRUE
```

---

## Important : utiliser un modèle non-reasoning

Pour fonctionner correctement, InTruth a besoin que le modèle renvoie sa réponse finale dans :

```js
choices[0].message.content
```

Certains modèles de type **reasoning**, **thinking** ou **chain-of-thought** renvoient leur réflexion dans :

```js
choices[0].message.reasoning
```

et laissent :

```js
choices[0].message.content
```

vide.

Dans ce cas, l’extension reçoit bien une réponse du fournisseur, mais elle ne peut pas l’utiliser.

### À retenir

Utilisez un modèle **chat**, **instruct** ou **non-reasoning**.

Évitez les modèles qui ne produisent que du raisonnement interne.

Si vous voyez une erreur du type :

```txt
contenu texte introuvable
message.content vide
reasoning rempli
```

le problème vient probablement du modèle choisi.

---

## Télécharger le projet

Vous pouvez télécharger le dépôt de deux manières.

### Option 1 — Depuis GitHub

Allez sur la page du dépôt :

```txt
https://github.com/Othman-Benbrahim/intruth-factcheck-firefox
```

Puis cliquez sur :

```txt
Code → Download ZIP
```

Décompressez ensuite le fichier ZIP sur votre ordinateur.

### Option 2 — Avec Git

```bash
git clone https://github.com/Othman-Benbrahim/intruth-factcheck-firefox.git
```

---

## Installer l’extension dans Firefox en local

L’extension se charge manuellement en mode développement.

1. Ouvrez Firefox.
2. Dans la barre d’adresse, entrez :

```txt
about:debugging#/runtime/this-firefox
```

3. Cliquez sur :

```txt
Load Temporary Add-on
```

ou en français :

```txt
Charger un module complémentaire temporaire
```

4. Sélectionnez le fichier :

```txt
realtime-factcheck/manifest.json
```

5. L’extension InTruth apparaît dans Firefox.

Attention : comme c’est un chargement temporaire, l’extension peut disparaître après fermeture complète de Firefox. Il faudra alors la recharger depuis `about:debugging`.

---

## Configuration des clés API

Ouvrez l’extension depuis l’icône Firefox.

Vous devez renseigner :

### 1. Clé Deepgram

Elle sert à transcrire l’audio.

Champ :

```txt
Deepgram API Key
```

La transcription actuelle est prévue pour fonctionner en français et en anglais.

### 2. Fournisseur LLM

Vous pouvez choisir :

```txt
Anthropic
```

ou :

```txt
Compatible OpenAI / LM Studio
```

Utilisez **Compatible OpenAI / LM Studio** pour :

- LM Studio en local ;
- FantasyAI ;
- un autre endpoint compatible OpenAI ;
- un serveur local compatible `/chat/completions`.

### 3. Endpoint LLM

Pour LM Studio en local, l’endpoint ressemble souvent à :

```txt
http://localhost:1234/v1
```

ou :

```txt
http://127.0.0.1:1234/v1
```

Pour FantasyAI, utilisez :

```txt
https://fantasyai.cloud/api/v1
```

Ne mettez pas forcément l’URL complète `/chat/completions`, car le service-worker peut déjà l’ajouter automatiquement.

### 4. Modèle LLM

Indiquez le nom du modèle utilisé.

Choisissez un modèle qui répond directement en JSON dans `message.content`.

---

## Permissions dans manifest.json

Si vous utilisez un fournisseur cloud, Firefox doit avoir le droit d’appeler son domaine.

Dans `manifest.json`, ajoutez le domaine dans `host_permissions`.

Exemple pour FantasyAI :

```json
"https://fantasyai.cloud/*"
```

Exemple pour Deepgram :

```json
"https://api.deepgram.com/*"
```

Exemple complet :

```json
"host_permissions": [
  "https://api.anthropic.com/*",
  "https://google.serper.dev/*",
  "https://api.deepgram.com/*",
  "https://fantasyai.cloud/*",
  "https://fonts.googleapis.com/*",
  "https://fonts.gstatic.com/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
]
```

Après modification du `manifest.json`, rechargez l’extension depuis :

```txt
about:debugging#/runtime/this-firefox
```

---

## Utiliser l’extension

1. Ouvrez une vidéo compatible.
2. Cliquez sur l’icône InTruth.
3. Entrez vos clés API.
4. Vérifiez que le fournisseur LLM est bien configuré.
5. Cliquez sur :

```txt
Start Fact-Checking
```

6. Lancez la vidéo.
7. L’overlay apparaît sur la page.
8. Les transcriptions, claims et verdicts s’affichent progressivement.

---

## Tester rapidement si tout fonctionne

Avant de tester sur une vraie vidéo politique, utilisez une phrase simple.

Par exemple, lancez une vidéo ou un audio contenant :

```txt
La capitale de la France est Paris.
```

Résultat attendu :

```txt
Transcription visible
Claim détecté
Verdict affiché
```

Si la transcription s’affiche mais pas le verdict, le problème vient probablement du LLM, du modèle choisi ou du format JSON renvoyé.

---

## Comprendre les erreurs fréquentes

### La transcription fonctionne, mais aucun verdict n’apparaît

Cela veut dire que Deepgram fonctionne.

Le problème se situe probablement ici :

```txt
LLM
modèle choisi
réponse JSON
endpoint
clé API
```

Vérifiez que le modèle n’est pas un modèle reasoning-only.

### Erreur : réponse vide du LLM

Le fournisseur répond peut-être, mais le modèle ne renvoie rien dans `message.content`.

Essayez un autre modèle non-reasoning.

### Erreur : JSON invalide

Le modèle répond, mais pas dans le bon format.

Essayez :

- un modèle plus simple ;
- un modèle instruct/chat ;
- un transcript plus court ;
- un modèle connu pour respecter les consignes JSON.

### Erreur : contenu texte introuvable

Cela arrive souvent quand la réponse ressemble à :

```json
{
  "message": {
    "content": "",
    "reasoning": "..."
  }
}
```

Dans ce cas, changez de modèle.

### Endpoint incorrect

Pour un endpoint OpenAI-compatible, utilisez généralement une base URL :

```txt
https://fournisseur.com/api/v1
```

et non :

```txt
https://fournisseur.com/api/v1/chat/completions
```

si le service-worker ajoute déjà `/chat/completions`.

---

## Utilisation avec LM Studio en local

1. Ouvrez LM Studio.
2. Chargez un modèle chat/instruct.
3. Lancez le serveur local.
4. Dans InTruth, choisissez :

```txt
Compatible OpenAI / LM Studio
```

5. Mettez comme endpoint :

```txt
http://localhost:1234/v1
```

6. Entrez le nom du modèle chargé.
7. Lancez InTruth.

Si rien ne se passe, vérifiez que le serveur LM Studio est bien actif.

---

## Utilisation avec FantasyAI

Pour une version de test avec FantasyAI :

1. Ajoutez dans `manifest.json` :

```json
"https://fantasyai.cloud/*"
```

2. Rechargez l’extension dans Firefox.
3. Dans la popup InTruth, choisissez :

```txt
Compatible OpenAI / LM Studio
```

4. Mettez comme endpoint :

```txt
https://fantasyai.cloud/api/v1
```

5. Entrez votre clé API FantasyAI.
6. Choisissez un modèle non-reasoning.
7. Lancez le test.

Si un modèle renvoie seulement du `reasoning` mais pas de `content`, changez de modèle.

---

## Mode debugging Firefox

Pour comprendre un problème, utilisez les outils de debug Firefox.

### Ouvrir le debug de l’extension

1. Allez sur :

```txt
about:debugging#/runtime/this-firefox
```

2. Trouvez InTruth.
3. Cliquez sur :

```txt
Inspect
```

ou :

```txt
Inspecter
```

4. Ouvrez la console.

Vous pourrez voir les erreurs du service-worker :

```txt
erreur LLM
réponse vide
JSON invalide
endpoint inaccessible
clé invalide
```

### Recharger l’extension

Après chaque modification de fichier :

1. retournez dans `about:debugging` ;
2. cliquez sur `Reload` ou `Recharger` ;
3. rechargez aussi la page vidéo ;
4. relancez l’extension.

---

## Structure du projet

```txt
realtime-factcheck/
├── manifest.json
├── src/
│   ├── background/
│   │   └── service-worker.js
│   ├── content/
│   │   ├── overlay.js
│   │   ├── capture.js
│   │   ├── lexical-features.js
│   │   └── session-export.js
│   └── popup/
│       ├── popup.html
│       ├── popup.css
│       └── popup.js
└── assets/
```

### Fichiers importants

```txt
manifest.json
```

Déclare les permissions Firefox et les domaines autorisés.

```txt
service-worker.js
```

Gère Deepgram, le LLM, les claims, les verdicts et les erreurs.

```txt
overlay.js
```

Affiche l’interface sur la page vidéo.

```txt
popup.js
```

Gère la popup, les clés API et le bouton de lancement.

---

## Confidentialité

Les clés API sont stockées localement dans Firefox.

L’audio est envoyé à Deepgram pour transcription.

Le texte transcrit est envoyé au fournisseur LLM configuré par l’utilisateur.

Si la recherche web est activée, certaines affirmations peuvent être envoyées à un moteur de recherche ou à une API de recherche.

N’utilisez pas cette extension sur des contenus sensibles si vous ne voulez pas que l’audio ou le transcript soit transmis à des services externes.

---

## Limites

InTruth est un outil expérimental.

Il peut :

- manquer des affirmations ;
- mal interpréter une phrase ;
- produire un verdict incomplet ;
- dépendre fortement de la qualité de transcription ;
- échouer si le modèle ne respecte pas le format JSON ;
- afficher `UNVERIFIABLE` quand le contexte manque.

L’extension aide à analyser un discours, mais ne remplace pas une vérification humaine.

---

## Résumé rapide

Pour que l’extension fonctionne :

```txt
1. Charger manifest.json dans Firefox via about:debugging
2. Ajouter les domaines cloud dans host_permissions
3. Entrer une clé Deepgram valide
4. Entrer une clé LLM valide
5. Utiliser un modèle non-reasoning
6. Vérifier que le modèle écrit dans message.content
7. Tester avec une phrase simple
8. Lancer le fact-checking
```

---

## Licence

MIT License.

