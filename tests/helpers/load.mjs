// tests/helpers/load.mjs
//
// Charge les scripts de l'extension dans Node, sans navigateur.
//
// Pourquoi ce chargeur : service-worker.js et overlay.js sont des scripts
// classiques (pas des modules ES) — c'est voulu, l'extension n'a aucune étape
// de build. On ne peut donc pas les `import`.
//
// Méthode : on enveloppe le source dans une fonction dont les paramètres
// portent les API navigateur bouchonnées (elles masquent les globales), puis
// on l'évalue dans le realm courant avec `vm.runInThisContext`. La fonction
// renvoie les symboles à tester.
//
// Le realm courant est important : un `vm.createContext` créerait des
// intrinsèques distinctes (Array, Object…), et toute comparaison profonde
// échouerait sur le prototype. Ici, les valeurs renvoyées sont natives.
//
// Si un nom testé est renommé dans le code, le chargement échoue bruyamment —
// c'est le comportement voulu.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
const EXT = join(REPO_ROOT, 'realtime-factcheck');

// ── Bouchon d'API navigateur ────────────────────────────────────────────────
// Proxy récursif : n'importe quel chemin (browser.storage.local.get,
// runtime.onMessage.addListener…) est accessible et appelable, et renvoie une
// promesse résolue. Suffisant pour charger sans effet de bord.
function apiStub() {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;   // ne pas se faire passer pour une promesse
      if (prop === Symbol.toPrimitive) return () => 'stub';
      return apiStub();
    },
    apply() { return Promise.resolve({}); },
    construct() { return apiStub(); },
  });
}

const silent = () => {};
const quietConsole = { log: silent, warn: silent, error: silent, info: silent, debug: silent };

function fakeElement() {
  return {
    style: {}, dataset: {}, textContent: '', innerHTML: '', className: '',
    classList: { add: silent, remove: silent, toggle: silent, contains: () => false },
    appendChild: silent, insertBefore: silent, replaceWith: silent, remove: silent,
    addEventListener: silent, setAttribute: silent, insertAdjacentElement: silent,
    querySelector: () => null, querySelectorAll: () => [],
  };
}

const fakeDocument = {
  title: '',
  body: fakeElement(),
  createElement: fakeElement,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: silent,
};

/**
 * Évalue un script d'extension et renvoie les symboles demandés.
 * @param {string} file      chemin du script
 * @param {string} exportsJs expression JS construisant l'objet renvoyé
 * @param {object} extras    globales supplémentaires à masquer (document…)
 */
function evaluate(file, exportsJs, extras = {}) {
  const source = readFileSync(file, 'utf8');

  // Globales masquées par des paramètres de fonction.
  const stubs = {
    browser: apiStub(),
    chrome: apiStub(),
    console: quietConsole,
    fetch: () => Promise.reject(new Error('réseau désactivé dans les tests')),
    WebSocket: function () { return apiStub(); },
    AudioContext: function () { return apiStub(); },
    setInterval: () => 0,
    clearInterval: silent,
    ...extras,
  };
  const names = Object.keys(stubs);
  const values = names.map((n) => stubs[n]);

  const wrapper = `(function (${names.join(', ')}) {\n${source}\n;return ${exportsJs};\n})`;

  let factory;
  try {
    factory = vm.runInThisContext(wrapper, { filename: file });
  } catch (err) {
    throw new Error(`Syntaxe invalide dans ${file} : ${err.message}`);
  }

  let exported;
  try {
    exported = factory(...values);
  } catch (err) {
    throw new Error(
      `Chargement de ${file} impossible : ${err.message}\n` +
      `→ un nom testé a peut-être été renommé, ou une API navigateur manque au bouchon.`
    );
  }

  const missing = Object.keys(exported).filter((k) => exported[k] === undefined);
  if (missing.length) {
    throw new Error(`Symboles introuvables dans ${file} : ${missing.join(', ')}`);
  }
  return exported;
}

// ── Symboles exposés aux tests ──────────────────────────────────────────────

