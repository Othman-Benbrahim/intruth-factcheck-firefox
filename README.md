# InTruth (Édition Firefox)

> **Note :** Ceci est un fork adapté pour **Mozilla Firefox** du projet original [InTruth](https://github.com/rpanigrahi222/intruth-factcheck) créé par Risha Panigrahi.

Bonjour à tous !

Voici **InTruth**, un vérificateur de faits (*fact-checker*) en temps réel conçu pour les débats diffusés en direct, les discours, les interviews, les conférences de presse et les événements politiques !

<img width="400" height="225" alt="Aperçu d'InTruth" src="https://github.com/user-attachments/assets/a0a8fba9-c28f-473c-866d-84951a9b548e" />

L'extension écoute l'audio de l'onglet actif, identifie les affirmations factuelles au moment précis où elles sont prononcées, et fournit instantanément un verdict basé sur des preuves grâce à une analyse IA et des recherches sur le Web. La plupart des articles de fact-checking sortent des jours après les débats ; désormais, vous pouvez évaluer la véracité des propos en direct.

Ceci fait partie d'un projet de recherche plus global, la suite arrive bientôt !

## ⚡ Fonctionnalités

- **Détection d'affirmations en direct :** Surveille en continu la parole sur l'onglet actif et repère les affirmations factuelles nécessitant une vérification en temps réel.
- **Évaluation de la véracité en direct :** Analyse les propos via des LLM (grands modèles de langage) et des sources externes pour classer la déclaration en :
  * `VRAI` (*True*)
  * `SUBSTANTIELLEMENT VRAI` (*Substantially True*)
  * `FAUX` (*False*)
  * `TROMPEUR / HORS CONTEXTE` (*Misleading*)
  * `INVÉRIFIABLE` (*Unverifiable*)
- **Attribution aux locuteurs :** Suit les différents interlocuteurs tout au long de la discussion et attribue, dans la mesure du possible, chaque affirmation au bon participant.
- **Analyse du contexte :** Utilise l'historique de la conversation et le contexte de l'événement pour affiner la détection et réduire les faux positifs.
- **Verdicts en temps réel :** Les vérifications et les sources cliquables s'affichent pendant que l'interview ou le débat est encore en cours.
- **Bring-Your-Own-Key (BYOK) :** L'utilisateur renseigne sa propre clé d'API Anthropic (aucun frais centralisé).

## 🚀 Comment utiliser InTruth

1. Ouvrez une vidéo, un live, un débat, une interview ou un discours (ex: YouTube).
2. Lancez l'extension et assignez les noms des débatteurs en un clic.
3. L'audio de l'onglet actif est capturé en arrière-plan.
4. La parole est transcrite instantanément.
5. Les affirmations factuelles pertinentes sont extraites.
6. Les déclarations sont confrontées à des sources d'autorité sur le Web.
7. Les verdicts et leurs explications s'affichent à l'écran !

## 🎯 Qu'est-ce qu'une affirmation "vérifiable" ?

Dans ce contexte, nous vérifions :
* Les déclarations factuelles précises
* Les statistiques et données numériques
* Les événements historiques
* Les actions et bilans gouvernementaux
* Les affirmations scientifiques et médicales
* Les registres publics et faits documentés

*Exemples :*
* « L'inflation a culminé à 9,1 % en 2022. »
* « Ce projet de loi a été voté au Sénat en 2021. »
* « Le taux de chômage est actuellement inférieur à 5 %. »

**CE QUE NOUS NE VÉRIFIONS PAS :**
* Les opinions personnelles
* Les prédictions ou promesses futures
* Les questions rhétoriques
* Les jugements de valeur
* Les descriptions subjectives

*Exemples :*
* « Cette politique va détruire notre économie. »
* « J'ai le meilleur programme pour le pays. »
* « Si mon adversaire gagne, ce sera un désastre. »

## 🔒 Confidentialité

* Les utilisateurs fournissent leurs propres identifiants d'API, l'auteur de l'extension n'y a absolument aucun accès.
* Les fragments de transcription sont envoyés directement au service d'IA configuré par l'utilisateur afin de générer les vérifications.
* Les clés et les préférences sont stockées **strictement en local** dans votre navigateur.

## 🔑 Permissions Firefox

* `tabCapture` : Capture le flux audio de l'onglet actif (uniquement après que l'utilisateur a explicitement démarré une session).
* `activeTab` : Permet à l'extension d'interagir avec l'onglet actuellement sélectionné.
* `scripting` : Permet d'injecter l'interface d'affichage des verdicts (panneau superposé) dans la page Web.
* `storage` : Sauvegarde vos clés d'API et vos paramètres localement.

*(Note d'architecture : Contrairement à Chrome, Firefox n'a pas besoin de la permission `offscreen` pour faire tourner l'audio et les WebSockets en tâche de fond).*

## ⚠️ Limites et avertissements

Le fact-checking est par nature imparfait ! Les verdicts générés peuvent occasionnellement être erronés, incomplets ou basés sur des informations obsolètes. Si vous avez un doute sur un sujet, faites vos propres recherches et consultez les sources primaires. 

**Cette extension est un outil d'assistance et d'information, pas une autorité absolue.**

---

### 💻 Prérequis

* Mozilla Firefox (version récente compatible Manifest V3 / Gecko)
* Une clé d'API Anthropic (Claude) valide

### 🛠️ Installation manuelle (Mode Développeur)

1. Clonez ce dépôt : `git clone https://github.com/.../intruth-firefox.git`
2. Ouvrez Firefox et tapez `about:debugging#/runtime/this-firefox` dans la barre d'adresse.
3. Cliquez sur le bouton **Charger un module temporaire...** (*Load Temporary Add-on*).
4. Sélectionnez le fichier `manifest.json` situé dans le dossier du projet.
5. Cliquez sur l'icône de l'extension dans la barre d'outils Firefox et collez votre clé d'API.
6. Lancez une vidéo et appuyez sur **Start** !

## 🤝 Contribution

Toutes les remarques, idées de fonctionnalités ou retours sur des cas particuliers sont les bienvenus ! Les LLM pouvant parfois se montrer d'une pédanterie excessive, attendez-vous à quelques débats avec l'IA... Ouvrez une *Issue* ou proposez une *Pull Request* !

## 📄 Licence

Licence MIT (voir le fichier `LICENSE`).
