# InTruth — Extension Firefox de fact-checking en temps reel

**InTruth** est une extension Firefox qui transcrit l'audio d'une video en direct, detecte les affirmations factuelles, puis affiche des verdicts de verification directement sur la page.

Elle peut etre utilisee sur des videos, debats, interviews, conferences, lives ou prises de parole politiques.

Cette version fonctionne avec :

- **Deepgram** pour la transcription audio ;
- un **LLM** pour analyser les phrases et produire des verdicts ;
- des fournisseurs compatibles **Anthropic** ou **OpenAI-compatible** ;
- des modeles locaux comme **LM Studio**.

---

## Ce que fait l'extension

Quand vous lancez InTruth sur une page video :

1. l'extension capture l'audio de l'onglet ;
2. Deepgram transforme l'audio en texte ;
3. le texte est decoupe en petits blocs ;
4. le LLM cherche des affirmations factuelles ;
5. l'extension affiche les claims et les verdicts dans un overlay.

Exemple :

```txt
Phrase entendue :
La capitale de la France est Paris.

Resultat attendu :
Claim detecte -> La capitale de la France est Paris.
Verdict -> TRUE
```

---

## Important : utiliser un modele non-reasoning

Pour fonctionner correctement, InTruth a besoin que le modele renvoie sa reponse finale dans :

```js
choices[0].message.content
```

Certains modeles de type **reasoning**, **thinking** ou **chain-of-thought** renvoient leur raisonnement dans :

```js
choices[0].message.reasoning
```

et laissent :

```js
choices[0].message.content
```

vide.

Dans ce cas, l'extension recoit bien une reponse du fournisseur, mais elle ne peut pas l'utiliser.

### A retenir

Utilisez un modele **chat**, **instruct** ou **non-reasoning**.

Evitez les modeles qui ne produisent que du raisonnement interne.

Si vous voyez une erreur du type :

```txt
contenu texte introuvable
message.content vide
reasoning rempli
```

le probleme vient probablement du modele choisi.

---

## Telecharger le projet

### Option 1 — Depuis GitHub

Allez sur la page du depot :

```txt
https://github.com/Othman-Benbrahim/intruth-factcheck-firefox
```

Puis cliquez sur :

```txt
Code -> Download ZIP
```

Decompressez ensuite le fichier ZIP sur votre ordinateur.

### Option 2 — Avec Git

```bash
git clone https://github.com/Othman-Benbrahim/intruth-factcheck-firefox.git
```

---

## Installer l'extension dans Firefox en local

L'extension se charge manuellement en mode developpement.

1. Ouvrez Firefox.
2. Dans la barre d'adresse, entrez :

```txt
about:debugging#/runtime/this-firefox
```

3. Cliquez sur :

```txt
Load Temporary Add-on
```

ou en francais :

```txt
Charger un module complementaire temporaire
```

4. Selectionnez le fichier :

```txt
realtime-factcheck/manifest.json
```

5. L'extension InTruth apparait dans Firefox.

Attention : comme c'est un chargement temporaire, l'extension peut disparaitre apres fermeture complete de Firefox. Il faudra alors la recharger depuis `about:debugging`.

---

## Configuration des cles API

Ouvrez l'extension depuis l'icone Firefox.

Vous devez renseigner :

### 1. Cle Deepgram

Elle sert a transcrire l'audio.

Champ :

```txt
Deepgram API Key
```

La transcription actuelle est prevue pour fonctionner en francais et en anglais.

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
- un autre endpoint compatible OpenAI ;
- un serveur local compatible `/chat/completions`.

### 3. Endpoint LLM

Pour LM Studio en local, l'endpoint ressemble souvent a :

```txt
http://localhost:1234/v1
```

ou :

```txt
http://127.0.0.1:1234/v1
```

Pour OpenAI officiel, l'endpoint est generalement :

```txt
https://api.openai.com/v1
```

### 4. Modele LLM

Indiquez le nom du modele utilise.

Choisissez un modele qui repond directement en JSON dans `message.content`.

---

## Permissions dans manifest.json

Si vous utilisez un fournisseur cloud, Firefox doit avoir le droit d'appeler son domaine.

Dans `manifest.json`, ajoutez le domaine dans `host_permissions`.

Exemple pour Deepgram :

```json
"https://api.deepgram.com/*"
```

Exemple pour OpenAI :

```json
"https://api.openai.com/*"
```

Exemple pour Anthropic :

```json
"https://api.anthropic.com/*"
```

Exemple de configuration :

```json
"host_permissions": [
  "https://api.anthropic.com/*",
  "https://api.openai.com/*",
  "https://google.serper.dev/*",
  "https://api.deepgram.com/*",
  "https://fonts.googleapis.com/*",
  "https://fonts.gstatic.com/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
]
```

