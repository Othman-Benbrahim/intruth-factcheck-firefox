// overlay.js

console.log('[overlay] content script loaded');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let panel = null;
let transcriptFeedEl = null;
let interimEl = null;
let claimFeedEl = null;
let verdictListEl = null;
let transcriptCollapsed = false;
const pendingCards    = new Map();
const pendingCardTimes = new Map();

const RUNTIME_ERROR_KEYS = ['rtfcLastPipelineError', 'rtfcLastPipelineErrorAt'];
let lastRuntimeError = null;

// expire pending cards after 90 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, time] of pendingCardTimes) {
    if (now - time > 90000) {
      const card = pendingCards.get(key);
      if (card) {
        card.classList.remove('rtfc-verdict--pending');
        const verifying = card.querySelector('.rtfc-verifying');
        if (verifying) verifying.textContent = '⚠ unverified';
      }
      pendingCards.delete(key);
      pendingCardTimes.delete(key);
    }
  }
}, 15000);

let lastTranscriptTimestamp = '';
const sentenceTimestamps   = [];
const MAX_TIMESTAMP_BUFFER = 10;

// ── Speaker state ────────────────────────────────────────────────────────────
let speakers = [];

// ── Speaker colors ────────────────────────────────────────────────────────────
const SPEAKER_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#f97316',
];
const speakerColorMap = new Map();

function getSpeakerColor(name) {
  if (!speakerColorMap.has(name)) {
    const idx = speakerColorMap.size % SPEAKER_COLORS.length;
    speakerColorMap.set(name, SPEAKER_COLORS[idx]);
  }
  return speakerColorMap.get(name);
}

// ── Speaker parsing ───────────────────────────────────────────────────────────
function parseSpeakersFromTitle(title) {
  if (!title) return [];
  const roleMatch = title.match(/(\d+)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:vs?\.?|versus)\s+(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/i);
  if (roleMatch) {
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    return [cap(roleMatch[2]), cap(roleMatch[4])];
  }
  // only match capitalized proper names (not lowercase words like "in", "the", etc.)
  const nameMatch = title.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:and|vs\.?|versus|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) {
    const clean = name => name.trim().split(' ').pop();
    return [clean(nameMatch[1]), clean(nameMatch[2])];
  }
  return [];
}

let lastActiveSpeaker = null; // track most recently labeled speaker

function normalizeSpeakerName(name) {
  if (!name) return name;
  // if name matches a known speaker's last name or full name, return the canonical last name
  for (const speaker of speakers) {
    const lastName = speaker.trim().split(' ').pop().toLowerCase();
    if (name.toLowerCase() === speaker.toLowerCase()) return speaker; // exact match
    if (name.toLowerCase().includes(lastName)) return speaker;        // last name match
  }
  return name; // unknown speaker — return as-is
}

function getClaimSpeaker(claimText) {
  if (!speakers.length) return 'Other';
  const lower = claimText.toLowerCase();

  // direct name match
  for (const speaker of speakers) {
    if (lower.includes(speaker.toLowerCase())) return speaker;
  }

  // partial name match (handles "Vice President Harris" → "Harris")
  for (const speaker of speakers) {
    const parts = speaker.toLowerCase().split(' ');
    if (parts.some(p => p.length > 3 && lower.includes(p))) return speaker;
  }

  // fallback: use last active speaker for vague references
  if (lastActiveSpeaker) return lastActiveSpeaker;

  return 'Other';
}

// ── Speaker ID confirmation ──────────────────────────────────────────────────

const confirmedSpeakerMap = {}; // { speakerId: 'Harris' }
const pendingSpeakerIds   = new Set(); // IDs waiting for confirmation

