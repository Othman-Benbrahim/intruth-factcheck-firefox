// service-worker.js  (Firefox — background event page)
// La capture audio est déléguée au content script (src/content/capture.js) via
// getUserMedia, parce que Firefox n'expose ni tabCapture ni l'audio de
// getDisplayMedia. Ce script reçoit des fragments audio (AUDIO_CHUNK), les pousse
// vers Deepgram (WebSocket), puis fait tourner le pipeline d'analyse inchangé
// (Claude + Serper) et renvoie les verdicts à l'overlay.
//
// Note : ce background est agnostique de la SOURCE audio. Si un jour Firefox
// supporte l'audio de getDisplayMedia, seul capture.js changerait.

// ── Polyfill namespace : browser.* (Firefox) ou chrome.* (fallback) ───────────
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// ── Configuration LLM (Anthropic OU endpoint compatible OpenAI / LM Studio) ────
let LLM_PROVIDER = 'anthropic';   // 'anthropic' | 'openai'
let LLM_API_KEY  = '';            // clé du fournisseur actif (peut être vide pour LM Studio local)
let LLM_ENDPOINT = '';            // base URL compatible OpenAI, ex. http://localhost:1234/v1
let LLM_MODEL    = '';            // identifiant du modèle
let LLM_REASONING = false;        // true si modèle "reasoning" (o-series, R1…)
let DEEPGRAM_KEY = '';
let SEARCH_PROVIDER = 'exa';   // recherche web enfichable : 'exa' | 'tavily' | 'serper' | 'none'
let EXA_KEY      = '';
let TAVILY_KEY   = '';
let SERPER_KEY   = '';
let FACTCHECK_KEY = '';           // clé Google Fact Check Tools (facultative, BYOK)

const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// ── État Deepgram ─────────────────────────────────────────────────────────────
let deepgramSocket  = null;
let utteranceBuffer = '';
let audioFlowing    = false;   // true tant que le content script envoie de l'audio


// ── État pipeline / LLM ──────────────────────────────────────────────────────
// Cet état est volontairement stocké côté service-worker, car la popup peut
// s'ouvrir APRÈS l'erreur. Sans cela, GET_STATUS ne peut pas dire que l'IA est HS.
let pipelineHealthy  = true;
let llmHealthy       = true;
let lastPipelineError = null;

// Diagnostic léger : permet de savoir si l'analyse est appelée, si le LLM répond,
// et où le pipeline se coupe, sans bloquer définitivement la session.
let lastAnalysisDebug = null;
let lastLLMWarning = null;
let analysisAttemptCount = 0;
let llmFailureCount = 0;

const LLM_MAX_RETRIES = 2;
const LLM_RETRY_BASE_DELAY_MS = 700;

// Réglages anti-troncature : on force le LLM à répondre court et on découpe
// la fenêtre de transcript en mini-lots pour éviter les JSON incomplets.
const LLM_ANALYSIS_MAX_TOKENS = 1400;
// Les modèles "reasoning" consomment beaucoup de tokens en réflexion avant de
// produire leur réponse : budget de sortie nettement plus large pour éviter
// une réponse vide / tronquée.
const LLM_REASONING_MAX_TOKENS = 6000;
const LLM_REASONING_VALIDATION_TOKENS = 2048;
const LLM_MAX_CLAIMS_PER_BATCH = 3;
const LLM_BATCH_CHAR_LIMIT = 900;
const LLM_MAX_BATCHES_PER_WINDOW = 4;

const PIPELINE_ERROR_STORAGE_KEYS = [
  'rtfcLastPipelineError',
  'rtfcLastPipelineErrorAt',
  'rtfcLastPipelineErrorSource',
];

function maybeCatch(promiseLike) {
  if (promiseLike && typeof promiseLike.catch === 'function') promiseLike.catch(() => {});
}

function persistPipelineError(errorInfo) {
  try {
    maybeCatch(browserAPI.storage.local.set({
      rtfcLastPipelineError: errorInfo.message,
      rtfcLastPipelineErrorAt: errorInfo.at,
      rtfcLastPipelineErrorSource: errorInfo.source,
    }));
  } catch (_) {}
}

function clearStoredPipelineError() {
  try { maybeCatch(browserAPI.storage.local.remove(PIPELINE_ERROR_STORAGE_KEYS)); }
  catch (_) {}
}

function sendToActiveTab(payload) {
  if (!activeTabId) return;
  try { maybeCatch(browserAPI.tabs.sendMessage(activeTabId, payload)); }
  catch (_) {}
}

function broadcastRuntime(payload) {
  // Utile si la popup est ouverte. Le storage.local sert aussi de secours.
  try { maybeCatch(browserAPI.runtime.sendMessage({ ...payload, origin: 'service-worker' })); }
  catch (_) {}
}

function setAnalysisDebug(stage, details = {}) {
  // Debug UI désactivé pour la version propre.
  // On conserve seulement le dernier état en mémoire pour GET_STATUS / diagnostic éventuel,
  // mais on n'envoie plus de PIPELINE_DEBUG à l'overlay ni à la popup.
  lastAnalysisDebug = {
    stage,
    at: Date.now(),
    ...details,
  };
}


let lastDeepgramDebugAt = 0;
let lastDeepgramDebugSignature = '';

function setDeepgramSignalDebug(stage, details = {}) {
  const now = Date.now();
  const signature = [
    stage,
    details.is_final,
    details.speech_final,
    details.textPreview,
    details.utteranceBufferChars,
    details.sentenceWindowSize,
    details.sentenceCount,
  ].join('|');

  // Les signaux interim peuvent arriver très vite : on les limite pour éviter
  // de saturer l'overlay. Les signaux finaux et speech_final passent toujours.
  const isImportant =
    stage !== 'deepgram_interim' ||
    details.is_final === true ||
    details.speech_final === true;

  if (!isImportant && signature === lastDeepgramDebugSignature && now - lastDeepgramDebugAt < 900) {
    return;
  }

  if (!isImportant && now - lastDeepgramDebugAt < 900) {
    return;
  }

  lastDeepgramDebugAt = now;
  lastDeepgramDebugSignature = signature;
  setAnalysisDebug(stage, details);
}

function notifyPipelineError(message, source = 'pipeline', options = {}) {
  const fatal = options.fatal !== false;
  const cleanMessage = String(message || 'Erreur pipeline inconnue.').trim() || 'Erreur pipeline inconnue.';
  const errorInfo = {
    message: cleanMessage,
    source,
    fatal,
    at: Date.now(),
  };

  if (fatal) {
    pipelineHealthy = false;
    if (source === 'llm') llmHealthy = false;
    lastPipelineError = errorInfo;
    persistPipelineError(errorInfo);
  } else {
    // Non fatal : on garde l'avertissement pour diagnostic, mais on ne bloque pas
    // la session ni le bouton Start.
    if (source === 'llm' || source === 'pipeline') lastLLMWarning = errorInfo;
  }

  const payload = {
    type: 'PIPELINE_ERROR',
    message: cleanMessage,
    source,
    fatal,
    at: errorInfo.at,
    pipelineError: cleanMessage,
    lastPipelineError: errorInfo,
  };

  sendToActiveTab(payload);
  broadcastRuntime(payload);
}

function clearPipelineError(reason = 'pipeline') {
  pipelineHealthy = true;
  llmHealthy = true;
  lastPipelineError = null;
  lastLLMWarning = null;
  clearStoredPipelineError();

  const payload = {
    type: 'PIPELINE_RECOVERED',
    reason,
    pipelineHealthy,
    llmHealthy,
    iaFunctional: true,
    at: Date.now(),
  };
  sendToActiveTab(payload);
  broadcastRuntime(payload);
}

function markLLMSuccess() {
  llmHealthy = true;
  if (lastPipelineError?.source === 'llm') clearPipelineError('llm');
}

function buildStatusResponse() {
  const pipelineError = lastPipelineError?.message || null;
  return {
    isCapturing,
    audioFlowing,
    pipelineHealthy,
    llmHealthy,
    iaFunctional: pipelineHealthy && llmHealthy && !pipelineError,
    aiFunctional: pipelineHealthy && llmHealthy && !pipelineError,
    pipelineError,
    error: pipelineError,
    lastPipelineError,
    lastLLMWarning,
    lastAnalysisDebug,
    analysisAttemptCount,
    llmFailureCount,
  };
}



// ── Validation pré-lancement des clés API ────────────────────────────────────

function buildConfigFromMessage(config = {}) {
  return {
    provider: (config.llmProvider || config.provider || LLM_PROVIDER || 'anthropic').trim(),
    endpoint: (config.llmEndpoint || config.endpoint || LLM_ENDPOINT || '').trim(),
    model:    (config.llmModel    || config.model    || LLM_MODEL    || '').trim(),
    apiKey:   (config.llmApiKey   || config.apiKey   || LLM_API_KEY  || '').trim(),
    deepgramKey: (config.deepgramKey || DEEPGRAM_KEY || '').trim(),
    reasoning: (config.llmReasoning === true || config.reasoning === true),
  };
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage || 'Délai dépassé.')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchJsonForValidation(url, options, timeoutMs = 9000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { ...options, signal: controller?.signal });
    let data = null;
    try { data = await res.json(); }
    catch (_) { data = null; }
    return { res, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function validateAnthropicKey(config) {
  if (!config.apiKey) {
    return { ok: false, source: 'llm', message: 'Clé Anthropic absente.' };
  }

  try {
    const { res, data } = await fetchJsonForValidation('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_ANTHROPIC_MODEL,
        max_tokens: 160,
        temperature: 0,
        system: 'Return a short plain text answer.',
        messages: [{
          role: 'user',
          content: 'Health check. Reply with OK.',
        }],
      }),
    });

    if (!res.ok || data?.error) {
      const apiMessage = extractAPIErrorMessage(data) || ('HTTP ' + res.status);
      return { ok: false, source: 'llm', message: 'Anthropic invalide : HTTP ' + res.status + ' — ' + apiMessage };
    }

    const extracted = extractAnthropicContent(data);
    if (!extracted.content) {
      return {
        ok: false,
        source: 'llm',
        message: 'Anthropic joignable, mais contenu texte introuvable. Format détecté : ' + describeLLMShape(data),
      };
    }

    return {
      ok: true,
      source: 'llm',
      message: 'Clé Anthropic valide. Réponse lue via ' + extracted.path + '.',
    };
  } catch (err) {
    const suffix = err?.name === 'AbortError' ? 'délai dépassé' : err.message;
    return { ok: false, source: 'llm', message: 'Anthropic injoignable : ' + suffix };
  }
}


async function validateOpenAICompatibleKey(config) {
  if (!config.endpoint) {
    return { ok: false, source: 'llm', message: 'Endpoint LLM absent.' };
  }
  if (!config.model) {
    return { ok: false, source: 'llm', message: 'Modèle LLM absent.' };
  }

  try {
    const url = buildOpenAIChatCompletionsUrl(config.endpoint);
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;

    const { res, data } = await fetchJsonForValidation(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildOpenAIBody(
        config.model,
        'Return a short plain text answer.',
        'Health check. Reply with OK.',
        config.reasoning ? LLM_REASONING_VALIDATION_TOKENS : 160,
        config.reasoning
      )),
    });

    if (!res.ok || data?.error) {
      const apiMessage = extractAPIErrorMessage(data) || ('HTTP ' + res.status);
      return {
        ok: false,
        source: 'llm',
        message: 'Endpoint LLM invalide : HTTP ' + res.status + ' — ' + apiMessage,
      };
    }

    const extracted = extractOpenAICompatibleContent(data);
    const content = extracted.content;
    if (!content) {
      return {
        ok: false,
        source: 'llm',
        message:
          'Endpoint LLM joignable, mais contenu texte introuvable. Format détecté : ' +
          describeLLMShape(data),
      };
    }

    return {
      ok: true,
      source: 'llm',
      message: 'Endpoint LLM valide. Réponse lue via ' + extracted.path + '.',
    };
  } catch (err) {
    const suffix = err?.name === 'AbortError' ? 'délai dépassé' : err.message;
    return { ok: false, source: 'llm', message: 'Endpoint LLM injoignable : ' + suffix };
  }
}


async function validateDeepgramKey(deepgramKey) {
  if (!deepgramKey) {
    return { ok: false, source: 'deepgram', message: 'Clé Deepgram absente.' };
  }

  const deepgramParams = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    model: 'nova-3',
    language: 'multi',
  });

  return withTimeout(new Promise((resolve) => {
    let opened = false;
    let done = false;
    let socket = null;

    function finish(result) {
      if (done) return;
      done = true;
      try {
        if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, 'validation complete');
      } catch (_) {}
      resolve(result);
    }

    try {
      socket = new WebSocket(
        `wss://api.deepgram.com/v1/listen?${deepgramParams.toString()}`,
        ['token', deepgramKey]
      );

      socket.onopen = () => {
        opened = true;
        finish({ ok: true, source: 'deepgram', message: 'Clé Deepgram valide.' });
      };

      socket.onerror = () => {
        finish({ ok: false, source: 'deepgram', message: 'Deepgram injoignable ou clé refusée.' });
      };

      socket.onclose = (event) => {
        if (opened || done) return;
        const reason = event?.reason ? ' — ' + event.reason : '';
        finish({ ok: false, source: 'deepgram', message: 'Deepgram invalide ou refusé (code ' + event.code + ')' + reason + '.' });
      };
    } catch (err) {
      finish({ ok: false, source: 'deepgram', message: 'Deepgram impossible à tester : ' + err.message });
    }
  }), 7000, 'Deepgram : délai de validation dépassé.').catch((err) => ({
    ok: false,
    source: 'deepgram',
    message: err.message,
  }));
}

