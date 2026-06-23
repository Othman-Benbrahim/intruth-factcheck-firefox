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
const reasoningEl  = document.getElementById('llmReasoning');
const reasoningField = document.getElementById('reasoningField');
const rememberEl   = document.getElementById('rememberKeys');
const keyHint      = document.getElementById('keyHint');
const keysSection  = document.getElementById('keysSection');
const runtimeErrorEl = document.getElementById('runtimeError');
const validationStatusEl = document.getElementById('validationStatus');

let isActive = false;
let lastRuntimeError = null;
let validationTimer = null;
let validationRunId = 0;
let lastValidation = { state: 'idle', ok: null, message: 'Validation non lancée.' };

const RUNTIME_ERROR_KEYS = ['rtfcLastPipelineError', 'rtfcLastPipelineErrorAt'];

// Clés "coordonnées" persistées selon le choix de mémorisation.
const SECRET_KEYS = ['llmEndpoint', 'llmModel', 'llmApiKey', 'deepgramKey'];

function rememberEnabled() { return !rememberEl || rememberEl.checked; }

// Mémorisation ON  -> storage.local  (persistant)
// Mémorisation OFF -> storage.session (session courante uniquement, hors disque)
function persistKeys(obj) {
  if (rememberEnabled()) {
    chrome.storage.local.set(obj);
    try { chrome.storage.session?.remove(Object.keys(obj)); } catch (_) {}
  } else {
    try { chrome.storage.session?.set(obj); } catch (_) {}
    chrome.storage.local.remove(Object.keys(obj));
  }
}

function collectSecretKeys() {
  return {
    llmEndpoint: endpointEl.value.trim(),
    llmModel:    modelEl.value.trim(),
    llmApiKey:   apiKeyEl.value.trim(),
    deepgramKey: deepgramEl.value.trim(),
  };
}

// Sauvegarde tout avant le lancement et attend que l'écriture soit faite,
// pour que le service-worker relise des clés à jour dans loadKeys().
function saveAllForStart() {
  chrome.storage.local.set({
    llmProvider: providerEl.value,
    llmReasoning: reasoningEl ? reasoningEl.checked : false,
    rememberKeys: rememberEnabled(),
  });
  const keys = collectSecretKeys();
  return new Promise((resolve) => {
    if (rememberEnabled()) {
      chrome.storage.local.set(keys, () => {
        try { chrome.storage.session?.remove(Object.keys(keys)); } catch (_) {}
        resolve();
      });
    } else {
      try {
        chrome.storage.session.set(keys, () => {
          chrome.storage.local.remove(Object.keys(keys), () => resolve());
        });
      } catch (_) { resolve(); }
    }
  });
}

// ── Load saved settings ───────────────────────────────────────────────────────

chrome.storage.local.get(
  ['llmProvider', 'llmEndpoint', 'llmModel', 'llmApiKey', 'anthropicKey', 'deepgramKey',
   'llmReasoning', 'rememberKeys', ...RUNTIME_ERROR_KEYS],
  (data) => {
    const remember = data.rememberKeys !== false; // défaut : mémorisation activée
    if (rememberEl)  rememberEl.checked  = remember;
    if (reasoningEl) reasoningEl.checked = data.llmReasoning === true;

    providerEl.value = data.llmProvider || 'anthropic';

    const applyFields = (src) => {
      if (src.llmEndpoint) endpointEl.value = src.llmEndpoint;
      if (src.llmModel)    modelEl.value    = src.llmModel;
      // rétro-compat : ancienne clé Anthropic réutilisée comme clé LLM
      if (src.llmApiKey)         apiKeyEl.value = src.llmApiKey;
      else if (data.anthropicKey) apiKeyEl.value = data.anthropicKey;
      if (src.deepgramKey) { deepgramEl.value = src.deepgramKey; deepgramEl.classList.add('saved'); }
    };

    if (data.rtfcLastPipelineError) {
      setRuntimeError(data.rtfcLastPipelineError, data.rtfcLastPipelineErrorAt, { persist: false });
    }

    const finish = () => { applyProviderUI(); updateHint(); scheduleKeyValidation(); };

    if (remember) {
      applyFields(data);
      finish();
    } else {
      // mémorisation désactivée : les clés sont en storage.session
      try {
        chrome.storage.session.get(SECRET_KEYS, (sess) => { applyFields(sess || {}); finish(); });
      } catch (_) {
        applyFields({});
        finish();
      }
    }
  }
);

// ── Provider-dependent UI ─────────────────────────────────────────────────────

function applyProviderUI() {
  const openai = providerEl.value === 'openai';
  endpointField.style.display = openai ? 'flex' : 'none';
  if (reasoningField) reasoningField.style.display = openai ? 'flex' : 'none';
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
  scheduleKeyValidation();
});

