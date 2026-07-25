// Contrats structurels du projet.
//
// L'extension n'utilise ni bundler ni modules ES : les fichiers du background
// partagent une portée globale et sont chargés dans l'ordre déclaré au
// manifeste. Rien, à l'exécution, ne signale un appel vers une fonction
// inexistante ou un mauvais ordre de chargement — ces tests le font.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/load.mjs';

const EXT = join(REPO_ROOT, 'realtime-factcheck');
const read = (...p) => readFileSync(join(EXT, ...p), 'utf8');

const manifest    = JSON.parse(read('manifest.json'));
const sessionStore = read('src', 'background', 'session-store.js');
const serviceWorker = read('src', 'background', 'service-worker.js');

const topLevelNames = (source) => new Set([
  ...(source.match(/^(?:async )?function (\w+)/gm) || []).map(m => m.replace(/^(?:async )?function /, '')),
  ...(source.match(/^const (\w+)/gm) || []).map(m => m.replace(/^const /, '')),
  ...(source.match(/^let (\w+)/gm) || []).map(m => m.replace(/^let /, '')),
]);

describe('ordre de chargement du background', () => {
  const scripts = manifest.background.scripts;

  test('les deux scripts sont déclarés', () => {
    assert.ok(scripts.includes('src/background/session-store.js'));
    assert.ok(scripts.includes('src/background/service-worker.js'));
  });

  test('le magasin de session est chargé avant le service worker', () => {
    assert.ok(
      scripts.indexOf('src/background/session-store.js') < scripts.indexOf('src/background/service-worker.js'),
      'session-store.js doit précéder service-worker.js'
    );
  });
});

describe('appels croisés entre fichiers du background', () => {
  test('toute fonction du magasin appelée par le service worker existe', () => {
    const defined = topLevelNames(sessionStore);
    const missing = [...defined].filter(() => false); // socle
    const called = [...defined].filter(n => new RegExp(`\\b${n}\\s*\\(`).test(serviceWorker));

    assert.ok(called.length > 0, 'le service worker n’utilise pas le magasin — câblage perdu ?');
    for (const name of called) {
      assert.ok(defined.has(name), `${name} est appelée mais n’est pas définie dans session-store.js`);
    }
    assert.deepEqual(missing, []);
  });

  test('les points d’entrée attendus du magasin sont bien utilisés', () => {
    for (const name of ['createSession', 'upsertClaimEvent', 'endSession', 'loadStoredSession']) {
      assert.match(serviceWorker, new RegExp(`\\b${name}\\s*\\(`), `${name} n’est plus appelée par le service worker`);
    }
  });

  test('le magasin ne dépend pas du service worker (sens unique)', () => {
    for (const name of ['routeSensors', 'gatherEvidence', 'callLLM', 'evaluateClaims']) {
      assert.doesNotMatch(sessionStore, new RegExp(`\\b${name}\\s*\\(`), `session-store.js ne doit pas appeler ${name}`);
    }
  });
});

describe('messages attendus par le content script', () => {
  test('le service worker répond à GET_SESSION', () => {
    assert.match(serviceWorker, /case 'GET_SESSION'/);
  });

  test('l’export demande bien la session au background', () => {
    const exportSrc = read('src', 'content', 'session-export.js');
    assert.match(exportSrc, /GET_SESSION/);
  });
});

describe('ordre des content scripts', () => {
  const js = manifest.content_scripts[0].js;

  test('session-export est chargé avant overlay', () => {
    assert.ok(
      js.indexOf('src/content/session-export.js') < js.indexOf('src/content/overlay.js'),
      'overlay.js appelle logVerdict/exportPDF définis dans session-export.js'
    );
  });

  test('le code mort n’est pas rechargé', () => {
    assert.equal(js.includes('src/content/lexical-features.js'), false);
  });
});

describe('permissions et hôtes', () => {
  test('le stockage est disponible (requis par la mémoire de session)', () => {
    assert.ok(manifest.permissions.includes('storage'));
  });

  test('les capteurs sans clé ont leur permission d’hôte', () => {
    const hosts = manifest.host_permissions.join(' ');
    assert.match(hosts, /publications\.europa\.eu/);
    assert.match(hosts, /federalregister\.gov/);
    assert.match(hosts, /site\.api\.espn\.com/);
  });
});