function showSpeakerBanner(speakerId, sample) {
  if (pendingSpeakerIds.has(speakerId)) return;
  if (speakerId in confirmedSpeakerMap) return;
  // if speakers not yet parsed from title, retry once after 1s
  if (!speakers.length) {
    setTimeout(() => showSpeakerBanner(speakerId, sample), 1000);
    return;
  }
  pendingSpeakerIds.add(speakerId);

  const banner = document.createElement('div');
  banner.className = 'rtfc-speaker-banner';

  const textEl = document.createElement('div');
  textEl.className = 'rtfc-speaker-banner-text';
  textEl.textContent = 'New speaker detected — who is this?';
  banner.appendChild(textEl);

  const sampleEl = document.createElement('div');
  sampleEl.className = 'rtfc-speaker-banner-sample';
  sampleEl.textContent = '"' + String(sample || '') + '..."';
  banner.appendChild(sampleEl);

  const buttonsEl = document.createElement('div');
  buttonsEl.className = 'rtfc-speaker-banner-buttons';

  speakers.forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'rtfc-speaker-banner-btn';
    btn.dataset.name = name;
    btn.dataset.id = String(speakerId);
    btn.textContent = name;
    buttonsEl.appendChild(btn);
  });

  const skipBtn = document.createElement('button');
  skipBtn.className = 'rtfc-speaker-banner-btn rtfc-speaker-banner-btn--skip';
  skipBtn.dataset.id = String(speakerId);
  skipBtn.textContent = 'Skip';
  buttonsEl.appendChild(skipBtn);

  banner.appendChild(buttonsEl);

  banner.querySelectorAll('.rtfc-speaker-banner-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      const id   = parseInt(btn.dataset.id);
      if (name) {
        confirmedSpeakerMap[id] = name;
        chrome.runtime.sendMessage({
          type: 'SPEAKER_NAMES',
          speakerIdToName: { [id]: name },
        });
      }
      pendingSpeakerIds.delete(id);
      if (!name) confirmedSpeakerMap[id] = null;
      banner.remove();
      // retroactively tag all existing grounded cards now that we have more info
      retryTagAllCards();
    });
  });

  // insert above verdicts
  const verdictsSection = panel?.querySelector('#rtfc-verdicts-section');
  if (verdictsSection) verdictsSection.insertAdjacentElement('beforebegin', banner);
}

// ── Speaker confirmation state ───────────────────────────────────────────────

function allSpeakersConfirmed() {
  // true when every speaker seen so far has been confirmed or skipped
  // and at least one real name has been confirmed
  const confirmedNames = Object.values(confirmedSpeakerMap).filter(v => v !== null);
  return confirmedNames.length >= Math.min(speakers.length, Object.keys(confirmedSpeakerMap).length)
    && Object.keys(confirmedSpeakerMap).length > 0;
}

function retryTagAllCards() {
  // retroactively tag all grounded cards once speakers are confirmed
  if (!verdictListEl) return;
  verdictListEl.querySelectorAll('.rtfc-verdict:not(.rtfc-verdict--pending)').forEach(card => {
    const sid = card.dataset.speakerid;
    if (sid === undefined) return;
    const rawName = confirmedSpeakerMap[sid];
    if (!rawName) return; // skipped or not confirmed
    const name = normalizeSpeakerName(rawName);
    // add or update tag
    let tag = card.querySelector('.rtfc-speaker-tag');
    if (tag) {
      tag.textContent = name;
      tag.style.background = getSpeakerColor(name);
    } else {
      const color = getSpeakerColor(name);
      tag = document.createElement('div');
      tag.className = 'rtfc-speaker-tag';
      tag.style.background = color;
      tag.textContent = name;
      card.insertBefore(tag, card.firstChild);
    }
  });
}

// ── Speaker editor ───────────────────────────────────────────────────────────

function sendSpeakerMap() {
  // Deepgram speaker IDs are assigned in order of first appearance
  // We map ID 0 → speakers[0], ID 1 → speakers[1], etc.
  const speakerIdToName = {};
  speakers.forEach((name, i) => { speakerIdToName[i] = name; });
  chrome.runtime.sendMessage({ type: 'SPEAKER_NAMES', speakerIdToName });
}

function renderSpeakerEditor() {
  const el = panel?.querySelector('#rtfc-speaker-editor');
  if (!el || !speakers.length) return;

  el.replaceChildren();

  speakers.forEach((name, i) => {
    const color = getSpeakerColor(name);

    const chip = document.createElement('span');
    chip.className = 'rtfc-speaker-chip';
    chip.dataset.idx = String(i);
    chip.style.borderColor = color;
    chip.style.color = color;

    const input = document.createElement('input');
    input.className = 'rtfc-speaker-chip-input';
    input.value = name;
    input.dataset.idx = String(i);
    input.style.color = color;

    chip.appendChild(input);
    el.appendChild(chip);
  });

  el.querySelectorAll('.rtfc-speaker-chip-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const oldName = speakers[idx];
      const newName = e.target.value.trim() || oldName;
      if (newName === oldName) return;

      // update color map
      if (speakerColorMap.has(oldName)) {
        speakerColorMap.set(newName, speakerColorMap.get(oldName));
        speakerColorMap.delete(oldName);
      }

      speakers[idx] = newName;
      e.target.style.color = getSpeakerColor(newName);
      e.target.closest('.rtfc-speaker-chip').style.borderColor = getSpeakerColor(newName);
      e.target.closest('.rtfc-speaker-chip').style.color = getSpeakerColor(newName);
      sendSpeakerMap(); // update service worker with new names
      retryTagAllCards();
    });

    // select all on focus for easy editing
    input.addEventListener('focus', e => e.target.select());
  });
}

// ── Error toast ──────────────────────────────────────────────────────────────

function isFatalError(message) {
  return /failed|fail|error|key|api|endpoint|absent|missing|échou|erreur|clé|absente|manqu/i.test(String(message || ''));
}