function bindSave(el, key, opts) {
  opts = opts || {};
  el.addEventListener('input', () => {
    el.classList.remove('saved');
    resetValidationStatus('Modification détectée — validation en attente.');
    updateHint();
    scheduleKeyValidation();
  });
  el.addEventListener('change', () => {
    persistKeys({ [key]: el.value.trim() });
    el.classList.add('saved');
    updateHint();
    scheduleKeyValidation(250);
  });
}
bindSave(endpointEl, 'llmEndpoint');
bindSave(modelEl,    'llmModel');
bindSave(apiKeyEl,   'llmApiKey');
bindSave(deepgramEl, 'deepgramKey');

// Mode reasoning (préférence non secrète → toujours en local)
if (reasoningEl) {
  reasoningEl.addEventListener('change', () => {
    chrome.storage.local.set({ llmReasoning: reasoningEl.checked });
    scheduleKeyValidation(250);
  });
}

// Mémorisation des clés : bascule local <-> session selon l'état de la case
if (rememberEl) {
  rememberEl.addEventListener('change', () => {
    const remember = rememberEl.checked;
    chrome.storage.local.set({ rememberKeys: remember });
    const keys = collectSecretKeys();
    if (remember) {
      chrome.storage.local.set(keys);
      try { chrome.storage.session?.remove(Object.keys(keys)); } catch (_) {}
    } else {
      try { chrome.storage.session?.set(keys); } catch (_) {}
      chrome.storage.local.remove(Object.keys(keys));
    }
  });
}

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


function currentConfig() {
  return {
    llmProvider: providerEl.value,
    llmEndpoint: endpointEl.value.trim(),
    llmModel: modelEl.value.trim(),
    llmApiKey: apiKeyEl.value.trim(),
    deepgramKey: deepgramEl.value.trim(),
    llmReasoning: reasoningEl ? reasoningEl.checked : false,
  };
}

function setValidationStatus(state, message) {
  lastValidation = {
    state,
    ok: state === 'ok' ? true : (state === 'error' ? false : null),
    message: message || '',
  };

  if (validationStatusEl) {
    validationStatusEl.textContent = message || '';
    validationStatusEl.className = 'validation-status ' + state;
  }
  updateHint();
}

function resetValidationStatus(message) {
  if (isActive) return;
  lastValidation = { state: 'idle', ok: null, message: message || 'Validation non lancée.' };
  if (validationStatusEl) {
    validationStatusEl.textContent = lastValidation.message;
    validationStatusEl.className = 'validation-status idle';
  }
}

function formatValidationMessage(result) {
  if (!result) return 'Validation impossible.';
  if (result.ok) return '✓ Clés valides : LLM et Deepgram opérationnels.';

  const parts = [];
  if (result.checks?.llm && !result.checks.llm.ok) parts.push('LLM : ' + result.checks.llm.message.replace(/^Endpoint LLM invalide :\s*/i, '').replace(/^Anthropic invalide :\s*/i, ''));
  if (result.checks?.deepgram && !result.checks.deepgram.ok) parts.push('Deepgram : ' + result.checks.deepgram.message.replace(/^Deepgram\s*:?\s*/i, ''));
  return '✕ ' + (parts.length ? parts.join(' | ') : (result.message || 'Clé invalide.'));
}

function scheduleKeyValidation(delay = 900) {
  if (isActive) return;
  clearTimeout(validationTimer);

  const missing = missingFields();
  if (missing.length) {
    resetValidationStatus('Validation en attente : ' + missing.join(', ') + ' manquante(s).');
    return;
  }

  validationTimer = setTimeout(validateKeysNow, delay);
}

function validateKeysNow() {
  if (isActive) return;
  const missing = missingFields();
  if (missing.length) {
    resetValidationStatus('Validation en attente : ' + missing.join(', ') + ' manquante(s).');
    return;
  }

  const runId = ++validationRunId;
  setValidationStatus('checking', 'Vérification des clés API...');

  chrome.runtime.sendMessage({ type: 'VALIDATE_KEYS', config: currentConfig() }, (result) => {
    if (runId !== validationRunId) return;

    if (chrome.runtime.lastError) {
      setValidationStatus('error', '✕ Validation impossible : ' + chrome.runtime.lastError.message);
      return;
    }

    const message = formatValidationMessage(result);
    setValidationStatus(result?.ok ? 'ok' : 'error', message);
  });
}


function formatRuntimeError(message) {
  const clean = String(message || '').trim();
  if (!clean) return 'IA non fonctionnelle : erreur inconnue.';
  return clean.startsWith('IA non fonctionnelle') ? clean : 'IA non fonctionnelle : ' + clean;
}

function formatErrorTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return ' • ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setRuntimeError(message, timestamp, opts) {
  opts = opts || {};
  const normalized = formatRuntimeError(message);
  const at = timestamp || Date.now();
  lastRuntimeError = { message: normalized, timestamp: at };

  if (runtimeErrorEl) {
    runtimeErrorEl.textContent = normalized + formatErrorTime(at);
    runtimeErrorEl.style.display = 'block';
  }

  statusEl.textContent = isActive ? 'Erreur • IA non fonctionnelle' : 'Erreur précédente • IA non fonctionnelle';
  statusEl.className = 'status error';

  if (isActive) {
    keyHint.textContent = normalized;
    keyHint.className = 'key-hint error';
  }

  if (opts.persist !== false) {
    chrome.storage.local.set({
      rtfcLastPipelineError: normalized,
      rtfcLastPipelineErrorAt: at,
    });
  }
}

