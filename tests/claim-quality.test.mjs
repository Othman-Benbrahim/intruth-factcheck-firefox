// Qualité des affirmations retenues et attribution des locuteurs.
//
// Deux problèmes observés sur des rapports réels :
//   - des segments mal transcrits partaient en vérification, consommaient un
//     appel LLM et une requête de recherche, et ressortaient en INVÉRIFIABLE ;
//   - la quasi-totalité des affirmations était attribuée à « Unknown », avec en
//     prime un doublon « Unknown » / « Inconnu » dans le rapport.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadServiceWorker, REPO_ROOT } from './helpers/load.mjs';

const sw = loadServiceWorker();
const serviceWorkerSrc = readFileSync(
  join(REPO_ROOT, 'realtime-factcheck', 'src', 'background', 'service-worker.js'), 'utf8');

describe('rejet du bruit de transcription', () => {
  // Cas relevés tels quels dans un rapport de session.
  const BRUIT = [
    ["Orban vient de les inviter pour contourner l'entente de nos.", 'segment coupé net'],
    ['Sur 430000 immigrés légaux, combien viennent pour travailler?', 'question, pas affirmation'],
    ['euh', 'trop court'],
    ['', 'vide'],
    ['9,1 % 2022', 'chiffres sans énoncé'],
    ['Et donc les', 'segment coupé'],
  ];

  for (const [text, raison] of BRUIT) {
    test(`écarté — ${raison}`, () => {
      assert.equal(sw.looksLikeTranscriptionNoise(text), true, `« ${text} » aurait dû être écarté`);
    });
  }

  // Ce sont exactement les affirmations que l'extension existe pour vérifier :
  // les écarter serait bien pire que de laisser passer du bruit.
  const A_CONSERVER = [
    "L'inflation a culminé à 9,1 % en 2022.",
    'Ce projet de loi a été voté au Sénat en 2021.',
    'Le taux de chômage est actuellement inférieur à 5 %.',
    "Les Chinois avaient de l'avance dans l'industrie de la voiture électrique.",
    "Il n'y a plus beaucoup d'usines en France",
    "Le Paraguay a éliminé l'Allemagne aux tirs au but.",
  ];

  for (const text of A_CONSERVER) {
    test(`conservé — « ${text.slice(0, 40)}… »`, () => {
      assert.equal(sw.looksLikeTranscriptionNoise(text), false);
    });
  }

  test('une affirmation chiffrée courte n’est jamais prise pour du bruit', () => {
    // Régression constatée : un seuil trop strict sur les mots « lettrés »
    // rejetait les faits chiffrés, précisément les plus vérifiables.
    assert.equal(sw.looksLikeTranscriptionNoise('Le PIB a reculé de 0,3 % en 2024.'), false);
  });

  test('le filtre agit avant la vérification sourcée', () => {
    // On vise le filtre lui-même : une simple mention ailleurs (journalisation)
    // ne prouve pas que le bruit est réellement écarté du pipeline.
    const filtre = serviceWorkerSrc.match(/const valid = results\.filter\([\s\S]{0,300}?\);/);
    assert.ok(filtre, 'filtre des résultats valides introuvable');
    assert.match(filtre[0], /looksLikeTranscriptionNoise\(r\.claim\)/,
      'le bruit doit être écarté avant de dépenser un appel de vérification');
    assert.match(filtre[0], /isDuplicate\(r\.claim\)/,
      'la déduplication doit rester en place');
  });
});

describe('normalisation des libellés de locuteur', () => {
  test('toutes les variantes d’« inconnu » deviennent nulles', () => {
    for (const v of ['Unknown', 'unknown', 'Inconnu', 'Other', 'autre', 'N/A', 'none', '?', '   ']) {
      assert.equal(sw.normalizeSpeakerLabel(v), null, `« ${v} » aurait dû être neutralisé`);
    }
  });

  test('les identifiants de diarisation ne sont pas des noms', () => {
    assert.equal(sw.normalizeSpeakerLabel('Speaker 0'), null);
    assert.equal(sw.normalizeSpeakerLabel('Locuteur 12'), null);
  });

  test('un vrai nom est conservé tel quel', () => {
    assert.equal(sw.normalizeSpeakerLabel('Zemmour'), 'Zemmour');
    assert.equal(sw.normalizeSpeakerLabel('  Glucksmann  '), 'Glucksmann');
  });

  test('les entrées absentes ne provoquent pas d’erreur', () => {
    assert.equal(sw.normalizeSpeakerLabel(null), null);
    assert.equal(sw.normalizeSpeakerLabel(undefined), null);
  });

  test('le rapport ne peut plus créer deux groupes pour un même inconnu', () => {
    const exportSrc = readFileSync(
      join(REPO_ROOT, 'realtime-factcheck', 'src', 'content', 'session-export.js'), 'utf8');
    const grouping = exportSrc.match(/const spk = [\s\S]{0,200}?;/);
    assert.ok(grouping, 'regroupement par locuteur introuvable');
    assert.match(grouping[0], /unknownish/,
      '« Unknown » et « Inconnu » doivent tomber dans le même groupe');
  });
});

