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
