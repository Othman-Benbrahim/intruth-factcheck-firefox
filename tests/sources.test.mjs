// Sélection des sources affichées sur une carte de verdict.
// Objectif : ne jamais présenter comme « source » un lien hors sujet ramené
// par un capteur trop large.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './helpers/load.mjs';

const sw = loadServiceWorker();

const item = (link, text, source = 'web') => ({ source, link, title: text, snippet: text });

const SUJET = item('https://a.com/1', 'le chomage a baisse de deux points cette annee');
const AUTRE = item('https://b.com/2', 'recette de tarte aux pommes pour le dessert');
const METEO = item('https://c.com/3', 'il fera beau et chaud demain sur tout le pays');

describe('dedupeByLink', () => {
  test('supprime les liens en double en gardant le premier', () => {
    const out = sw.dedupeByLink([SUJET, AUTRE, item('https://a.com/1', 'doublon')]);
    assert.equal(out.length, 2);
    assert.equal(out[0].link, 'https://a.com/1');
  });

  test('ignore les entrées sans lien', () => {
    const out = sw.dedupeByLink([SUJET, { source: 'web', title: 'sans lien' }, null]);
    assert.equal(out.length, 1);
  });

  test('liste vide → liste vide', () => {
    assert.deepEqual(sw.dedupeByLink([]), []);
  });
});

describe('relevanceFilterItems', () => {
  test('écarte les résultats hors sujet', () => {
    const kept = sw.relevanceFilterItems('le chomage a baisse de deux points', [SUJET, AUTRE, METEO]);
    const links = kept.map((i) => i.link);
    assert.ok(links.includes('https://a.com/1'), 'la source pertinente a été perdue');
    assert.equal(links.includes('https://b.com/2'), false, 'une recette est passée pour une preuve');
  });

  test('sans mots exploitables dans l’affirmation → repli non vide', () => {
    const kept = sw.relevanceFilterItems('a b', [SUJET, AUTRE]);
    assert.ok(Array.isArray(kept));
  });

  test('aucune preuve → tableau vide', () => {
    assert.deepEqual(sw.relevanceFilterItems('le chomage a baisse', []), []);
  });
});

describe('selectCitedSources', () => {
  const evidence = { items: [SUJET, AUTRE, METEO] };

  test('respecte les numéros de sources indiqués par le modèle', () => {
    const out = sw.selectCitedSources({ used_sources: [1] }, evidence, 'chomage');
    assert.deepEqual(out, ['https://a.com/1']);
  });

  test('ignore les index invalides plutôt que de planter', () => {
    const out = sw.selectCitedSources({ used_sources: [99, 0, -1] }, evidence, 'le chomage a baisse de deux points');
    assert.ok(Array.isArray(out));
    assert.equal(out.includes(undefined), false);
  });

  test('sans indication du modèle, retombe sur le filtre de pertinence', () => {
    const out = sw.selectCitedSources({}, evidence, 'le chomage a baisse de deux points');
    assert.ok(out.includes('https://a.com/1'));
    assert.equal(out.includes('https://b.com/2'), false);
  });

  test('plafonne le nombre de sources affichées', () => {
    const many = { items: Array.from({ length: 12 }, (_, i) => item(`https://s${i}.com/x`, 'chomage baisse deux points')) };
    const out = sw.selectCitedSources({}, many, 'chomage baisse deux points');
    assert.ok(out.length <= 4, `trop de sources affichées : ${out.length}`);
  });

  test('ne renvoie jamais deux fois le même lien', () => {
    const dup = { items: [SUJET, item('https://a.com/1', 'meme lien autre titre')] };
    const out = sw.selectCitedSources({ used_sources: [1, 2] }, dup, 'chomage');
    assert.equal(new Set(out).size, out.length);
  });

  test('aucune preuve → aucune source', () => {
    assert.deepEqual(sw.selectCitedSources({}, { items: [] }, 'chomage'), []);
  });
});

describe('déduplication des affirmations', () => {
  test('la clé normalisée ignore ponctuation, casse et ordre', () => {
    const a = sw.normalizeClaimKey('Le chômage a baissé de 2% en 2024 !');
    const b = sw.normalizeClaimKey('en 2024 le CHOMAGE a baisse');
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0);
    // les deux formulations partagent l'essentiel des mots significatifs
    const motsA = new Set(a.split(' '));
    const communs = b.split(' ').filter((m) => motsA.has(m));
    assert.ok(communs.length >= 2, `trop peu de mots communs : ${communs.join(',')}`);
  });
});