async function validateKeysBeforeStart(configFromPopup = {}) {
  const config = buildConfigFromMessage(configFromPopup);

  const llmPromise = config.provider === 'openai'
    ? validateOpenAICompatibleKey(config)
    : validateAnthropicKey(config);
  const deepgramPromise = validateDeepgramKey(config.deepgramKey);

  const [llm, deepgram] = await Promise.all([llmPromise, deepgramPromise]);
  const checks = { llm, deepgram };
  const errors = [llm, deepgram].filter(r => !r.ok).map(r => r.message);
  const warnings = [llm, deepgram].filter(r => r.ok && r.warning).map(r => r.message);
  const ok = errors.length === 0;

  if (ok) {
    return {
      ok: true,
      message: warnings.length
        ? 'Clés valides. Avertissement : ' + warnings.join(' | ')
        : 'Clés valides : LLM et Deepgram opérationnels.',
      warnings,
      checks,
      checkedAt: Date.now(),
    };
  }

  return {
    ok: false,
    message: errors.join(' | '),
    warnings,
    checks,
    checkedAt: Date.now(),
  };
}

async function loadKeys() {
  // browser.storage renvoie une Promise sous Firefox (pas de callback).
  const local = await browserAPI.storage.local.get([
    'deepgramKey', 'llmProvider', 'llmApiKey', 'llmEndpoint', 'llmModel', 'llmReasoning', 'anthropicKey', 'factCheckKey',
    'searchProvider', 'exaKey', 'tavilyKey', 'serperKey',
  ]);
  // Si la mémorisation est désactivée, les clés sont en storage.session
  // (mémoire de session, non écrite sur le disque). On lit les deux, la
  // session étant prioritaire pour les valeurs secrètes.
  let session = {};
  try {
    session = await browserAPI.storage.session.get(['deepgramKey', 'llmApiKey', 'llmEndpoint', 'llmModel', 'factCheckKey', 'exaKey', 'tavilyKey', 'serperKey']);
  } catch (_) { session = {}; }
  const pick = (k) => (session && session[k] !== undefined && session[k] !== '') ? session[k] : local[k];

  DEEPGRAM_KEY  = pick('deepgramKey') || '';
  FACTCHECK_KEY = (pick('factCheckKey') || '').trim();
  LLM_PROVIDER  = local.llmProvider || 'anthropic';
  LLM_ENDPOINT  = (pick('llmEndpoint') || '').trim();
  LLM_MODEL     = (pick('llmModel')    || '').trim();
  LLM_REASONING = local.llmReasoning === true;
  // rétro-compatibilité : si une ancienne clé Anthropic existe, on la réutilise
  LLM_API_KEY   = (pick('llmApiKey') || local.anthropicKey || '').trim();
  SEARCH_PROVIDER = local.searchProvider || 'exa';
  EXA_KEY    = (pick('exaKey')    || '').trim();
  TAVILY_KEY = (pick('tavilyKey') || '').trim();
  SERPER_KEY = (pick('serperKey') || '').trim();
}

const EVALUATE_PROMPT = `
You are a bilingual real-time fact-checking assistant.
The transcript may be in English, French, or a mix of both.

Return ONLY valid JSON.
No Markdown. No code fences. No comments. No text before or after JSON.

Important anti-truncation rules:
- Return at most ${LLM_MAX_CLAIMS_PER_BATCH} factual claims per response.
- Prioritize the most checkable, verifiable claims.
- Keep all fields short.
- If there is no clear factual claim, return [].
- Do not include long quotes from the transcript.
- Do not create multiple objects unless explicitly unavoidable.

Return a JSON array using exactly this compact shape:
[
  {
    "claim": "short original factual claim",
    "claim_fr": "short French version",
    "claim_en": "short English version",
    "verdict": "TRUE | SUBSTANTIALLY TRUE | FALSE | MISLEADING | UNVERIFIABLE",
    "speaker": "identified speaker name or Unknown",
    "explanation": "one short sentence",
    "confidence": 0.0,
    "used_sources": []
  }
]

Rules:
- Understand French and English directly.
- Ignore opinions, jokes, filler, greetings, vague claims, and claims that cannot be checked.
- Evaluate claims as they were made at the time of the recording when a date is provided.
- "used_sources": when numbered sources are provided in the user message, list ONLY the numbers of the sources that directly support your verdict; exclude off-topic or unused ones. If no sources are provided or none are relevant, return [].
`;

// ── Speaker parsing (mirrors overlay.js) ─────────────────────────────────────

function parseSpeakersFromTitle(title) {
  if (!title) return [];
  const roleMatch = title.match(/(\d+)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:vs?\.?|versus)\s+(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/i);
  if (roleMatch) {
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    return [cap(roleMatch[2]), cap(roleMatch[4])];
  }
  const nameMatch = title.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:and|vs\.?|versus|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) {
    const clean = name => name.trim().split(' ').pop();
    return [clean(nameMatch[1]), clean(nameMatch[2])];
  }
  return [];
}

// ── Serper ────────────────────────────────────────────────────────────────────

const BLOCKED_DOMAINS = [
  'reddit.com', 'facebook.com', 'twitter.com', 'x.com',
  'tiktok.com', 'instagram.com', 'pinterest.com', 'quora.com',
  'yelp.com', 'tripadvisor.com', 'youtube.com',
  'democrats.org', 'republicans.org', 'gop.com', 'dnc.org',
  'afscme.org', 'ntu.org', 'americanprogress.org', 'heritage.org',
  'breitbart.com', 'dailykos.com', 'mediamatters.org', 'newsmax.com',
  'thefederalist.com', 'motherjones.com', 'nationalreview.com',
  'democrats-appropriations.house.gov', 'waysandmeans.house.gov',
  'bostonkravmaga.com',
];

// Chaque source renvoie une liste d'objets de preuve homogènes :
//   { source: 'web'|'wikipedia'|'factcheck', title, snippet, link }
// Le snippet contient le texte de preuve effectivement lu par le LLM.

// ── Galaxie Open Data : capteurs thématiques gratuits ────────────────────────
// Chaque capteur renvoie une liste d'objets de preuve homogènes :
//   { source, title, snippet, link }
// Le snippet contient le texte de preuve effectivement lu par le LLM.
// Aucune de ces sources ne donne le verdict : elles fournissent le contexte,
// le LLM pèse les témoignages.

// Adresse de courtoisie pour les "polite pools" (OpenAlex, Crossref, Nominatim).
// À personnaliser : certains serveurs universitaires l'exigent.
const CONTACT_EMAIL = 'intruth@othmanbenbrahim.dev';

// ── Web (Serper) ──────────────────────────────────────────────────────────────

// ── Recherche web enfichable (Exa / Tavily / Serper, BYOK) ───────────────────
// Tous renvoient la même forme { source:'web', title, snippet, link } : transparent
// pour le reste du pipeline (crédibilité, citations, corroboration, dissonance).

async function searchWeb(query, retries = 2) {
  if (SEARCH_PROVIDER === 'exa'    && EXA_KEY)    return searchExa(query);
  if (SEARCH_PROVIDER === 'tavily' && TAVILY_KEY) return searchTavily(query);
  if (SEARCH_PROVIDER === 'serper' && SERPER_KEY) return searchSerper(query, retries);
  // repli : n'importe quelle clé présente (ordre Exa > Tavily > Serper)
  if (EXA_KEY)    return searchExa(query);
  if (TAVILY_KEY) return searchTavily(query);
  if (SERPER_KEY) return searchSerper(query, retries);
  return [];
}

// Exa — recherche neuronale (en-tête x-api-key). type 'auto' = toujours dispo ;
// passer à 'fast' (~450 ms) ou 'instant' (~250 ms) pour réduire la latence.
const EXA_SEARCH_TYPE = 'auto';
async function searchExa(query) {
  try {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': EXA_KEY },
      body: JSON.stringify({
        query,
        type: EXA_SEARCH_TYPE,
        numResults: 6,
        contents: { highlights: true, text: { maxCharacters: 600 } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    return (data.results ?? [])
      .map(r => {
        const hi = Array.isArray(r.highlights) ? r.highlights.join(' ') : '';
        const body = hi || (typeof r.text === 'string' ? r.text : '');
        return {
          source:  'web',
          title:   (r.title || '').trim(),
          snippet: (body || '').replace(/\s+/g, ' ').trim().slice(0, 600),
          link:    r.url || '',
        };
      })
      .filter(r => r.link && !BLOCKED_DOMAINS.some(d => r.link.includes(d)))
      .slice(0, 4);
  } catch (err) {
    console.error('[exa] error:', err);
    return [];
  }
}

// Tavily — recherche orientée LLM (clé dans le corps, comme dans au-crible).
async function searchTavily(query) {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        max_results: 6,
        search_depth: 'basic',
        include_answer: false,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return (data.results ?? [])
      .map(r => ({
        source:  'web',
        title:   (r.title || '').trim(),
        snippet: (r.content || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        link:    r.url || '',
      }))
      .filter(r => r.link && !BLOCKED_DOMAINS.some(d => r.link.includes(d)))
      .slice(0, 4);
  } catch (err) {
    console.error('[tavily] error:', err);
    return [];
  }
}

async function searchSerper(query, retries = 2) {
  if (!SERPER_KEY) return []; // pas de clé Serper → on s'appuie sur les autres capteurs
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_KEY },
      body: JSON.stringify({ q: query, num: 6 }),
    });
    const data = await res.json();
    return (data.organic ?? [])
      .filter(r => r.link && !BLOCKED_DOMAINS.some(d => r.link.includes(d)))
      .slice(0, 4)
      .map(r => ({
        source:  'web',
        title:   (r.title || '').trim(),
        snippet: (r.snippet || '').replace(/\s+/g, ' ').trim(),
        link:    r.link,
      }));
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      return searchSerper(query, retries - 1);
    }
    console.error('[serper] error:', err);
    return [];
  }
}

// ── Wikipédia / MediaWiki (sans clé) ─────────────────────────────────────────

async function fetchWikipedia(query, lang) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      generator: 'search', gsrsearch: query, gsrlimit: '2',
      prop: 'extracts', exintro: '1', explaintext: '1', exchars: '600',
    }).toString();
    const res = await fetch(url);
    const data = await res.json();
    const pages = data?.query?.pages;
    if (!pages) return [];
    return Object.values(pages)
      .filter(p => p && p.extract)
      .map(p => ({
        source:  'wikipedia',
        title:   `Wikipédia (${lang}) — ${p.title}`,
        snippet: p.extract.replace(/\s+/g, ' ').trim().slice(0, 600),
        link:    `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, '_'))}`,
      }));
  } catch (err) {
    console.error('[wikipedia] error:', err);
    return [];
  }
}

async function searchWikipedia(query) {
  const groups = await Promise.all([
    fetchWikipedia(query, 'en'),
    fetchWikipedia(query, 'fr'),
  ]);
  return groups.flat();
}

// ── Wikidata (sans clé) — recherche d'entité + description ────────────────────
// Version légère : libellé + description de l'entité la mieux appariée.
// (Les requêtes SPARQL d'ontologie brute restent un chantier à part.)

async function fetchWikidata(query) {
  try {
    const url = 'https://www.wikidata.org/w/api.php?' + new URLSearchParams({
      action: 'wbsearchentities', search: query, language: 'fr', uselang: 'fr',
      format: 'json', origin: '*', limit: '1', type: 'item',
    }).toString();
    const res = await fetch(url);
    const data = await res.json();
    const ent = (data.search ?? [])[0];
    if (!ent) return [];
    return [{
      source:  'wikidata',
      title:   `Wikidata — ${ent.label || ent.id}`,
      snippet: ent.description ? `${ent.description}.` : `Entité ${ent.id}.`,
      link:    `https://www.wikidata.org/wiki/${ent.id}`,
    }];
  } catch (err) {
    console.error('[wikidata] error:', err);
    return [];
  }
}

// ── GDELT — événements et actualité mondiale (sans clé) ───────────────────────

// ── ESPN — résultats sportifs (sans clé, endpoints non officiels) ────────────
// Précision priorisée : on ne renvoie un match que si une équipe citée dans
// l'affirmation y figure (sinon rien — mieux vaut aucune source qu'une mauvaise).
// Couvre les grandes ligues US + grands championnats de foot. Utilise la date de
// la page quand elle est connue.

const ESPN_LEAGUES = [
  { re: /\b(nba|basket)\b/i,                            path: 'basketball/nba' },
  { re: /\b(wnba)\b/i,                                  path: 'basketball/wnba' },
  { re: /\b(nfl|super ?bowl|touchdown|quarterback)\b/i, path: 'football/nfl' },
  { re: /\b(mlb|home run)\b/i,                          path: 'baseball/mlb' },
  { re: /\b(nhl)\b/i,                                   path: 'hockey/nhl' },
  { re: /\b(mls)\b/i,                                   path: 'soccer/usa.1' },
  { re: /\b(premier league|chelsea|arsenal|liverpool|tottenham|manchester|man city|man united)\b/i, path: 'soccer/eng.1' },
  { re: /\b(la liga|real madrid|barcel\w*|atl[ée]tico|s[ée]ville|sevilla)\b/i, path: 'soccer/esp.1' },
  { re: /\b(ligue 1|psg|paris saint|marseille|monaco|lyon|lille|rennes|nice)\b/i, path: 'soccer/fra.1' },
  { re: /\b(bundesliga|bayern|dortmund|leipzig|leverkusen)\b/i, path: 'soccer/ger.1' },
  { re: /\b(serie a|juventus|\bjuve\b|milan|inter|naples|napoli|roma)\b/i, path: 'soccer/ita.1' },
  { re: /\b(champions league|ligue des champions)\b/i, path: 'soccer/uefa.champions' },
];