function persistRuntimeError(message) {
  const normalized = String(message || 'Erreur pipeline inconnue.').trim();
  const at = Date.now();
  lastRuntimeError = { message: normalized, timestamp: at };
  chrome.storage.local.set({
    rtfcLastPipelineError: normalized,
    rtfcLastPipelineErrorAt: at,
  });
}

function clearRuntimeErrorStorage() {
  lastRuntimeError = null;
  chrome.storage.local.remove(RUNTIME_ERROR_KEYS);
}

function showError(message, opts) {
  opts = opts || {};
  const normalized = String(message || 'Erreur pipeline inconnue.').trim();

  if (opts.persist !== false) {
    persistRuntimeError(normalized);
  }

  if (!panel) {
    createPanel();
  }
  if (!panel) return;

  const existing = panel.querySelector('.rtfc-error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'rtfc-error-toast';

  const icon = document.createElement('span');
  icon.className = 'rtfc-error-icon';
  icon.textContent = '⚠';
  toast.appendChild(icon);

  const msgEl = document.createElement('span');
  msgEl.className = 'rtfc-error-msg';
  msgEl.textContent = normalized;
  toast.appendChild(msgEl);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'rtfc-error-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => toast.remove());
  toast.appendChild(closeBtn);

  panel.querySelector('#rtfc-header').insertAdjacentElement('afterend', toast);

  // auto-dismiss after 8 seconds unless it looks like a fatal configuration/API error
  if (!isFatalError(normalized)) {
    setTimeout(() => toast.remove(), 8000);
  }
}
// ── Panel ─────────────────────────────────────────────────────────────────────
function createPanel() {
  if (panel) return;

  panel = document.createElement('div');
  panel.id = 'rtfc-panel';

  const header = document.createElement('div');
  header.id = 'rtfc-header';

  const title = document.createElement('span');
  const dot = document.createElement('span');
  dot.className = 'rtfc-dot';
  title.appendChild(dot);
  title.appendChild(document.createTextNode('InTruth'));
  header.appendChild(title);

  const headerActions = document.createElement('div');
  headerActions.className = 'rtfc-header-actions';

  const exportBtn = document.createElement('button');
  exportBtn.id = 'rtfc-export';
  exportBtn.type = 'button';
  exportBtn.title = 'Exporter la session en Markdown';
  exportBtn.textContent = '↓ Export';
  headerActions.appendChild(exportBtn);

  const closeBtn = document.createElement('button');
  closeBtn.id = 'rtfc-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  headerActions.appendChild(closeBtn);

  header.appendChild(headerActions);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.id = 'rtfc-body';

  const transcriptSection = document.createElement('div');
  transcriptSection.id = 'rtfc-transcript-section';

  const transcriptHeader = document.createElement('div');
  transcriptHeader.className = 'rtfc-section-header';

  const transcriptLabel = document.createElement('span');
  transcriptLabel.className = 'rtfc-section-label';
  transcriptLabel.textContent = 'Transcript';
  transcriptHeader.appendChild(transcriptLabel);

  const transcriptToggle = document.createElement('button');
  transcriptToggle.className = 'rtfc-toggle-btn';
  transcriptToggle.id = 'rtfc-transcript-toggle';
  transcriptToggle.type = 'button';
  transcriptToggle.textContent = '▾';
  transcriptHeader.appendChild(transcriptToggle);

  transcriptSection.appendChild(transcriptHeader);

  const transcriptFeed = document.createElement('div');
  transcriptFeed.id = 'rtfc-transcript-feed';
  transcriptSection.appendChild(transcriptFeed);

  const interim = document.createElement('p');
  interim.id = 'rtfc-interim';
  transcriptSection.appendChild(interim);

  body.appendChild(transcriptSection);

  const claimsSection = document.createElement('div');
  claimsSection.id = 'rtfc-claims-section';

  const claimsHeader = document.createElement('div');
  claimsHeader.className = 'rtfc-section-header';

  const claimsLabel = document.createElement('span');
  claimsLabel.className = 'rtfc-section-label';
  claimsLabel.textContent = 'Claims';
  claimsHeader.appendChild(claimsLabel);
  claimsSection.appendChild(claimsHeader);

  const claimFeed = document.createElement('ul');
  claimFeed.id = 'rtfc-claim-feed';
  claimsSection.appendChild(claimFeed);

  body.appendChild(claimsSection);

  const verdictsSection = document.createElement('div');
  verdictsSection.id = 'rtfc-verdicts-section';

  const verdictsHeader = document.createElement('div');
  verdictsHeader.className = 'rtfc-section-header';

  const verdictsLabel = document.createElement('span');
  verdictsLabel.className = 'rtfc-section-label';
  verdictsLabel.textContent = 'Verdicts';
  verdictsHeader.appendChild(verdictsLabel);

  const speakerEditor = document.createElement('div');
  speakerEditor.id = 'rtfc-speaker-editor';
  verdictsHeader.appendChild(speakerEditor);

  verdictsSection.appendChild(verdictsHeader);

  const verdicts = document.createElement('div');
  verdicts.id = 'rtfc-verdicts';

  const empty = document.createElement('p');
  empty.className = 'rtfc-empty';
  empty.textContent = 'Verdicts will appear here...';
  verdicts.appendChild(empty);

  verdictsSection.appendChild(verdicts);
  body.appendChild(verdictsSection);

  panel.appendChild(body);
  document.body.appendChild(panel);

  transcriptFeedEl = panel.querySelector('#rtfc-transcript-feed');
  interimEl        = panel.querySelector('#rtfc-interim');
  claimFeedEl      = panel.querySelector('#rtfc-claim-feed');
  verdictListEl    = panel.querySelector('#rtfc-verdicts');

  if (lastRuntimeError?.message) {
    showError(lastRuntimeError.message, { persist: false });
  }

  panel.querySelector('#rtfc-close').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_FACTCHECK' });
    removePanel();
  });

  panel.querySelector('#rtfc-export').addEventListener('click', () => exportPDF());

  makeDraggable(panel);

  panel.querySelector('#rtfc-transcript-toggle').addEventListener('click', () => {
    transcriptCollapsed = !transcriptCollapsed;
    transcriptFeedEl.style.display = transcriptCollapsed ? 'none' : '';
    interimEl.style.display = transcriptCollapsed ? 'none' : '';
    panel.querySelector('#rtfc-transcript-toggle').textContent = transcriptCollapsed ? '▸' : '▾';
  });
}

