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

describe('détection du discours — garde-fous', () => {
  test('la fonctionnalité est désactivée par défaut côté background', () => {
    assert.match(serviceWorker, /let DISCOURSE_ENABLED = false/,
      'le drapeau doit valoir false par défaut');
  });

  test('la consigne n’est envoyée au modèle que si le drapeau est actif', () => {
    const fn = serviceWorker.match(/function discourseInstruction\(\)[\s\S]*?\n}/);
    assert.ok(fn, 'discourseInstruction introuvable');
    assert.match(fn[0], /if \(!DISCOURSE_ENABLED\) return ''/,
      'la consigne doit être vide quand la détection est désactivée');
  });

  test('aucun appel LLM supplémentaire : la consigne rejoint le prompt existant', () => {
    assert.match(serviceWorker, /\$\{languageInstruction\(\)\}\$\{discourseInstruction\(\)\}/,
      'la consigne de discours doit être ajoutée au prompt rapide existant');
  });

  test('le flux temps réel ne fait que deux appels LLM par fenêtre', () => {
    // La revue de session est un troisième appel, mais à la demande : il doit
    // vivre dans runSessionReview, jamais dans le pipeline d'analyse.
    const review = serviceWorker.match(/async function runSessionReview[\s\S]*?\n}/);
    assert.ok(review, 'runSessionReview introuvable');

    const liveCalls = (serviceWorker.replace(review[0], '').match(/await callLLM\(/g) || []).length;
    assert.equal(liveCalls, 2, `attendu 2 appels LLM en direct (rapide + sourcé), trouvé ${liveCalls}`);
    assert.equal((review[0].match(/await callLLM\(/g) || []).length, 1,
      'la revue doit tenir en un seul appel');
  });

  test('la séparation précède la normalisation des verdicts', () => {
    const iSplit = serviceWorker.indexOf('splitDiscourseItems(parsed.results)');
    const iNorm  = serviceWorker.indexOf('normalizeVerdictResults(split.claims)');
    assert.ok(iSplit > 0 && iNorm > iSplit,
      'les énoncés de discours doivent être écartés avant toute normalisation de verdict');
  });

  test('le discours ne passe pas par la vérification sourcée', () => {
    const ground = serviceWorker.match(/async function groundAndUpdate[\s\S]*?\n}/);
    assert.ok(ground, 'groundAndUpdate introuvable');
    assert.doesNotMatch(ground[0], /PREDICTION|COMMITMENT|discourse/i,
      'la vérification sourcée ne doit jamais traiter un énoncé de discours');
  });

  test('le prompt interdit explicitement de juger ces énoncés', () => {
    assert.match(serviceWorker, /NEVER give them a verdict/i);
  });
});

describe('revue de session — garde-fous', () => {
  test('la revue ne se déclenche qu’à la demande', () => {
    assert.match(serviceWorker, /case 'REVIEW_SESSION'/);
    // Aucun appel automatique depuis le pipeline d'analyse ni à l'arrêt.
    const stop = serviceWorker.match(/function stopFactCheck[\s\S]*?\n}/);
    assert.ok(stop);
    assert.doesNotMatch(stop[0], /runSessionReview/,
      'la revue ne doit pas partir automatiquement à l’arrêt de session');
  });

  test('elle s’appuie sur le condensé d’événements, pas sur le transcript brut', () => {
    const review = serviceWorker.match(/async function runSessionReview[\s\S]*?\n}/);
    assert.match(review[0], /buildReviewDigest/);
    assert.doesNotMatch(review[0], /contextText|sentenceWindow/,
      'la revue ne doit pas consommer le transcript brut');
  });

  test('les constats sont filtrés avant d’être renvoyés', () => {
    const review = serviceWorker.match(/async function runSessionReview[\s\S]*?\n}/);
    assert.match(review[0], /validateReviewFindings/,
      'les constats non étayés doivent être écartés côté code, pas laissés au modèle');
  });

  test('le prompt impose neutralité et citation exacte', () => {
    assert.match(serviceWorker, /NEUTRALITY/i);
    assert.match(serviceWorker, /Never infer intent/i);
    assert.match(serviceWorker, /PRECISION OVER RECALL/i);
    assert.match(serviceWorker, /verbatim/i);
  });

  test('le prompt n’autorise que les trois procédés retenus', () => {
    assert.match(serviceWorker, /FALSE_DILEMMA \| WHATABOUTISM \| AD_HOMINEM/);
  });
});

