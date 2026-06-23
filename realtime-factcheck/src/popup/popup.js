// popup.js

const toggleBtn   = document.getElementById('toggleBtn');
const statusEl    = document.getElementById('status');
const anthropicEl = document.getElementById('anthropicKey');
const deepgramEl  = document.getElementById('deepgramKey');
const keyHint     = document.getElementById('keyHint');
const keysSection = document.getElementById('keysSection');

let isActive = false;

// ── Load saved keys ───────────────────────────────────────────────────────────

chrome.storage.local.get(['anthropicKey', 'deepgramKey'], (data) => {
  if (data.anthropicKey) { anthropicEl.value = data.anthropicKey; anthropicEl.classList.add('saved'); }
  if (data.deepgramKey)  { deepgramEl.value  = data.deepgramKey;  deepgramEl.classList.add('saved'); }
  updateHint();
});

// ── Save keys on change ───────────────────────────────────────────────────────

anthropicEl.addEventListener('input', () => {
  anthropicEl.classList.remove('saved');
  updateHint();
});
anthropicEl.addEventListener('change', () => {
  chrome.storage.local.set({ anthropicKey: anthropicEl.value.trim() });
  anthropicEl.classList.add('saved');
  updateHint();
});

deepgramEl.addEventListener('input', () => {
  deepgramEl.classList.remove('saved');
  updateHint();
});
deepgramEl.addEventListener('change', () => {
  chrome.storage.local.set({ deepgramKey: deepgramEl.value.trim() });
  deepgramEl.classList.add('saved');
  updateHint();
});

function updateHint() {
  const hasAnthropic = !!anthropicEl.value.trim();
  const hasDeepgram  = !!deepgramEl.value.trim();

  if (isActive) {
    toggleBtn.disabled = false;
    return;
  }

  if (!hasAnthropic && !hasDeepgram) {
    keyHint.textContent = 'Enter your Anthropic and Deepgram API keys to start.';
    keyHint.className = 'key-hint';
    toggleBtn.disabled = true;
  } else if (!hasAnthropic) {
    keyHint.textContent = 'Enter your Anthropic API key.';
    keyHint.className = 'key-hint';
    toggleBtn.disabled = true;
  } else if (!hasDeepgram) {
    keyHint.textContent = 'Enter your Deepgram API key.';
    keyHint.className = 'key-hint';
    toggleBtn.disabled = true;
  } else {
    keyHint.textContent = 'Keys saved.';
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
  toggleBtn.textContent  = active ? 'Stop Fact-Checking' : 'Start Fact-Checking';
  toggleBtn.className    = 'toggle-btn' + (active ? ' active' : '');
  statusEl.textContent   = active ? 'Live • Fact-checking active' : 'Inactive';
  statusEl.className     = 'status' + (active ? ' active' : '');
  // hide key fields while active
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

  const anthropicKey = anthropicEl.value.trim();
  const deepgramKey  = deepgramEl.value.trim();

  if (!anthropicKey) {
    keyHint.textContent = 'Please enter your Anthropic API key.';
    keyHint.className   = 'key-hint error';
    return;
  }
  if (!deepgramKey) {
    keyHint.textContent = 'Please enter your Deepgram API key.';
    keyHint.className   = 'key-hint error';
    return;
  }

  // save keys then start
  await new Promise(r => chrome.storage.local.set({ anthropicKey, deepgramKey }, r));

  chrome.runtime.sendMessage({ type: 'START_FACTCHECK' }, (res) => {
    if (res?.ok) {
      setActive(true);
    } else {
      keyHint.textContent = 'Failed to start: ' + (res?.error || 'unknown error');
      keyHint.className   = 'key-hint error';
    }
  });
});
