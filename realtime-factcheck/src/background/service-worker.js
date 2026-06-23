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

const EVALUATE_PROMPT = ``;

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
  if (activeTabId) browserAPI.tabs.sendMessage(activeTabId, { type: 'PIPELINE_ERROR', message: msg }).catch(() => {});
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
    const data = await res.json();
    if (data.error) { reportLLMError(data.error.message || 'Unknown API error'); return ''; }
    return stripFences(data.content?.[0]?.text?.trim() || '');
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
    const data = await res.json();
    if (data.error) {
      reportLLMError(typeof data.error === 'string' ? data.error : (data.error.message || 'Erreur LLM'));
      return '';
    }
    return stripFences(data.choices?.[0]?.message?.content?.trim() || '');
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

const HEDGING_WORDS   = ['think','believe','maybe','perhaps','probably','might','could','seem','appears','guess','suppose','somewhat'];
const CERTAINTY_WORDS = ['definitely','certainly','absolutely','always','never','clearly','obviously','undoubtedly','exactly','proven'];
const FILLER_WORDS    = ['um','uh','like','basically','actually','literally','right','okay'];
const EMOTIONAL_WORDS = ['disaster','terrible','horrible','amazing','incredible','great','awful','fantastic','disgusting','wonderful','worst','best'];
const EXCLUSIVE_WORDS = ['but','except','however','although','unless','without','exclude'];
const FP_SINGULAR     = ['i','me','my','mine','myself'];

function extractLexical(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const total = words.length || 1;
  const rate  = (list) => Math.round(words.filter(w => list.some(h => w.includes(h))).length / total * 100);
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

function normalizeClaimKey(claim) {
  return claim.toLowerCase()
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
        const urls = await searchWeb(fastResult.claim);
        if (!urls.length) return null;
        const raw = await callLLM(
          `${titleContext}Transcript: "${contextText}"\n\nEvaluate ONLY this specific claim:\n1. ${fastResult.claim}\n\nWeb search results:\n${urls.join('\n')}${lexicalContext}`,
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

    deepgramSocket = new WebSocket(
      'wss://api.deepgram.com/v1/listen?' + [
        'encoding=linear16',
        'sample_rate=16000',
        'channels=1',
        'model=nova-2',
        'language=en-US',
        'punctuate=true',
        'interim_results=true',
        'utterance_end_ms=2500',
        'smart_format=true',
        'vad_events=true',
        'diarize=true',
      ].join('&'),
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
      if (activeTabId) {
        browserAPI.tabs.sendMessage(activeTabId, {
          type: 'PIPELINE_ERROR',
          message: 'Erreur de transcription — vérifiez votre clé Deepgram.',
        }).catch(() => {});
      }
    };

    deepgramSocket.onclose = (e) => {
      console.log('[background] Deepgram fermé:', e.code, e.reason);
      if (e.code === 1008 || e.code === 1011) {
        if (activeTabId) {
          browserAPI.tabs.sendMessage(activeTabId, {
            type: 'PIPELINE_ERROR',
            message: 'Connexion Deepgram échouée (code ' + e.code + '). Vérifiez votre clé API.',
          }).catch(() => {});
        }
        return;
      }
      // reconnexion seulement si une session est active ET que l'audio circule encore
      if (isCapturing && audioFlowing) {
        if (activeTabId) {
          browserAPI.tabs.sendMessage(activeTabId, {
            type: 'PIPELINE_ERROR',
            message: 'Transcription déconnectée — reconnexion...',
          }).catch(() => {});
        }
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
          if (activeTabId) browserAPI.tabs.sendMessage(activeTabId, {
            type: 'PIPELINE_ERROR', message: 'Deepgram : ' + err.message,
          }).catch(() => {});
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
      if (activeTabId) browserAPI.tabs.sendMessage(activeTabId, {
        type: 'PIPELINE_ERROR', message: 'Capture audio arrêtée.',
      }).catch(() => {});
      break;

    case 'CAPTURE_ERROR':
      if (activeTabId) browserAPI.tabs.sendMessage(activeTabId, {
        type: 'PIPELINE_ERROR', message: msg.message || 'Erreur de capture audio.',
      }).catch(() => {});
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
      if (activeTabId) {
        browserAPI.tabs.sendMessage(activeTabId, { type: 'PIPELINE_ERROR', message: msg.message }).catch(() => {});
      }
      break;

    case 'GET_STATUS':
      sendResponse({ isCapturing });
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

  resetWindow();
  recentClaims.clear();

  if (wasCapturing && activeTabId) {
    browserAPI.tabs.sendMessage(activeTabId, { type: 'STOP_FACTCHECK' }).catch(() => {});
  }

  activeTabId = null;
  stopKeepAlive();
  console.log('[service-worker] session arrêtée');
}
