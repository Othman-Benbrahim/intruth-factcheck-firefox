// session-store.js
//
// Mémoire de session : modèle d'événements typés, identifiants stables,
// persistance dans storage.local.
//
// Pourquoi ce fichier existe :
//   - avant, l'historique vivait dans un tableau du content script. Une
//     navigation ou un rechargement de page le détruisait, et l'export était
//     perdu ;
//   - l'event page Firefox peut être suspendue : tout état purement en mémoire
//     dans le background disparaît avec elle.
// Le magasin devient donc la source de vérité, côté background, et il survit
// aux deux situations.
//
// Chargé AVANT service-worker.js (voir background.scripts du manifeste) :
// scripts classiques, portée globale partagée, aucune étape de build.

// ── Modèle d'événement ──────────────────────────────────────────────────────
// Un seul type en Phase 1. Le modèle est volontairement générique pour
// accueillir les types de discours ultérieurs sans migration de données.
const EVENT_TYPES = Object.freeze({
  CLAIM: 'CLAIM',
});

const EVENT_STATUS = Object.freeze({
  PENDING:  'pending',   // vérification en cours
  RESOLVED: 'resolved',  // verdict sourcé rendu
});

// Plafond de sécurité : au-delà, on ne perd pas les événements récents mais on
// cesse d'empiler indéfiniment (débat de plusieurs heures, quota de stockage).
const MAX_EVENTS = 600;

const SESSION_STORAGE_KEY = 'intruthSession';
const SESSION_SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 3000;

// ── Identifiants et empreintes ──────────────────────────────────────────────

let eventCounter = 0;

/** Identifiant d'événement stable et lisible. */
function makeEventId(type) {
  eventCounter += 1;
  const stamp = Date.now().toString(36);
  return `${String(type || 'EVT').toLowerCase()}_${stamp}_${eventCounter}`;
}

/** Mots significatifs d'un énoncé, pour comparer deux formulations. */
function fingerprintTokens(text) {
  return (String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]{4,}/g) || []);
}

/**
 * Empreinte d'une affirmation : mots significatifs triés et dédupliqués.
 * Deux formulations équivalentes donnent la même empreinte.
 */
function claimFingerprint(text) {
  return [...new Set(fingerprintTokens(text))].sort().join(' ');
}

/** Proximité de deux énoncés, entre 0 et 1 (recouvrement de vocabulaire). */
function claimSimilarity(a, b) {
  const setA = new Set(fingerprintTokens(a));
  const setB = new Set(fingerprintTokens(b));
  if (!setA.size || !setB.size) return 0;
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  return common / Math.max(setA.size, setB.size);
}

// ── Création et cycle de vie ────────────────────────────────────────────────

function createSession(source) {
  const now = Date.now();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id:        `ses_${now.toString(36)}`,
    startedAt: now,
    endedAt:   null,
    source: {
      title: (source && source.title) || '',
      date:  (source && source.date)  || '',
      url:   (source && source.url)   || '',
    },
    speakers: {},   // { speakerId: nom confirmé }
    events:   [],
  };
}

function endSession(session) {
  if (!session) return null;
  session.endedAt = Date.now();
  return session;
}

function isSessionActive(session) {
  return Boolean(session && !session.endedAt);
}

// ── Écriture d'événements ───────────────────────────────────────────────────

