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
  CLAIM:      'CLAIM',       // affirmation factuelle → vérifiable
  PREDICTION: 'PREDICTION',  // énoncé sur l'avenir → non vérifiable aujourd'hui
  COMMITMENT: 'COMMITMENT',  // promesse ou engagement du locuteur
});

// Types de discours : consignés, jamais jugés. Aucun verdict ne leur est
// attribué — une prédiction n'est ni vraie ni fausse au moment où elle est
// prononcée, et un engagement encore moins.
const DISCOURSE_TYPES = Object.freeze([EVENT_TYPES.PREDICTION, EVENT_TYPES.COMMITMENT]);

const EVENT_STATUS = Object.freeze({
  PENDING:  'pending',   // vérification en cours
  RESOLVED: 'resolved',  // verdict sourcé rendu
  RECORDED: 'recorded',  // consigné sans jugement (types de discours)
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

// ── Types de discours ───────────────────────────────────────────────────────

/** Reconnaît un item de discours dans la réponse brute du modèle. */
function discourseKindOf(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = String(item.kind || item.event_type || item.discourse_type || '').trim().toUpperCase();
  return DISCOURSE_TYPES.includes(raw) ? raw : null;
}

/** Énoncé porté par un item de discours, quel que soit le nom du champ. */
function discourseStatement(item) {
  return String(item.statement || item.text || item.claim || item.content || '').trim();
}

/**
 * Sépare les items de discours des affirmations factuelles.
 * Appelé AVANT toute normalisation de verdict : sans quoi une prédiction
 * serait traitée comme une affirmation et recevrait un verdict.
 */
function splitDiscourseItems(rawResults) {
  const claims = [];
  const discourse = [];
  for (const item of (Array.isArray(rawResults) ? rawResults : [])) {
    const kind = discourseKindOf(item);
    if (!kind) { claims.push(item); continue; }
    const statement = discourseStatement(item);
    if (!statement) continue;               // item de discours vide : ignoré
    discourse.push({
      kind,
      statement,
      speaker: item.speaker || null,
      horizon: item.horizon || item.deadline || null,
    });
  }
  return { claims, discourse };
}

// ── Recevabilité d'un énoncé de discours ────────────────────────────────────
// Le modèle étiquette volontiers en PREDICTION un propos au passé, et en
// COMMITMENT une simple conduite de débat (« je voudrais continuer »). Sur un
// rapport réel, deux énoncés sur quinze étaient exploitables. On vérifie donc
// la forme avant de consigner : ces contrôles sont déterministes.

// Le futur est marqué : périphrase (« va poser »), futur simple (« seront »),
// ou repère temporel explicite.
// Le futur simple est reconnu APRÈS un sujet : sans cette ancre, « les patrons »
// ou « environs » passeraient pour des verbes au futur.
const FUTURE_MARKERS = /\b(?:vais|vas|va|allons|allez|vont)\s+\p{L}{3,}|\b(?:je|tu|il|elle|on|nous|vous|ils|elles|qui)\s+(?:\p{L}+\s+){0,2}\p{L}{2,}(?:rai|ras|ra|rons|rez|ront)(?![\p{L}])|\b(?:sera|seront|serai|serez|serons|aura|auront|aurai|aurez|aurons)\b|\b(?:demain|bient[oô]t|prochaine?s?|d['’]ici|dor[ée]navant|[àa] l['’]avenir)\b|\bwill\b|\bgoing to\b/iu;

// Un engagement suppose que le locuteur se lie lui-même.
const COMMISSIVE_MARKERS = /\b(?:je|nous|on)\s+(?:vais|vas|allons|va)\s+\p{L}{3,}|\bje\s+m['’]engage\b|\bnous\s+nous\s+engageons\b|\bje\s+promets\b|\b(?:je|nous)\s+\p{L}{2,}(?:rai|rons)\b|\b(?:i|we)\s+will\b/iu;

// Verbes de conduite du débat : « je voudrais continuer » n'engage à rien.
const DEBATE_MANAGEMENT = /\b(?:continuer|poursuivre|r[ée]pondre|d[ée]battre|parler|dire|ajouter|terminer|finir|revenir|pr[ée]ciser|expliquer|commencer|interrompre)\b/i;

// Le modèle décrit le propos au lieu de le citer.
const META_REPORT = /^[A-ZÀ-Þ][\p{L}'’-]*\s+(?:affirme|d[ée]clare|dit|explique|soutient|pr[ée]tend|estime|ajoute|indique|annonce|says?|claims?|states?)\b/u;

// Bégaiement ou reprise : « Je, je, si vous voulez… ».
// « \b » de JavaScript ignore les lettres accentuées : « La laïcité » était pris
// pour une répétition de « la ». D'où la sentinelle Unicode explicite.
const STUTTER = /^(\p{L}{1,6})[,\s]+\1(?![\p{L}])/iu;

/**
 * Un énoncé de discours est-il exploitable ?
 * @param {string} kind        PREDICTION ou COMMITMENT
 * @param {string} statement   énoncé transcrit
 * @param {function} isNoise   détecteur de bruit de transcription (injecté :
 *                             il vit dans le service worker)
 */
function isUsableDiscourseStatement(kind, statement, isNoise) {
  const t = String(statement || '').trim();
  if (!t) return false;
  if (typeof isNoise === 'function' && isNoise(t)) return false;
  if (STUTTER.test(t)) return false;
  if (META_REPORT.test(t)) return false;

  const words = t.split(/\s+/).filter(Boolean).length;
  if (words < 5) return false;                 // trop bref pour porter un engagement

  if (kind === EVENT_TYPES.PREDICTION) {
    // Sans marque de futur, l'énoncé parle du passé ou du présent.
    return FUTURE_MARKERS.test(t);
  }

  if (kind === EVENT_TYPES.COMMITMENT) {
    if (!COMMISSIVE_MARKERS.test(t)) return false;
    // Un engagement qui ne porte que sur le déroulement de l'échange n'en est pas un.
    if (words < 9 && DEBATE_MANAGEMENT.test(t)) return false;
    return true;
  }

  return false;
}

/** Ne garde que les énoncés exploitables, en nettoyant l'étiquette de diarisation. */
function filterUsableDiscourseItems(items, isNoise) {
  return (Array.isArray(items) ? items : []).filter(it => {
    if (!it) return false;
    const statement = String(it.statement || '').replace(/^\[[^\]]{1,40}\]\s*/, '').trim();
    return isUsableDiscourseStatement(it.kind, statement, isNoise);
  });
}

function discourseEventFromItem(session, item) {
  const now = Date.now();
  return {
    id:        makeEventId(item.kind),
    type:      item.kind,
    createdAt: now,
    updatedAt: now,
    offsetMs:  session ? Math.max(0, now - session.startedAt) : 0,
    text:      item.statement,
    fingerprint: claimFingerprint(item.statement),
    status:    EVENT_STATUS.RECORDED,
    speaker:   item.speaker || null,
    speakerId: (item.speakerId !== undefined && item.speakerId !== null) ? String(item.speakerId) : null,
    horizon:   item.horizon || null,
    // Volontairement absents : verdict, confidence, sources.
  };
}

/** Consigne un énoncé de discours, sans doublon. */
function upsertDiscourseEvent(session, item) {
  if (!session || !item || !item.kind || !item.statement) return null;
  if (!DISCOURSE_TYPES.includes(item.kind)) return null;

  const fingerprint = claimFingerprint(item.statement);
  let existing = session.events.find(e => e.type === item.kind && e.fingerprint === fingerprint);
  if (!existing) {
    // « Je voudrais continuer » et « Maintenant je voudrais continuer » sont le
    // même énoncé : la reprise est fréquente à l'oral.
    existing = session.events.find(e =>
      e.type === item.kind && claimSimilarity(item.statement, e.text) >= 0.6);
  }
  if (existing) {
    existing.updatedAt = Date.now();
    if (item.speaker && !existing.speaker) existing.speaker = item.speaker;
    if (item.horizon && !existing.horizon) existing.horizon = item.horizon;
    return existing;
  }

  const fresh = discourseEventFromItem(session, item);
  session.events.push(fresh);
  if (session.events.length > MAX_EVENTS) {
    session.events.splice(0, session.events.length - MAX_EVENTS);
  }
  return fresh;
}

// ── Lecture / synthèse ──────────────────────────────────────────────────────

function sessionSummary(session) {
  const empty = {
    total: 0, resolved: 0, pending: 0, durationMs: 0, discourse: 0,
    byVerdict: {}, bySpeaker: {}, byDiscourse: {},
  };
  if (!session) return empty;

  const claims = session.events.filter(e => e.type === EVENT_TYPES.CLAIM);
  const discourse = session.events.filter(e => DISCOURSE_TYPES.includes(e.type));
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

  const byDiscourse = {};
  for (const e of discourse) byDiscourse[e.type] = (byDiscourse[e.type] || 0) + 1;

  return {
    total:      claims.length,
    resolved,
    pending:    claims.length - resolved,
    discourse:  discourse.length,
    byDiscourse,
    durationMs: (session.endedAt || Date.now()) - session.startedAt,
    byVerdict,
    bySpeaker,
  };
}

// ── Revue de session ────────────────────────────────────────────────────────
// La revue s'appuie sur la LISTE DES ÉVÉNEMENTS, jamais sur le transcript brut :
// un débat de deux heures dépasserait la fenêtre de contexte, et coûterait cher
// pour un gain nul — l'essentiel a déjà été extrait pendant la session.

const REVIEW_MIN_EVENTS = 3;      // en-deçà, une revue n'a rien à dire
const REVIEW_MAX_EVENTS = 120;    // borne de contexte et de coût

/** Horodatage lisible à partir d'un décalage en millisecondes. */
function formatOffset(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

/**
 * Condensé transmis au modèle pour la revue.
 * Renvoie aussi `texts` : les énoncés réellement prononcés, qui serviront à
 * valider les citations produites par le modèle.
 */
function buildReviewDigest(session, cap) {
  const limit = typeof cap === 'number' ? cap : REVIEW_MAX_EVENTS;
  const empty = { lines: [], texts: [], counts: { claims: 0, discourse: 0, unresolved: 0 }, truncated: false };
  if (!session || !Array.isArray(session.events) || !session.events.length) return empty;

  const ordered = session.events.slice().sort((a, b) => (a.offsetMs || 0) - (b.offsetMs || 0));
  const truncated = ordered.length > limit;
  const kept = truncated ? ordered.slice(-limit) : ordered;   // on garde les plus récents

  const lines = [];
  const texts = [];
  const counts = { claims: 0, discourse: 0, unresolved: 0 };

  kept.forEach((e, i) => {
    const who = e.speaker || 'Inconnu';
    const when = formatOffset(e.offsetMs);
    const text = String(e.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    texts.push(text);

    if (e.type === EVENT_TYPES.CLAIM) {
      counts.claims++;
      if (e.status !== EVENT_STATUS.RESOLVED) counts.unresolved++;
      const verdict = e.verdict || 'NON VÉRIFIÉ';
      lines.push(`#${i + 1} [${verdict}] ${when} ${who} : "${text}"`);
    } else if (DISCOURSE_TYPES.includes(e.type)) {
      counts.discourse++;
      const horizon = e.horizon ? ` (échéance : ${e.horizon})` : '';
      lines.push(`#${i + 1} [${e.type}] ${when} ${who} : "${text}"${horizon}`);
    }
  });

  return { lines, texts, counts, truncated };
}

function canReviewSession(session) {
  if (!session || !Array.isArray(session.events)) return false;
  return session.events.length >= REVIEW_MIN_EVENTS;
}

// ── Validation des constats de la revue ─────────────────────────────────────
// Precision > recall : un constat n'est retenu que s'il est vérifiable.
// Le modèle doit citer un extrait RÉELLEMENT prononcé et nommer le critère
// structurel qui fonde le constat. Sans les deux, le constat est écarté.

const REVIEW_FALLACY_TYPES = Object.freeze([
  'FALSE_DILEMMA',   // deux options présentées comme seules possibles
  'WHATABOUTISM',    // réponse à une critique par une contre-accusation
  'AD_HOMINEM',      // attaque de la personne au lieu de l'argument
]);

const REVIEW_QUOTE_MIN_OVERLAP = 0.8;
const REVIEW_CRITERION_MIN_LENGTH = 15;

function normalizeForQuote(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** L'extrait cité correspond-il à un énoncé réellement prononcé ? */
function quoteIsGrounded(quote, texts) {
  const q = normalizeForQuote(quote);
  if (q.length < 10) return false;
  const normalized = (texts || []).map(normalizeForQuote);
  if (normalized.some(t => t.includes(q))) return true;
  // tolérance à une reformulation mineure
  const qWords = new Set(q.split(' ').filter(w => w.length > 2));
  if (!qWords.size) return false;
  return normalized.some(t => {
    const tWords = new Set(t.split(' ').filter(w => w.length > 2));
    if (!tWords.size) return false;
    let common = 0;
    for (const w of qWords) if (tWords.has(w)) common++;
    return common / qWords.size >= REVIEW_QUOTE_MIN_OVERLAP;
  });
}

/**
 * Filtre les constats du modèle. Retourne les constats retenus et le décompte
 * des constats écartés, avec leur motif — utile pour ajuster le prompt.
 */
function validateReviewFindings(rawFindings, texts) {
  const kept = [];
  const rejected = { unknownType: 0, ungroundedQuote: 0, missingCriterion: 0 };

  for (const f of (Array.isArray(rawFindings) ? rawFindings : [])) {
    if (!f || typeof f !== 'object') { rejected.unknownType++; continue; }

    const type = String(f.type || f.kind || '').trim().toUpperCase();
    if (!REVIEW_FALLACY_TYPES.includes(type)) { rejected.unknownType++; continue; }

    const criterion = String(f.criterion || f.reason || '').trim();
    if (criterion.length < REVIEW_CRITERION_MIN_LENGTH) { rejected.missingCriterion++; continue; }

    const quote = String(f.quote || f.excerpt || '').trim();
    if (!quoteIsGrounded(quote, texts)) { rejected.ungroundedQuote++; continue; }

    kept.push({ type, quote, criterion, speaker: f.speaker || null });
  }

  return { findings: kept, rejected };
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
