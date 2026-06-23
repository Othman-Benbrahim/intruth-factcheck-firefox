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
let DEEPGRAM_KEY = '';
const SERPER_KEY = '';

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
  if (fatal) broadcastRuntime(payload);
}

function clearPipelineError(reason = 'pipeline') {
  pipelineHealthy = true;
  llmHealthy = true;
  lastPipelineError = null;
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
        max_tokens: 4,
        temperature: 0,
        messages: [{ role: 'user', content: 'Reply OK.' }],
      }),
    });

    if (!res.ok || data?.error) {
      const apiMessage = data?.error?.message || data?.error || ('HTTP ' + res.status);
      return { ok: false, source: 'llm', message: 'Anthropic invalide : ' + apiMessage };
    }
    return { ok: true, source: 'llm', message: 'Clé Anthropic valide.' };
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
    const base = config.endpoint.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;

    const { res, data } = await fetchJsonForValidation(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are a health check endpoint.' },
          { role: 'user', content: 'Reply OK.' },
        ],
      }),
    });

    if (!res.ok || data?.error) {
      const apiMessage = typeof data?.error === 'string'
        ? data.error
        : (data?.error?.message || ('HTTP ' + res.status));
      return { ok: false, source: 'llm', message: 'Endpoint LLM invalide : ' + apiMessage };
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { ok: false, source: 'llm', message: 'Endpoint LLM joignable, mais réponse inattendue.' };
    }

    return { ok: true, source: 'llm', message: 'Endpoint LLM valide.' };
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
  const ok = errors.length === 0;

  if (ok) {
    return {
      ok: true,
      message: 'Clés valides : LLM et Deepgram opérationnels.',
      checks,
      checkedAt: Date.now(),
    };
  }

  return {
    ok: false,
    message: errors.join(' | '),
    checks,
    checkedAt: Date.now(),
  };
}

async function loadKeys() {
  // browser.storage renvoie une Promise sous Firefox (pas de callback).
  const data = await browserAPI.storage.local.get([
    'deepgramKey', 'llmProvider', 'llmApiKey', 'llmEndpoint', 'llmModel', 'anthropicKey',
  ]);
  DEEPGRAM_KEY = data.deepgramKey || '';
  LLM_PROVIDER = data.llmProvider || 'anthropic';
  LLM_ENDPOINT = (data.llmEndpoint || '').trim();
  LLM_MODEL    = (data.llmModel    || '').trim();
  // rétro-compatibilité : si une ancienne clé Anthropic existe, on la réutilise
  LLM_API_KEY  = (data.llmApiKey || data.anthropicKey || '').trim();
}

