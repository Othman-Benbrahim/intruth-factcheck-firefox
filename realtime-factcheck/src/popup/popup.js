// popup.js

const toggleBtn    = document.getElementById('toggleBtn');
const statusEl     = document.getElementById('status');
const providerEl   = document.getElementById('llmProvider');
const endpointEl   = document.getElementById('llmEndpoint');
const endpointField= document.getElementById('endpointField');
const modelEl      = document.getElementById('llmModel');
const modelLabel   = document.getElementById('modelLabel');
const apiKeyEl     = document.getElementById('llmApiKey');
const apiKeyLabel  = document.getElementById('apiKeyLabel');
const deepgramEl   = document.getElementById('deepgramKey');
const keyHint      = document.getElementById('keyHint');
const keysSection  = document.getElementById('keysSection');

let isActive = false;

// ── Load saved settings ───────────────────────────────────────────────────────

chrome.storage.local.get(
  ['llmProvider', 'llmEndpoint', 'llmModel', 'llmApiKey', 'anthropicKey', 'deepgramKey'],
  (data) => {
    providerEl.value = data.llmProvider || 'anthropic';
    if (data.llmEndpoint) endpointEl.value = data.llmEndpoint;
    if (data.llmModel)    modelEl.value    = data.llmModel;
    // rétro-compat : ancienne clé Anthropic réutilisée comme clé LLM
    if (data.llmApiKey)        apiKeyEl.value = data.llmApiKey;
    else if (data.anthropicKey) apiKeyEl.value = data.anthropicKey;
    if (data.deepgramKey) { deepgramEl.value = data.deepgramKey; deepgramEl.classList.add('saved'); }
    applyProviderUI();
    updateHint();
  }
);

// ── Provider-dependent UI ─────────────────────────────────────────────────────

function applyProviderUI() {
  const openai = providerEl.value === 'openai';
  endpointField.style.display = openai ? 'flex' : 'none';
  apiKeyLabel.textContent = openai ? 'Clé API (facultative pour LM Studio local)' : 'Clé API Anthropic';
  modelLabel.textContent  = openai ? 'Modèle (identifiant)' : 'Modèle Anthropic (optionnel)';
  modelEl.placeholder     = openai ? 'ex. gpt-4o-mini / nom-du-modèle-local' : 'claude-haiku-4-5-20251001';
  apiKeyEl.placeholder    = openai ? 'sk-... (ou vide pour LM Studio)' : 'sk-ant-...';
}

// ── Save on change ────────────────────────────────────────────────────────────

providerEl.addEventListener('change', () => {
  chrome.storage.local.set({ llmProvider: providerEl.value });
  applyProviderUI();
  updateHint();
});

function bindSave(el, key, opts) {
  opts = opts || {};
  el.addEventListener('input', () => { el.classList.remove('saved'); updateHint(); });
  el.addEventListener('change', () => {
    chrome.storage.local.set({ [key]: el.value.trim() });
    el.classList.add('saved');
    updateHint();
  });
}
bindSave(endpointEl, 'llmEndpoint');
bindSave(modelEl,    'llmModel');
bindSave(apiKeyEl,   'llmApiKey');
bindSave(deepgramEl, 'deepgramKey');

// ── Validation / hint ─────────────────────────────────────────────────────────

function missingFields() {
  const openai = providerEl.value === 'openai';
  const missing = [];
  if (!deepgramEl.value.trim()) missing.push('clé Deepgram');
  if (openai) {
    if (!endpointEl.value.trim()) missing.push('endpoint');
    if (!modelEl.value.trim())    missing.push('modèle');
    // clé API facultative en mode OpenAI/LM Studio
  } else {
    if (!apiKeyEl.value.trim())   missing.push('clé Anthropic');
  }
  return missing;
}

function updateHint() {
  if (isActive) { toggleBtn.disabled = false; return; }
  const missing = missingFields();
  if (missing.length) {
    keyHint.textContent = 'Manque : ' + missing.join(', ') + '.';
    keyHint.className = 'key-hint';
    toggleBtn.disabled = true;
  } else {
    keyHint.textContent = 'Paramètres enregistrés.';
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
  if (res?.isCapturing) setActive(true);
});

function setActive(active) {
  isActive = active;
  toggleBtn.textContent = active ? 'Stop Fact-Checking' : 'Start Fact-Checking';
  toggleBtn.className   = 'toggle-btn' + (active ? ' active' : '');
  statusEl.textContent  = active ? 'Live • Fact-checking active' : 'Inactive';
  statusEl.className     = 'status' + (active ? ' active' : '');
  keysSection.style.display = active ? 'none' : 'flex';
  if (!active) updateHint();
}

// ── Toggle ────────────────────────────────────────────────────────────────────

toggleBtn.addEventListener('click', async () => {
  if (isActive) {
    chrome.runtime.sendMessage({ type: 'STOP_FACTCHECK' });
    setActive(false);
    return;
  }

  const missing = missingFields();
  if (missing.length) {
    keyHint.textContent = 'Veuillez renseigner : ' + missing.join(', ') + '.';
    keyHint.className   = 'key-hint error';
    return;
  }

  // save everything then start
  await new Promise(r => chrome.storage.local.set({
    llmProvider: providerEl.value,
    llmEndpoint: endpointEl.value.trim(),
    llmModel:    modelEl.value.trim(),
    llmApiKey:   apiKeyEl.value.trim(),
    deepgramKey: deepgramEl.value.trim(),
  }, r));

  chrome.runtime.sendMessage({ type: 'START_FACTCHECK' }, (res) => {
    if (res?.ok) {
      setActive(true);
    } else {
      keyHint.textContent = 'Échec du démarrage : ' + (res?.error || 'erreur inconnue');
      keyHint.className   = 'key-hint error';
    }
  });
});
