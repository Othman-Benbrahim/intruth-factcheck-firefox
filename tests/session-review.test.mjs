// Revue de session : condensé transmis au modèle et filtrage de ses constats.
//
// Le point sensible n'est pas la revue elle-même, c'est ce qu'on accepte d'en
// retenir. Un modèle à qui l'on demande de repérer des procédés rhétoriques en
// invente volontiers. La règle appliquée ici est mécanique : sans citation
// réellement prononcée ET sans critère structurel nommé, le constat est écarté.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadSessionStore } from './helpers/load.mjs';

const claim = (text, verdict = 'TRUE', pending = false) => ({
  claim: text, verdict, confidence: 0.8, explanation: '', pending, sources: [],
});

/**
 * Affirmations sans aucun vocabulaire commun : ces tests portent sur le
 * comptage et la troncature, pas sur la déduplication (couverte ailleurs).
 * Des énoncés trop proches seraient fusionnés — à juste titre — et fausseraient
 * la mesure.
 */
function distinctClaim(i) {
  return `sujet${i}alpha porte${i}bravo dossier${i}charlie`;
}

function sessionWith(n) {
  const st = loadSessionStore();
  const s = st.createSession({ title: 'Débat télévisé' });
  for (let i = 0; i < n; i++) st.upsertClaimEvent(s, claim(distinctClaim(i)));
  return { st, s };
}

describe('conditions de déclenchement', () => {
  test('une session trop courte ne justifie pas de revue', () => {
    const { st, s } = sessionWith(2);
    assert.equal(st.canReviewSession(s), false);
  });

  test('au-delà du seuil, la revue devient possible', () => {
    const seuil = loadSessionStore().REVIEW_MIN_EVENTS;
    const { st, s } = sessionWith(seuil);
    assert.equal(s.events.length, seuil, 'jeu de test invalide : des affirmations ont fusionné');
    assert.equal(st.canReviewSession(s), true);
  });

  test('sans session, jamais de revue', () => {
    const st = loadSessionStore();
    assert.equal(st.canReviewSession(null), false);
    assert.equal(st.canReviewSession({}), false);
  });
});

describe('condensé transmis au modèle', () => {
  test('une ligne par événement, avec horodatage et locuteur', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, { ...claim('Le chômage a baissé de deux points', 'FALSE'), speaker: 'Dupont' });

    const d = st.buildReviewDigest(s);
    assert.equal(d.lines.length, 1);
    assert.match(d.lines[0], /\[FALSE\]/);
    assert.match(d.lines[0], /Dupont/);
    assert.match(d.lines[0], /\d\d:\d\d/);
  });

  test('les énoncés de discours figurent avec leur type', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertDiscourseEvent(s, { kind: 'PREDICTION', statement: 'Les impôts baisseront l’an prochain', horizon: '2027' });

    const d = st.buildReviewDigest(s);
    assert.match(d.lines[0], /\[PREDICTION\]/);
    assert.match(d.lines[0], /2027/);
    assert.equal(d.counts.discourse, 1);
  });

  test('les affirmations non vérifiées sont comptées', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, claim('une affirmation deja verifiee ici', 'TRUE', false));
    st.upsertClaimEvent(s, claim('une affirmation encore en attente la', 'TRUE', true));

    const d = st.buildReviewDigest(s);
    assert.equal(d.counts.claims, 2);
    assert.equal(d.counts.unresolved, 1);
  });

  test('une session longue est tronquée sur les événements récents', () => {
    const { st, s } = sessionWith(30);
    const d = st.buildReviewDigest(s, 10);
    assert.equal(d.lines.length, 10);
    assert.equal(d.truncated, true);
    assert.match(d.lines[d.lines.length - 1], /sujet29alpha/);
  });

  test('sous la limite, rien n’est tronqué', () => {
    const { st, s } = sessionWith(5);
    const d = st.buildReviewDigest(s, 10);
    assert.equal(d.truncated, false);
  });

  test('les énoncés bruts accompagnent le condensé (pour valider les citations)', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, claim('Le chômage a baissé de deux points'));
    const d = st.buildReviewDigest(s);
    assert.deepEqual(d.texts, ['Le chômage a baissé de deux points']);
  });

  test('session vide → condensé vide plutôt qu’une exception', () => {
    const st = loadSessionStore();
    assert.deepEqual(st.buildReviewDigest(null).lines, []);
    assert.deepEqual(st.buildReviewDigest(st.createSession({})).lines, []);
  });
});