const SW_EXPORTS = `{
  registrableDomain, domainOfLink, wordShingles, jaccardSim,
  sourceCredibility, clusterEvidence, computeCorroboration,
  buildCorroborationContext, applyCorroborationGuard,
  SOURCE_CREDIBILITY, CORRO_PRIMARY,
  SENSOR_KEYWORDS, routeSensors, ESPN_LEAGUES,
  EU_MARKERS, EU_KNOWN_ACTS, matchEuKnownActs, buildEurLexSparql, eurLexLink,
  US_MARKERS, usLegalTerms, FEDREG_TYPES,
  resolveDismissivePronouns, getOpponentName, speakerConfidenceFromLexical,
  extractLexical, parseSpeakersFromTitle,
  relevanceFilterItems, selectCitedSources, dedupeByLink,
  isTopicallyRelevant, filterTitleMatchSensors, topicTokens, TITLE_MATCH_SENSORS,
  looksLikeTranscriptionNoise, normalizeSpeakerLabel, learnSpeakerMapping, matchKnownParticipant,
  normalizeVerdictItem, cleanPersonName, TITLE_NON_NAMES,
  normalizeClaimKey, languageInstruction, LANGUAGE_NAMES, LANGUAGE_LOCALE
}`;

// `settings` est un `let` de premier niveau : on expose un setter pour piloter
// le filtre d'affichage depuis les tests.
const OVERLAY_EXPORTS = `{
  timestampToSeconds, shouldShowVerdict, colorForVerdict,
  commitmentFromLexical, computeDissonance, parseSpeakersFromTitle,
  escapeHtml, DEFAULT_SETTINGS, shouldShowDiscourse, discourseLabel, DISCOURSE_LABELS,
  setSettings(o) { settings = Object.assign({}, DEFAULT_SETTINGS, o); }
}`;

const SESSION_EXPORTS = `{
  EVENT_TYPES, EVENT_STATUS, DISCOURSE_TYPES, MAX_EVENTS,
  discourseKindOf, discourseStatement, splitDiscourseItems, upsertDiscourseEvent,
  isUsableDiscourseStatement, FUTURE_MARKERS, COMMISSIVE_MARKERS,
  filterUsableDiscourseItems,
  makeEventId, claimFingerprint, claimSimilarity,
  createSession, endSession, isSessionActive,
  findClaimEvent, claimEventFromResult, upsertClaimEvent, setSessionSpeakers,
  sessionSummary, serializeSession, deserializeSession,
  buildReviewDigest, canReviewSession, validateReviewFindings, quoteIsGrounded,
  REVIEW_FALLACY_TYPES, REVIEW_MIN_EVENTS, REVIEW_MAX_EVENTS,
  saveSessionNow, loadStoredSession, clearStoredSession
}`;

/**
 * Magasin de session, avec un stockage en mémoire contrôlable.
 * Chaque appel renvoie une instance neuve : les tests de persistance doivent
 * partir d'un état propre.
 */
export function loadSessionStore() {
  const backing = new Map();
  const storage = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (backing.has(k)) out[k] = backing.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) backing.set(k, v); },
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) backing.delete(k); },
  };
  const api = { storage: { local: storage } };
  const store = evaluate(
    join(EXT, 'src', 'background', 'session-store.js'),
    SESSION_EXPORTS,
    { browser: api, chrome: api }
  );
  return { ...store, __storage: backing };
}

let swCache = null;
let overlayCache = null;

/** Fonctions pures du service worker. */
export function loadServiceWorker() {
  if (!swCache) {
    swCache = evaluate(join(EXT, 'src', 'background', 'service-worker.js'), SW_EXPORTS);
  }
  return swCache;
}

/** Fonctions pures de l'overlay (content script). */
export function loadOverlay() {
  if (!overlayCache) {
    overlayCache = evaluate(
      join(EXT, 'src', 'content', 'overlay.js'),
      OVERLAY_EXPORTS,
      { document: fakeDocument, window: {}, location: { href: '' } }
    );
  }
  return overlayCache;
}