/** Retrouve l'événement correspondant à un énoncé : empreinte exacte, puis proximité. */
function findClaimEvent(session, text, threshold) {
  if (!session || !session.events.length) return null;
  const target = claimFingerprint(text);
  if (target) {
    const exact = session.events.find(e => e.type === EVENT_TYPES.CLAIM && e.fingerprint === target);
    if (exact) return exact;
  }
  // Le second passage peut reformuler légèrement l'affirmation : on tolère.
  const min = typeof threshold === 'number' ? threshold : 0.4;
  let best = null;
  let bestScore = 0;
  for (const e of session.events) {
    if (e.type !== EVENT_TYPES.CLAIM) continue;
    const score = claimSimilarity(text, e.text);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= min ? best : null;
}

/** Construit un événement d'affirmation à partir d'un résultat du pipeline. */
function claimEventFromResult(session, result) {
  const now = Date.now();
  return {
    id:        makeEventId(EVENT_TYPES.CLAIM),
    type:      EVENT_TYPES.CLAIM,
    createdAt: now,
    updatedAt: now,
    offsetMs:  session ? Math.max(0, now - session.startedAt) : 0,
    text:      result.claim || '',
    fingerprint: claimFingerprint(result.claim),
    status:    result.pending ? EVENT_STATUS.PENDING : EVENT_STATUS.RESOLVED,
    speaker:   result.speaker || null,
    speakerId: (result.dominantSpeakerId !== undefined && result.dominantSpeakerId !== null)
      ? String(result.dominantSpeakerId) : null,
    verdict:           result.verdict || null,
    confidence:        result.confidence ?? null,
    explanation:       result.explanation || '',
    sources:           Array.isArray(result.sources) ? result.sources.slice(0, 6) : [],
    corroboration:     result.corroboration || null,
    speakerConfidence: result.speaker_confidence || null,
    lexical:           result.lexical || null,
    mediaTimestamp:    result._timestamp || null,
  };
}

/**
 * Insère ou met à jour un événement d'affirmation.
 * Le passage rapide crée l'événement, le passage sourcé le complète — sans
 * jamais le dupliquer, même si le modèle a reformulé l'énoncé.
 */
function upsertClaimEvent(session, result) {
  if (!session || !result || !result.claim) return null;

  const existing = findClaimEvent(session, result.claim);
  const fresh = claimEventFromResult(session, result);

  if (!existing) {
    session.events.push(fresh);
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    return fresh;
  }

  // Un résultat en attente ne doit jamais écraser un verdict déjà sourcé.
  if (result.pending && existing.status === EVENT_STATUS.RESOLVED) return existing;

  existing.updatedAt = Date.now();
  existing.status    = fresh.status;
  existing.text      = fresh.text || existing.text;
  existing.fingerprint = fresh.fingerprint || existing.fingerprint;
  // Champs enrichis par le passage sourcé : on ne remplace que si renseignés.
  if (fresh.verdict)            existing.verdict = fresh.verdict;
  if (fresh.confidence !== null) existing.confidence = fresh.confidence;
  if (fresh.explanation)        existing.explanation = fresh.explanation;
  if (fresh.sources.length)     existing.sources = fresh.sources;
  if (fresh.corroboration)      existing.corroboration = fresh.corroboration;
  if (fresh.speakerConfidence)  existing.speakerConfidence = fresh.speakerConfidence;
  if (fresh.lexical)            existing.lexical = fresh.lexical;
  if (fresh.speaker)            existing.speaker = fresh.speaker;
  if (fresh.speakerId !== null) existing.speakerId = fresh.speakerId;
  if (fresh.mediaTimestamp)     existing.mediaTimestamp = fresh.mediaTimestamp;
  return existing;
}

/** Enregistre les noms de locuteurs confirmés par l'utilisateur. */
function setSessionSpeakers(session, speakerIdToName) {
  if (!session || !speakerIdToName) return;
  for (const [id, name] of Object.entries(speakerIdToName)) {
    if (name) session.speakers[String(id)] = name;
  }
  // Rétro-attribution : les événements déjà enregistrés récupèrent le nom.
  for (const e of session.events) {
    if (e.speakerId !== null && !e.speaker && session.speakers[e.speakerId]) {
      e.speaker = session.speakers[e.speakerId];
    }
  }
}

// ── Lecture / synthèse ──────────────────────────────────────────────────────

function sessionSummary(session) {
  const empty = {
    total: 0, resolved: 0, pending: 0, durationMs: 0,
    byVerdict: {}, bySpeaker: {},
  };
  if (!session) return empty;

  const claims = session.events.filter(e => e.type === EVENT_TYPES.CLAIM);
  const byVerdict = {};
  const bySpeaker = {};
  let resolved = 0;

  for (const e of claims) {
    if (e.status === EVENT_STATUS.RESOLVED) resolved++;
    const v = e.verdict || 'UNKNOWN';
    byVerdict[v] = (byVerdict[v] || 0) + 1;
    const s = e.speaker || 'Inconnu';
    bySpeaker[s] = (bySpeaker[s] || 0) + 1;
  }

  return {
    total:      claims.length,
    resolved,
    pending:    claims.length - resolved,
    durationMs: (session.endedAt || Date.now()) - session.startedAt,
    byVerdict,
    bySpeaker,
  };
}

// ── Persistance ─────────────────────────────────────────────────────────────

/** Copie transmissible / stockable (aucune référence vive). */
function serializeSession(session) {
  if (!session) return null;
  return JSON.parse(JSON.stringify(session));
}

/** Relit une session stockée en écartant les formes inattendues. */
function deserializeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.events) || !raw.startedAt) return null;
  if (raw.schemaVersion !== SESSION_SCHEMA_VERSION) return null;  // schéma ancien : ignoré
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id:        raw.id || `ses_${Number(raw.startedAt).toString(36)}`,
    startedAt: raw.startedAt,
    endedAt:   raw.endedAt || null,
    source:    raw.source || { title: '', date: '', url: '' },
    speakers:  raw.speakers || {},
    events:    raw.events.filter(e => e && e.id && e.type),
  };
}

let saveTimer = null;

function sessionStorageApi() {
  const api = (typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null));
  return api && api.storage && api.storage.local ? api.storage.local : null;
}

/** Écriture différée : on n'écrit pas à chaque événement. */
function scheduleSessionSave(session) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveSessionNow(session); }, SAVE_DEBOUNCE_MS);
}

async function saveSessionNow(session) {
  const store = sessionStorageApi();
  if (!store || !session) return false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    await store.set({ [SESSION_STORAGE_KEY]: serializeSession(session) });
    return true;
  } catch (err) {
    console.error('[session] écriture impossible :', err && err.message);
    return false;
  }
}

async function loadStoredSession() {
  const store = sessionStorageApi();
  if (!store) return null;
  try {
    const data = await store.get([SESSION_STORAGE_KEY]);
    return deserializeSession(data && data[SESSION_STORAGE_KEY]);
  } catch (err) {
    console.error('[session] lecture impossible :', err && err.message);
    return null;
  }
}

async function clearStoredSession() {
  const store = sessionStorageApi();
  if (!store) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    await store.remove([SESSION_STORAGE_KEY]);
  } catch (err) {
    console.error('[session] suppression impossible :', err && err.message);
  }
}