function espnDateParam() {
  if (!pageDate) return '';
  const d = new Date(pageDate);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function fetchEspn(query) {
  const leagues = ESPN_LEAGUES.filter(l => l.re.test(query)).slice(0, 2);
  if (!leagues.length) return [];
  const dateParam = espnDateParam();
  const claimWords = new Set((query.toLowerCase().match(/[\p{L}\d]{3,}/gu)) || []);
  const out = [];
  for (const lg of leagues) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${lg.path}/scoreboard` +
        (dateParam ? `?dates=${dateParam}` : '');
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      for (const ev of (data.events || [])) {
        const comp = (ev.competitions && ev.competitions[0]) || {};
        const cs = comp.competitors || [];
        if (cs.length < 2) continue;
        const teamsText = cs.map(c => `${c.team && c.team.displayName || ''} ${c.team && c.team.shortDisplayName || ''} ${c.team && c.team.abbreviation || ''}`).join(' ').toLowerCase();
        if (![...claimWords].some(w => teamsText.includes(w))) continue; // précision : équipe citée requise
        const score  = cs.map(c => `${c.team && (c.team.displayName || c.team.name) || '?'} ${c.score != null ? c.score : ''}`.trim()).join(' — ');
        const status = (ev.status && ev.status.type && (ev.status.type.description || ev.status.type.shortDetail)) || '';
        out.push({
          source:  'espn',
          title:   `ESPN — ${ev.shortName || ev.name || 'match'}`,
          snippet: `${score} · ${status}${ev.date ? ' · ' + String(ev.date).slice(0, 10) : ''}`.replace(/\s+/g, ' ').trim(),
          link:    (ev.links && ev.links[0] && ev.links[0].href) || url,
        });
      }
    } catch (err) {
      console.error('[espn] error:', err);
    }
  }
  return out.slice(0, 4);
}

async function fetchGdelt(query) {
  try {
    const url = 'https://api.gdeltproject.org/api/v2/doc/doc?' + new URLSearchParams({
      query, mode: 'artlist', format: 'json', maxrecords: '3', sort: 'hybridrel',
    }).toString();
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    return (data.articles ?? []).slice(0, 3).map(a => ({
      source:  'gdelt',
      title:   (a.title || '').trim(),
      snippet: `${a.domain || ''}${a.seendate ? ' · ' + a.seendate : ''}`.trim(),
      link:    a.url,
    })).filter(i => i.link);
  } catch (err) {
    console.error('[gdelt] error:', err);
    return [];
  }
}

// ── Nominatim / OpenStreetMap — vérification spatiale (sans clé) ──────────────
// Politique stricte : on s'identifie via le paramètre email (mécanisme officiel,
// car l'en-tête User-Agent n'est pas modifiable depuis un fetch navigateur),
// on limite à 1 résultat et on s'appuie fortement sur le cache.

async function fetchNominatim(query) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q: query, format: 'jsonv2', limit: '1', email: CONTACT_EMAIL,
    }).toString();
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json().catch(() => []);
    return (Array.isArray(data) ? data : []).slice(0, 1).map(p => ({
      source:  'nominatim',
      title:   `Lieu — ${p.display_name || query}`,
      snippet: `Type : ${p.type || p.category || 'n/d'}. Coordonnées : ${p.lat}, ${p.lon}.`,
      link:    `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=12/${p.lat}/${p.lon}`,
    }));
  } catch (err) {
    console.error('[nominatim] error:', err);
    return [];
  }
}

// ── Europe PMC (PubMed) — consensus médical (sans clé) ────────────────────────

async function fetchEuropePmc(query) {
  try {
    const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?' + new URLSearchParams({
      query, format: 'json', pageSize: '3', resultType: 'lite',
    }).toString();
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    const list = data?.resultList?.result ?? [];
    return list.slice(0, 3).map(r => ({
      source:  'europepmc',
      title:   (r.title || '').trim(),
      snippet: `${r.authorString || ''}${r.journalTitle ? ' — ' + r.journalTitle : ''}${r.pubYear ? ' (' + r.pubYear + ')' : ''}. Cité ${r.citedByCount ?? 0} fois.`.replace(/\s+/g, ' ').trim(),
      link:    r.doi ? `https://doi.org/${r.doi}` : (r.pmid ? `https://europepmc.org/article/MED/${r.pmid}` : ''),
    })).filter(i => i.link);
  } catch (err) {
    console.error('[europepmc] error:', err);
    return [];
  }
}

// ── OpenAlex — recherche académique (sans clé, polite pool via mailto) ────────

function reconstructAbstract(inv) {
  if (!inv) return '';
  const words = [];
  for (const [w, positions] of Object.entries(inv)) {
    for (const p of positions) words[p] = w;
  }
  return words.filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 400);
}

async function fetchOpenAlex(query) {
  try {
    const url = 'https://api.openalex.org/works?' + new URLSearchParams({
      search: query, per_page: '3', mailto: CONTACT_EMAIL,
    }).toString();
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    return (data.results ?? []).slice(0, 3).map(w => {
      const abs = reconstructAbstract(w.abstract_inverted_index);
      return {
        source:  'openalex',
        title:   (w.display_name || '').trim(),
        snippet: `${w.publication_year || ''} · cité ${w.cited_by_count ?? 0} fois.${abs ? ' ' + abs : ''}`.trim(),
        link:    w.doi || w.id || '',
      };
    }).filter(i => i.link);
  } catch (err) {
    console.error('[openalex] error:', err);
    return [];
  }
}

// ── Crossref — intégrité scientifique (sans clé, détecte les rétractations) ───

async function fetchCrossref(query) {
  try {
    const url = 'https://api.crossref.org/works?' + new URLSearchParams({
      query, rows: '3',
      select: 'title,DOI,issued,container-title,update-to,is-referenced-by-count',
      mailto: CONTACT_EMAIL,
    }).toString();
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    const items = data?.message?.items ?? [];
    return items.slice(0, 3).map(it => {
      const title = (it.title && it.title[0]) ? it.title[0] : '';
      const year  = it.issued?.['date-parts']?.[0]?.[0] || '';
      const venue = (it['container-title'] && it['container-title'][0]) || '';
      const retracted = Array.isArray(it['update-to']) &&
        it['update-to'].some(u => /retract/i.test((u.type || '') + ' ' + (u.label || '')));
      const flag = retracted ? ' ⚠️ ARTICLE RÉTRACTÉ' : '';
      return {
        source:  'crossref',
        title:   String(title).trim(),
        snippet: `${venue}${year ? ' (' + year + ')' : ''} · cité ${it['is-referenced-by-count'] ?? 0} fois.${flag}`.trim(),
        link:    it.DOI ? `https://doi.org/${it.DOI}` : '',
      };
    }).filter(i => i.link);
  } catch (err) {
    console.error('[crossref] error:', err);
    return [];
  }
}

// ── Banque Mondiale — chiffres officiels d'États (sans clé) ───────────────────
// Paramétrique (pays + indicateur + année) : on mappe quelques pays et
// indicateurs courants depuis le texte de l'affirmation.

const WB_COUNTRY_ISO = {
  'france': 'FR', 'états-unis': 'US', 'etats-unis': 'US', 'usa': 'US', 'united states': 'US', 'america': 'US',
  'chine': 'CN', 'china': 'CN', 'allemagne': 'DE', 'germany': 'DE', 'royaume-uni': 'GB', 'uk': 'GB', 'united kingdom': 'GB',
  'espagne': 'ES', 'spain': 'ES', 'italie': 'IT', 'italy': 'IT', 'japon': 'JP', 'japan': 'JP', 'canada': 'CA',
  'inde': 'IN', 'india': 'IN', 'brésil': 'BR', 'bresil': 'BR', 'brazil': 'BR', 'russie': 'RU', 'russia': 'RU',
  'mexique': 'MX', 'mexico': 'MX',
};

const WB_INDICATORS = [
  { re: /\binflation\b/i,                           code: 'FP.CPI.TOTL.ZG',   label: 'Inflation (prix à la consommation, % annuel)' },
  { re: /\b(ch[ôo]mage|unemployment)\b/i,           code: 'SL.UEM.TOTL.ZS',   label: 'Chômage (% population active)' },
  { re: /\b(croissance|gdp growth)\b/i,             code: 'NY.GDP.MKTP.KD.ZG', label: 'Croissance du PIB (% annuel)' },
  { re: /\b(dette|debt)\b/i,                         code: 'GC.DOD.TOTL.GD.ZS', label: 'Dette publique (% du PIB)' },
  { re: /\bpopulation\b/i,                           code: 'SP.POP.TOTL',       label: 'Population totale' },
  { re: /\b(pib|gdp)\b/i,                            code: 'NY.GDP.MKTP.CD',    label: 'PIB (USD courants)' },
];

function detectCountryIso(text) {
  const t = (text || '').toLowerCase();
  for (const [name, iso] of Object.entries(WB_COUNTRY_ISO)) {
    if (t.includes(name)) return { iso, name };
  }
  return null;
}

async function fetchWorldBank(text) {
  try {
    const country = detectCountryIso(text);
    const ind = WB_INDICATORS.find(i => i.re.test(text));
    if (!country || !ind) return []; // pays ou indicateur non identifié → on s'abstient
    const url = `https://api.worldbank.org/v2/country/${country.iso}/indicator/${ind.code}?` + new URLSearchParams({
      format: 'json', per_page: '8', date: '2014:2024',
    }).toString();
    const res = await fetch(url);
    const data = await res.json().catch(() => null);
    const series = Array.isArray(data) ? data[1] : null;
    if (!series || !series.length) return [];
    const points = series.filter(p => p.value != null).slice(0, 4)
      .map(p => `${p.date} : ${p.value}`).join(' ; ');
    if (!points) return [];
    return [{
      source:  'worldbank',
      title:   `Banque Mondiale — ${ind.label} (${country.name})`,
      snippet: `Données officielles : ${points}.`,
      link:    `https://data.worldbank.org/indicator/${ind.code}?locations=${country.iso}`,
    }];
  } catch (err) {
    console.error('[worldbank] error:', err);
    return [];
  }
}

// ── Google Fact Check Tools (clé facultative) ────────────────────────────────

async function searchFactCheck(query, retries = 1) {
  if (!FACTCHECK_KEY) return [];
  try {
    const url = 'https://factchecktools.googleapis.com/v1alpha1/claims:search?' + new URLSearchParams({
      query, pageSize: '5', key: FACTCHECK_KEY,
    }).toString();
    const res = await fetch(url);
    const data = await res.json();
    if (data && data.error) {
      console.error('[factcheck] API error:', data.error.message);
      notifyPipelineError('Fact Check API : ' + (data.error.message || 'erreur'), 'search', { fatal: false });
      return [];
    }
    const items = [];
    for (const c of (data.claims ?? [])) {
      const review = (c.claimReview ?? [])[0];
      if (!review || !review.url) continue;
      const publisher = review.publisher?.name || review.publisher?.site || 'éditeur inconnu';
      const rating    = review.textualRating || 'note non précisée';
      const claimText = (c.text || '').trim();
      const claimant  = c.claimant ? ` (déclarée par ${c.claimant})` : '';
      items.push({
        source:  'factcheck',
        title:   `Fact-check — ${publisher} · verdict : ${rating}`,
        snippet: `Affirmation déjà vérifiée${claimant} : "${claimText}". ${review.title || ''}`.replace(/\s+/g, ' ').trim(),
        link:    review.url,
      });
    }
    return items;
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 400));
      return searchFactCheck(query, retries - 1);
    }
    console.error('[factcheck] error:', err);
    return [];
  }
}

// ── Cache local (mémoire + TTL) ──────────────────────────────────────────────
// Dans un discours, les mêmes entités reviennent souvent : on évite de
// re-requêter une source pour la même entité dans les 10 dernières minutes.
// (Cache mémoire, suffisant pour une session live ; pas besoin d'IndexedDB.)

const sensorCache = new Map(); // clé -> { at, items }
const SENSOR_CACHE_TTL = 10 * 60 * 1000;

function sensorCacheKey(sensor, q) {
  return sensor + '::' + (q || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function cachedSensor(sensor, q, fn) {
  const key = sensorCacheKey(sensor, q);
  const now = Date.now();
  const hit = sensorCache.get(key);
  if (hit && (now - hit.at) < SENSOR_CACHE_TTL) return hit.items;
  let items = [];
  try { items = await fn(); } catch (_) { items = []; }
  sensorCache.set(key, { at: now, items });
  if (sensorCache.size > 400) {
    // éviction du plus ancien
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of sensorCache) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    if (oldestKey) sensorCache.delete(oldestKey);
  }
  return items;
}

// ── Smart Router — quels capteurs interroger selon le contenu ────────────────
// Évite de lancer 10 requêtes par phrase (et de se faire bannir).

const SENSOR_KEYWORDS = {
  sport:   /\b(match|matchs|championnat|tournoi|playoffs?|penalty|mi-temps|prolongation|carton rouge|carton jaune|corner|hat.?trick|touchdown|quarterback|home run|nba|nfl|mlb|nhl|mls|wnba|premier league|champions league|ligue des champions|ligue 1|la liga|bundesliga|serie a|super ?bowl|coupe du monde|world cup|roland.?garros|wimbledon|tour de france|ballon d.or|grand prix|formule ?1|formula ?1|real madrid|barcelone|barcelona|bar[çc]a|juventus|\bjuve\b|bayern|dortmund|liverpool|chelsea|arsenal|tottenham|atl[ée]tico|\bpsg\b|\bom\b|lakers|celtics|warriors|yankees|mbapp[ée]|messi|ronaldo|neymar|lebron|federer|nadal|djokovic)\b/i,
  health:  /\b(virus|vaccin\w*|sant[ée]|maladie|m[ée]dica\w*|clinique|patient|cancer|covid|[ée]pid[ée]mie|pand[ée]mie|\boms\b|th[ée]rapie|sympt[ôo]me|health|vaccine|disease|drug|clinical|\bwho\b)\b/i,
  economy: /\b(pib|inflation|dette|ch[ôo]mage|croissance|d[ée]ficit|budget|gdp|unemployment|debt|deficit|recession|economic)\b/i,
  geo:     /\b(ville|pays|r[ée]gion|fronti[èe]re|kilom[èe]tres?|\bkms?\b|capitale|continent|oc[ée]an|montagne|fleuve|border|city|country|located|capital|geograph\w*)\b/i,
  science: /\b([ée]tude|recherche|publication|climat|physique|chimie|biologie|scientifique|study|research|paper|climate|\bscience\b|peer.?review|journal)\b/i,
};

function routeSensors(text) {
  const t = text || '';
  const isSport = SENSOR_KEYWORDS.sport.test(t);
  // GDELT (presse) bruite les résultats sportifs → exclu pour le sport, où on lui
  // substitue le capteur ESPN (scores structurés).
  const sensors = new Set(['wikipedia', 'wikidata']);
  if (!isSport) sensors.add('gdelt');
  if (isSport)  sensors.add('espn');
  if (SENSOR_KEYWORDS.health.test(t))  { sensors.add('europepmc'); sensors.add('crossref'); }
  if (SENSOR_KEYWORDS.science.test(t)) { sensors.add('openalex');  sensors.add('crossref'); }
  if (SENSOR_KEYWORDS.economy.test(t)) { sensors.add('worldbank'); }
  if (SENSOR_KEYWORDS.geo.test(t))     { sensors.add('nominatim'); }
  // Sources à clé : tentées si la clé est présente (sinon court-circuit interne)
  sensors.add('web');
  sensors.add('factcheck');
  return sensors;
}

// ── Agrégation des preuves (routeur + cache + parallélisme) ──────────────────

function dedupeByLink(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || !it.link || seen.has(it.link)) continue;
    seen.add(it.link);
    out.push(it);
  }
  return out;
}

