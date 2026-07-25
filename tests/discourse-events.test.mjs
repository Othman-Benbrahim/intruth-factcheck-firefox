// Types de discours : prédictions et engagements.
//
// Règle cardinale de cette phase : ces énoncés sont CONSIGNÉS, jamais jugés.
// Une prédiction n'est ni vraie ni fausse au moment où elle est prononcée.
// La majorité des tests ci-dessous vérifie précisément qu'aucun verdict ne
// peut s'y attacher, à aucune étape.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSessionStore, loadOverlay, loadServiceWorker, REPO_ROOT } from './helpers/load.mjs';

describe('reconnaissance d’un item de discours', () => {
  const st = loadSessionStore();

  test('les types attendus sont reconnus', () => {
    assert.equal(st.discourseKindOf({ kind: 'PREDICTION' }), 'PREDICTION');
    assert.equal(st.discourseKindOf({ kind: 'COMMITMENT' }), 'COMMITMENT');
  });

  test('la casse et les noms de champ alternatifs sont tolérés', () => {
    assert.equal(st.discourseKindOf({ kind: 'prediction' }), 'PREDICTION');
    assert.equal(st.discourseKindOf({ event_type: 'COMMITMENT' }), 'COMMITMENT');
  });

  test('un type inconnu n’est pas du discours', () => {
    assert.equal(st.discourseKindOf({ kind: 'FALLACY' }), null);
    assert.equal(st.discourseKindOf({ kind: 'OPINION' }), null);
    assert.equal(st.discourseKindOf({ claim: 'une affirmation' }), null);
    assert.equal(st.discourseKindOf(null), null);
  });

  test('l’énoncé est lu quel que soit le champ employé', () => {
    assert.equal(st.discourseStatement({ statement: 'a' }), 'a');
    assert.equal(st.discourseStatement({ text: 'b' }), 'b');
    assert.equal(st.discourseStatement({}), '');
  });
});

describe('séparation discours / affirmations', () => {
  const st = loadSessionStore();

  const RAW = [
    { claim: 'Le chômage a baissé de deux points', verdict: 'TRUE' },
    { kind: 'PREDICTION', statement: 'Le chômage baissera encore l’an prochain', horizon: '2027' },
    { kind: 'COMMITMENT', statement: 'Je supprimerai cette taxe', speaker: 'Dupont' },
  ];

  test('chaque item part du bon côté', () => {
    const { claims, discourse } = st.splitDiscourseItems(RAW);
    assert.equal(claims.length, 1);
    assert.equal(discourse.length, 2);
    assert.equal(claims[0].verdict, 'TRUE');
  });

  test('un énoncé de discours ne porte aucun verdict', () => {
    const { discourse } = st.splitDiscourseItems(RAW);
    for (const d of discourse) {
      assert.equal('verdict' in d, false, 'un verdict a été attaché à un énoncé de discours');
      assert.equal('confidence' in d, false);
    }
  });

  test('l’échéance et le locuteur déclarés sont conservés', () => {
    const { discourse } = st.splitDiscourseItems(RAW);
    assert.equal(discourse[0].horizon, '2027');
    assert.equal(discourse[1].speaker, 'Dupont');
  });

  test('un item de discours sans énoncé est écarté', () => {
    const { discourse } = st.splitDiscourseItems([{ kind: 'PREDICTION', statement: '   ' }]);
    assert.equal(discourse.length, 0);
  });

  test('un type non reconnu reste une affirmation (aucune perte)', () => {
    const { claims, discourse } = st.splitDiscourseItems([{ kind: 'SARCASM', claim: 'quelque chose' }]);
    assert.equal(claims.length, 1);
    assert.equal(discourse.length, 0);
  });

  test('entrée vide ou invalide → deux listes vides', () => {
    assert.deepEqual(st.splitDiscourseItems([]), { claims: [], discourse: [] });
    assert.deepEqual(st.splitDiscourseItems(null), { claims: [], discourse: [] });
  });
});

