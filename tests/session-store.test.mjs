// Mémoire de session : modèle d'événements, identifiants stables, persistance.
//
// Enjeu principal : le pipeline émet deux fois chaque affirmation (passage
// rapide puis passage sourcé), parfois avec une formulation légèrement
// différente. Le magasin doit tenir UN seul événement par affirmation, et ne
// jamais laisser un résultat provisoire écraser un verdict sourcé.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadSessionStore } from './helpers/load.mjs';

const fast = (claim, extra = {}) => ({
  claim, verdict: 'TRUE', confidence: 0.6, explanation: 'analyse rapide',
  pending: true, sources: [], ...extra,
});
const grounded = (claim, extra = {}) => ({
  claim, verdict: 'FALSE', confidence: 0.9, explanation: 'analyse sourcée',
  pending: false, sources: ['https://exemple.org/a'], ...extra,
});

describe('empreinte d’une affirmation', () => {
  const st = loadSessionStore();

  test('ignore casse, accents et ponctuation', () => {
    assert.equal(
      st.claimFingerprint('Le chômage a baissé !'),
      st.claimFingerprint('le CHOMAGE a baisse')
    );
  });

  test('ignore l’ordre des mots', () => {
    assert.equal(
      st.claimFingerprint('inflation forte en 2022'),
      st.claimFingerprint('2022 forte inflation')
    );
  });

  test('deux sujets différents ont des empreintes différentes', () => {
    assert.notEqual(
      st.claimFingerprint('le chomage a baisse'),
      st.claimFingerprint('la temperature a augmente')
    );
  });

  test('similarité : identique = 1, sans rapport = 0', () => {
    assert.equal(st.claimSimilarity('inflation forte cette annee', 'inflation forte cette annee'), 1);
    assert.equal(st.claimSimilarity('inflation forte', 'tarte pommes'), 0);
  });
});

describe('identifiants d’événement', () => {
  const st = loadSessionStore();

  test('sont uniques', () => {
    const ids = new Set(Array.from({ length: 50 }, () => st.makeEventId('CLAIM')));
    assert.equal(ids.size, 50);
  });

  test('portent le type en préfixe', () => {
    assert.match(st.makeEventId('CLAIM'), /^claim_/);
  });
});

describe('cycle de vie d’une session', () => {
  const st = loadSessionStore();

  test('une session neuve est active et vide', () => {
    const s = st.createSession({ title: 'Débat', date: '2026-07-25' });
    assert.equal(st.isSessionActive(s), true);
    assert.equal(s.events.length, 0);
    assert.equal(s.source.title, 'Débat');
    assert.ok(s.id.startsWith('ses_'));
  });

  test('une session close ne l’est plus', () => {
    const s = st.createSession({});
    st.endSession(s);
    assert.equal(st.isSessionActive(s), false);
    assert.ok(s.endedAt);
  });
});

describe('upsert — un seul événement par affirmation', () => {
  test('le passage rapide crée l’événement', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, fast('Le chômage a baissé de deux points'));
    assert.equal(s.events.length, 1);
    assert.equal(s.events[0].status, st.EVENT_STATUS.PENDING);
    assert.equal(s.events[0].type, st.EVENT_TYPES.CLAIM);
  });

  test('le passage sourcé complète le même événement', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, fast('Le chômage a baissé de deux points'));
    st.upsertClaimEvent(s, grounded('Le chômage a baissé de deux points'));
    assert.equal(s.events.length, 1, 'l’affirmation a été dupliquée');
    assert.equal(s.events[0].verdict, 'FALSE');
    assert.equal(s.events[0].status, st.EVENT_STATUS.RESOLVED);
    assert.deepEqual(s.events[0].sources, ['https://exemple.org/a']);
  });

  test('tolère une reformulation entre les deux passages', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, fast('Le chômage a baissé de deux points cette année'));
    st.upsertClaimEvent(s, grounded('le chomage a baisse de 2 points cette annee'));
    assert.equal(s.events.length, 1);
  });

  test('deux affirmations distinctes restent distinctes', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, fast('Le chômage a baissé de deux points'));
    st.upsertClaimEvent(s, fast('La température moyenne a augmenté fortement'));
    assert.equal(s.events.length, 2);
  });

  test('un résultat provisoire n’écrase jamais un verdict sourcé', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, grounded('Le chômage a baissé de deux points'));
    st.upsertClaimEvent(s, fast('Le chômage a baissé de deux points'));
    assert.equal(s.events[0].verdict, 'FALSE', 'le verdict sourcé a été perdu');
    assert.equal(s.events[0].status, st.EVENT_STATUS.RESOLVED);
  });

  test('une entrée sans affirmation est ignorée', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    assert.equal(st.upsertClaimEvent(s, { verdict: 'TRUE' }), null);
    assert.equal(st.upsertClaimEvent(null, fast('quelque chose')), null);
    assert.equal(s.events.length, 0);
  });

  test('le nombre d’événements reste borné', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    for (let i = 0; i < st.MAX_EVENTS + 40; i++) {
      st.upsertClaimEvent(s, fast(`affirmation numero ${i} portant sur un sujet distinct ${i}`));
    }
    assert.ok(s.events.length <= st.MAX_EVENTS, `débordement : ${s.events.length}`);
  });

  test('la corroboration et la conviction sont conservées', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, grounded('Le chômage a baissé de deux points', {
      corroboration: { band: 'SOLIDE', voices: 3, primaries: 1, circular: false },
      speaker_confidence: 'HIGH',
    }));
    assert.equal(s.events[0].corroboration.band, 'SOLIDE');
    assert.equal(s.events[0].speakerConfidence, 'HIGH');
  });
});

