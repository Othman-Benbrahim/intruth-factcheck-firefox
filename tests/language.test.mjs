// Langue de sortie des verdicts.
// Rappel du principe : la transcription reste en auto-détection ; seule la
// SORTIE (affirmation + explication) est pilotée. Les libellés de verdict
// restent normalisés en anglais côté pipeline.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './helpers/load.mjs';

const sw = loadServiceWorker();

describe('table des langues', () => {
  test('les 16 langues annoncées sont présentes', () => {
    assert.equal(Object.keys(sw.LANGUAGE_NAMES).length, 16);
  });

  test('chaque langue a une localisation de recherche', () => {
    for (const code of Object.keys(sw.LANGUAGE_NAMES)) {
      const loc = sw.LANGUAGE_LOCALE[code];
      assert.ok(loc, `localisation manquante pour « ${code} »`);
      assert.ok(loc.gl && loc.hl, `gl/hl incomplet pour « ${code} »`);
    }
  });

  test('le français est correctement localisé', () => {
    assert.deepEqual(sw.LANGUAGE_LOCALE.fr, { gl: 'fr', hl: 'fr' });
    assert.equal(sw.LANGUAGE_NAMES.fr, 'French');
  });
});

describe('consigne de langue injectée au modèle', () => {
  const instruction = sw.languageInstruction();

  test('cible bien les champs de sortie', () => {
    assert.match(instruction, /claim/);
    assert.match(instruction, /explanation/);
  });

  test('la langue par défaut est le français', () => {
    assert.match(instruction, /French/);
  });

  test('les libellés de verdict restent normalisés', () => {
    assert.match(instruction, /TRUE/);
    assert.match(instruction, /UNVERIFIABLE/);
  });
});