describe('recevabilité d’un énoncé de discours', () => {
  // Sur un rapport réel, 13 énoncés sur 15 étaient inexploitables : fragments
  // mal transcrits, propos au passé étiquetés « prédiction », ou simple
  // conduite du débat prise pour un engagement.
  const st = loadSessionStore();
  const sw = loadServiceWorker();
  const gate = (kind, texte) => st.isUsableDiscourseStatement(kind, texte, sw.looksLikeTranscriptionNoise);

  describe('une prédiction doit parler du futur', () => {
    const REJETS = [
      ['Nous avons fait venir des millions et des millions de gens.', 'passé composé'],
      ['Nous expulsons que dix pour cent des déboutés.', 'présent'],
      ["Mais les patrons, c'est fini depuis longtemps.", 'passé — et « patrons » n’est pas un futur simple'],
      ['Je suis là pour débattre, pas pour répondre à vos questions.', 'aucune projection'],
    ];
    for (const [texte, raison] of REJETS) {
      test(`écarté — ${raison}`, () => assert.equal(gate('PREDICTION', texte), false));
    }

    const ACCEPTES = [
      "Je vais réduire l'immigration légale.",
      "Au bout du mandat d'Emmanuel Macron, il y aura deux millions d'immigrés légaux.",
      'La laïcité va poser des règles.',
    ];
    for (const texte of ACCEPTES) {
      test(`conservé — « ${texte.slice(0, 40)}… »`, () => assert.equal(gate('PREDICTION', texte), true));
    }
  });

  describe('un engagement doit lier le locuteur', () => {
    test('la simple conduite du débat n’engage à rien', () => {
      assert.equal(gate('COMMITMENT', 'Je voudrais continuer.'), false);
      assert.equal(gate('COMMITMENT', 'Maintenant je voudrais continuer.'), false);
    });

    test('un énoncé long mais non commissif est écarté', () => {
      // Piège : « sera » marque le futur mais n'engage personne.
      assert.equal(gate('COMMITMENT', 'Cette réforme sera très importante pour le pays.'), false);
      assert.equal(gate('COMMITMENT', 'Les élites françaises ont décidé de fermer les usines.'), false);
    });

    test('une promesse explicite est retenue', () => {
      assert.equal(gate('COMMITMENT', "Je vais supprimer cette taxe dès la rentrée."), true);
      assert.equal(gate('COMMITMENT', "Nous allons reprendre le contrôle de nos frontières."), true);
    });
  });

  describe('formes inexploitables', () => {
    test('fragment tronqué', () => {
      assert.equal(gate('PREDICTION', 'nous avons accumulé'), false);
    });

    test('bégaiement', () => {
      assert.equal(gate('COMMITMENT', "Je, je, si vous voulez, ce n'est pas une religion."), false);
    });

    test('le modèle décrit au lieu de citer', () => {
      assert.equal(
        gate('PREDICTION', "Zemmour affirme que les politiques d'immigration vont changer radicalement."),
        false);
    });

    test('énoncé vide ou trop bref', () => {
      assert.equal(gate('PREDICTION', ''), false);
      assert.equal(gate('PREDICTION', 'Ça ira mieux.'), false);
    });
  });

  test('un mot accentué n’est pas pris pour une répétition', () => {
    // « La laïcité » : la limite de mot de JavaScript ignore les accents et
    // faisait passer ce début de phrase pour un bégaiement.
    assert.equal(gate('PREDICTION', 'La laïcité va poser des règles.'), true);
  });

  test('le filtre en lot écarte les énoncés inexploitables', () => {
    const items = [
      { kind: 'PREDICTION', statement: "Je vais réduire l'immigration légale." },
      { kind: 'PREDICTION', statement: 'Nous avons fait venir des millions de gens.' },
      { kind: 'COMMITMENT', statement: 'Je voudrais continuer.' },
      { kind: 'PREDICTION', statement: '[Speaker 0] La laïcité va poser des règles nouvelles.' },
      null,
    ];
    const gardes = st.filterUsableDiscourseItems(items, sw.looksLikeTranscriptionNoise);
    assert.equal(gardes.length, 2, 'le tri en lot ne correspond pas au tri unitaire');
  });

  test('le filtre est réellement appliqué avant consignation', () => {
    const swSrc = readFileSync(join(REPO_ROOT, 'realtime-factcheck', 'src', 'background', 'service-worker.js'), 'utf8');
    assert.match(swSrc, /const usable = filterUsableDiscourseItems\(discourseItems/,
      'un énoncé inexploitable ne doit jamais atteindre la mémoire de session');
    assert.match(swSrc, /const enriched = usable\.map/,
      'seuls les énoncés retenus doivent être consignés');
  });
});

describe('déduplication des énoncés de discours', () => {
  test('une reprise proche n’est pas consignée deux fois', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertDiscourseEvent(s, { kind: 'COMMITMENT', statement: 'Je voudrais continuer maintenant' });
    st.upsertDiscourseEvent(s, { kind: 'COMMITMENT', statement: 'Maintenant je voudrais continuer' });
    assert.equal(s.events.length, 1, 'la reprise orale a créé un doublon');
  });

  test('un texte identique étiqueté deux fois ne donne qu’un énoncé', () => {
    // Relevé sur un rapport réel : « Serons nombreux à ne pas vous laisser
    // faire » (prédiction) et « Nous serons nombreux à ne pas vous laisser
    // faire » (engagement) sont le même propos, entendu deux fois.
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertDiscourseEvent(s, { kind: 'PREDICTION', statement: 'Nous serons nombreux à ne pas vous laisser faire' });
    st.upsertDiscourseEvent(s, { kind: 'COMMITMENT', statement: 'Serons nombreux à ne pas vous laisser faire' });
    assert.equal(s.events.length, 1, 'le même propos a été consigné deux fois');
  });

  test('deux propos distincts restent distincts même de type différent', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertDiscourseEvent(s, { kind: 'PREDICTION', statement: 'Les impôts baisseront dès l’an prochain' });
    st.upsertDiscourseEvent(s, { kind: 'COMMITMENT', statement: 'Je supprimerai la taxe sur les carburants' });
    assert.equal(s.events.length, 2);
  });
});