function buildEvidenceText(items) {
  const labelFor = (s) =>
    s === 'web'         ? 'Web' :
    s === 'wikipedia'   ? 'Wikipédia' :
    s === 'wikidata'    ? 'Wikidata' :
    s === 'gdelt'       ? 'Actualité (GDELT)' :
    s === 'europepmc'   ? 'Médical (Europe PMC)' :
    s === 'openalex'    ? 'Académique (OpenAlex)' :
    s === 'crossref'    ? 'Publication (Crossref)' :
    s === 'worldbank'   ? 'Banque Mondiale' :
    s === 'nominatim'   ? 'Géo (OpenStreetMap)' :
    s === 'espn'        ? 'Résultat sportif (ESPN)' :
    s === 'factcheck'   ? 'Fact-check existant' : 'Source';
  return items.map((it, i) => {
    let domain = '';
    try { domain = new URL(it.link).hostname.replace(/^www\./, ''); } catch (_) {}
    const head = `[${i + 1}] (${labelFor(it.source)}) ${it.title || domain}` +
      (it.source === 'web' && domain ? ` — ${domain}` : '');
    const body = it.snippet ? `\n    ${it.snippet}` : '';
    return `${head}${body}\n    ${it.link}`;
  }).join('\n');
}

// Interroge en parallèle les capteurs choisis par le routeur, avec cache.
async function gatherEvidence(queries) {
  const q0 = queries[0];
  const routeText = queries.join(' ');
  const sensors = routeSensors(routeText);
  const tasks = [];

  if (sensors.has('web') && (EXA_KEY || TAVILY_KEY || SERPER_KEY)) {
    for (const q of queries) tasks.push(cachedSensor('web', q, () => searchWeb(q)));
  }
  if (sensors.has('wikipedia')) tasks.push(cachedSensor('wikipedia', q0, () => searchWikipedia(q0)));
  if (sensors.has('wikidata'))  tasks.push(cachedSensor('wikidata',  q0, () => fetchWikidata(q0)));
  if (sensors.has('gdelt'))     tasks.push(cachedSensor('gdelt',     q0, () => fetchGdelt(q0)));
  if (sensors.has('espn'))      tasks.push(cachedSensor('espn',      q0, () => fetchEspn(q0)));
  if (sensors.has('europepmc')) tasks.push(cachedSensor('europepmc', q0, () => fetchEuropePmc(q0)));
  if (sensors.has('openalex'))  tasks.push(cachedSensor('openalex',  q0, () => fetchOpenAlex(q0)));
  if (sensors.has('crossref'))  tasks.push(cachedSensor('crossref',  q0, () => fetchCrossref(q0)));
  if (sensors.has('worldbank')) tasks.push(cachedSensor('worldbank', routeText, () => fetchWorldBank(routeText)));
  if (sensors.has('nominatim')) tasks.push(cachedSensor('nominatim', q0, () => fetchNominatim(q0)));
  if (sensors.has('factcheck') && FACTCHECK_KEY) tasks.push(cachedSensor('factcheck', q0, () => searchFactCheck(q0)));

  const groups = await Promise.all(tasks.map(p => Promise.resolve(p).catch(() => [])));
  const items  = dedupeByLink(groups.flat()).slice(0, 9);
  return {
    items,
    sources: items.map(it => it.link),  // URLs affichées dans la carte de verdict
    text:    buildEvidenceText(items),  // bloc de preuves lu par le LLM
  };
}

// ── Claude ────────────────────────────────────────────────────────────────────

function stripFences(raw) {
  let s = (raw || '');
  // Modèles reasoning : retirer le bloc de réflexion <think>…</think>
  // (et un éventuel <think> non refermé en cas de troncature), qui précède
  // souvent le JSON et casserait l'extraction.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<think>[\s\S]*$/i, '');
  return s.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
}

function reportLLMError(msg, options = {}) {
  console.error('[llm] API error:', msg);
  notifyPipelineError(msg, 'llm', { fatal: options.fatal !== false });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableLLMError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return /429|rate|limit|timeout|délai|delai|tempor|network|fetch|injoignable|failed|502|503|504|500/.test(msg);
}

// Point d'entrée unique : route vers Anthropic ou un endpoint compatible OpenAI.
// Cette fonction réessaie les erreurs temporaires puis ne signale qu'une seule
// erreur finale, au lieu de bloquer durablement le pipeline à la première tentative.
async function callLLM(userMessage, systemPrompt, options = {}) {
  const maxRetries = Number.isInteger(options.retries) ? options.retries : LLM_MAX_RETRIES;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const content = LLM_PROVIDER === 'openai'
        ? await callOpenAICompatible(userMessage, systemPrompt)
        : await callAnthropic(userMessage, systemPrompt);

      markLLMSuccess();
      if (attempt > 0) {
        setAnalysisDebug('llm_recovered_after_retry', { attempt: attempt + 1 });
      }
      return content;
    } catch (err) {
      lastError = err;
      const retryable = isRetryableLLMError(err);
      setAnalysisDebug('llm_attempt_failed', {
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        retryable,
        message: err?.message || String(err),
      });

      if (attempt < maxRetries && retryable) {
        const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  llmFailureCount++;
  reportLLMError(lastError?.message || 'LLM : erreur inconnue.');
  return '';
}

async function callAnthropic(userMessage, systemPrompt) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': LLM_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: LLM_MODEL || DEFAULT_ANTHROPIC_MODEL,
        max_tokens: LLM_ANALYSIS_MAX_TOKENS,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const rawText = await res.text();
    const data = parseJsonMaybe(rawText);

    setAnalysisDebug('llm_http_response', {
      provider: 'anthropic',
      status: res.status,
      ok: res.ok,
      rawPreview: previewLLMResponse(rawText, 500),
      topLevelKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
    });

    if (!data) {
      throw new Error(
        'Anthropic : réponse non JSON (HTTP ' + res.status + '). Aperçu brut : ' +
        previewLLMResponse(rawText, 320)
      );
    }

    if (!res.ok || data.error) {
      const apiMessage = extractAPIErrorMessage(data) || ('HTTP ' + res.status);
      throw new Error(
        'Anthropic : HTTP ' + res.status + ' — ' + apiMessage +
        '. Aperçu brut : ' + previewLLMResponse(rawText, 320)
      );
    }

    const extracted = extractAnthropicContent(data);
    const content = stripFences(extracted.content || '');

    if (!content) {
      throw new Error(
        'Anthropic : réponse reçue mais contenu texte introuvable. ' +
        'Format détecté : ' + describeLLMShape(data) +
        '. Aperçu brut : ' + previewLLMResponse(rawText, 420)
      );
    }

    setAnalysisDebug('llm_content_extracted', {
      provider: 'anthropic',
      path: extracted.path,
      contentPreview: previewLLMResponse(content, 260),
    });

    return content;
  } catch (err) {
    throw new Error(err?.message || 'Anthropic : erreur inconnue.');
  }
}

// Compatible OpenAI : OpenAI, LM Studio (ex. http://localhost:1234/v1), ou tout
// fournisseur exposant l'endpoint /chat/completions.
async function callOpenAICompatible(userMessage, systemPrompt) {
  const url = buildOpenAIChatCompletionsUrl(LLM_ENDPOINT);
  const headers = { 'Content-Type': 'application/json' };
  if (LLM_API_KEY) headers['Authorization'] = 'Bearer ' + LLM_API_KEY; // facultatif pour LM Studio local

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildOpenAIBody(
        LLM_MODEL, systemPrompt, userMessage,
        LLM_REASONING ? LLM_REASONING_MAX_TOKENS : LLM_ANALYSIS_MAX_TOKENS,
        LLM_REASONING
      )),
    });

    const rawText = await res.text();
    const data = parseJsonMaybe(rawText);

    setAnalysisDebug('llm_http_response', {
      provider: 'openai-compatible',
      status: res.status,
      ok: res.ok,
      url: redactUrlForDebug(url),
      rawPreview: previewLLMResponse(rawText, 500),
      topLevelKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
    });

    if (!data) {
      throw new Error(
        'Endpoint LLM : réponse non JSON (HTTP ' + res.status + '). Aperçu brut : ' +
        previewLLMResponse(rawText, 320)
      );
    }

    if (!res.ok || data.error) {
      const apiMessage = extractAPIErrorMessage(data) || ('HTTP ' + res.status);
      throw new Error(
        'Endpoint LLM : HTTP ' + res.status + ' — ' + apiMessage +
        '. Aperçu brut : ' + previewLLMResponse(rawText, 320)
      );
    }

    const extracted = extractOpenAICompatibleContent(data);
    const content = stripFences(extracted.content || '');

    if (!content) {
      throw new Error(
        'Endpoint LLM : réponse reçue mais contenu texte introuvable. ' +
        'Chemin testé : choices[0].message.content, choices[0].text, output_text, output, message.content, content. ' +
        'Format détecté : ' + describeLLMShape(data) +
        '. Aperçu brut : ' + previewLLMResponse(rawText, 420)
      );
    }

    setAnalysisDebug('llm_content_extracted', {
      provider: 'openai-compatible',
      path: extracted.path,
      contentPreview: previewLLMResponse(content, 260),
    });

    return content;
  } catch (err) {
    const msg = err?.message || 'Endpoint LLM : erreur inconnue.';
    throw new Error(msg.startsWith('Endpoint LLM') ? msg : 'Endpoint LLM injoignable : ' + msg);
  }
}

function previewLLMResponse(str, limit = 260) {
  const clean = String(str || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > limit ? clean.slice(0, limit) + '…' : clean;
}

function parseJsonMaybe(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  try { return JSON.parse(rawText); }
  catch (_) { return null; }
}

// Construit le corps d'une requête /chat/completions, en tenant compte des
// contraintes des modèles "reasoning" :
//  - pas de `temperature` (souvent rejetée, seule la valeur par défaut est admise) ;
//  - budget de sortie via `max_completion_tokens` (et non `max_tokens`, refusé
//    par les modèles o-series côté OpenAI) ;
// Les modèles classiques gardent `max_tokens` + `temperature: 0`.
function buildOpenAIBody(model, systemPrompt, userMessage, maxOut, reasoning) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage },
    ],
  };
  if (reasoning) {
    body.max_completion_tokens = maxOut;
  } else {
    body.max_tokens = maxOut;
    body.temperature = 0;
  }
  return body;
}

function buildOpenAIChatCompletionsUrl(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!base) return '/chat/completions';
  // Permet de coller soit https://fournisseur/api/v1, soit l'URL complète
  // https://fournisseur/api/v1/chat/completions sans créer /chat/completions/chat/completions.
  if (/\/chat\/completions$/i.test(base)) return base;
  return base + '/chat/completions';
}

function redactUrlForDebug(url) {
  try {
    const u = new URL(url);
    // On garde le domaine et le chemin : pas de clé API dans l'URL normalement.
    return u.origin + u.pathname;
  } catch (_) {
    return String(url || '').split('?')[0];
  }
}

function extractAPIErrorMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const err = data.error || data.errors;
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (Array.isArray(err)) {
    return err.map(e => e?.message || e?.detail || e?.code || JSON.stringify(e)).join(' | ');
  }
  return err.message || err.detail || err.code || err.type || JSON.stringify(err).slice(0, 300);
}

function coerceContentToText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return part.text || part.content || part.value || '';
    }).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') {
    return value.text || value.content || value.value || '';
  }
  return '';
}

function extractOpenAICompatibleContent(data) {
  const choices = data?.choices;
  if (Array.isArray(choices) && choices.length) {
    const first = choices[0] || {};
    const msgContent = coerceContentToText(first.message?.content);
    if (msgContent) return { content: msgContent, path: 'choices[0].message.content' };

    const text = coerceContentToText(first.text);
    if (text) return { content: text, path: 'choices[0].text' };

    const delta = coerceContentToText(first.delta?.content);
    if (delta) return { content: delta, path: 'choices[0].delta.content' };
  }

  const outputText = coerceContentToText(data?.output_text);
  if (outputText) return { content: outputText, path: 'output_text' };

  const output = data?.output;
  if (Array.isArray(output)) {
    const parts = [];
    for (const item of output) {
      if (typeof item === 'string') parts.push(item);
      else if (item?.content) parts.push(coerceContentToText(item.content));
      else if (item?.text) parts.push(coerceContentToText(item.text));
    }
    const joined = parts.filter(Boolean).join('\n');
    if (joined) return { content: joined, path: 'output[]' };
  }

  const messageContent = coerceContentToText(data?.message?.content);
  if (messageContent) return { content: messageContent, path: 'message.content' };

  const content = coerceContentToText(data?.content);
  if (content) return { content, path: 'content' };

  const nested = data?.data && typeof data.data === 'object'
    ? extractOpenAICompatibleContent(data.data)
    : { content: '', path: '' };
  if (nested.content) return { content: nested.content, path: 'data.' + nested.path };

  return { content: '', path: 'not-found' };
}