function removePanel() {
  panel?.remove();
  panel = null;
  transcriptFeedEl = null;
  interimEl = null;
  claimFeedEl = null;
  verdictListEl = null;
  transcriptCollapsed = false;
  pendingCards.clear();
  pendingCardTimes.clear();
  speakers = [];
  speakerColorMap.clear();
  sentenceTimestamps.length = 0;
  lastTranscriptTimestamp = '';
  lastActiveSpeaker = null;
  Object.keys(confirmedSpeakerMap).forEach(k => delete confirmedSpeakerMap[k]);
  pendingSpeakerIds.clear();
}

// ── Transcript ────────────────────────────────────────────────────────────────
function addTranscriptText(text) {
  if (!transcriptFeedEl) return;
  const span = document.createElement('span');
  span.textContent = text + ' ';
  span.className = 'rtfc-transcript-word';
  transcriptFeedEl.appendChild(span);
  transcriptFeedEl.scrollTop = transcriptFeedEl.scrollHeight;
}

function updateInterim(text) {
  if (!interimEl) return;
  interimEl.textContent = text;
}

function clearInterim() {
  if (!interimEl) return;
  interimEl.textContent = '';
}

// ── Claims ────────────────────────────────────────────────────────────────────
function addClaimBullet(claim) {
  if (!claimFeedEl) return;
  const li = document.createElement('li');
  li.className = 'rtfc-claim-bullet rtfc-claim-bullet--pending';
  li.dataset.claim = claim.toLowerCase().slice(0, 40);
  li.textContent = claim;
  claimFeedEl.appendChild(li);
  return li;
}