describe('locuteurs', () => {
  test('les noms confirmés sont attribués rétroactivement', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, fast('Le chômage a baissé de deux points', { dominantSpeakerId: 0 }));
    assert.equal(s.events[0].speaker, null);

    st.setSessionSpeakers(s, { 0: 'Dupont' });
    assert.equal(s.speakers['0'], 'Dupont');
    assert.equal(s.events[0].speaker, 'Dupont', 'rétro-attribution non appliquée');
  });

  test('un nom déjà connu n’est pas écrasé', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, fast('Une affirmation quelconque ici', { dominantSpeakerId: 1, speaker: 'Martin' }));
    st.setSessionSpeakers(s, { 1: 'Dupont' });
    assert.equal(s.events[0].speaker, 'Martin');
  });
});

describe('synthèse de session', () => {
  test('compte les verdicts, les locuteurs et les vérifications en cours', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, grounded('premiere affirmation sur le chomage', { speaker: 'Dupont' }));
    st.upsertClaimEvent(s, grounded('deuxieme affirmation sur la temperature', { verdict: 'TRUE', speaker: 'Dupont' }));
    st.upsertClaimEvent(s, fast('troisieme affirmation sur les transports', { speaker: 'Martin' }));

    const sum = st.sessionSummary(s);
    assert.equal(sum.total, 3);
    assert.equal(sum.resolved, 2);
    assert.equal(sum.pending, 1);
    assert.equal(sum.byVerdict.FALSE, 1);
    assert.equal(sum.byVerdict.TRUE, 2);
    assert.equal(sum.bySpeaker.Dupont, 2);
    assert.ok(sum.durationMs >= 0);
  });

  test('sans session → synthèse vide plutôt qu’une exception', () => {
    const st = loadSessionStore();
    assert.equal(st.sessionSummary(null).total, 0);
  });
});

describe('persistance', () => {
  test('une session enregistrée est relue à l’identique', async () => {
    const st = loadSessionStore();
    const s = st.createSession({ title: 'Débat télévisé' });
    st.upsertClaimEvent(s, grounded('Le chômage a baissé de deux points'));

    assert.equal(await st.saveSessionNow(s), true);
    const back = await st.loadStoredSession();

    assert.ok(back, 'session non relue');
    assert.equal(back.id, s.id);
    assert.equal(back.source.title, 'Débat télévisé');
    assert.equal(back.events.length, 1);
    assert.equal(back.events[0].verdict, 'FALSE');
  });

  test('la session relue est indépendante de l’originale', async () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, fast('une affirmation a conserver ici'));
    await st.saveSessionNow(s);

    const back = await st.loadStoredSession();
    back.events[0].verdict = 'MODIFIÉ';
    assert.notEqual(s.events[0].verdict, 'MODIFIÉ');
  });

  test('la suppression vide bien le stockage', async () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    await st.saveSessionNow(s);
    await st.clearStoredSession();
    assert.equal(await st.loadStoredSession(), null);
  });

  test('sans rien de stocké → null', async () => {
    const st = loadSessionStore();
    assert.equal(await st.loadStoredSession(), null);
  });

  test('une session active est distinguée d’une session close', async () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    await st.saveSessionNow(s);
    assert.equal(st.isSessionActive(await st.loadStoredSession()), true);

    st.endSession(s);
    await st.saveSessionNow(s);
    assert.equal(st.isSessionActive(await st.loadStoredSession()), false);
  });
});

describe('robustesse de la relecture', () => {
  const st = loadSessionStore();

  test('les formes inattendues sont écartées', () => {
    assert.equal(st.deserializeSession(null), null);
    assert.equal(st.deserializeSession('texte'), null);
    assert.equal(st.deserializeSession({}), null);
    assert.equal(st.deserializeSession({ events: [] }), null);          // pas de startedAt
    assert.equal(st.deserializeSession({ startedAt: 1, events: {} }), null);
  });

  test('un schéma d’une autre version est ignoré', () => {
    assert.equal(st.deserializeSession({ schemaVersion: 99, startedAt: 1, events: [] }), null);
  });

  test('les événements incomplets sont filtrés', () => {
    const back = st.deserializeSession({
      schemaVersion: 1, startedAt: Date.now(),
      events: [{ id: 'a', type: 'CLAIM' }, { type: 'CLAIM' }, null],
    });
    assert.equal(back.events.length, 1);
  });
});