const EVALUATE_PROMPT = `
You are a bilingual real-time fact-checking assistant.
The transcript may be in English, French, or a mix of both.
Your job is to detect factual claims in either language, evaluate them, and return bilingual claim translations.

Rules:
- Understand French and English directly.
- If the claim is in French, keep the original French text in "claim" and provide an English translation in "claim_en".
- If the claim is in English, keep the original English text in "claim" and provide a French translation in "claim_fr".
- If the claim mixes French and English, keep the mixed original text in "claim" and provide both "claim_fr" and "claim_en" when useful.
- Do not translate proper names, organization names, laws, places, or technical terms when that would distort the meaning.
- Evaluate claims as they were made at the time of the recording when a date is provided.
- Ignore purely subjective opinions, jokes, filler, greetings, and vague claims that cannot be fact-checked.
- Return only valid JSON. No Markdown. No code fences. No extra text.

Return a JSON array. Each object must follow this shape:
{
  "claim": "original factual claim, in the source language",
  "claim_fr": "French translation or French original when available",
  "claim_en": "English translation or English original when available",
  "verdict": "TRUE | SUBSTANTIALLY TRUE | FALSE | MISLEADING | UNVERIFIABLE",
  "speaker": "identified speaker name or Unknown",
  "explanation": "short explanation in the same language as the claim when possible",
  "confidence": 0.0
}

If there is no factual claim, return [].
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

async function searchWeb(query, retries = 2) {
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_KEY },
      body: JSON.stringify({ q: query, num: 6 }),
    });
    const data = await res.json();
    return (data.organic ?? [])
      .map(r => r.link)
      .filter(url => url && !BLOCKED_DOMAINS.some(d => url.includes(d)))
      .slice(0, 3);
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      return searchWeb(query, retries - 1);
    }
    console.error('[serper] error:', err);
    return [];
  }
}

// ── Claude ────────────────────────────────────────────────────────────────────

function stripFences(raw) {
  return (raw || '').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
}

function reportLLMError(msg) {
  console.error('[llm] API error:', msg);
  notifyPipelineError(msg, 'llm', { fatal: true });
}

// Point d'entrée unique : route vers Anthropic ou un endpoint compatible OpenAI.
async function callLLM(userMessage, systemPrompt) {
  if (LLM_PROVIDER === 'openai') return callOpenAICompatible(userMessage, systemPrompt);
  return callAnthropic(userMessage, systemPrompt);
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
        max_tokens: 768,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    let data = {};
    try { data = await res.json(); }
    catch (jsonErr) {
      reportLLMError('Anthropic : réponse non JSON (HTTP ' + res.status + ').');
      return '';
    }

    if (!res.ok || data.error) {
      const apiMessage = data.error?.message || data.error || ('HTTP ' + res.status);
      reportLLMError('Anthropic : ' + apiMessage);
      return '';
    }

    const content = stripFences(data.content?.[0]?.text?.trim() || '');
    if (!content) {
      reportLLMError('Anthropic : réponse vide du modèle.');
      return '';
    }

    markLLMSuccess();
    return content;
  } catch (err) {
    reportLLMError('Anthropic : ' + err.message);
    return '';
  }
}

// Compatible OpenAI : OpenAI, LM Studio (ex. http://localhost:1234/v1), ou tout
// fournisseur exposant l'endpoint /chat/completions.
async function callOpenAICompatible(userMessage, systemPrompt) {
  try {
    const base = LLM_ENDPOINT.replace(/\/+$/, '');   // on enlève un éventuel "/" final
    const url  = base + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (LLM_API_KEY) headers['Authorization'] = 'Bearer ' + LLM_API_KEY; // facultatif pour LM Studio local

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 768,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage },
        ],
      }),
    });
    let data = {};
    try { data = await res.json(); }
    catch (jsonErr) {
      reportLLMError('Endpoint LLM : réponse non JSON (HTTP ' + res.status + ').');
      return '';
    }

    if (!res.ok || data.error) {
      const apiMessage = typeof data.error === 'string'
        ? data.error
        : (data.error?.message || ('HTTP ' + res.status));
      reportLLMError('Endpoint LLM : ' + apiMessage);
      return '';
    }

    const content = stripFences(data.choices?.[0]?.message?.content?.trim() || '');
    if (!content) {
      reportLLMError('Endpoint LLM : réponse vide du modèle.');
      return '';
    }

    markLLMSuccess();
    return content;
  } catch (err) {
    reportLLMError('Endpoint LLM injoignable : ' + err.message);
    return '';
  }
}

function parseArray(str) {
  const start = str.indexOf('[');
  const end   = str.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(str.slice(start, end + 1)); }
  catch { return []; }
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

const WINDOW_SIZE = 4;
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
    await evaluateClaims(flushText, pageTitle, flushLexSummary, flushLexSnapshot, flushDominantSpeaker, flushDominantId);
  }
  lastSpeakerId = speakerId;

  const confirmedName = (speakerId !== null && speakerId !== undefined) ? speakerIdToName[speakerId] : null;
  const label         = confirmedName ? `[${confirmedName}]` : (speakerId !== null && speakerId !== undefined ? `[Speaker ${speakerId}]` : null);
  const labeledText   = label ? `${label} ${text}` : text;

  sentenceWindow.push({ text: labeledText, speakerId, speakerName: confirmedName });
  if (sentenceWindow.length > WINDOW_KEEP) sentenceWindow.shift();
  sentenceCount++;

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
      await evaluateClaims(contextText, pageTitle, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId);
    } catch (e) {
    }
  }
}

// ── Evaluation pipeline ───────────────────────────────────────────────────────

async function evaluateClaims(contextText, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId) {
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

    const raw     = await callLLM(
      `${titleContext}Transcript: "${contextText}"${alreadyChecked}${lexicalContext}`,
      EVALUATE_PROMPT
    );
    const results = parseArray(raw);
    const valid   = results.filter(r => r.claim && r.verdict && !isDuplicate(r.claim));

    if (!valid.length) return;

    if (activeTabId) {
      browserAPI.tabs.sendMessage(activeTabId, {
        type: 'NEW_VERDICT',
        results: valid.map(r => ({
          ...r,
          sources:          [],
          pending:          true,
          lexical:          lexicalSnapshot,
          dominantSpeakerId,
          speaker:          dominantSpeaker || (r.speaker && !r.speaker.match(/^Speaker\s*\d+$/i) ? r.speaker : null),
        })),
      }).catch(() => {});
      console.log('[pipeline] fast verdicts sent:', valid.length, '| speaker:', dominantSpeaker);
    }

    groundAndUpdate(contextText, valid, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId);

  } catch (err) {
    console.error('[pipeline] error:', err);
  }
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
        const urlGroups = await Promise.all(searchQueries.map(q => searchWeb(q)));
        const urls = [...new Set(urlGroups.flat())].slice(0, 5);
        if (!urls.length) return null;
        const raw = await callLLM(
          `${titleContext}Transcript: "${contextText}"\n\nEvaluate ONLY this specific claim:\n1. ${fastResult.claim}\n\nAvailable bilingual versions, when present:\nFrench: ${fastResult.claim_fr || fastResult.translation_fr || ''}\nEnglish: ${fastResult.claim_en || fastResult.translation_en || ''}\n\nWeb search results:\n${urls.join('\n')}${lexicalContext}`,
          EVALUATE_PROMPT
        );
        const results = parseArray(raw);
        const match   = results.find(r => r.claim && r.verdict);
        if (!match) return null;
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

        return { ...match, verdict: finalVerdict, sources: urls, pending: false, lexical: lexicalSnapshot, speaker: resolvedSpeaker, dominantSpeakerId };
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
      resolve();
    };

    deepgramSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'UtteranceEnd') {
          if (activeTabId) {
            browserAPI.tabs.sendMessage(activeTabId, { type: 'UTTERANCE_END' }).catch(() => {});
          }
          return;
        }

        const result = data.channel?.alternatives?.[0];
        if (!result || !result.transcript) return;

        const text    = result.transcript.trim();
        const isFinal = data.is_final;
        const speech  = data.speech_final;
        const speaker = result.words?.[0]?.speaker ?? null;

        if (!text) return;

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
  resetWindow();
  recentClaims.clear();

  if (wasCapturing && activeTabId) {
    browserAPI.tabs.sendMessage(activeTabId, { type: 'STOP_FACTCHECK' }).catch(() => {});
  }

  activeTabId = null;
  stopKeepAlive();
  console.log('[service-worker] session arrêtée');
}