describe('langue de sortie — pièges connus', () => {
  test('la revue utilise sa propre consigne de langue', () => {
    const review = serviceWorker.match(/async function runSessionReview[\s\S]*?\n}/);
    assert.match(review[0], /reviewLanguageInstruction\(\)/,
      'la consigne des verdicts nomme des champs absents du schéma de revue');
    assert.doesNotMatch(review[0], /[^w]languageInstruction\(\)/,
      'la revue ne doit pas réutiliser la consigne des verdicts');
  });

  test('la consigne de revue nomme les champs qui existent vraiment', () => {
    const fn = serviceWorker.match(/function reviewLanguageInstruction[\s\S]*?\n}/);
    assert.ok(fn, 'reviewLanguageInstruction introuvable');
    for (const field of ['summary', 'patterns', 'criterion', 'unresolved']) {
      assert.match(fn[0], new RegExp(field), `champ ${field} absent de la consigne`);
    }
  });

  test('les citations ne doivent jamais être traduites', () => {
    const fn = serviceWorker.match(/function reviewLanguageInstruction[\s\S]*?\n}/);
    assert.match(fn[0], /never translate/i,
      'traduire une citation la rendrait introuvable dans le transcript');
  });
});

describe('corroboration — base de calcul du garde-fou', () => {
  test('le garde-fou s’appuie sur les sources réellement citées', () => {
    const ground = serviceWorker.match(/async function groundAndUpdate[\s\S]*?\n}\n/);
    assert.ok(ground);
    assert.match(ground[0], /const citedItems[\s\S]{0,200}computeCorroboration\(citedItems\)/,
      'sans recalcul sur les sources citées, une source affichée peut coexister avec « 0 voix »');
    assert.match(ground[0], /applyCorroborationGuard\(finalVerdict, match\.confidence, finalCorroboration\)/);
  });

  test('la corroboration renvoyée est celle qui a servi au garde-fou', () => {
    assert.match(serviceWorker, /corroboration: finalCorroboration/,
      'le rapport doit refléter la corroboration réellement appliquée');
  });
});

describe('reprise du panneau sans recharger la page', () => {
  test('un démarrage sur session active rattache au lieu de ne rien faire', () => {
    const start = serviceWorker.match(/async function startFactCheck[\s\S]*?\n}/);
    assert.ok(start, 'startFactCheck introuvable');
    assert.match(start[0], /if \(isCapturing\)[\s\S]{0,200}reattachPanel\(/,
      'un appel sur session active doit remonter le panneau');
  });

  test('le rattachement est atteignable depuis le popup', () => {
    assert.match(serviceWorker, /case 'REATTACH_PANEL'/);
    const popup = read('src', 'popup', 'popup.js');
    assert.match(popup, /REATTACH_PANEL/, 'le popup doit pouvoir demander la réouverture');
  });

  test('une seule implémentation partagée par le popup et le rechargement', () => {
    const calls = (serviceWorker.match(/reattachPanel\(/g) || []).length;
    assert.ok(calls >= 3, `attendu au moins 3 usages (définition + 2 appelants), trouvé ${calls}`);
    assert.equal((serviceWorker.match(/async function reattachPanel/g) || []).length, 1,
      'une seule définition attendue');
  });

  test('le rattachement échoue proprement hors session', () => {
    const fn = serviceWorker.match(/async function reattachPanel[\s\S]*?\n}/);
    assert.match(fn[0], /no-session/);
    assert.match(fn[0], /no-content-script/);
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