describe('consignation dans la session', () => {
  const item = (kind, statement, extra = {}) => ({ kind, statement, ...extra });

  test('un énoncé consigné n’a ni verdict, ni confiance, ni sources', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    const evt = st.upsertDiscourseEvent(s, item('PREDICTION', 'Le chômage baissera l’an prochain'));

    assert.equal(evt.type, 'PREDICTION');
    assert.equal(evt.status, st.EVENT_STATUS.RECORDED);
    assert.equal(evt.verdict, undefined, 'un verdict a été enregistré');
    assert.equal(evt.confidence, undefined);
    assert.equal(evt.sources, undefined);
  });

  test('le même énoncé n’est pas consigné deux fois', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertDiscourseEvent(s, item('COMMITMENT', 'Je supprimerai cette taxe dès la rentrée'));
    st.upsertDiscourseEvent(s, item('COMMITMENT', 'je supprimerai cette TAXE des la rentree'));
    assert.equal(s.events.length, 1);
  });

  test('un propos différent de même racine reste un second événement', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertDiscourseEvent(s, item('PREDICTION', 'Cette mesure produira des effets rapides'));
    st.upsertDiscourseEvent(s, item('COMMITMENT', 'Je financerai cette mesure par une taxe nouvelle'));
    assert.equal(s.events.length, 2);
  });

  test('les informations manquantes sont complétées, jamais écrasées', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertDiscourseEvent(s, item('PREDICTION', 'Les impôts baisseront nettement', { speaker: 'Dupont' }));
    st.upsertDiscourseEvent(s, item('PREDICTION', 'Les impôts baisseront nettement', { speaker: 'Martin', horizon: '2028' }));
    assert.equal(s.events[0].speaker, 'Dupont');
    assert.equal(s.events[0].horizon, '2028');
  });

  test('une entrée invalide est refusée', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    assert.equal(st.upsertDiscourseEvent(s, item('PREDICTION', '')), null);
    assert.equal(st.upsertDiscourseEvent(s, item('FALLACY', 'un énoncé')), null);
    assert.equal(st.upsertDiscourseEvent(null, item('PREDICTION', 'un énoncé')), null);
    assert.equal(s.events.length, 0);
  });

  test('discours et affirmations cohabitent sans se confondre', () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertClaimEvent(s, { claim: 'Le chômage a baissé de deux points', verdict: 'TRUE', pending: false });
    st.upsertDiscourseEvent(s, item('PREDICTION', 'Le chômage baissera encore l’an prochain'));

    const sum = st.sessionSummary(s);
    assert.equal(sum.total, 1, 'le discours a été compté comme une affirmation');
    assert.equal(sum.discourse, 1);
    assert.equal(sum.byDiscourse.PREDICTION, 1);
  });

  test('la persistance conserve les énoncés de discours', async () => {
    const st = loadSessionStore();
    const s = st.createSession({});
    st.upsertDiscourseEvent(s, item('COMMITMENT', 'Je supprimerai cette taxe dès la rentrée'));
    await st.saveSessionNow(s);

    const back = await st.loadStoredSession();
    assert.equal(back.events.length, 1);
    assert.equal(back.events[0].type, 'COMMITMENT');
    assert.equal(back.events[0].status, 'recorded');
  });
});

describe('affichage des énoncés de discours', () => {
  const ov = loadOverlay();

  test('la fonctionnalité est désactivée par défaut', () => {
    assert.equal(ov.DEFAULT_SETTINGS.discourseEnabled, false);
  });

  test('les libellés sont explicites et en français', () => {
    assert.equal(ov.discourseLabel('PREDICTION'), 'PRÉDICTION');
    assert.equal(ov.discourseLabel('COMMITMENT'), 'ENGAGEMENT');
    assert.equal(ov.discourseLabel('INCONNU'), 'ÉNONCÉ');
  });

  test('aucun libellé n’évoque un jugement de vérité', () => {
    for (const label of Object.values(ov.DISCOURSE_LABELS)) {
      assert.doesNotMatch(label, /VRAI|FAUX|TRUE|FALSE|TROMPEUR/i);
    }
  });

  test('les énoncés s’effacent quand un filtre de verdict est actif', () => {
    ov.setSettings({ verdictFilter: 'all' });
    assert.equal(ov.shouldShowDiscourse(), true);
    ov.setSettings({ verdictFilter: 'flagged' });
    assert.equal(ov.shouldShowDiscourse(), false);
    ov.setSettings({ verdictFilter: 'accurate' });
    assert.equal(ov.shouldShowDiscourse(), false);
  });
});
