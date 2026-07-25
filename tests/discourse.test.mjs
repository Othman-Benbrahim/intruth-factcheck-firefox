// Analyse du discours côté service worker : résolution des tournures
// indirectes, conviction du locuteur, extraction lexicale.
//
// La résolution des pronoms est optionnelle et réécrit le transcript avant
// analyse : les garde-fous comptent autant que les cas positifs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './helpers/load.mjs';

const sw = loadServiceWorker();
const R = sw.resolveDismissivePronouns;
const OPP = 'Dupont';

describe('résolution des tournures indirectes — français', () => {
  test('« quelqu’un qui » avec apostrophe typographique', () => {
    assert.match(R('ça vient de quelqu’un qui a menti', null, OPP), /vient de Dupont qui/);
  });

  test('« quelqu\'un qui » avec apostrophe droite', () => {
    assert.match(R("venant de quelqu'un qui refuse", null, OPP), /venant de Dupont qui/);
  });

  test('« de la part de quelqu’un qui »', () => {
    assert.match(R("de la part de quelqu'un qui triche", null, OPP), /part de Dupont qui/);
  });

  test('« vous avez été condamné » → nom de l’adversaire', () => {
    assert.match(R('vous avez été condamné en 2023', null, OPP), /Dupont a été condamné/);
  });

  test('couvre le vocabulaire juridique élargi', () => {
    assert.match(R('vous avez été mise en examen', null, OPP), /Dupont a été mise en examen/);
    assert.match(R('il a été poursuivi pour fraude', null, OPP), /Dupont a été poursuivi/);
    assert.match(R('elle a été arrêtée hier', null, OPP), /Dupont a été arrêtée/);
  });
});

describe('résolution des tournures indirectes — anglais', () => {
  test('coming from someone who', () => {
    assert.match(R('coming from someone who lied', null, OPP), /coming from Dupont who/);
  });

  test('you were found liable', () => {
    assert.match(R('you were found liable last year', null, OPP), /Dupont was found liable/);
  });

  test('you have been convicted', () => {
    assert.match(R('you have been convicted', null, OPP), /Dupont has been convicted/);
  });

  test('he was indicted', () => {
    assert.match(R('he was indicted in June', null, OPP), /Dupont was indicted/);
  });
});

describe('garde-fous de la réécriture', () => {
  test('une phrase neutre n’est jamais modifiée', () => {
    const neutre = 'Le chômage a baissé de deux points en 2024.';
    assert.equal(R(neutre, null, OPP), neutre);
  });

  test('« vous avez été formidable » n’est pas juridique → intact', () => {
    assert.match(R('vous avez été formidable ce soir', null, OPP), /vous avez été formidable/);
  });

  test('sans adversaire identifié, le texte reste intact', () => {
    assert.equal(R('il a été condamné', null, null), 'il a été condamné');
    assert.equal(R('il a été condamné', null, undefined), 'il a été condamné');
  });

  test('entrée vide ou non textuelle → pas d’exception', () => {
    assert.equal(R('', null, OPP), '');
    assert.equal(R(null, null, OPP), null);
  });
});

describe('conviction du locuteur (déterministe)', () => {
  const lex = (rates) => ({ wordCount: 30, rates });

  test('marqueurs de certitude → HIGH', () => {
    assert.equal(
      sw.speakerConfidenceFromLexical(lex({ certainty: 10, hedging: 0, filler: 0, emotional: 0, exclusive: 0 })),
      'HIGH'
    );
  });

  test('hésitations et tics de langage → LOW', () => {
    assert.equal(
      sw.speakerConfidenceFromLexical(lex({ certainty: 0, hedging: 10, filler: 4, emotional: 0, exclusive: 2 })),
      'LOW'
    );
  });

  test('signaux équilibrés → MEDIUM', () => {
    assert.equal(
      sw.speakerConfidenceFromLexical(lex({ certainty: 3, hedging: 3, filler: 0, emotional: 0, exclusive: 0 })),
      'MEDIUM'
    );
  });

  test('échantillon trop court → pas de conclusion', () => {
    assert.equal(sw.speakerConfidenceFromLexical({ wordCount: 3, rates: { certainty: 10 } }), null);
  });

  test('sans données lexicales → null', () => {
    assert.equal(sw.speakerConfidenceFromLexical({}), null);
    assert.equal(sw.speakerConfidenceFromLexical(null), null);
  });
});

describe('extraction lexicale', () => {
  test('détecte les marqueurs d’hésitation en français', () => {
    const f = sw.extractLexical('je pense que peut-être le chômage a baissé');
    assert.ok(f.rates.hedging > 0, 'hedging non détecté');
    assert.ok(f.wordCount > 0);
  });

  test('un texte neutre ne déclenche aucun marqueur fort', () => {
    const f = sw.extractLexical('le taux a été publié ce matin');
    assert.equal(f.rates.certainty, 0);
  });
});

describe('identification des locuteurs depuis le titre', () => {
  test('extrait deux noms propres d’un intitulé de débat', () => {
    const names = sw.parseSpeakersFromTitle('Harris vs Trump Presidential Debate');
    assert.equal(names.length, 2);
  });

  test('un titre sans confrontation ne produit rien', () => {
    assert.deepEqual(sw.parseSpeakersFromTitle('Journal télévisé de 20h'), []);
    assert.deepEqual(sw.parseSpeakersFromTitle(''), []);
  });
});