Apres modification du `manifest.json`, rechargez l'extension depuis :

```txt
about:debugging#/runtime/this-firefox
```

---

## Utiliser l'extension

1. Ouvrez une video compatible.
2. Cliquez sur l'icone InTruth.
3. Entrez vos cles API.
4. Verifiez que le fournisseur LLM est bien configure.
5. Cliquez sur :

```txt
Start Fact-Checking
```

6. Lancez la video.
7. L'overlay apparait sur la page.
8. Les transcriptions, claims et verdicts s'affichent progressivement.

---

## Tester rapidement si tout fonctionne

Avant de tester sur une vraie video politique, utilisez une phrase simple.

Par exemple, lancez une video ou un audio contenant :

```txt
La capitale de la France est Paris.
```

Resultat attendu :

```txt
Transcription visible
Claim detecte
Verdict affiche
```

Si la transcription s'affiche mais pas le verdict, le probleme vient probablement du LLM, du modele choisi ou du format JSON renvoye.

---

## Comprendre les erreurs frequentes

### La transcription fonctionne, mais aucun verdict n'apparait

Cela veut dire que Deepgram fonctionne.

Le probleme se situe probablement ici :

```txt
LLM
modele choisi
reponse JSON
endpoint
cle API
```

Verifiez que le modele n'est pas un modele reasoning-only.

### Erreur : reponse vide du LLM

Le fournisseur repond peut-etre, mais le modele ne renvoie rien dans `message.content`.

Essayez un autre modele non-reasoning.

### Erreur : JSON invalide

Le modele repond, mais pas dans le bon format.

Essayez :

- un modele plus simple ;
- un modele instruct/chat ;
- un transcript plus court ;
- un modele connu pour respecter les consignes JSON.

### Erreur : contenu texte introuvable

Cela arrive souvent quand la reponse ressemble a :

```json
{
  "message": {
    "content": "",
    "reasoning": "..."
  }
}
```

Dans ce cas, changez de modele.

### Endpoint incorrect

Pour un endpoint OpenAI-compatible, utilisez generalement une base URL :

```txt
https://fournisseur.com/api/v1
```

et non :

```txt
https://fournisseur.com/api/v1/chat/completions
```

si le service-worker ajoute deja `/chat/completions`.

---

## Utilisation avec LM Studio en local

1. Ouvrez LM Studio.
2. Chargez un modele chat/instruct.
3. Lancez le serveur local.
4. Dans InTruth, choisissez :

```txt
Compatible OpenAI / LM Studio
```

5. Mettez comme endpoint :

```txt
http://localhost:1234/v1
```

6. Entrez le nom du modele charge.
7. Lancez InTruth.

Si rien ne se passe, verifiez que le serveur LM Studio est bien actif.

---

## Mode debugging Firefox

Pour comprendre un probleme, utilisez les outils de debug Firefox.

### Ouvrir le debug de l'extension

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
reponse vide
JSON invalide
endpoint inaccessible
cle invalide
```

### Recharger l'extension

Apres chaque modification de fichier :

1. retournez dans `about:debugging` ;
2. cliquez sur `Reload` ou `Recharger` ;
3. rechargez aussi la page video ;
4. relancez l'extension.

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

Declare les permissions Firefox et les domaines autorises.

```txt
service-worker.js
```

Gere Deepgram, le LLM, les claims, les verdicts et les erreurs.

```txt
overlay.js
```

Affiche l'interface sur la page video.

```txt
popup.js
```

Gere la popup, les cles API et le bouton de lancement.

---

## Confidentialite

Les cles API sont stockees localement dans Firefox.

L'audio est envoye a Deepgram pour transcription.

Le texte transcrit est envoye au fournisseur LLM configure par l'utilisateur.

Si la recherche web est activee, certaines affirmations peuvent etre envoyees a un moteur de recherche ou a une API de recherche.

Pour plus de details, consultez le fichier :

```txt
PRIVACY.md
```

---

## Limites

InTruth est un outil experimental.

Il peut :

- manquer des affirmations ;
- mal interpreter une phrase ;
- produire un verdict incomplet ;
- dependre fortement de la qualite de transcription ;
- echouer si le modele ne respecte pas le format JSON ;
- afficher `UNVERIFIABLE` quand le contexte manque.

L'extension aide a analyser un discours, mais ne remplace pas une verification humaine.

---

## Resume rapide

Pour que l'extension fonctionne :

```txt
1. Charger manifest.json dans Firefox via about:debugging
2. Ajouter les domaines cloud dans host_permissions
3. Entrer une cle Deepgram valide
4. Entrer une cle LLM valide
5. Utiliser un modele non-reasoning
6. Verifier que le modele ecrit dans message.content
7. Tester avec une phrase simple
8. Lancer le fact-checking
```

---

## Licence

MIT License.

