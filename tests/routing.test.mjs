// Routage des capteurs.
// Enjeu principal : les mots-clés d'un domaine ne doivent pas déborder sur un
// autre. Le piège historique est le sport, dont le vocabulaire (« score »,
// « défaite », « vainqueur ») chevauche la politique — domaine principal
// d'InTruth. Ces tests verrouillent cette frontière.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './helpers/load.mjs';

const sw = loadServiceWorker();
const routes = (text) => sw.routeSensors(text);

describe('socle commun', () => {
  test('les sources généralistes sont toujours interrogées', () => {
    const s = routes('Une phrase quelconque sans domaine particulier');
    assert.ok(s.has('wikipedia'));
    assert.ok(s.has('wikidata'));
  });

  test('web et fact-check sont toujours tentés', () => {
    const s = routes('Une phrase quelconque');
    assert.ok(s.has('web'));
    assert.ok(s.has('factcheck'));
  });
});

describe('sport — ESPN activé, GDELT écarté', () => {
  const SPORT = [
    'Le PSG a battu Marseille en finale',
    'Le Real Madrid a gagné 3-1',
    'Les Lakers ont écrasé Boston en NBA',
    'Mbappé a marqué un hat-trick',
    'Finale de la Coupe du Monde',
    'Nadal a remporté Roland-Garros',
  ];

  for (const claim of SPORT) {
    test(`« ${claim} » → capteur ESPN`, () => {
      assert.ok(routes(claim).has('espn'));
    });
  }

  test('GDELT est écarté sur le sport (la presse confond pronostic et résultat)', () => {
    assert.equal(routes('Le Paraguay a éliminé l’Allemagne en Coupe du Monde').has('gdelt'), false);
  });
});

describe('sport — pas de faux positif sur la politique', () => {
  const POLITIQUE = [
    'La défaite électorale de la majorité',
    'Le candidat a fait un score de 23%',
    'Le vainqueur de l’élection présidentielle',
    'Le candidat a battu son rival au second tour',
    'Le chômage a baissé de 2%',
    'La dette publique atteint 110% du PIB',
  ];

  for (const claim of POLITIQUE) {
    test(`« ${claim} » n’est pas traité comme du sport`, () => {
      assert.equal(routes(claim).has('espn'), false);
    });
  }

  test('GDELT reste actif sur une affirmation politique', () => {
    assert.ok(routes('La défaite électorale de la majorité').has('gdelt'));
  });
});

describe('domaines spécialisés', () => {
  test('santé → Europe PMC', () => {
    assert.ok(routes('Un vaccin réduit le risque de cancer de 40%').has('europepmc'));
  });

  test('économie → Banque Mondiale', () => {
    assert.ok(routes('Le PIB de la France a augmenté de 2%').has('worldbank'));
  });

  test('géographie → Nominatim', () => {
    assert.ok(routes('La capitale du Brésil est Brasilia').has('nominatim'));
  });
});

describe('juridictions', () => {
  test('marqueurs européens → EUR-Lex', () => {
    assert.ok(routes('La directive européenne a été transposée').has('eurlex'));
  });

  test('acte notoire cité → EUR-Lex même sans autre marqueur', () => {
    assert.ok(routes('Le RGPD est entré en vigueur en 2018').has('eurlex'));
  });

  test('marqueurs américains → Federal Register', () => {
    assert.ok(routes('Trump signed an executive order on tariffs').has('fedreg'));
    assert.ok(routes('The EPA finalized a rule on emissions').has('fedreg'));
  });

  test('le Sénat français ne déclenche pas le registre américain', () => {
    assert.equal(routes('Le Sénat a voté la loi sur le climat').has('fedreg'), false);
    assert.equal(routes('L’Assemblée nationale a adopté le texte').has('fedreg'), false);
  });

  test('une directive européenne ne déclenche pas le registre américain', () => {
    assert.equal(routes('La directive européenne a été transposée').has('fedreg'), false);
  });
});

describe('pas de capteur juridique hors sujet', () => {
  const NEUTRES = [
    'Le chômage a baissé de deux points',
    'Une explosion a fait trois blessés à Monaco',
    'Il a eu un accident hier soir',
  ];

  for (const claim of NEUTRES) {
    test(`« ${claim} » n’active aucun capteur légal`, () => {
      const s = routes(claim);
      assert.equal(s.has('eurlex'), false);
      assert.equal(s.has('fedreg'), false);
    });
  }
});
