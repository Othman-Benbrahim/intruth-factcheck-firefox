// Indépendance des sources et corroboration déterministe.
// Règle centrale : la corroboration ne gonfle JAMAIS un verdict, elle ne fait
// que plafonner ou rétrograder sur preuve mince.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './helpers/load.mjs';

const sw = loadServiceWorker();

const web = (domain, text) => ({
  source: 'web', link: `https://${domain}/x`, title: text, snippet: text,
});
const primary = (source, text) => ({
  source, link: `https://${source}.example.org/y`, title: text, snippet: text,
});

describe('registrableDomain (eTLD+1)', () => {
  test('gère les TLD à deux niveaux', () => {
    assert.equal(sw.registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
    assert.equal(sw.registrableDomain('news.gov.uk'), 'news.gov.uk');
  });

  test('réduit un sous-domaine au domaine enregistrable', () => {
    assert.equal(sw.registrableDomain('news.example.com'), 'example.com');
    assert.equal(sw.registrableDomain('example.com'), 'example.com');
  });

  test('domainOfLink tolère une URL invalide', () => {
    assert.equal(sw.domainOfLink('https://www.lemonde.fr/article'), 'lemonde.fr');
    assert.equal(sw.domainOfLink('pas-une-url'), 'pas-une-url');
  });
});

describe('similarité lexicale', () => {
  test('textes identiques → 1', () => {
    const a = sw.wordShingles('le taux de chomage a baisse');
    const b = sw.wordShingles('le taux de chomage a baisse');
    assert.equal(sw.jaccardSim(a, b), 1);
  });

  test('textes disjoints → 0', () => {
    const a = sw.wordShingles('alpha beta gamma delta');
    const b = sw.wordShingles('rien a voir ici vraiment');
    assert.equal(sw.jaccardSim(a, b), 0);
  });

  test('ensemble vide → 0', () => {
    assert.equal(sw.jaccardSim(new Set(), sw.wordShingles('quelque chose ici')), 0);
  });
});

describe('clusterEvidence — compter des voix, pas des liens', () => {
  test('deux quasi-doublons sur des domaines différents = une seule voix', () => {
    const a = web('a.com', 'le taux de chomage a baisse de deux points cette annee');
    const b = web('b.com', 'le taux de chomage a baisse de deux points cette annee');
    const c = web('c.com', 'il fera beau et chaud sur tout le pays demain matin');
    assert.equal(sw.clusterEvidence([a, b, c]).length, 2);
  });

  test('même domaine = une seule voix', () => {
    const items = [web('x.com', 'aaa un'), web('x.com', 'bbb deux'), web('x.com', 'ccc trois')];
    assert.equal(sw.clusterEvidence(items).length, 1);
  });

  test('liste vide → aucun cluster', () => {
    assert.deepEqual(sw.clusterEvidence([]), []);
  });
});

describe('computeCorroboration — bandes de robustesse', () => {
  test('aucune source → INSUFFISANTE', () => {
    assert.equal(sw.computeCorroboration([]).band, 'INSUFFISANTE');
  });

  test('une seule voix générique → FAIBLE', () => {
    assert.equal(sw.computeCorroboration([web('a.com', 'chomage baisse')]).band, 'FAIBLE');
  });

  test('une source primaire seule → MODÉRÉE (jamais pénalisée)', () => {
    const wb = primary('worldbank', 'gdp growth three percent');
    assert.equal(sw.computeCorroboration([wb]).band, 'MODÉRÉE');
  });

  test('deux voix indépendantes → MODÉRÉE', () => {
    const items = [web('a.com', 'sujet un ici'), web('c.com', 'autre sujet different')];
    assert.equal(sw.computeCorroboration(items).band, 'MODÉRÉE');
  });

  test('primaire + deux voix → SOLIDE', () => {
    const items = [
      primary('worldbank', 'gdp growth'),
      web('a.com', 'sujet un ici'),
      web('c.com', 'autre sujet different'),
    ];
    assert.equal(sw.computeCorroboration(items).band, 'SOLIDE');
  });

  test('reprises multiples d’une même voix → reporting circulaire', () => {
    const items = [web('x.com', 'aaa un'), web('x.com', 'bbb deux'), web('x.com', 'ccc trois')];
    const c = sw.computeCorroboration(items);
    assert.equal(c.voices, 1);
    assert.equal(c.circular, true);
  });

  test('les capteurs légaux comptent comme sources primaires', () => {
    assert.ok(sw.CORRO_PRIMARY.has('eurlex'));
    assert.ok(sw.CORRO_PRIMARY.has('fedreg'));
    assert.ok(sw.CORRO_PRIMARY.has('worldbank'));
  });
});

describe('crédibilité par type de capteur', () => {
  test('données officielles au sommet, web générique en bas', () => {
    assert.equal(sw.SOURCE_CREDIBILITY.worldbank, 1.0);
    assert.equal(sw.SOURCE_CREDIBILITY.eurlex, 1.0);
    assert.equal(sw.SOURCE_CREDIBILITY.fedreg, 1.0);
    assert.ok(sw.SOURCE_CREDIBILITY.web < sw.SOURCE_CREDIBILITY.wikipedia);
  });

  test('capteur inconnu → valeur neutre', () => {
    assert.equal(sw.sourceCredibility('capteur-inexistant'), 0.5);
  });
});

describe('applyCorroborationGuard — ne jamais gonfler', () => {
  test('INSUFFISANTE force UNVERIFIABLE et abaisse la confiance', () => {
    assert.deepEqual(
      sw.applyCorroborationGuard('TRUE', 0.9, { band: 'INSUFFISANTE' }),
      { verdict: 'UNVERIFIABLE', confidence: 0.3 }
    );
  });

  test('FAIBLE plafonne la confiance sans toucher au verdict', () => {
    assert.deepEqual(
      sw.applyCorroborationGuard('TRUE', 0.9, { band: 'FAIBLE' }),
      { verdict: 'TRUE', confidence: 0.4 }
    );
  });

  test('FAIBLE ne remonte jamais une confiance déjà basse', () => {
    assert.deepEqual(
      sw.applyCorroborationGuard('TRUE', 0.2, { band: 'FAIBLE' }),
      { verdict: 'TRUE', confidence: 0.2 }
    );
  });

  test('MODÉRÉE et SOLIDE laissent le verdict intact', () => {
    assert.deepEqual(
      sw.applyCorroborationGuard('FALSE', 0.95, { band: 'SOLIDE' }),
      { verdict: 'FALSE', confidence: 0.95 }
    );
    assert.deepEqual(
      sw.applyCorroborationGuard('TRUE', 0.9, { band: 'MODÉRÉE' }),
      { verdict: 'TRUE', confidence: 0.9 }
    );
  });

  test('sans corroboration calculée → aucun effet', () => {
    assert.deepEqual(
      sw.applyCorroborationGuard('TRUE', 0.8, null),
      { verdict: 'TRUE', confidence: 0.8 }
    );
  });
});

describe('buildCorroborationContext', () => {
  test('mentionne la bande et instruit la prudence quand la preuve est mince', () => {
    const txt = sw.buildCorroborationContext({ voices: 0, primaries: 0, circular: false, band: 'INSUFFISANTE' });
    assert.match(txt, /INSUFFISANTE/);
    assert.match(txt, /UNVERIFIABLE/);
  });

  test('signale le reporting circulaire', () => {
    const txt = sw.buildCorroborationContext({ voices: 1, primaries: 0, circular: true, band: 'FAIBLE' });
    assert.match(txt, /circulaire/i);
  });

  test('sans corroboration → chaîne vide', () => {
    assert.equal(sw.buildCorroborationContext(null), '');
  });
});