function applyVerdictToBullet(claim, verdict, confidence) {
  if (!claimFeedEl) return;
  const color = colorForVerdict(verdict, confidence);
  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  const bullets = claimFeedEl.querySelectorAll('.rtfc-claim-bullet');
  let bestLi = null, bestScore = 0;
  for (const li of bullets) {
    const bulletWords = (li.textContent || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    const overlap = bulletWords.filter(w => claimWords.has(w)).length;
    const score = overlap / Math.max(claimWords.size, bulletWords.length);
    if (score > bestScore) { bestScore = score; bestLi = li; }
  }
  if (bestLi && bestScore >= 0.3) {
    bestLi.className = 'rtfc-claim-bullet rtfc-claim-bullet--' + color;
  }
}

// ── Verdicts ──────────────────────────────────────────────────────────────────
function colorForVerdict(verdict, confidence) {
  if (confidence === 'LOW')              return 'yellow';
  if (verdict === 'TRUE')                return 'green';
  if (verdict === 'SUBSTANTIALLY TRUE')  return 'teal';
  if (verdict === 'FALSE')               return 'red';
  if (verdict === 'MISLEADING')          return 'yellow';
  if (verdict === 'UNVERIFIABLE')        return 'grey';
  return 'grey';
}

function appendConvictionRow(fragment, label, text) {
  const row = document.createElement('div');
  row.className = 'rtfc-conviction-row';

  const labelEl = document.createElement('span');
  labelEl.className = 'rtfc-conviction-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);
  row.appendChild(document.createTextNode(' ' + text));

  fragment.appendChild(row);
}

function buildLexicalRowsFragment(lexical) {
  const fragment = document.createDocumentFragment();
  if (!lexical) return fragment;

  const r = lexical.rates || {};
  if (r.hedging > 0)
    appendConvictionRow(fragment, 'Hedging language:', r.hedging + '% rate — e.g. "I think", "maybe", "probably"');
  if (r.certainty > 0)
    appendConvictionRow(fragment, 'Certainty markers:', r.certainty + '% rate — e.g. "definitely", "always"');
  if (r.filler > 0)
    appendConvictionRow(fragment, 'Filler words:', r.filler + '% rate — e.g. "um", "like", "you know"');
  if (r.emotional > 0)
    appendConvictionRow(fragment, 'Emotional language:', r.emotional + '% rate');
  if (r.exclusive > 0)
    appendConvictionRow(fragment, 'Qualifying words:', r.exclusive + '% rate — e.g. "but", "except"');
  if (r.firstPersonSg > 0)
    appendConvictionRow(fragment, 'First-person singular:', r.firstPersonSg + '% rate');
  if (lexical.wordsPerSecond != null) {
    const rateDesc = lexical.wordsPerSecond > 3.5 ? 'fast' : lexical.wordsPerSecond < 2 ? 'slow' : 'moderate';
    appendConvictionRow(fragment, 'Speech rate:', lexical.wordsPerSecond + ' w/s (' + rateDesc + ')');
  }
  return fragment;
}

// ── Dissonance cognitive ─────────────────────────────────────────────────────
// Croise l'engagement lexical du locuteur (assertif vs prudent, calculé à partir
// des taux de certitude / hésitation) avec le verdict factuel.

function commitmentFromLexical(lexical) {
  const r = lexical && lexical.rates;
  if (!r) return null;
  const assertive = (r.certainty || 0) + (r.emotional || 0) * 0.5;
  const hedged    = (r.hedging   || 0) + (r.exclusive || 0) * 0.5 + (r.filler || 0) * 0.3;
  if (assertive - hedged >= 5) return 'ASSERTIF';
  if (hedged - assertive >= 5) return 'PRUDENT';
  return 'NEUTRE';
}

function computeDissonance(result) {
  const commit = commitmentFromLexical(result.lexical);
  if (!commit || commit === 'NEUTRE') return null;
  const v = result.verdict;
  const refuted   = v === 'FALSE' || v === 'MISLEADING';
  const confirmed = v === 'TRUE'  || v === 'SUBSTANTIALLY TRUE';
  if (commit === 'ASSERTIF' && refuted)   return { level: 'alert', icon: '⚠️', label: 'Péremptoire mais réfuté' };
  if (commit === 'PRUDENT'  && refuted)   return { level: 'info',  icon: 'ℹ️', label: 'Imprécision prudente' };
  if (commit === 'ASSERTIF' && confirmed) return { level: 'ok',    icon: '✓',  label: 'Affirmé et confirmé' };
  return null; // les autres croisements (prudent + exact, invérifiable…) ne sont pas signalés
}

function buildCard(result) {
  const color = colorForVerdict(result.verdict, result.confidence);
  const convictionColor = result.speaker_confidence === 'HIGH' ? 'green'
                        : result.speaker_confidence === 'LOW'  ? 'red'
                        : 'yellow';

  const card = document.createElement('div');
  card.className = 'rtfc-verdict rtfc-verdict--' + color + (result.pending ? ' rtfc-verdict--pending' : '');
  card.dataset.claim = String(result.claim || '').toLowerCase().slice(0, 40);
  if (result.dominantSpeakerId !== null && result.dominantSpeakerId !== undefined) {
    card.dataset.speakerid = String(result.dominantSpeakerId);
  }
  card._resultData = result;

  // speaker tag — only show on grounded cards AND only when all speakers confirmed
  // this prevents wrong tags from appearing before diarization stabilizes
  if (!result.pending && allSpeakersConfirmed()) {
    const confirmedName = (result.dominantSpeakerId !== null && result.dominantSpeakerId !== undefined)
      ? confirmedSpeakerMap[result.dominantSpeakerId]
      : undefined;
    const rawSpeaker = (confirmedName !== undefined && confirmedName !== null)
      ? confirmedName
      : result.speaker || null;
    const normalizedName = rawSpeaker ? normalizeSpeakerName(rawSpeaker) : null;
    const speakerName  = (normalizedName && !normalizedName.match(/^Speaker\s*\d+$/i)) ? normalizedName : null;
    const speakerColor = speakerName ? getSpeakerColor(speakerName) : null;
    if (speakerColor) {
      const speakerTag = document.createElement('div');
      speakerTag.className = 'rtfc-speaker-tag';
      speakerTag.style.background = speakerColor;
      speakerTag.textContent = speakerName;
      card.appendChild(speakerTag);
    }
  }

  const header = document.createElement('div');
  header.className = 'rtfc-verdict-header';

  const badge = document.createElement('span');
  badge.className = 'rtfc-badge rtfc-badge--' + color;
  badge.textContent = result.verdict || '';
  header.appendChild(badge);

  if (result.pending) {
    const verifying = document.createElement('span');
    verifying.className = 'rtfc-verifying';
    verifying.textContent = '⟳ verifying...';
    header.appendChild(verifying);
  }

  const confidence = document.createElement('span');
  confidence.className = 'rtfc-confidence-right';
  confidence.textContent = String(result.confidence || '') + ' certainty';
  header.appendChild(confidence);

  const timestamp = document.createElement('span');
  timestamp.className = 'rtfc-timestamp';
  timestamp.textContent = result._timestamp || '';
  header.appendChild(timestamp);

  card.appendChild(header);

  const claim = document.createElement('p');
  claim.className = 'rtfc-claim';
  claim.textContent = '"' + String(result.claim || '') + '"';
  card.appendChild(claim);

  const explanation = document.createElement('p');
  explanation.className = 'rtfc-explanation';
  explanation.textContent = result.explanation || '';
  card.appendChild(explanation);

  // Pastille de dissonance cognitive (si le croisement engagement × verdict est notable)
  const dissonance = computeDissonance(result);
  if (dissonance) {
    const diss = document.createElement('div');
    diss.className = 'rtfc-dissonance rtfc-dissonance--' + dissonance.level;
    const dicon = document.createElement('span');
    dicon.className = 'rtfc-dissonance-icon';
    dicon.textContent = dissonance.icon;
    diss.appendChild(dicon);
    diss.appendChild(document.createTextNode(dissonance.label));
    card.appendChild(diss);
  }

  const speakerConfidence = document.createElement('div');
  speakerConfidence.className = 'rtfc-speaker-confidence';

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'rtfc-speaker-toggle';
  toggleBtn.type = 'button';

  const dot = document.createElement('span');
  dot.className = 'rtfc-speaker-dot rtfc-speaker-dot--' + convictionColor;
  toggleBtn.appendChild(dot);
  toggleBtn.appendChild(document.createTextNode('Speaker conviction: ' + (result.speaker_confidence || 'N/A')));

  const arrow = document.createElement('span');
  arrow.className = 'rtfc-speaker-arrow';
  arrow.textContent = '▾';
  toggleBtn.appendChild(arrow);

  speakerConfidence.appendChild(toggleBtn);

  const reasons = document.createElement('div');
  reasons.className = 'rtfc-speaker-explanation';
  reasons.style.display = 'none';
  reasons.appendChild(buildLexicalRowsFragment(result.lexical));
  speakerConfidence.appendChild(reasons);

  card.appendChild(speakerConfidence);

  const safeSources = (result.sources ?? []).filter(url => typeof url === 'string' && url.trim());
  if (safeSources.length) {
    const sources = document.createElement('div');
    sources.className = 'rtfc-sources';

    safeSources.forEach((url, i) => {
      const isUrl = url.startsWith('http://') || url.startsWith('https://');
      if (isUrl) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Source ' + (i + 1);
        sources.appendChild(a);
      } else {
        const span = document.createElement('span');
        span.className = 'rtfc-source-text';
        span.textContent = url;
        sources.appendChild(span);
      }
    });

    card.appendChild(sources);
  }

  toggleBtn.addEventListener('click', () => {
    const open = reasons.style.display === 'none';
    reasons.style.display = open ? 'block' : 'none';
    arrow.textContent = open ? '▴' : '▾';
  });

  return card;
}