function extractAnthropicContent(data) {
  const content = data?.content;
  if (Array.isArray(content)) {
    const text = content.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' && part.text) return part.text;
      return part.text || part.content || '';
    }).filter(Boolean).join('\n');
    if (text) return { content: text, path: 'content[].text' };
  }

  const direct = coerceContentToText(content);
  if (direct) return { content: direct, path: 'content' };

  const text = coerceContentToText(data?.text);
  if (text) return { content: text, path: 'text' };

  return { content: '', path: 'not-found' };
}

function describeLLMShape(data) {
  if (!data || typeof data !== 'object') return typeof data;
  const keys = Object.keys(data).slice(0, 12);
  const choice0 = Array.isArray(data.choices) ? data.choices[0] : null;
  const choiceKeys = choice0 && typeof choice0 === 'object' ? Object.keys(choice0).slice(0, 8) : [];
  const messageKeys = choice0?.message && typeof choice0.message === 'object'
    ? Object.keys(choice0.message).slice(0, 8)
    : [];
  return JSON.stringify({
    keys,
    choicesLength: Array.isArray(data.choices) ? data.choices.length : null,
    choice0Keys: choiceKeys,
    messageKeys,
    hasOutputText: typeof data.output_text === 'string',
    hasOutput: Array.isArray(data.output),
    hasContent: Boolean(data.content),
  });
}

function normalizeParsedLLMValue(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const possibleArrays = [
      value.results,
      value.claims,
      value.verdicts,
      value.data,
      value.output,
      value.items,
    ];
    const found = possibleArrays.find(Array.isArray);
    if (found) return found;
    if (value.claim && value.verdict) return [value];
    if (value.statement || value.assertion || value.text || value.content) return [value];
  }
  return null;
}

function normalizeVerdictLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase().replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (upper === 'TRUE' || upper === 'CORRECT' || upper === 'VRAI') return 'TRUE';
  if (upper === 'SUBSTANTIALLY TRUE' || upper === 'MOSTLY TRUE' || upper === 'PLUTOT VRAI' || upper === 'PLUTÔT VRAI') return 'SUBSTANTIALLY TRUE';
  if (upper === 'FALSE' || upper === 'INCORRECT' || upper === 'FAUX') return 'FALSE';
  if (upper === 'MISLEADING' || upper === 'TROMPEUR' || upper === 'PARTLY FALSE' || upper === 'PARTIALLY FALSE') return 'MISLEADING';
  if (upper === 'UNVERIFIABLE' || upper === 'UNKNOWN' || upper === 'INSUFFICIENT EVIDENCE' || upper === 'NON VERIFIABLE' || upper === 'NON VÉRIFIABLE') return 'UNVERIFIABLE';
  return upper;
}

function normalizeVerdictItem(item) {
  if (!item || typeof item !== 'object') return null;
  const claim = item.claim
    || item.claim_en
    || item.claim_fr
    || item.statement
    || item.assertion
    || item.text
    || item.fact
    || item.content
    || '';
  const verdict = normalizeVerdictLabel(item.verdict || item.label || item.status || item.result || item.assessment || item.truth_value || '');

  if (!String(claim || '').trim()) return { ...item, claim: '', verdict };

  const normalized = {
    ...item,
    claim: String(claim).trim(),
    verdict,
  };

  if (!normalized.speaker && item.speaker_name) normalized.speaker = item.speaker_name;
  if (!normalized.explanation && item.reason) normalized.explanation = item.reason;
  if (!normalized.explanation && item.rationale) normalized.explanation = item.rationale;
  if (!normalized.explanation && item.justification) normalized.explanation = item.justification;

  if (typeof normalized.confidence !== 'number') {
    const numeric = Number(item.confidence ?? item.score ?? item.probability);
    if (Number.isFinite(numeric)) normalized.confidence = numeric > 1 ? numeric / 100 : numeric;
  }

  return normalized;
}

function normalizeVerdictResults(results) {
  return Array.isArray(results) ? results.map(normalizeVerdictItem).filter(Boolean) : [];
}

function escapeRawControlsInsideJsonStrings(input) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const ch of String(input || '')) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }

    if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ' ';
      continue;
    }

    out += ch;
  }

  return out;
}

function sanitizeLLMJsonCandidate(candidate) {
  return stripFences(String(candidate || ''))
    .replace(/^\uFEFF/, '')
    .replace(/^[\s\n\r]*json\s*/i, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function tryParseNormalizedLLMValue(candidate) {
  const first = sanitizeLLMJsonCandidate(candidate);
  const variants = [
    first,
    escapeRawControlsInsideJsonStrings(first),
    first.replace(/,\s*([}\]])/g, '$1'),
    escapeRawControlsInsideJsonStrings(first).replace(/,\s*([}\]])/g, '$1'),
  ];

  let lastError = null;
  for (const variant of [...new Set(variants)]) {
    if (!variant) continue;
    try {
      const parsed = JSON.parse(variant);
      const normalized = normalizeParsedLLMValue(parsed);
      if (normalized) return { ok: true, results: normalized, repairedText: variant };
      return { ok: false, error: 'JSON valide mais non normalisable.', repairedText: variant };
    } catch (err) {
      lastError = err;
    }
  }

  return { ok: false, error: lastError?.message || 'JSON.parse failed', repairedText: first };
}

function extractBalancedJsonCandidates(text, opening, closing) {
  const s = String(text || '');
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === opening) {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === closing && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function extractJsonRange(text, opening, closing) {
  const candidates = extractBalancedJsonCandidates(text, opening, closing);
  return candidates.length ? candidates[0] : '';
}

function decodeJsonStringLiteral(value) {
  try {
    return JSON.parse('"' + String(value || '').replace(/"/g, '\\"') + '"');
  } catch (_) {
    return String(value || '').replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\r/g, ' ');
  }
}

function extractQuotedFieldFromLooseObject(objectText, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"', 'i');
  const match = String(objectText || '').match(re);
  return match ? decodeJsonStringLiteral(match[1]) : '';
}

function looseExtractVerdictObjects(text) {
  const cleaned = sanitizeLLMJsonCandidate(text);
  const objectCandidates = extractBalancedJsonCandidates(cleaned, '{', '}');
  const items = [];

  for (const candidate of objectCandidates) {
    const parsed = tryParseNormalizedLLMValue(candidate);
    if (parsed.ok && parsed.results?.length) {
      items.push(...parsed.results);
      continue;
    }

    // Fallback de récupération champ par champ : utile quand l'enveloppe globale
    // est cassée mais que les objets individuels sont presque lisibles.
    const item = {
      claim: extractQuotedFieldFromLooseObject(candidate, 'claim'),
      claim_fr: extractQuotedFieldFromLooseObject(candidate, 'claim_fr'),
      claim_en: extractQuotedFieldFromLooseObject(candidate, 'claim_en'),
      verdict: extractQuotedFieldFromLooseObject(candidate, 'verdict'),
      speaker: extractQuotedFieldFromLooseObject(candidate, 'speaker'),
      explanation: extractQuotedFieldFromLooseObject(candidate, 'explanation'),
    };
    const confidence = extractQuotedFieldFromLooseObject(candidate, 'confidence');
    if (confidence) item.confidence = Number(confidence);

    if (item.claim || item.claim_fr || item.claim_en || item.verdict) {
      items.push(item);
    }
  }

  // Dernier recours pour une réponse tronquée au milieu d'un seul objet :
  // on récupère les champs déjà présents si claim + verdict existent.
  if (!items.length && /"claim"\s*:/.test(cleaned) && /"verdict"\s*:/.test(cleaned)) {
    const item = {
      claim: extractQuotedFieldFromLooseObject(cleaned, 'claim'),
      claim_fr: extractQuotedFieldFromLooseObject(cleaned, 'claim_fr'),
      claim_en: extractQuotedFieldFromLooseObject(cleaned, 'claim_en'),
      verdict: extractQuotedFieldFromLooseObject(cleaned, 'verdict'),
      speaker: extractQuotedFieldFromLooseObject(cleaned, 'speaker') || 'Unknown',
      explanation: extractQuotedFieldFromLooseObject(cleaned, 'explanation') || 'Explication non récupérée : réponse JSON partiellement tronquée.',
    };
    if (item.claim && item.verdict) items.push(item);
  }

  return normalizeVerdictResults(items);
}

function parseArrayWithDiagnostics(str) {
  const raw = String(str || '').trim();
  if (!raw) {
    return {
      ok: false,
      results: [],
      reason: 'empty',
      message: 'LLM : réponse vide, aucune analyse exploitable reçue.',
      rawPreview: '',
    };
  }

  const cleaned = sanitizeLLMJsonCandidate(raw);
  const rawPreview = previewLLMResponse(cleaned);

  // 1) JSON direct, avec petites réparations classiques.
  const direct = tryParseNormalizedLLMValue(cleaned);
  if (direct.ok) {
    return { ok: true, results: direct.results, reason: 'json-or-repaired-json', rawPreview };
  }

  // 2) Extraction d'un tableau équilibré au milieu d'un texte.
  const arrayCandidate = extractJsonRange(cleaned, '[', ']');
  if (arrayCandidate) {
    const parsedArray = tryParseNormalizedLLMValue(arrayCandidate);
    if (parsedArray.ok) {
      return { ok: true, results: parsedArray.results, reason: 'extracted-balanced-array', rawPreview };
    }
  }

  // 3) Extraction d'un objet équilibré au milieu d'un texte.
  const objectCandidate = extractJsonRange(cleaned, '{', '}');
  if (objectCandidate) {
    const parsedObject = tryParseNormalizedLLMValue(objectCandidate);
    if (parsedObject.ok) {
      return { ok: true, results: parsedObject.results, reason: 'extracted-balanced-object', rawPreview };
    }
  }

  // 4) Récupération objet par objet, même si l'enveloppe globale est cassée.
  const looseResults = looseExtractVerdictObjects(cleaned);
  if (looseResults.length) {
    return {
      ok: true,
      results: looseResults,
      reason: 'loose-object-recovery',
      rawPreview,
    };
  }

  const looksTruncatedArray = cleaned.includes('[') && cleaned.indexOf('[') > -1 && cleaned.lastIndexOf(']') < cleaned.indexOf('[');
  const looksTruncatedObject = cleaned.includes('{') && cleaned.indexOf('{') > -1 && cleaned.lastIndexOf('}') < cleaned.indexOf('{');
  const truncated = looksTruncatedArray || looksTruncatedObject || /finish_reason"\s*:\s*"length"/i.test(cleaned);

  return {
    ok: false,
    results: [],
    reason: truncated ? 'truncated-json' : 'invalid-json',
    message: truncated
      ? 'LLM : réponse JSON tronquée. La fenêtre a été découpée, mais le modèle a encore coupé sa sortie.'
      : 'LLM : JSON invalide reçu. Le modèle répond, mais pas dans le format attendu.',
    rawPreview,
    parseError: direct.error,
  };
}

function parseArray(str) {
  return parseArrayWithDiagnostics(str).results;
}

function splitTranscriptForLLM(text, maxChars = LLM_BATCH_CHAR_LIMIT) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  // On essaie d'abord de découper sur les labels [Speaker X] / [Nom].
  const speakerParts = normalized
    .split(/(?=\[[^\]]{1,60}\]\s+)/g)
    .map(s => s.trim())
    .filter(Boolean);

  const parts = speakerParts.length > 1 ? speakerParts : normalized.split(/[.!?…]+\s+/g);
  const batches = [];
  let current = '';

  for (const part of parts) {
    if (!part) continue;
    if ((current + ' ' + part).trim().length <= maxChars) {
      current = (current + ' ' + part).trim();
      continue;
    }
    if (current) batches.push(current);

    if (part.length <= maxChars) {
      current = part;
    } else {
      // Dernier recours : découpe par mots pour éviter une requête trop longue.
      const words = part.split(/\s+/);
      current = '';
      for (const word of words) {
        if ((current + ' ' + word).trim().length > maxChars) {
          if (current) batches.push(current);
          current = word;
        } else {
          current = (current + ' ' + word).trim();
        }
      }
    }
  }

  if (current) batches.push(current);
  return batches.slice(0, LLM_MAX_BATCHES_PER_WINDOW);
}

// ── Lexical features ──────────────────────────────────────────────────────────

const HEDGING_WORDS = [
  // English
  'think','believe','maybe','perhaps','probably','might','could','seem','appears','guess','suppose','somewhat',
  // Français
  'pense','crois','croire','peut-être','probablement','possible','pourrait','semblerait','semble','j imagine','je suppose','environ','à peu près'
];
const CERTAINTY_WORDS = [
  // English
  'definitely','certainly','absolutely','always','never','clearly','obviously','undoubtedly','exactly','proven',
  // Français
  'certainement','absolument','toujours','jamais','clairement','évidemment','exactement','prouvé','preuve','forcément','sans aucun doute'
];
const FILLER_WORDS = [
  // English
  'um','uh','like','basically','actually','literally','right','okay',
  // Français
  'euh','heu','bah','ben','genre','en fait','du coup','voilà','quoi','ok','d accord'
];
const EMOTIONAL_WORDS = [
  // English
  'disaster','terrible','horrible','amazing','incredible','great','awful','fantastic','disgusting','wonderful','worst','best',
  // Français
  'catastrophe','terrible','horrible','incroyable','génial','affreux','fantastique','dégoûtant','merveilleux','pire','meilleur'
];
const EXCLUSIVE_WORDS = [
  // English
  'but','except','however','although','unless','without','exclude',
  // Français
  'mais','sauf','cependant','pourtant','bien que','à moins que','sans','exclure'
];
const FP_SINGULAR = [
  // English
  'i','me','my','mine','myself',
  // Français
  'je','moi','mon','ma','mes','mien','mienne','moi-même'
];