describe('ancrage des citations', () => {
  const st = loadSessionStore();
  const TEXTS = ['Le chômage a baissé de deux points cette année', 'Je supprimerai cette taxe dès la rentrée'];

  test('une citation exacte est acceptée', () => {
    assert.equal(st.quoteIsGrounded('Le chômage a baissé de deux points cette année', TEXTS), true);
  });

  test('la casse, les accents et la ponctuation sont tolérés', () => {
    assert.equal(st.quoteIsGrounded('LE CHOMAGE A BAISSE DE DEUX POINTS CETTE ANNEE !', TEXTS), true);
  });

  test('un extrait partiel mais fidèle est accepté', () => {
    assert.equal(st.quoteIsGrounded('a baissé de deux points cette année', TEXTS), true);
  });

  test('une citation inventée est refusée', () => {
    assert.equal(st.quoteIsGrounded('Les étrangers sont responsables du chômage', TEXTS), false);
  });

  test('une citation trop courte est refusée', () => {
    assert.equal(st.quoteIsGrounded('oui', TEXTS), false);
    assert.equal(st.quoteIsGrounded('', TEXTS), false);
  });

  test('sans énoncé de référence, rien n’est ancré', () => {
    assert.equal(st.quoteIsGrounded('Le chômage a baissé de deux points', []), false);
  });
});

describe('filtrage des constats du modèle', () => {
  const st = loadSessionStore();
  const TEXTS = ['Le chômage a baissé de deux points cette année', 'Je supprimerai cette taxe dès la rentrée'];
  const CRITERION = 'Deux options sont présentées comme les seules possibles.';

  test('un constat complet et ancré est retenu', () => {
    const r = st.validateReviewFindings(
      [{ type: 'FALSE_DILEMMA', quote: TEXTS[0], criterion: CRITERION, speaker: 'Dupont' }], TEXTS);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].speaker, 'Dupont');
  });

  test('un constat sans citation réelle est écarté', () => {
    const r = st.validateReviewFindings(
      [{ type: 'FALSE_DILEMMA', quote: 'une phrase jamais prononcée ici', criterion: CRITERION }], TEXTS);
    assert.equal(r.findings.length, 0);
    assert.equal(r.rejected.ungroundedQuote, 1);
  });

  test('un constat sans critère nommé est écarté', () => {
    const r = st.validateReviewFindings(
      [{ type: 'FALSE_DILEMMA', quote: TEXTS[0], criterion: 'bof' }], TEXTS);
    assert.equal(r.findings.length, 0);
    assert.equal(r.rejected.missingCriterion, 1);
  });

  test('un procédé hors des trois retenus est écarté', () => {
    const r = st.validateReviewFindings(
      [{ type: 'STRAW_MAN', quote: TEXTS[0], criterion: CRITERION },
       { type: 'SLIPPERY_SLOPE', quote: TEXTS[0], criterion: CRITERION }], TEXTS);
    assert.equal(r.findings.length, 0);
    assert.equal(r.rejected.unknownType, 2);
  });

  test('seuls trois procédés sont autorisés, et ils sont structurels', () => {
    assert.deepEqual([...st.REVIEW_FALLACY_TYPES].sort(),
      ['AD_HOMINEM', 'FALSE_DILEMMA', 'WHATABOUTISM']);
  });

  test('une liste vide est une réponse valide', () => {
    const r = st.validateReviewFindings([], TEXTS);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.rejected, { unknownType: 0, ungroundedQuote: 0, missingCriterion: 0 });
  });

  test('une réponse malformée ne fait pas échouer la revue', () => {
    assert.deepEqual(st.validateReviewFindings(null, TEXTS).findings, []);
    assert.deepEqual(st.validateReviewFindings('texte', TEXTS).findings, []);
    assert.equal(st.validateReviewFindings([null, 42, 'x'], TEXTS).findings.length, 0);
  });

  test('le tri sépare correctement le bon grain de l’ivraie', () => {
    const r = st.validateReviewFindings([
      { type: 'AD_HOMINEM',    quote: TEXTS[1], criterion: CRITERION },        // retenu
      { type: 'WHATABOUTISM',  quote: 'jamais prononcé nulle part', criterion: CRITERION }, // écarté
      { type: 'INVENTED_TYPE', quote: TEXTS[0], criterion: CRITERION },        // écarté
      { type: 'FALSE_DILEMMA', quote: TEXTS[0], criterion: 'court' },          // écarté
    ], TEXTS);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].type, 'AD_HOMINEM');
    assert.equal(r.rejected.ungroundedQuote, 1);
    assert.equal(r.rejected.unknownType, 1);
    assert.equal(r.rejected.missingCriterion, 1);
  });
});