function findPendingCard(claim) {
  const key = claim.toLowerCase().slice(0, 40);
  if (pendingCards.has(key)) return pendingCards.get(key);

  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  let bestCard = null, bestScore = 0;
  for (const [cardKey, card] of pendingCards) {
    const cardWords = cardKey.split(/\s+/).filter(w => w.length >= 4);
    const overlap = cardWords.filter(w => claimWords.has(w)).length;
    const score = overlap / Math.max(claimWords.size, cardWords.length);
    if (score > bestScore) { bestScore = score; bestCard = card; }
  }
  if (bestScore >= 0.4) return bestCard;
  return verdictListEl?.querySelector('.rtfc-verdict--pending');
}

function getVideoTimestamp() {
  const video = document.querySelector('video');
  if (!video) return '';
  const s = Math.floor(video.currentTime);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
  return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

function getClaimTimestamp(claim) {
  if (!sentenceTimestamps.length) return lastTranscriptTimestamp || getVideoTimestamp();
  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  let bestMatch = null, bestScore = 0;
  for (const entry of sentenceTimestamps) {
    const sentWords = entry.text.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    const overlap = sentWords.filter(w => claimWords.has(w)).length;
    const score = overlap / Math.max(claimWords.size, sentWords.length);
    if (score > bestScore) { bestScore = score; bestMatch = entry; }
  }
  return bestScore >= 0.3 ? bestMatch.timestamp : (lastTranscriptTimestamp || getVideoTimestamp());
}

function addVerdict(result) {
  if (!verdictListEl) return;
  verdictListEl.querySelector('.rtfc-empty')?.remove();
  applyVerdictToBullet(result.claim, result.verdict, result.confidence);
  if (!result._timestamp) result._timestamp = getClaimTimestamp(result.claim);
  const card = buildCard(result);
  if (result.pending) {
    const key = result.claim.toLowerCase().slice(0, 40);
    pendingCards.set(key, card);
    pendingCardTimes.set(key, Date.now());
  } else {
    logVerdict(result);
  }
  verdictListEl.prepend(card);
}

function updateVerdict(result) {
  const existing = findPendingCard(result.claim);
  if (!result._timestamp) result._timestamp = getClaimTimestamp(result.claim);
  // inherit dominantSpeakerId from pending card if grounded result doesn't have one
  if (existing && existing.dataset.speakerid && !result.dominantSpeakerId) {
    result.dominantSpeakerId = existing.dataset.speakerid;
  }
  const newCard = buildCard(result);
  if (existing) {
    existing.replaceWith(newCard);
    for (const [k, v] of pendingCards) {
      if (v === existing) { pendingCards.delete(k); pendingCardTimes.delete(k); break; }
    }
  } else {
    verdictListEl?.querySelector('.rtfc-empty')?.remove();
    verdictListEl?.prepend(newCard);
  }
  applyVerdictToBullet(result.claim, result.verdict, result.confidence);
  logVerdict(result);
}

function makeDraggable(panel) {
  const header = panel.querySelector('#rtfc-header');
  let isDragging = false, startX, startY, startLeft, startTop;
  header.addEventListener('mousedown', (e) => {
    if (e.target.id === 'rtfc-close' || e.target.id === 'rtfc-export') return;
    isDragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    header.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panel.style.right = 'unset';
    panel.style.left  = Math.max(0, startLeft + e.clientX - startX) + 'px';
    panel.style.top   = Math.max(0, startTop  + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => { isDragging = false; header.style.cursor = 'grab'; });
}


// ── Pipeline debug visible ───────────────────────────────────────────────────
function formatDebugValue(value) {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); }
    catch (_) { return String(value); }
  }
  return String(value);
}