describe('identification des participants depuis le titre', () => {
  // Sans participants reconnus, l'apprentissage de la correspondance ne peut
  // jamais démarrer : toutes les affirmations restent « Inconnu ».
  const CAS = [
    ["Eric Zemmour : Mon débat face à Raphaël Glucksmann, l'idiot utile - YouTube", ['Zemmour', 'Glucksmann']],
    ['Harris vs Trump Presidential Debate', ['Harris', 'Trump']],
    ['Débat : Jean-Luc Mélenchon contre Éric Zemmour', ['Mélenchon', 'Zemmour']],
    ['Emmanuel Macron répond à Marine Le Pen', ['Macron', 'Pen']],
  ];

  for (const [titre, attendu] of CAS) {
    test(`« ${titre.slice(0, 42)}… » → ${attendu.join(' / ')}`, () => {
      assert.deepEqual(sw.parseSpeakersFromTitle(titre), attendu);
    });
  }

  test('un titre sans confrontation ne produit aucun participant', () => {
    assert.deepEqual(sw.parseSpeakersFromTitle('Journal télévisé de 20h'), []);
    assert.deepEqual(sw.parseSpeakersFromTitle('LIVE - Conférence de presse du Premier ministre'), []);
    assert.deepEqual(sw.parseSpeakersFromTitle('Les Chinois et la voiture électrique en France'), []);
    assert.deepEqual(sw.parseSpeakersFromTitle(''), []);
  });

  test('les mots génériques ne sont jamais pris pour des noms', () => {
    assert.equal(sw.cleanPersonName('Trump Presidential Debate'), 'Trump');
    assert.equal(sw.cleanPersonName('La France'), null);
    assert.equal(sw.cleanPersonName('Marine Le Pen'), 'Pen');
  });

  test('la chaîne complète mène à une attribution', () => {
    const titre = "Eric Zemmour : Mon débat face à Raphaël Glucksmann - YouTube";
    const participants = sw.parseSpeakersFromTitle(titre);
    const premier = sw.learnSpeakerMapping(0, 'Zemmour', participants, {});
    assert.deepEqual(premier, { id: '0', name: 'Zemmour' });
    assert.deepEqual(
      sw.learnSpeakerMapping(1, 'Glucksmann', participants, { '0': 'Zemmour' }),
      { id: '1', name: 'Glucksmann' });
  });
});

describe('étiquette de diarisation dans le texte', () => {
  // Le transcript envoyé au modèle est préfixé « [Speaker 0] … » ; le modèle
  // recopiait parfois l'étiquette dans l'affirmation, qui s'affichait telle
  // quelle dans le rapport.
  test('le préfixe est retiré de l’affirmation', () => {
    assert.equal(
      sw.normalizeVerdictItem({ claim: '[Speaker 0] on emprisonnerait les curés.', verdict: 'TRUE' }).claim,
      'on emprisonnerait les curés.');
    assert.equal(
      sw.normalizeVerdictItem({ claim: '[Zemmour] La laïcité découle des guerres de religion.', verdict: 'TRUE' }).claim,
      'La laïcité découle des guerres de religion.');
  });

  test('une affirmation sans préfixe n’est pas altérée', () => {
    const texte = 'Le taux de chômage est inférieur à 5 %.';
    assert.equal(sw.normalizeVerdictItem({ claim: texte, verdict: 'TRUE' }).claim, texte);
  });

  test('un crochet en milieu de phrase est préservé', () => {
    const texte = 'Le taux [sic] a baissé de 2 %.';
    assert.equal(sw.normalizeVerdictItem({ claim: texte, verdict: 'TRUE' }).claim, texte);
  });

  test('les énoncés de discours sont nettoyés de la même façon', () => {
    const src = serviceWorkerSrc.match(/const enriched = usable\.map[\s\S]{0,400}?\}\)\);/);
    assert.ok(src, 'enrichissement des énoncés de discours introuvable');
    assert.match(src[0], /statement:[\s\S]{0,120}replace\(/,
      'le préfixe doit être retiré de l’énoncé');
    assert.match(src[0], /canonicalSpeakerName\(it\.speaker/,
      '« Speaker 1 » ne doit pas s’afficher, et « Jean-Luc Mélenchon » doit se réduire à « Mélenchon »');
  });
});

describe('références de sources dans le texte affiché', () => {
  // Le modèle écrivait « selon [1] » : ces numéros n'existent pas pour le
  // lecteur, qui ne voit que des liens nommés.
  test('une référence entre crochets est retirée avec son connecteur', () => {
    assert.equal(
      sw.stripSourceReferences("L'islam inclut des principes sociaux, mais n'est pas politique selon [1]."),
      "L'islam inclut des principes sociaux, mais n'est pas politique.");
  });

  test('une mention parenthésée est retirée', () => {
    assert.equal(sw.stripSourceReferences('Le chiffre est confirmé (source 2).'), 'Le chiffre est confirmé.');
  });

  test('un texte sans référence n’est pas altéré', () => {
    const texte = 'Le taux de chômage est passé sous les 5 % en 2024.';
    assert.equal(sw.stripSourceReferences(texte), texte);
  });

  test('le nettoyage est appliqué à la normalisation', () => {
    assert.equal(
      sw.normalizeVerdictItem({ claim: 'Une affirmation quelconque ici.', verdict: 'TRUE', explanation: 'Confirmé [1].' }).explanation,
      'Confirmé.');
  });
});

