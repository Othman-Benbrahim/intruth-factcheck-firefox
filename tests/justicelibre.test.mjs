// Capteur JusticeLibre — droit français consolidé.
//
// L'accès se fait en MCP (JSON-RPC sur HTTP) plutôt qu'en REST : ces tests
// portent sur les parties déterministes — routage, extraction de mots-clés,
// construction des liens Légifrance et lecture des réponses du protocole.
// Aucun appel réseau n'est effectué.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadServiceWorker, REPO_ROOT } from './helpers/load.mjs';

const sw = loadServiceWorker();

describe('routage vers le droit français', () => {
  const ACTIVE = [
    'La loi du 22 août 2021 sur le climat a été promulguée',
    'Le décret n° 2023-123 a été publié au Journal officiel',
    "L'Assemblée nationale a voté le projet de loi",
    'Cette disposition figure au code du travail',
    "L'article L. 1132-1 interdit toute discrimination",
    'Le Conseil constitutionnel a censuré cet amendement',
  ];
  for (const claim of ACTIVE) {
    test(`« ${claim.slice(0, 44)}… » → JusticeLibre`, () => {
      assert.equal(sw.routeSensors(claim).has('justicelibre'), true);
    });
  }

  test('une affirmation juridique européenne n’active pas le droit français', () => {
    assert.equal(sw.routeSensors('La directive européenne a été transposée').has('justicelibre'), false);
    assert.equal(sw.routeSensors('Le RGPD est entré en vigueur en 2018').has('justicelibre'), false);
  });

  test('une affirmation juridique américaine non plus', () => {
    assert.equal(sw.routeSensors('Congress passed the spending bill').has('justicelibre'), false);
    assert.equal(sw.routeSensors('Trump signed an executive order').has('justicelibre'), false);
  });

  test('une affirmation non juridique n’active aucun capteur légal', () => {
    for (const claim of ['Le chômage a baissé de deux points', "Le Paraguay a éliminé l'Allemagne"]) {
      const s = sw.routeSensors(claim);
      assert.equal(s.has('justicelibre'), false);
      assert.equal(s.has('eurlex'), false);
      assert.equal(s.has('fedreg'), false);
    }
  });
});

describe('préparation de la requête', () => {
  test('les mots vides et les mots courts sont écartés', () => {
    const terms = sw.frenchLawTerms('La loi du 22 août 2021 sur le climat et la résilience');
    assert.ok(terms.length > 0);
    assert.equal(terms.includes('dans'), false);
    assert.ok(terms.length <= 6, 'trop de termes envoyés');
  });

  test('rien d’exploitable → aucune requête', () => {
    assert.deepEqual(sw.frenchLawTerms('a de le'), []);
    assert.deepEqual(sw.frenchLawTerms(''), []);
  });
});

describe('liens Légifrance', () => {
  test('un article de code pointe vers /codes/', () => {
    assert.equal(
      sw.legifranceArticleUrl({ legiarti: 'LEGIARTI000006900846', titre_section: 'Code du travail' }),
      'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006900846');
  });

  test('une loi non codifiée pointe vers /loda/', () => {
    assert.equal(
      sw.legifranceArticleUrl({ legiarti: 'LEGIARTI000043956924', titre_section: 'Loi climat et résilience' }),
      'https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000043956924');
  });

  test('sans identifiant, on renvoie vers la racine plutôt qu’un lien mort', () => {
    assert.equal(sw.legifranceArticleUrl({}), 'https://www.legifrance.gouv.fr/');
    assert.equal(sw.legifranceArticleUrl(null), 'https://www.legifrance.gouv.fr/');
  });
});

describe('lecture des réponses MCP', () => {
  // Le serveur peut répondre en JSON simple ou en flux d'événements selon le
  // transport négocié : les deux doivent être compris.
  const fakeResponse = (contentType, body) => ({
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  });
  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    result: { structuredContent: { articles: [{ legiarti: 'LEGIARTI1', num: 'L.1132-1' }] } },
  });
  const article = (data) => data?.result?.structuredContent?.articles?.[0]?.legiarti;

  test('réponse JSON', async () => {
    assert.equal(article(await sw.readMcpBody(fakeResponse('application/json', payload))), 'LEGIARTI1');
  });

  test('flux d’événements', async () => {
    const body = `event: message\ndata: ${payload}\n\n`;
    assert.equal(article(await sw.readMcpBody(fakeResponse('text/event-stream', body))), 'LEGIARTI1');
  });

  test('flux à plusieurs blocs : le dernier exploitable est retenu', async () => {
    const body = `data: {"jsonrpc":"2.0"}\n\ndata: ${payload}\n\n`;
    assert.equal(article(await sw.readMcpBody(fakeResponse('text/event-stream', body))), 'LEGIARTI1');
  });

  test('le marqueur de fin de flux est ignoré', async () => {
    const body = `data: ${payload}\n\ndata: [DONE]\n\n`;
    assert.equal(article(await sw.readMcpBody(fakeResponse('text/event-stream', body))), 'LEGIARTI1');
  });

  test('une réponse illisible ne fait pas échouer le capteur', async () => {
    assert.equal(await sw.readMcpBody(fakeResponse('application/json', '')), null);
    assert.equal(await sw.readMcpBody(fakeResponse('application/json', '<html>erreur</html>')), null);
    assert.equal(await sw.readMcpBody(fakeResponse('text/event-stream', 'event: ping\n\n')), null);
  });
});

describe('intégration au pipeline', () => {
  const src = readFileSync(
    join(REPO_ROOT, 'realtime-factcheck', 'src', 'background', 'service-worker.js'), 'utf8');

  test('le capteur est branché sur la collecte des preuves', () => {
    const fn = src.match(/async function gatherEvidence[\s\S]*?\n}/);
    assert.match(fn[0], /fetchJusticeLibre\(/);
  });

  test('le texte de loi compte comme source primaire', () => {
    assert.ok(sw.CORRO_PRIMARY.has('justicelibre'));
    // Relayé par un tiers : crédible, mais sous les sources officielles directes.
    assert.ok(sw.SOURCE_CREDIBILITY.justicelibre < sw.SOURCE_CREDIBILITY.eurlex);
    assert.ok(sw.SOURCE_CREDIBILITY.justicelibre > sw.SOURCE_CREDIBILITY.wikipedia);
  });

  test('une défaillance du service ne remonte jamais d’erreur', () => {
    const fn = src.match(/async function fetchJusticeLibre[\s\S]*?\n}/);
    assert.match(fn[0], /catch/, 'le capteur doit absorber ses erreurs');
    assert.match(fn[0], /return \[\]/, 'et renvoyer une liste vide');
  });

  test('l’appel est borné dans le temps', () => {
    assert.match(src, /JUSTICELIBRE_TIMEOUT_MS/);
    const fn = src.match(/async function mcpRequest[\s\S]*?\n}/);
    assert.match(fn[0], /AbortController/);
  });

  test('la permission d’hôte est déclarée', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'realtime-factcheck', 'manifest.json'), 'utf8'));
    assert.ok(manifest.host_permissions.some(h => h.includes('justicelibre.org')));
  });
});
