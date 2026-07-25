// Capteurs juridiques : EUR-Lex (UE) et Federal Register (US).
// Ces tests portent sur les parties déterministes — détection, construction de
// requête, liens. Aucun appel réseau n'est effectué.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './helpers/load.mjs';

const sw = loadServiceWorker();

describe('EU_MARKERS', () => {
  test('reconnaît « (UE) » entre parenthèses', () => {
    // piège historique : « \b » ne peut pas s'ancrer après une parenthèse
    assert.ok(sw.EU_MARKERS.test('Le règlement (UE) 2022/2065 impose des obligations'));
    assert.ok(sw.EU_MARKERS.test('le texte (eu) ici'));
  });

  test('« eu » participe passé n’est pas un marqueur européen', () => {
    assert.equal(sw.EU_MARKERS.test('il a eu un problème'), false);
    assert.equal(sw.EU_MARKERS.test('nous avons eu ce débat'), false);
  });

  test('reconnaît les institutions et sigles usuels', () => {
    assert.ok(sw.EU_MARKERS.test('la Commission européenne a proposé'));
    assert.ok(sw.EU_MARKERS.test('le RGPD protège les données'));
  });
});

describe('actes européens notoires', () => {
  test('le RGPD est résolu vers son identifiant CELEX', () => {
    const hits = sw.matchEuKnownActs('le RGPD protège les données personnelles');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].source, 'eurlex');
    assert.match(hits[0].link, /CELEX:32016R0679/);
    assert.match(hits[0].title, /2016\/679/);
  });

  test('pas de faux positif sur un mot isolé', () => {
    assert.equal(sw.matchEuKnownActs('le climat se réchauffe').length, 0);
  });

  test('« loi européenne sur le climat » est bien reconnue', () => {
    assert.equal(sw.matchEuKnownActs('la loi européenne sur le climat').length, 1);
  });

  test('la table est cohérente (regex + CELEX + titre pour chaque entrée)', () => {
    for (const act of sw.EU_KNOWN_ACTS) {
      assert.ok(act.re instanceof RegExp, 'regex manquante');
      assert.match(act.celex, /^3\d{4}[LR]\d{4}$/, `CELEX douteux : ${act.celex}`);
      assert.ok(act.title.length > 10, `titre trop court : ${act.title}`);
    }
  });

  test('lien EUR-Lex bien formé', () => {
    assert.equal(
      sw.eurLexLink('32016R0679'),
      'https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32016R0679'
    );
  });
});

describe('requête SPARQL EUR-Lex', () => {
  test('utilise l’index plein texte et borne les résultats', () => {
    const q = sw.buildEurLexSparql('la directive européenne sur les travailleurs détachés');
    assert.ok(q, 'requête non construite');
    assert.match(q, /bif:contains/);
    assert.match(q, /LIMIT 4/);
    assert.match(q, /lang:FRA/);
  });

  test('termes trop courts → aucune requête (pas d’appel inutile)', () => {
    assert.equal(sw.buildEurLexSparql('a b c'), null);
    assert.equal(sw.buildEurLexSparql(''), null);
  });

  test('les guillemets sont neutralisés', () => {
    const q = sw.buildEurLexSparql('travailleurs " OR \'1\'=\'1 detaches');
    if (q !== null) assert.equal(q.includes('"1"'), false);
  });
});

describe('Federal Register (US)', () => {
  test('reconnaît les marqueurs fédéraux américains', () => {
    assert.ok(sw.US_MARKERS.test('Congress passed the spending bill'));
    assert.ok(sw.US_MARKERS.test('Trump signed an executive order'));
    assert.ok(sw.US_MARKERS.test('The White House announced a policy'));
    assert.ok(sw.US_MARKERS.test('The FDA approved a new drug'));
    assert.ok(sw.US_MARKERS.test('Le Congrès américain a voté le budget'));
  });

  test('ne confond pas le Sénat français avec le Sénat américain', () => {
    assert.equal(sw.US_MARKERS.test('Le Sénat a voté la loi'), false);
    assert.equal(sw.US_MARKERS.test('Le président a signé un décret'), false);
  });

  test('extraction de termes : mots vides et génériques filtrés', () => {
    const terms = sw.usLegalTerms('The executive order on immigration enforcement rules');
    assert.ok(terms.length > 0);
    assert.equal(terms.includes('the'), false);
    assert.equal(terms.includes('rules'), false);
    assert.ok(terms.length <= 6, 'trop de termes envoyés à l’API');
  });

  test('rien d’exploitable → aucun terme (pas d’appel)', () => {
    assert.equal(sw.usLegalTerms('a to of in').length, 0);
  });

  test('les types de documents sont traduits pour l’affichage', () => {
    assert.equal(sw.FEDREG_TYPES.RULE, 'Règlement final');
    assert.equal(sw.FEDREG_TYPES.PRESDOCU, 'Document présidentiel');
  });
});