function stageToHuman(stage) {
  const map = {
    deepgram_connected: 'Deepgram connecté',
    deepgram_interim: 'Transcription interim',
    deepgram_final_buffer_signal: 'is_final=true / speech_final=false',
    deepgram_final_speech_signal: 'is_final=true / speech_final=true',
    deepgram_utterance_end: 'UtteranceEnd',
    deepgram_event_no_transcript: 'Événement sans transcript',
    deepgram_empty_transcript: 'Transcript vide',
    transcript_dispatched_to_overlay: 'Transcript envoyé overlay',
    final_transcript_received: 'Phrase finale reçue',
    sentence_window_updated: 'Fenêtre de phrases mise à jour',
    evaluate_triggered_window: 'Analyse déclenchée',
    evaluate_triggered_speaker_change: 'Analyse déclenchée changement speaker',
    evaluate_started: 'evaluateClaims démarré',
    llm_fast_response_received: 'Réponse LLM reçue',
    llm_parse_failed: 'Parsing LLM échoué',
    llm_json_parsed: 'JSON LLM parsé',
    llm_no_claims_detected: 'Aucun claim détecté',
    llm_no_usable_verdicts: 'Aucun verdict exploitable',
    fast_verdicts_sent: 'Verdicts envoyés',
  };
  return map[stage] || stage || 'debug';
}

