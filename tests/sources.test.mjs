// Sélection des sources affichées sur une carte de verdict.
// Objectif : ne jamais présenter comme « source » un lien hors sujet ramené
// par un capteur trop large.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadServiceWorker, REPO_ROOT } from './helpers/load.mjs';

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

describe('pertinence des capteurs à correspondance de titre', () => {
  // Cas relevés dans un rapport réel : Wikipédia répondait par titre approchant
  // et ramenait des articles sans rapport, qui étaient ensuite affichés comme
  // sources ET comptés comme voix indépendantes dans la corroboration.
  const wiki = (title, snippet) => ({
    source: 'wikipedia', title, snippet: snippet || title,
    link: 'https://fr.wikipedia.org/wiki/' + encodeURIComponent(title),
  });

  const HORS_SUJET = [
    ["J'ai critiqué la cérémonie d'inauguration des Jeux Olympiques comme vulgaire", 'Indochine (groupe)'],
    ['Une civilisation est en train de nous remplacer', 'La Montagne entre nous'],
    ["On a besoin d'immigrer pour travailler", 'The Cleaning Lady'],
    ['Renault va fermer les yeux', 'Carlos Ghosn'],
    ['Cinquante mille, ça ne fait même pas dix pour cent', 'Attentat du 14 juillet 2016 à Nice'],
  ];

  const PERTINENTS = [
    ["On a besoin d'immigrer pour travailler", 'Immigration en France'],
    ["Les Chinois avaient de l'avance dans l'industrie de la voiture électrique", 'Voiture électrique en France'],
    ["L'Islam est une civilisation", 'Civilisation islamique'],
    ["Les politiques ont favorisé l'extrême diversité avec l'invasion islamique', 'Islam en France"],
  ];

  for (const [claim, title] of HORS_SUJET) {
    test(`« ${title} » est écarté`, () => {
      assert.equal(sw.isTopicallyRelevant(claim, wiki(title)), false);
    });
  }

  test('« Immigration en France » est conservé (morphologie tolérée)', () => {
    assert.equal(sw.isTopicallyRelevant("On a besoin d'immigrer pour travailler", wiki('Immigration en France')), true);
  });

  test('« Voiture électrique en France » est conservé', () => {
    assert.equal(sw.isTopicallyRelevant(
      "Les Chinois avaient de l'avance dans l'industrie de la voiture électrique",
      wiki('Voiture électrique en France')), true);
  });

  test('« Islam en France » est conservé malgré une affirmation longue', () => {
    assert.equal(sw.isTopicallyRelevant(
      "Les politiques ont favorisé l'extrême diversité avec l'invasion islamique",
      wiki('Islam en France')), true);
  });

  test('un titre elliptique est rattrapé par son résumé', () => {
    assert.equal(sw.isTopicallyRelevant(
      'Les protestants ont été perçus de la même manière',
      wiki('Louis XIII', 'Louis XIII roi de France, révocation des protestants et siège de La Rochelle')), true);
  });

  test('les mots vides ne suffisent jamais à établir la pertinence', () => {
    const tokens = sw.topicTokens('nous vous pour avec dans cette comme entre');
    assert.equal(tokens.size, 0);
  });

  test('seuls les capteurs cherchant par titre sont filtrés', () => {
    assert.ok(sw.TITLE_MATCH_SENSORS.has('wikipedia'));
    assert.ok(sw.TITLE_MATCH_SENSORS.has('wikidata'));
    assert.equal(sw.TITLE_MATCH_SENSORS.has('web'), false);
    assert.equal(sw.TITLE_MATCH_SENSORS.has('worldbank'), false);
  });

  test('le filtre laisse passer les autres capteurs sans les juger', () => {
    const items = [
      { source: 'web', title: 'sans rapport du tout', snippet: 'rien', link: 'https://a.com/1' },
      wiki('Indochine (groupe)'),
    ];
    const kept = sw.filterTitleMatchSensors('une affirmation sur les jeux olympiques', items);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].source, 'web');
  });

  // Second lot, relevé sur un débat où le filtre initial laissait passer des
  // articles ne partageant qu'un mot passe-partout avec l'affirmation.
  const HORS_SUJET_2 = [
    ["Un seul million d'italiens est resté.", 'Sabrina Salerno'],
    ['Le tiers des personnes qui viennent sont des étudiants.', 'Tiers-lieu'],
    ['On devrait trouver six millions de personnes de plus en France en dix ans.', 'Attentats du 13 novembre 2015 en France'],
    ["Nous sommes le seul pays d'Europe qui dit nous sommes des gallo-romains.", 'Albert (Somme)'],
    ["Il y avait trois millions d'italiens qui étaient venus entre 1870 et 1940.", 'Guerre franco-allemande de 1870'],
  ];

  for (const [claim, title] of HORS_SUJET_2) {
    test(`« ${title} » est écarté (un seul mot commun ne suffit pas)`, () => {
      assert.equal(sw.isTopicallyRelevant(claim, wiki(title)), false);
    });
  }

  test('un quantificateur ne rend pas un article pertinent', () => {
    assert.ok(sw.TOPIC_LOW_SIGNAL.has('tiers'), '« tiers » doit être non discriminant');
    assert.ok(sw.TOPIC_LOW_SIGNAL.has('franc'), '« France » doit être non discriminant');
  });

  test('un titre court dont un mot fort correspond reste pertinent', () => {
    assert.equal(sw.isTopicallyRelevant(
      "Les politiques ont favorisé l'extrême diversité avec l'invasion islamique",
      wiki('Islam en France')), true);
  });

  test('« nous sommes » ne renvoie pas au département de la Somme', () => {
    assert.equal(sw.isTopicallyRelevant(
      'Nous sommes le seul pays qui dit cela', wiki('Albert (Somme)')), false);
  });

  test('une affirmation trop courte ne fait écarter personne', () => {
    assert.equal(sw.isTopicallyRelevant('oui', wiki('Indochine (groupe)')), true);
  });

  test('le filtre est réellement appliqué à la collecte des preuves', () => {
    // Sans cette vérification, retirer l'appel dans gatherEvidence passerait
    // inaperçu : les fonctions resteraient correctes mais inutilisées.
    const src = readFileSync(join(REPO_ROOT, 'realtime-factcheck', 'src', 'background', 'service-worker.js'), 'utf8');
    const fn = src.match(/async function gatherEvidence[\s\S]*?\n}/);
    assert.ok(fn, 'gatherEvidence introuvable');
    assert.match(fn[0], /filterTitleMatchSensors\(/,
      'un article hors sujet doit être écarté avant de compter comme voix indépendante');
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