describe('variantes du nom d’un même locuteur', () => {
  // Le modèle alterne « Mélenchon » et « Jean-Luc Mélenchon » : sans réduction,
  // le rapport affichait deux libellés pour la même personne.
  test('une forme longue se réduit au nom déjà retenu', () => {
    assert.equal(sw.canonicalSpeakerName('Jean-Luc Mélenchon', { '0': 'Mélenchon' }), 'Mélenchon');
    assert.equal(sw.canonicalSpeakerName('M. Zemmour', { '1': 'Zemmour' }), 'Zemmour');
  });

  test('un nom déjà canonique est inchangé', () => {
    assert.equal(sw.canonicalSpeakerName('Mélenchon', { '0': 'Mélenchon' }), 'Mélenchon');
  });

  test('un locuteur inconnu du groupe garde son nom', () => {
    assert.equal(sw.canonicalSpeakerName('Macron', { '0': 'Mélenchon' }), 'Macron');
  });

  test('les libellés vides restent neutralisés', () => {
    assert.equal(sw.canonicalSpeakerName('Unknown', { '0': 'Mélenchon' }), null);
    assert.equal(sw.canonicalSpeakerName('Speaker 1', {}), null);
  });
});

describe('apprentissage de la correspondance locuteur', () => {
  const PARTICIPANTS = ['Zemmour', 'Glucksmann'];

  test('un nom reconnu est associé à l’identifiant de diarisation', () => {
    assert.deepEqual(
      sw.learnSpeakerMapping(0, 'Zemmour', PARTICIPANTS, {}),
      { id: '0', name: 'Zemmour' });
  });

  test('une civilité ou un prénom n’empêche pas la reconnaissance', () => {
    assert.deepEqual(
      sw.learnSpeakerMapping(1, 'M. Glucksmann', PARTICIPANTS, {}),
      { id: '1', name: 'Glucksmann' });
  });

  test('un locuteur non identifié n’apprend rien', () => {
    assert.equal(sw.learnSpeakerMapping(1, 'Unknown', PARTICIPANTS, {}), null);
    assert.equal(sw.learnSpeakerMapping(1, 'Speaker 1', PARTICIPANTS, {}), null);
    assert.equal(sw.learnSpeakerMapping(1, '', PARTICIPANTS, {}), null);
  });

  test('un nom absent de la liste des participants est refusé', () => {
    assert.equal(sw.learnSpeakerMapping(0, 'Macron', PARTICIPANTS, {}), null);
  });

  test('sans identifiant de diarisation, rien à apprendre', () => {
    assert.equal(sw.learnSpeakerMapping(null, 'Zemmour', PARTICIPANTS, {}), null);
    assert.equal(sw.learnSpeakerMapping(undefined, 'Zemmour', PARTICIPANTS, {}), null);
  });

  test('une correspondance déjà établie n’est jamais écrasée', () => {
    assert.equal(sw.learnSpeakerMapping(0, 'Glucksmann', PARTICIPANTS, { '0': 'Zemmour' }), null);
  });

  test('un même nom ne peut pas désigner deux identifiants', () => {
    assert.equal(sw.learnSpeakerMapping(1, 'Zemmour', PARTICIPANTS, { '0': 'Zemmour' }), null);
  });

  test('sans participants connus, aucune inférence', () => {
    assert.equal(sw.learnSpeakerMapping(0, 'Zemmour', [], {}), null);
  });

  test('l’apprentissage est branché sur la vérification sourcée', () => {
    const fn = serviceWorkerSrc.match(/async function groundAndUpdate[\s\S]*?\n}\n/);
    assert.ok(fn, 'groundAndUpdate introuvable');
    assert.match(fn[0], /learnSpeakerMapping\(/,
      'la correspondance déduite doit être retenue pour la suite de la session');
    assert.match(fn[0], /SPEAKER_LEARNED/,
      'le panneau doit être informé pour ré-étiqueter les cartes déjà posées');
  });

  test('le panneau applique la correspondance apprise', () => {
    const overlaySrc = readFileSync(
      join(REPO_ROOT, 'realtime-factcheck', 'src', 'content', 'overlay.js'), 'utf8');
    assert.match(overlaySrc, /case 'SPEAKER_LEARNED'/);
    assert.match(overlaySrc, /SPEAKER_LEARNED'[\s\S]{0,400}retryTagAllCards\(\)/,
      'les cartes antérieures doivent être ré-étiquetées');
  });
});