function normalizeForLexical(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[’']/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLexical(text) {
  const normalized = normalizeForLexical(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  const total = words.length || 1;
  const rate = (list) => {
    let count = 0;
    for (const marker of list) {
      const m = normalizeForLexical(marker);
      if (!m) continue;
      if (m.includes(' ')) {
        if ((` ${normalized} `).includes(` ${m} `)) count += 1;
      } else {
        count += words.filter(w => w.includes(m)).length;
      }
    }
    return Math.round(count / total * 100);
  };
  return {
    rates: {
      hedging:       rate(HEDGING_WORDS),
      certainty:     rate(CERTAINTY_WORDS),
      filler:        rate(FILLER_WORDS),
      emotional:     rate(EMOTIONAL_WORDS),
      exclusive:     rate(EXCLUSIVE_WORDS),
      firstPersonSg: Math.round(words.filter(w => FP_SINGULAR.includes(w)).length / total * 100),
    },
    wordsPerSecond: null,
    wordCount: total,
  };
}

// Conviction du locuteur (déterministe, depuis les features lexicales).
// Reflète commitmentFromLexical de l'overlay : ASSERTIF->HIGH, PRUDENT->LOW, sinon MEDIUM.
function speakerConfidenceFromLexical(lexical) {
  const r = lexical && lexical.rates;
  if (!r) return null;
  if ((lexical.wordCount || 0) < 5) return null;
  const assertive = (r.certainty || 0) + (r.emotional || 0) * 0.5;
  const hedged    = (r.hedging   || 0) + (r.exclusive || 0) * 0.5 + (r.filler || 0) * 0.3;
  if (assertive - hedged >= 5) return 'HIGH';
  if (hedged - assertive >= 5) return 'LOW';
  return 'MEDIUM';
}

function buildLexicalSummary(f) {
  const r = f.rates || f;
  const notes = [];
  if (r.hedging > 8)       notes.push(`hedging language (${r.hedging}%)`);
  if (r.certainty > 8)     notes.push(`certainty markers (${r.certainty}%)`);
  if (r.filler > 8)        notes.push(`filler words (${r.filler}%)`);
  if (r.emotional > 8)     notes.push(`emotional language (${r.emotional}%)`);
  if (r.exclusive > 8)     notes.push(`qualifying words (${r.exclusive}%)`);
  if (r.firstPersonSg > 8) notes.push(`first-person singular (${r.firstPersonSg}%)`);
  if (f.wordsPerSecond) {
    const pace = f.wordsPerSecond > 3.5 ? 'fast' : f.wordsPerSecond < 2 ? 'slow' : 'moderate';
    notes.push(`speech rate ${f.wordsPerSecond} w/s (${pace})`);
  }
  return notes.length ? `Features detected: ${notes.join(', ')}.` : 'Neutral delivery.';
}

// ── Claim deduplication ───────────────────────────────────────────────────────

const recentClaims   = new Map(); // key → [timestamp, originalClaim]
const CLAIM_DEDUP_MS = 200000;

function stripAccents(text) {
  return (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeClaimKey(claim) {
  return stripAccents(claim.toLowerCase())
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 4)
    .sort()
    .join(' ');
}

function isDuplicate(claim) {
  const key = normalizeClaimKey(claim);
  const now = Date.now();

  for (const [k, v] of recentClaims) {
    const t = Array.isArray(v) ? v[0] : v;
    if (now - t > CLAIM_DEDUP_MS) recentClaims.delete(k);
  }

  if (recentClaims.has(key)) return true;

  const keyWords = new Set(key.split(' ').filter(Boolean));
  const figures  = (claim.match(/\$[\d,.]+(?:\s*(?:trillion|billion|million|thousand))?/gi) || [])
    .map(d => d.replace(/[,\s]/g, '').toLowerCase());

  for (const [k, v] of recentClaims) {
    const kWords = k.split(' ').filter(Boolean);
    if (kWords.filter(w => keyWords.has(w)).length / Math.max(keyWords.size, kWords.length) >= 0.35) return true;
    if (figures.length) {
      const origClaim = Array.isArray(v) ? v[1] : '';
      if (origClaim) {
        const origFigures = (origClaim.match(/\$[\d,.]+(?:\s*(?:trillion|billion|million|thousand))?/gi) || [])
          .map(d => d.replace(/[,\s]/g, '').toLowerCase());
        if (figures.some(f => origFigures.includes(f))) return true;
      }
    }
  }

  recentClaims.set(key, [now, claim]);
  return false;
}

// ── Rolling window ────────────────────────────────────────────────────────────

// Fenêtre d'analyse plus courte pour la version de test : l'analyse démarre
// après 2 phrases finales au lieu de 4, afin de confirmer rapidement que
// evaluateClaims() est bien appelée. Remettre 4 en production si coût API trop élevé.
const WINDOW_SIZE = 2;
const WINDOW_KEEP = 15;

let sentenceWindow  = [];
let sentenceCount   = 0;
let windowLexical   = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
let windowStartTime = null;
let pageTitle       = '';
let pageDate        = '';
let currentSpeakerId  = null;
let lastSpeakerId     = null;
let speakerIdToName   = {};
let confirmedSpeakers = new Set();

function resetWindow() {
  sentenceWindow   = [];
  sentenceCount    = 0;
  windowLexical    = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
  windowStartTime  = null;
  currentSpeakerId  = null;
  lastSpeakerId     = null;
  speakerIdToName   = {};
  confirmedSpeakers = new Set();
}

async function onNewSentence(text, speakerId) {
  setAnalysisDebug('final_transcript_received', {
    textPreview: previewLLMResponse(text, 120),
    speakerId: speakerId ?? null,
    sentenceCountBeforePush: sentenceCount,
    windowLengthBeforePush: sentenceWindow.length,
  });

  if (lastSpeakerId !== null &&
      speakerId !== null &&
      speakerId !== undefined &&
      speakerId !== lastSpeakerId &&
      sentenceCount % WINDOW_SIZE !== 0 &&
      sentenceWindow.length >= 2) {
    const flushText = sentenceWindow.map(s => s.text).join(' ');
    const flushCounts = {};
    sentenceWindow.slice(-WINDOW_SIZE).forEach(s => {
      if (s.speakerId !== null && s.speakerId !== undefined)
        flushCounts[s.speakerId] = (flushCounts[s.speakerId] || 0) + 1;
    });
    const flushDominantId = Object.keys(flushCounts).length
      ? Object.entries(flushCounts).sort((a,b) => b[1]-a[1])[0][0]
      : null;
    const flushDominantSpeaker = flushDominantId !== null ? (speakerIdToName[flushDominantId] || null) : null;
    const flushLexSnapshot = JSON.parse(JSON.stringify(windowLexical));
    const flushLexSummary  = buildLexicalSummary(flushLexSnapshot);
    windowLexical   = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
    windowStartTime = null;
    setAnalysisDebug('evaluate_triggered_speaker_change', {
      sentenceCount,
      windowLength: sentenceWindow.length,
      textPreview: previewLLMResponse(flushText, 180),
    });
    await evaluateClaims(flushText, pageTitle, flushLexSummary, flushLexSnapshot, flushDominantSpeaker, flushDominantId);
  }
  lastSpeakerId = speakerId;

  const confirmedName = (speakerId !== null && speakerId !== undefined) ? speakerIdToName[speakerId] : null;
  const label         = confirmedName ? `[${confirmedName}]` : (speakerId !== null && speakerId !== undefined ? `[Speaker ${speakerId}]` : null);
  const labeledText   = label ? `${label} ${text}` : text;

  sentenceWindow.push({ text: labeledText, speakerId, speakerName: confirmedName });
  if (sentenceWindow.length > WINDOW_KEEP) sentenceWindow.shift();
  sentenceCount++;

  setAnalysisDebug('sentence_window_updated', {
    sentenceCount,
    windowSize: WINDOW_SIZE,
    windowLength: sentenceWindow.length,
    nextTriggerIn: WINDOW_SIZE - (sentenceCount % WINDOW_SIZE || WINDOW_SIZE),
    lastSentencePreview: previewLLMResponse(labeledText, 160),
    speakerId: speakerId ?? null,
    speakerName: confirmedName || null,
  });

  if (!windowStartTime) windowStartTime = Date.now();

  const f = extractLexical(text);
  const r = f.rates, wr = windowLexical.rates;
  wr.hedging       = Math.round((wr.hedging       + r.hedging)       / 2);
  wr.certainty     = Math.round((wr.certainty     + r.certainty)     / 2);
  wr.filler        = Math.round((wr.filler        + r.filler)        / 2);
  wr.emotional     = Math.round((wr.emotional     + r.emotional)     / 2);
  wr.exclusive     = Math.round((wr.exclusive     + r.exclusive)     / 2);
  wr.firstPersonSg = Math.round((wr.firstPersonSg + r.firstPersonSg) / 2);
  windowLexical.wordCount += f.wordCount;

  if (sentenceCount % WINDOW_SIZE === 0) {
    const contextText = sentenceWindow.map(s => s.text).join(' ');

    const currentWindowSentences = sentenceWindow.slice(-WINDOW_SIZE);
    const counts = {};
    currentWindowSentences.forEach(s => {
      if (s.speakerId !== null && s.speakerId !== undefined) {
        counts[s.speakerId] = (counts[s.speakerId] || 0) + 1;
      }
    });
    const dominantSpeakerId = Object.keys(counts).length
      ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
      : null;
    const dominantSpeaker = dominantSpeakerId !== null
      ? (speakerIdToName[dominantSpeakerId] || null)
      : null;

    const elapsed = windowStartTime ? (Date.now() - windowStartTime) / 1000 : null;
    if (elapsed && elapsed > 0) windowLexical.wordsPerSecond = Math.round(windowLexical.wordCount / elapsed * 10) / 10;
    windowStartTime = null;

    const lexicalSnapshot = JSON.parse(JSON.stringify(windowLexical));
    const lexicalSummary  = buildLexicalSummary(lexicalSnapshot);

    windowLexical   = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
    windowStartTime = null;

    try {
      setAnalysisDebug('evaluate_triggered_window', {
        sentenceCount,
        windowSize: WINDOW_SIZE,
        windowLength: sentenceWindow.length,
        textPreview: previewLLMResponse(contextText, 180),
      });
      await evaluateClaims(contextText, pageTitle, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId);
    } catch (e) {
      console.error('[pipeline] evaluateClaims failed:', e);
      notifyPipelineError('Pipeline d’analyse : ' + (e?.message || e), 'pipeline', { fatal: true });
    }
  }
}

// ── Evaluation pipeline ───────────────────────────────────────────────────────

async function evaluateClaims(contextText, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId) {
  analysisAttemptCount++;
  setAnalysisDebug('evaluate_started', {
    analysisAttemptCount,
    contextChars: String(contextText || '').length,
    contextPreview: previewLLMResponse(contextText, 220),
    titlePreview: previewLLMResponse(title, 120),
  });

  try {
    const dateContext    = pageDate ? `\nDate: ${pageDate}` : '';

    const titleNames    = parseSpeakersFromTitle(title || '');
    const nameList = titleNames.join(' and ');
    const speakerLegend = titleNames.length
      ? `\nDebate participants: ${nameList}.` +
        `\nSpeaker attribution rules:` +
        `\n- [Speaker N] labels indicate turn order only — do NOT map Speaker 0 to the first name listed.` +
        `\n- Identify speakers using: (1) first-person language — when someone says "I", "my plan", "I intend to", they ARE the speaker — attribute the claim to the known participant whose policies match; (2) policy content — match stated positions to each participant's known platform; (3) cross-references — participants typically refer to each other by name.` +
        `\n- Use your knowledge of each named participant's background, policies, and public record to attribute correctly.` +
        `\n- If a moderator or third party is speaking, attribute to them if identifiable, otherwise use "Unknown".` +
        `\n- NEVER output "Speaker N" or any [Speaker N] format in any field.`
      : `\nIdentify speakers using first-person language, policy content, and speech patterns. Never output "Speaker N".`;

    const titleContext = title
      ? `Video: "${title}"${dateContext}${speakerLegend}\n\nEvaluate claims as they were made at the time of this recording. Do not apply knowledge of events after this date.\n\n`
      : '';
    const lexicalContext = lexicalSummary ? `\n\nLexical analysis: ${lexicalSummary}` : '';

    const checkedList = [...recentClaims.values()]
      .filter(v => Array.isArray(v) && v[1])
      .map(v => v[1])
      .slice(-15)
      .join('\n- ');
    const alreadyChecked = checkedList
      ? `\n\nClaims already fact-checked this session — do NOT re-evaluate these or close variants:\n- ${checkedList}\n`
      : '';

    const batches = splitTranscriptForLLM(contextText);
    setAnalysisDebug('llm_batches_prepared', {
      batchCount: batches.length,
      maxChars: LLM_BATCH_CHAR_LIMIT,
      maxClaimsPerBatch: LLM_MAX_CLAIMS_PER_BATCH,
      previews: batches.map(b => previewLLMResponse(b, 120)),
    });

    const aggregated = [];
    const parseFailures = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batchText = batches[batchIndex];

      const raw = await callLLM(
        `${titleContext}Transcript chunk ${batchIndex + 1}/${batches.length}: "${batchText}"${alreadyChecked}${lexicalContext}`,
        EVALUATE_PROMPT
      );

      setAnalysisDebug('llm_fast_response_received', {
        batchIndex: batchIndex + 1,
        batchCount: batches.length,
        hasRaw: Boolean(raw),
        rawPreview: previewLLMResponse(raw, 320),
      });

      const parsed = parseArrayWithDiagnostics(raw);
      if (!parsed.ok) {
        parseFailures.push(parsed);
        setAnalysisDebug('llm_parse_failed', {
          batchIndex: batchIndex + 1,
          reason: parsed.reason || null,
          message: parsed.message || null,
          rawPreview: parsed.rawPreview || parsed.parseError || '',
        });
        console.warn('[pipeline] LLM response rejected:', parsed.reason, parsed.rawPreview || parsed.parseError || '');
        continue;
      }

      const batchResults = normalizeVerdictResults(parsed.results);
      aggregated.push(...batchResults);

      setAnalysisDebug('llm_json_parsed', {
        batchIndex: batchIndex + 1,
        parseReason: parsed.reason,
        resultCount: batchResults.length,
        firstResultPreview: batchResults[0] ? previewLLMResponse(JSON.stringify(batchResults[0]), 220) : '',
      });
    }

    const results = normalizeVerdictResults(aggregated);

    if (!results.length && parseFailures.length) {
      const first = parseFailures[0];
      notifyPipelineError(
        first.message + (first.rawPreview ? ' Aperçu : ' + first.rawPreview : ''),
        'llm',
        { fatal: false }
      );
      return;
    }

    if (!results.length) {
      setAnalysisDebug('llm_no_claims_detected', {
        contextPreview: previewLLMResponse(contextText, 180),
      });
      console.info('[pipeline] LLM returned no factual claim in this window.');
      return;
    }

    const invalidShapeCount = results.filter(r => !r || !r.claim || !r.verdict).length;
    const valid = results.filter(r => r && r.claim && r.verdict && !isDuplicate(r.claim));

    if (!valid.length) {
      const message = invalidShapeCount
        ? 'LLM : réponse reçue, mais aucun verdict exploitable. Les champs claim/verdict sont absents ou mal nommés.'
        : 'LLM : uniquement des affirmations déjà analysées, aucun nouveau verdict à afficher.';
      setAnalysisDebug('llm_no_usable_verdicts', {
        invalidShapeCount,
        resultCount: results.length,
        sample: results[0] ? previewLLMResponse(JSON.stringify(results[0]), 220) : '',
      });
      console.warn('[pipeline] no usable verdict after filtering:', { invalidShapeCount, results });
      notifyPipelineError(message, 'llm', { fatal: invalidShapeCount > 0 });
      return;
    }

    if (activeTabId) {
      browserAPI.tabs.sendMessage(activeTabId, {
        type: 'NEW_VERDICT',
        results: valid.map(r => ({
          ...r,
          sources:          [],
          pending:          true,
          lexical:          lexicalSnapshot,
          speaker_confidence: speakerConfidenceFromLexical(lexicalSnapshot),
          dominantSpeakerId,
          speaker:          dominantSpeaker || (r.speaker && !r.speaker.match(/^Speaker\s*\d+$/i) ? r.speaker : null),
        })),
      }).catch(() => {});
      console.log('[pipeline] fast verdicts sent:', valid.length, '| speaker:', dominantSpeaker);
      setAnalysisDebug('fast_verdicts_sent', { count: valid.length, claims: valid.map(r => r.claim).slice(0, 3) });
    }

    groundAndUpdate(contextText, valid, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId);

  } catch (err) {
    console.error('[pipeline] error:', err);
    notifyPipelineError('Pipeline d’analyse : ' + (err?.message || err), 'pipeline', { fatal: true });
  }
}

// ── Sélection des sources réellement pertinentes pour le verdict ─────────────
// ── Indépendance des sources + corroboration (déterministe, 0 appel LLM) ──────
// Inspiré d'au-crible : on compte des VOIX indépendantes (pas des URL) et on
// démasque le reporting circulaire (verbatim / quasi-verbatim). 100 % JS pur,
// testable hors-ligne. Ne remplace jamais le verdict du modèle : il le calibre.

const CORRO_MULTI_TLD = new Set([
  'co.uk','org.uk','gov.uk','ac.uk','me.uk','co.jp','or.jp','ne.jp',
  'com.au','net.au','org.au','gov.au','edu.au','co.nz','com.br','gov.br',
  'co.in','gov.in','com.mx','co.za','com.tr','com.cn','gov.cn',
]);

function registrableDomain(hostname) {
  const h = String(hostname || '').replace(/^www\./, '').toLowerCase();
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  return CORRO_MULTI_TLD.has(lastTwo) ? lastThree : lastTwo;
}

function domainOfLink(link) {
  try { return registrableDomain(new URL(link).hostname); }
  catch { return String(link || ''); }
}

function normalizeForShingles(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordShingles(text, n) {
  n = n || 3;
  const tokens = normalizeForShingles(text).split(' ').filter(Boolean);
  const set = new Set();
  if (tokens.length < n) { if (tokens.length) set.add(tokens.join(' ')); return set; }
  for (let i = 0; i <= tokens.length - n; i++) set.add(tokens.slice(i, i + n).join(' '));
  return set;
}

function jaccardSim(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Crédibilité par TYPE de capteur (signaux, jamais réputation média). 0..1.
const SOURCE_CREDIBILITY = {
  worldbank: 1.0, crossref: 0.95, openalex: 0.9, europepmc: 0.9,
  factcheck: 0.85, espn: 0.85, wikidata: 0.75, wikipedia: 0.7,
  gdelt: 0.5, web: 0.5,
};
function sourceCredibility(src) {
  return SOURCE_CREDIBILITY[src] != null ? SOURCE_CREDIBILITY[src] : 0.5;
}

// Sources « primaires / officielles » : leur seule présence sort de FAIBLE.
const CORRO_PRIMARY = new Set(['worldbank', 'crossref', 'openalex', 'europepmc', 'factcheck']);

// Union-find : deux items dans la même voix si même domaine OU quasi-doublon lexical.
function clusterEvidence(items, threshold) {
  threshold = (typeof threshold === 'number') ? threshold : 0.5;
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  if (!n) return [];
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const domains  = list.map(it => domainOfLink(it.link));
  const shingles = list.map(it => wordShingles(`${it.title || ''} ${it.snippet || ''}`));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (domains[i] === domains[j] || jaccardSim(shingles[i], shingles[j]) > threshold) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(list[i]);
  }
  return [...groups.values()];
}

// Score de corroboration : voix indépendantes + présence de primaires + circulaire.
// Mesure la ROBUSTESSE de l'étayage (pas le « pour/contre » : ça exigerait un appel
// LLM de classification qu'on évite volontairement).
function computeCorroboration(items, threshold) {
  const clusters = clusterEvidence(items, threshold);
  const voices = clusters.length;
  let primaries = 0, circular = false, weighted = 0;
  for (const members of clusters) {
    let best = 0;
    for (const m of members) best = Math.max(best, sourceCredibility(m.source));
    weighted += best;
    if (members.some(m => CORRO_PRIMARY.has(m.source))) primaries++;
    if (members.length >= 3) circular = true;
  }
  let band;
  if (voices === 0)                        band = 'INSUFFISANTE';
  else if (primaries >= 1 && voices >= 2)  band = 'SOLIDE';
  else if (primaries >= 1 || voices >= 2)  band = 'MODÉRÉE';
  else                                     band = 'FAIBLE';
  return { voices, primaries, circular, weighted: Math.round(weighted * 100) / 100, band };
}

// Contexte injecté dans le prompt sourcé (additif, comme la prudence sport).
function buildCorroborationContext(c) {
  if (!c) return '';
  const bits = [`${c.voices} voix indépendante${c.voices > 1 ? 's' : ''}`];
  if (c.primaries > 0) bits.push(`dont ${c.primaries} primaire/officielle${c.primaries > 1 ? 's' : ''}`);
  if (c.circular) bits.push("reporting circulaire détecté (reprises d'une même source)");
  let instr = '';
  if (c.band === 'INSUFFISANTE')
    instr = " Corroboration indépendante insuffisante : réponds UNVERIFIABLE sauf preuve explicite ci-dessus.";
  else if (c.band === 'FAIBLE')
    instr = " Corroboration faible (source unique) : n'attribue pas une confiance élevée.";
  return `\n\nCorroboration (indices, déterministe) : ${bits.join(', ')} — robustesse ${c.band}.${instr}`;
}

// Garde-fou : ne JAMAIS gonfler ; seulement plafonner/abaisser sur preuve mince.
// INSUFFISANTE (aucune voix crédible sur le sujet) -> UNVERIFIABLE + confiance basse.
// FAIBLE (une seule voix générique) -> confiance plafonnée, verdict inchangé.
function applyCorroborationGuard(verdict, confidence, c) {
  if (!c) return { verdict, confidence };
  const num = Number(confidence);
  const hasNum = Number.isFinite(num);
  if (c.band === 'INSUFFISANTE') {
    return {
      verdict: (verdict && verdict !== 'UNVERIFIABLE') ? 'UNVERIFIABLE' : verdict,
      confidence: hasNum ? Math.min(num, 0.3) : 0.3,
    };
  }
  if (c.band === 'FAIBLE') {
    return { verdict, confidence: hasNum ? Math.min(num, 0.4) : confidence };
  }
  return { verdict, confidence };
}

function relevanceFilterItems(claim, items) {
  const list = Array.isArray(items) ? items : [];
  const claimWords = new Set(String(claim || '').toLowerCase().match(/[\p{L}\d]{4,}/gu) || []);
  if (!claimWords.size) return list.slice(0, 3);
  const scored = list.map(it => {
    const text = ((it.title || '') + ' ' + (it.snippet || '')).toLowerCase();
    const words = new Set(text.match(/[\p{L}\d]{4,}/gu) || []);
    let overlap = 0;
    for (const w of claimWords) if (words.has(w)) overlap++;
    return { it, overlap };
  });
  let kept = scored.filter(x => x.overlap >= 2);
  if (!kept.length) kept = scored.filter(x => x.overlap >= 1);
  kept.sort((a, b) => b.overlap - a.overlap);
  return kept.map(x => x.it);
}

function selectCitedSources(match, evidence, claim, cap) {
  cap = cap || 4;
  const items = (evidence && evidence.items) || [];
  let chosen = [];
  if (match && Array.isArray(match.used_sources)) {
    chosen = match.used_sources
      .map(n => parseInt(n, 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= items.length)
      .map(n => items[n - 1]);
  }
  if (!chosen.length) chosen = relevanceFilterItems(claim, items);
  const seen = new Set();
  const out = [];
  for (const it of chosen) {
    if (it && it.link && !seen.has(it.link)) { seen.add(it.link); out.push(it.link); }
    if (out.length >= cap) break;
  }
  return out;
}

async function groundAndUpdate(contextText, fastResults, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId) {
  try {
    const dateCtx      = pageDate ? `\nDate: ${pageDate}` : '';
    const titleContext = title
      ? `Video: "${title}"${dateCtx}\nEvaluate claims as they were made at the time of this recording. Web search results may include articles published after the debate date — ignore any information that was not publicly known at the time of the debate.\n\n`
      : '';
    const lexicalContext = lexicalSummary ? `\n\nLexical analysis: ${lexicalSummary}` : '';

    const groundedAll = await Promise.all(fastResults.map(async (fastResult) => {
      try {
        const searchQueries = [...new Set([
          fastResult.claim,
          fastResult.claim_en,
          fastResult.claim_fr,
          fastResult.translation_en,
          fastResult.translation_fr,
        ].filter(Boolean))].slice(0, 3);
        const urlGroups = await gatherEvidence(searchQueries);
        const urls = urlGroups.sources;
        let safeUrls = relevanceFilterItems(fastResult.claim, urlGroups.items).slice(0, 4).map(it => it.link);
        if (!safeUrls.length) safeUrls = urls.slice(0, 4);
        const isSport = SENSOR_KEYWORDS.sport.test(fastResult.claim || '');
        const sportCaution = isSport
          ? "\n\nIMPORTANT — résultat sportif : n'affirme un score, un vainqueur ou une statistique chiffrée que si une source ci-dessus le confirme explicitement. En l'absence de confirmation, réponds UNVERIFIABLE plutôt que de deviner."
          : "";
        const corrobItems   = relevanceFilterItems(fastResult.claim, urlGroups.items);
        const corroboration = computeCorroboration(corrobItems);
        const corrobContext = buildCorroborationContext(corroboration);
        if (!urls.length) {
          // La recherche web est indisponible ou n'a rien trouvé : on clôt le verdict rapide
          // au lieu de laisser l'interface bloquée en état pending.
          return {
            ...fastResult,
            sources: [],
            pending: false,
            lexical: lexicalSnapshot,
            speaker_confidence: speakerConfidenceFromLexical(lexicalSnapshot),
            speaker: dominantSpeaker || (fastResult.speaker && !fastResult.speaker.match(/^Speaker\s*\d+$/i) ? fastResult.speaker : null),
            dominantSpeakerId,
          };
        }
        const raw = await callLLM(
          `${titleContext}Transcript: "${contextText}"\n\nEvaluate ONLY this specific claim:\n1. ${fastResult.claim}\n\nAvailable bilingual versions, when present:\nFrench: ${fastResult.claim_fr || fastResult.translation_fr || ''}\nEnglish: ${fastResult.claim_en || fastResult.translation_en || ''}\n\nSources (web, encyclopédies, bases scientifiques/médicales, données officielles, actualité, fact-checks déjà publiés) — base ton verdict sur ces éléments. Accorde un poids fort aux données officielles (Banque Mondiale), au consensus scientifique et aux fact-checks d'organismes reconnus ; un article signalé « RÉTRACTÉ » ne doit pas servir de preuve à charge ou à décharge.\n\nRenseigne le champ "used_sources" avec les numéros des sources ci-dessous réellement utilisées pour ce verdict (exclus les sources hors-sujet ; [] si aucune n’est pertinente) :\n${urlGroups.text}${lexicalContext}${sportCaution}${corrobContext}`,
          EVALUATE_PROMPT
        );
        const parsed = parseArrayWithDiagnostics(raw);
        if (!parsed.ok) {
          console.warn('[grounded] LLM response rejected:', parsed.reason, parsed.rawPreview || parsed.parseError || '');
          notifyPipelineError(
            'Analyse sourcée : réponse LLM non conforme. Le verdict rapide est conservé.',
            'llm',
            { fatal: false }
          );
          return { ...fastResult, sources: safeUrls, pending: false, lexical: lexicalSnapshot, speaker_confidence: speakerConfidenceFromLexical(lexicalSnapshot), speaker: dominantSpeaker || fastResult.speaker || null, dominantSpeakerId };
        }

        const results = normalizeVerdictResults(parsed.results);
        const match = results.find(r => r && r.claim && r.verdict);
        if (!match) {
          console.warn('[grounded] no usable grounded verdict:', results);
          notifyPipelineError(
            'Analyse sourcée : réponse reçue mais aucun verdict exploitable. Le verdict rapide est conservé.',
            'llm',
            { fatal: false }
          );
          return { ...fastResult, sources: safeUrls, pending: false, lexical: lexicalSnapshot, speaker_confidence: speakerConfidenceFromLexical(lexicalSnapshot), speaker: dominantSpeaker || fastResult.speaker || null, dominantSpeakerId };
        }
        const lateResolved = dominantSpeakerId !== null && dominantSpeakerId !== undefined
          ? speakerIdToName[dominantSpeakerId] || null
          : null;
        const resolvedSpeaker = lateResolved
          || dominantSpeaker
          || (match.speaker && !match.speaker.match(/^Speaker\s*\d+$/i) ? match.speaker : null)
          || (fastResult.speaker && !fastResult.speaker.match(/^Speaker\s*\d+$/i) ? fastResult.speaker : null);

        const fastWasTrue = fastResult.verdict === 'TRUE' || fastResult.verdict === 'SUBSTANTIALLY TRUE';
        const groundedIsMisleading = match.verdict === 'MISLEADING';
        const finalVerdict = (fastWasTrue && groundedIsMisleading) ? fastResult.verdict : match.verdict;

        const guarded = applyCorroborationGuard(finalVerdict, match.confidence, corroboration);
        return { ...match, verdict: guarded.verdict, confidence: guarded.confidence, corroboration, sources: selectCitedSources(match, urlGroups, fastResult.claim), pending: false, lexical: lexicalSnapshot, speaker_confidence: speakerConfidenceFromLexical(lexicalSnapshot), speaker: resolvedSpeaker, dominantSpeakerId };
      } catch (err) {
        console.error('[grounded] error:', fastResult.claim.slice(0, 40), err);
        return null;
      }
    }));

    const valid = groundedAll.filter(Boolean);
    if (valid.length && activeTabId) {
      browserAPI.tabs.sendMessage(activeTabId, { type: 'UPDATE_VERDICTS', results: valid }).catch(() => {});
      console.log('[pipeline] grounded verdicts sent:', valid.length);
    }
  } catch (err) {
    console.error('[grounded] error:', err);
  }
}

// ── Transcription Deepgram -> overlay + analyse ───────────────────────────────
// (logique de suivi du locuteur reprise de l'ancien handler TRANSCRIPT_RESULT)

function onTranscriptionResult(text, isFinal, isInterim, speaker) {
  setAnalysisDebug('transcript_dispatched_to_overlay', {
    isFinal: Boolean(isFinal),
    isInterim: Boolean(isInterim),
    speaker: speaker ?? null,
    textPreview: previewLLMResponse(text, 140),
    sentenceWindowSize: sentenceWindow.length,
    sentenceCount,
  });

  if (activeTabId) {
    browserAPI.tabs.sendMessage(activeTabId, {
      type: 'TRANSCRIPT_RESULT',
      text,
      isFinal,
      interim: isInterim,
    }).catch(() => {});
  }

  if (isFinal) {
    if (speaker !== null && speaker !== undefined) {
      currentSpeakerId = speaker;
      if (activeTabId && !confirmedSpeakers.has(currentSpeakerId) && !speakerIdToName[currentSpeakerId]) {
        browserAPI.tabs.sendMessage(activeTabId, {
          type:      'NEW_SPEAKER',
          speakerId: currentSpeakerId,
          sample:    text.slice(0, 80),
        }).catch(() => {});
      }
    }
    onNewSentence(text, currentSpeakerId);
  }
}

// ── Deepgram (WebSocket dans le background — non soumis au CSP de la page) ─────

function connectDeepgram() {
  return new Promise((resolve, reject) => {
    if (!DEEPGRAM_KEY) { reject(new Error('Deepgram key missing')); return; }

    const deepgramParams = new URLSearchParams({
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      // Nova-3 + language=multi permet de transcrire français, anglais,
      // et les passages qui alternent entre les deux langues.
      model: 'nova-3',
      language: 'multi',
      // Aide Deepgram à mieux découper les prises de parole en code-switching.
      endpointing: '100',
      punctuate: 'true',
      interim_results: 'true',
      utterance_end_ms: '2500',
      smart_format: 'true',
      vad_events: 'true',
      diarize: 'true',
    });

    deepgramSocket = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${deepgramParams.toString()}`,
      ['token', DEEPGRAM_KEY]
    );

    deepgramSocket.onopen = () => {
      console.log('[background] deepgram connecté');
      setAnalysisDebug('deepgram_connected', {
        model: 'nova-3',
        language: 'multi',
        endpointing: '100',
      });
      resolve();
    };

    deepgramSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'UtteranceEnd') {
          setDeepgramSignalDebug('deepgram_utterance_end', {
            utteranceBufferChars: utteranceBuffer.length,
            sentenceWindowSize: sentenceWindow.length,
            sentenceCount,
          });
          if (activeTabId) {
            browserAPI.tabs.sendMessage(activeTabId, { type: 'UTTERANCE_END' }).catch(() => {});
          }
          return;
        }

        const result = data.channel?.alternatives?.[0];

        if (!result || !result.transcript) {
          setDeepgramSignalDebug('deepgram_event_no_transcript', {
            eventType: data.type || 'unknown',
            is_final: Boolean(data.is_final),
            speech_final: Boolean(data.speech_final),
            sentenceWindowSize: sentenceWindow.length,
            sentenceCount,
          });
          return;
        }

        const text    = result.transcript.trim();
        const isFinal = Boolean(data.is_final);
        const speech  = Boolean(data.speech_final);
        const speaker = result.words?.[0]?.speaker ?? null;

        if (!text) {
          setDeepgramSignalDebug('deepgram_empty_transcript', {
            is_final: isFinal,
            speech_final: speech,
            sentenceWindowSize: sentenceWindow.length,
            sentenceCount,
          });
          return;
        }

        setDeepgramSignalDebug(
          isFinal && speech ? 'deepgram_final_speech_signal'
            : isFinal ? 'deepgram_final_buffer_signal'
            : 'deepgram_interim',
          {
            is_final: isFinal,
            speech_final: speech,
            speaker,
            textPreview: previewLLMResponse(text, 160),
            utteranceBufferChars: utteranceBuffer.length,
            sentenceWindowSize: sentenceWindow.length,
            sentenceCount,
            route: isFinal && speech
              ? 'onTranscriptionResult(final=true) → onNewSentence'
              : isFinal
                ? 'buffer only, waiting for speech_final'
                : 'interim only',
          }
        );

        if (isFinal && speech) {
          const fullText = utteranceBuffer ? utteranceBuffer + ' ' + text : text;
          utteranceBuffer = '';
          onTranscriptionResult(fullText.trim(), true, false, speaker);
        } else if (isFinal && !speech) {
          utteranceBuffer += (utteranceBuffer ? ' ' : '') + text;
          onTranscriptionResult(utteranceBuffer, false, true, speaker);
        } else {
          onTranscriptionResult(text, false, true, speaker);
        }
      } catch (err) {
        console.error('[background] erreur parsing Deepgram:', err);
      }
    };

    deepgramSocket.onerror = (err) => {
      console.error('[background] erreur Deepgram:', err);
      notifyPipelineError('Erreur de transcription — vérifiez votre clé Deepgram.', 'deepgram', { fatal: true });
    };

    deepgramSocket.onclose = (e) => {
      console.log('[background] Deepgram fermé:', e.code, e.reason);
      if (e.code === 1008 || e.code === 1011) {
        notifyPipelineError('Connexion Deepgram échouée (code ' + e.code + '). Vérifiez votre clé API.', 'deepgram', { fatal: true });
        return;
      }
      // reconnexion seulement si une session est active ET que l'audio circule encore
      if (isCapturing && audioFlowing) {
        notifyPipelineError('Transcription déconnectée — reconnexion...', 'deepgram', { fatal: false });
        setTimeout(() => {
          if (isCapturing && audioFlowing) connectDeepgram().catch(() => {});
        }, 1000);
      }
    };
  });
}

// ── État session ──────────────────────────────────────────────────────────────

let activeTabId = null;
let isCapturing = false;
let keepAliveInterval = null;

function startKeepAlive() {
  keepAliveInterval = setInterval(() => browserAPI.runtime.getPlatformInfo(() => {}), 20000);
}

function stopKeepAlive() {
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

// ── Messages ──────────────────────────────────────────────────────────────────

browserAPI.runtime.onConnect.addListener(() => console.log('[service-worker] woken by port connect'));

browserAPI.runtime.onStartup.addListener(() => {
  isCapturing = false;
  audioFlowing = false;
  activeTabId = null;
  pipelineHealthy = true;
  llmHealthy = true;
  lastPipelineError = null;
  lastLLMWarning = null;
  lastAnalysisDebug = null;
  analysisAttemptCount = 0;
  llmFailureCount = 0;
});

browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'START_FACTCHECK':
      startFactCheck()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'STOP_FACTCHECK':
      stopFactCheck();
      sendResponse({ ok: true });
      break;

    // Le content script a obtenu le flux micro -> on ouvre Deepgram
    case 'CAPTURE_STARTED':
      audioFlowing = true;
      if (isCapturing) {
        connectDeepgram().catch((err) => {
          notifyPipelineError('Deepgram : ' + err.message, 'deepgram', { fatal: true });
        });
      }
      break;

    // Fragment audio (Int16 PCM 16 kHz) envoyé par le content script
    case 'AUDIO_CHUNK':
      if (msg.chunk && deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
        deepgramSocket.send(msg.chunk);
      }
      break;

    // L'utilisateur a arrêté le partage micro (ou la piste s'est terminée)
    case 'CAPTURE_ENDED':
      audioFlowing = false;
      if (deepgramSocket) { deepgramSocket.close(); deepgramSocket = null; }
      utteranceBuffer = '';
      sendToActiveTab({ type: 'CAPTURE_ENDED', message: 'Capture audio arrêtée.' });
      break;

    case 'CAPTURE_ERROR':
      notifyPipelineError(msg.message || 'Erreur de capture audio.', 'capture', { fatal: true });
      break;

    case 'SPEAKER_NAMES':
      if (msg.speakerIdToName) {
        Object.entries(msg.speakerIdToName).forEach(([id, name]) => {
          const numId = parseInt(id);
          if (!confirmedSpeakers.has(numId)) {
            speakerIdToName[numId] = name;
            confirmedSpeakers.add(numId);
          }
        });
        console.log('[service-worker] speaker map updated:', speakerIdToName);
      }
      break;

    case 'PAGE_TITLE':
      pageTitle = msg.title || '';
      pageDate  = msg.date  || '';
      console.log('[service-worker] page title:', pageTitle.slice(0, 60));
      console.log('[service-worker] page date:', pageDate);
      break;

    case 'PIPELINE_ERROR':
      if (msg.origin === 'service-worker') break;
      notifyPipelineError(msg.message || 'Erreur pipeline inconnue.', msg.source || 'pipeline', { fatal: msg.fatal !== false });
      break;

    case 'VALIDATE_KEYS':
      validateKeysBeforeStart(msg.config || {})
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, message: err.message || 'Validation impossible.' }));
      return true;

    case 'GET_STATUS':
      sendResponse(buildStatusResponse());
      break;
  }
});

// ── Start / stop ──────────────────────────────────────────────────────────────

async function startFactCheck() {
  if (isCapturing) return;

  await loadKeys();
  if (!DEEPGRAM_KEY) {
    throw new Error('Clé API Deepgram absente. Renseignez-la dans le popup.');
  }
  if (LLM_PROVIDER === 'openai') {
    if (!LLM_ENDPOINT) throw new Error('Endpoint LLM absent (ex. http://localhost:1234/v1).');
    if (!LLM_MODEL)    throw new Error('Identifiant du modèle LLM absent.');
  } else {
    if (!LLM_API_KEY)  throw new Error('Clé API Anthropic absente. Renseignez-la dans le popup.');
  }

  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');
  activeTabId = tab.id;

  clearPipelineError('new-session');
  lastAnalysisDebug = null;
  analysisAttemptCount = 0;
  llmFailureCount = 0;
  resetWindow();
  recentClaims.clear();
  isCapturing  = true;
  audioFlowing = false;
  startKeepAlive();

  // Le content script affiche l'overlay et le bouton "Activer le micro".
  // Deepgram ne s'ouvre qu'au message CAPTURE_STARTED (après le clic utilisateur).
  await browserAPI.tabs.sendMessage(activeTabId, { type: 'START_FACTCHECK' });

  console.log('[service-worker] session démarrée sur l\'onglet', activeTabId);
}

function stopFactCheck() {
  pageTitle = '';
  pageDate  = '';

  const wasCapturing = isCapturing;
  isCapturing  = false;
  audioFlowing = false;

  if (deepgramSocket) { deepgramSocket.close(); deepgramSocket = null; }
  utteranceBuffer = '';

  clearPipelineError('stopped');
  lastAnalysisDebug = null;
  resetWindow();
  recentClaims.clear();

  if (wasCapturing && activeTabId) {
    browserAPI.tabs.sendMessage(activeTabId, { type: 'STOP_FACTCHECK' }).catch(() => {});
  }

  activeTabId = null;
  stopKeepAlive();
  console.log('[service-worker] session arrêtée');
}