function clearRuntimeError() {
  lastRuntimeError = null;
  if (runtimeErrorEl) {
    runtimeErrorEl.textContent = '';
    runtimeErrorEl.style.display = 'none';
  }
  chrome.storage.local.remove(RUNTIME_ERROR_KEYS);
}

function handleRuntimeErrorMessage(msg) {
  const rawMessage = msg?.message || msg?.error || 'Erreur pipeline inconnue.';
  setRuntimeError(rawMessage, Date.now());
}

function updateHint() {
  if (lastRuntimeError && isActive) { toggleBtn.disabled = false; return; }
  if (isActive) { toggleBtn.disabled = false; return; }
  const missing = missingFields();
  if (missing.length) {
    keyHint.textContent = 'Manque : ' + missing.join(', ') + '.';
    keyHint.className = 'key-hint';
    toggleBtn.disabled = true;
  } else if (lastValidation.state === 'checking') {
    keyHint.textContent = 'Validation des clés en cours...';
    keyHint.className = 'key-hint';
    toggleBtn.disabled = true;
  } else if (lastValidation.ok === false) {
    keyHint.textContent = 'Corrige les clés API avant de lancer InTruth.';
    keyHint.className = 'key-hint error';
    toggleBtn.disabled = true;
  } else if (lastValidation.ok === true) {
    keyHint.textContent = 'Clés validées.';
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  } else {
    keyHint.textContent = 'Paramètres enregistrés. Validation automatique en attente.';
    keyHint.className = 'key-hint';
    toggleBtn.disabled = true;
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
  if (res?.isCapturing) setActive(true);
  if (res?.pipelineError || res?.error) setRuntimeError(res.pipelineError || res.error, Date.now());
});

function setActive(active) {
  isActive = active;
  toggleBtn.textContent = active ? 'Stop Fact-Checking' : 'Start Fact-Checking';
  toggleBtn.className   = 'toggle-btn' + (active ? ' active' : '');
  keysSection.style.display = active ? 'none' : 'flex';

  if (lastRuntimeError) {
    statusEl.textContent = active ? 'Erreur • IA non fonctionnelle' : 'Erreur précédente • IA non fonctionnelle';
    statusEl.className = 'status error';
  } else {
    statusEl.textContent  = active ? 'Live • Fact-checking active' : 'Inactive';
    statusEl.className     = 'status' + (active ? ' active' : '');
  }

  if (!active) updateHint();
}

// ── Toggle ────────────────────────────────────────────────────────────────────

toggleBtn.addEventListener('click', async () => {
  if (isActive) {
    chrome.runtime.sendMessage({ type: 'STOP_FACTCHECK' });
    clearRuntimeError();
    setActive(false);
    return;
  }

  const missing = missingFields();
  if (missing.length) {
    keyHint.textContent = 'Veuillez renseigner : ' + missing.join(', ') + '.';
    keyHint.className   = 'key-hint error';
    return;
  }

  // save everything, validate, then start
  clearRuntimeError();
  await saveAllForStart();

  if (lastValidation.ok !== true) {
    await new Promise((resolve) => {
      const runId = ++validationRunId;
      setValidationStatus('checking', 'Vérification des clés API avant lancement...');
      chrome.runtime.sendMessage({ type: 'VALIDATE_KEYS', config: currentConfig() }, (result) => {
        if (runId !== validationRunId) return resolve(false);
        if (chrome.runtime.lastError) {
          setValidationStatus('error', '✕ Validation impossible : ' + chrome.runtime.lastError.message);
          return resolve(false);
        }
        setValidationStatus(result?.ok ? 'ok' : 'error', formatValidationMessage(result));
        resolve(Boolean(result?.ok));
      });
    });
  }

  if (lastValidation.ok !== true) return;

  chrome.runtime.sendMessage({ type: 'START_FACTCHECK' }, (res) => {
    if (res?.ok) {
      setActive(true);
    } else {
      const error = 'Échec du démarrage : ' + (res?.error || 'erreur inconnue');
      keyHint.textContent = error;
      keyHint.className   = 'key-hint error';
      setRuntimeError(error, Date.now());
    }
  });
});


// ── Runtime errors from service-worker / content scripts ─────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'PIPELINE_ERROR' || msg.type === 'CAPTURE_ERROR') {
    handleRuntimeErrorMessage(msg);
  }
  if (msg.type === 'PIPELINE_OK' || msg.type === 'PIPELINE_RECOVERED') {
    clearRuntimeError();
    setActive(isActive);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.rtfcLastPipelineError) {
    const message = changes.rtfcLastPipelineError.newValue;
    if (message) {
      setRuntimeError(message, changes.rtfcLastPipelineErrorAt?.newValue || Date.now(), { persist: false });
    } else {
      lastRuntimeError = null;
      if (runtimeErrorEl) {
        runtimeErrorEl.textContent = '';
        runtimeErrorEl.style.display = 'none';
      }
      setActive(isActive);
    }
  }
});