function renderPipelineDebug(msg) {
  if (!panel) createPanel();
  if (!pipelineDebugEl) return;

  const stage = msg.stage || msg.lastAnalysisDebug?.stage || 'unknown';
  const details = msg.details || {};
  const stageEl = panel.querySelector('#rtfc-debug-stage');
  if (stageEl) stageEl.textContent = stageToHuman(stage);

  const lines = [];
  lines.push('stage: ' + stageToHuman(stage));

  if ('is_final' in details) lines.push('is_final: ' + formatDebugValue(details.is_final));
  if ('speech_final' in details) lines.push('speech_final: ' + formatDebugValue(details.speech_final));
  if ('route' in details) lines.push('route: ' + formatDebugValue(details.route));

  if ('sentenceWindowSize' in details) lines.push('sentenceWindow: ' + details.sentenceWindowSize);
  if ('windowLength' in details) lines.push('windowLength: ' + details.windowLength);
  if ('sentenceCount' in details) lines.push('sentenceCount: ' + details.sentenceCount);
  if ('nextTriggerIn' in details) lines.push('next trigger: ' + details.nextTriggerIn + ' phrase(s)');
  if ('analysisAttemptCount' in details) lines.push('analysisAttempt: ' + details.analysisAttemptCount);

  if ('speaker' in details) lines.push('speaker: ' + formatDebugValue(details.speaker));
  if ('speakerId' in details) lines.push('speakerId: ' + formatDebugValue(details.speakerId));

  if ('textPreview' in details) lines.push('text: ' + formatDebugValue(details.textPreview));
  if ('contextPreview' in details) lines.push('context: ' + formatDebugValue(details.contextPreview));
  if ('rawPreview' in details) lines.push('LLM raw: ' + formatDebugValue(details.rawPreview));
  if ('resultCount' in details) lines.push('resultCount: ' + formatDebugValue(details.resultCount));
  if ('count' in details) lines.push('verdictCount: ' + formatDebugValue(details.count));
  if ('reason' in details) lines.push('reason: ' + formatDebugValue(details.reason));
  if ('message' in details) lines.push('message: ' + formatDebugValue(details.message));

  const t = msg.at ? new Date(msg.at).toLocaleTimeString() : new Date().toLocaleTimeString();
  lines.push('time: ' + t);

  pipelineDebugEl.textContent = lines.join('\n');

  // Coloration rapide du statut
  if (stage.includes('failed') || stage.includes('no_usable')) {
    pipelineDebugEl.style.color = '#fecaca';
  } else if (stage.includes('sent') || stage.includes('parsed') || stage.includes('speech_signal')) {
    pipelineDebugEl.style.color = '#a7f3d0';
  } else if (stage.includes('buffer') || stage.includes('no_claim')) {
    pipelineDebugEl.style.color = '#fde68a';
  } else {
    pipelineDebugEl.style.color = '#bfdbfe';
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  console.log('[overlay] message received:', msg.type);
  switch (msg.type) {

    case 'START_FACTCHECK':
      clearRuntimeErrorStorage();
      createPanel();
      startSession();
      speakers = parseSpeakersFromTitle(document.title || '');
      speakerColorMap.clear();
      chrome.runtime.sendMessage({
        type:  'PAGE_TITLE',
        title: document.title || '',
        date:  (() => {
          const el = document.querySelector('meta[itemprop="uploadDate"]') ||
                     document.querySelector('meta[property="og:updated_time"]');
          return el ? new Date(el.content).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
        })(),
      });
      renderSpeakerEditor();
      break;

    case 'STOP_FACTCHECK':
      stopSession();
      clearRuntimeErrorStorage();
      removePanel();
      break;

    case 'TRANSCRIPT_RESULT':
      if (msg.interim) {
        updateInterim(msg.text);
      } else if (msg.isFinal) {
        const ts = getVideoTimestamp();
        lastTranscriptTimestamp = ts;
        sentenceTimestamps.push({ text: msg.text, timestamp: ts });
        if (sentenceTimestamps.length > MAX_TIMESTAMP_BUFFER) sentenceTimestamps.shift();
        clearInterim();
        // strip [Speaker N] prefix before displaying
        const displayText = msg.text.replace(/^\[.*?\]\s*/, '');
        addTranscriptText(displayText);
        // track which speaker is active from label
        const labelMatch = msg.text.match(/^\[(.+?)\]/);
        if (labelMatch && speakers.includes(labelMatch[1])) {
          lastActiveSpeaker = labelMatch[1];
        }
      }
      break;

    case 'NEW_SPEAKER':
      if (panel) showSpeakerBanner(msg.speakerId, msg.sample || '');
      break;

    case 'PIPELINE_ERROR':
      showError(msg.message || 'An error occurred in the fact-checking pipeline.');
      break;

    case 'CAPTURE_ERROR':
      showError(msg.message || msg.error || 'Erreur de capture audio.');
      break;
    case 'PIPELINE_DEBUG':
      break;

    case 'PIPELINE_OK':
    case 'PIPELINE_RECOVERED':
      clearRuntimeErrorStorage();
      break;

    case 'NEW_VERDICT':
      if (msg.results) {
        for (const result of msg.results) {
          addClaimBullet(result.claim);
          addVerdict(result);
        }
      }
      break;

    case 'UPDATE_VERDICTS':
      if (msg.results) {
        for (const result of msg.results) {
          updateVerdict(result);
        }
      }
      break;
  }
});