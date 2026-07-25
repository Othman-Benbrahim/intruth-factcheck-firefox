// Fonctions pures de l'overlay : horodatage cliquable, filtre d'affichage,
// couleurs de verdict, dissonance cognitive.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOverlay } from './helpers/load.mjs';

const ov = loadOverlay();

describe('horodatage → secondes (saut vidéo)', () => {
  test('format mm:ss', () => {
    assert.equal(ov.timestampToSeconds('01:35'), 95);
    assert.equal(ov.timestampToSeconds('00:00'), 0);
  });

  test('format h:mm:ss', () => {
    assert.equal(ov.timestampToSeconds('1:02:03'), 3723);
  });

  test('entrée invalide → null (l’horodatage reste inerte)', () => {
    assert.equal(ov.timestampToSeconds(''), null);
    assert.equal(ov.timestampToSeconds(null), null);
    assert.equal(ov.timestampToSeconds('abc'), null);
    assert.equal(ov.timestampToSeconds('12'), null);
  });
});

describe('filtre d’affichage des verdicts', () => {
  test('« Tout » n’en masque aucun', () => {
    ov.setSettings({ verdictFilter: 'all' });
    for (const v of ['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE', 'SUBSTANTIALLY TRUE']) {
      assert.equal(ov.shouldShowVerdict(v), true, v);
    }
  });

  test('« Problèmes » ne garde que FAUX et TROMPEUR', () => {
    ov.setSettings({ verdictFilter: 'flagged' });
    assert.equal(ov.shouldShowVerdict('FALSE'), true);
    assert.equal(ov.shouldShowVerdict('MISLEADING'), true);
    assert.equal(ov.shouldShowVerdict('TRUE'), false);
    assert.equal(ov.shouldShowVerdict('UNVERIFIABLE'), false);
  });

  test('« Confirmés » ne garde que VRAI et SUBSTANTIELLEMENT VRAI', () => {
    ov.setSettings({ verdictFilter: 'accurate' });
    assert.equal(ov.shouldShowVerdict('TRUE'), true);
    assert.equal(ov.shouldShowVerdict('SUBSTANTIALLY TRUE'), true);
    assert.equal(ov.shouldShowVerdict('FALSE'), false);
  });

  test('réglages par défaut : tout est affiché', () => {
    ov.setSettings({});
    assert.equal(ov.DEFAULT_SETTINGS.verdictFilter, 'all');
    assert.equal(ov.shouldShowVerdict('UNVERIFIABLE'), true);
  });
});

describe('couleurs de verdict', () => {
  test('chaque verdict a sa couleur', () => {
    assert.equal(ov.colorForVerdict('TRUE', 0.9), 'green');
    assert.equal(ov.colorForVerdict('SUBSTANTIALLY TRUE', 0.9), 'teal');
    assert.equal(ov.colorForVerdict('FALSE', 0.9), 'red');
    assert.equal(ov.colorForVerdict('MISLEADING', 0.9), 'yellow');
    assert.equal(ov.colorForVerdict('UNVERIFIABLE', 0.9), 'grey');
  });

  test('verdict inconnu → neutre plutôt qu’une couleur trompeuse', () => {
    assert.equal(ov.colorForVerdict('N’IMPORTE QUOI', 0.9), 'grey');
  });
});

describe('engagement du locuteur (overlay)', () => {
  const lex = (rates) => ({ wordCount: 30, rates });

  test('assertif / prudent / neutre', () => {
    assert.equal(ov.commitmentFromLexical(lex({ certainty: 10, hedging: 0, filler: 0, emotional: 0, exclusive: 0 })), 'ASSERTIF');
    assert.equal(ov.commitmentFromLexical(lex({ certainty: 0, hedging: 10, filler: 4, emotional: 0, exclusive: 2 })), 'PRUDENT');
    assert.equal(ov.commitmentFromLexical(lex({ certainty: 3, hedging: 3, filler: 0, emotional: 0, exclusive: 0 })), 'NEUTRE');
  });

  test('sans données lexicales → null', () => {
    assert.equal(ov.commitmentFromLexical({}), null);
  });
});

describe('dissonance cognitive', () => {
  const assertif = { wordCount: 30, rates: { certainty: 10, hedging: 0, filler: 0, emotional: 0, exclusive: 0 } };
  const prudent  = { wordCount: 30, rates: { certainty: 0, hedging: 10, filler: 4, emotional: 0, exclusive: 2 } };
  const neutre   = { wordCount: 30, rates: { certainty: 3, hedging: 3, filler: 0, emotional: 0, exclusive: 0 } };

  test('péremptoire mais réfuté → alerte', () => {
    const d = ov.computeDissonance({ lexical: assertif, verdict: 'FALSE' });
    assert.equal(d?.level, 'alert');
  });

  test('prudent et réfuté → information', () => {
    const d = ov.computeDissonance({ lexical: prudent, verdict: 'MISLEADING' });
    assert.equal(d?.level, 'info');
  });

  test('affirmé et confirmé → validation', () => {
    const d = ov.computeDissonance({ lexical: assertif, verdict: 'TRUE' });
    assert.equal(d?.level, 'ok');
  });

  test('les croisements non significatifs ne sont pas signalés', () => {
    assert.equal(ov.computeDissonance({ lexical: neutre, verdict: 'FALSE' }), null);
    assert.equal(ov.computeDissonance({ lexical: assertif, verdict: 'UNVERIFIABLE' }), null);
    assert.equal(ov.computeDissonance({ verdict: 'FALSE' }), null);
  });
});

describe('échappement HTML', () => {
  test('neutralise les caractères dangereux', () => {
    const out = ov.escapeHtml('<script>alert("x")</script>');
    assert.equal(out.includes('<script>'), false);
    assert.match(out, /&lt;/);
  });

  test('accepte une entrée non textuelle sans planter', () => {
    assert.equal(typeof ov.escapeHtml(null), 'string');
    assert.equal(typeof ov.escapeHtml(42), 'string');
  });
});
