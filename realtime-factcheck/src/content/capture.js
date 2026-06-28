// capture.js  (content script)
// Capture audio via getUserMedia (seule API audio réellement disponible sous
// Firefox pour une extension). L'utilisateur choisit le périphérique d'entrée
// dans la fenêtre de permission micro de Firefox : pour capter le son de
// l'onglet proprement, il sélectionne un périphérique "Monitor"/loopback.
// L'audio est converti en PCM 16 kHz mono et envoyé au background en fragments.
//
// Partage le même monde isolé que overlay.js (mêmes globals accessibles), mais on
// passe par le DOM pour rester découplé.

const capBrowserAPI = (typeof browser !== 'undefined') ? browser : chrome;

let capStream      = null;
let capAudioCtx    = null;
let capSource      = null;
let capWorkletNode = null;
let capGain        = null;
let capRunning     = false;

function capFindPanel() {
  return document.getElementById('rtfc-panel');
}

// Injecte une barre "micro" en haut de l'overlay, dès que le panneau existe.
function capInjectBar(attempt) {
  attempt = attempt || 0;
  const panel = capFindPanel();
  if (!panel) {
    if (attempt < 25) setTimeout(() => capInjectBar(attempt + 1), 200);
    return;
  }
  if (panel.querySelector('#rtfc-capture-bar')) return;

  const bar = document.createElement('div');
  bar.id = 'rtfc-capture-bar';
  bar.setAttribute('style', [
    'display:flex', 'flex-direction:column', 'gap:6px',
    'padding:10px 12px', 'margin:0',
    'border-bottom:0.5px solid rgba(255,255,255,0.07)',
  ].join(';'));

  const btn = document.createElement('button');
  btn.id = 'rtfc-capture-btn';
  btn.type = 'button';
  btn.textContent = '🎙 Activer la capture audio';
  btn.setAttribute('style', [
    'background:rgba(74,222,128,0.12)', 'color:#4ade80',
    'border:0.5px solid rgba(74,222,128,0.4)', 'border-radius:7px',
    'padding:8px 12px', 'font-family:Inter,sans-serif', 'font-size:12px',
    'font-weight:600', 'cursor:pointer', 'width:100%', 'text-align:center',
  ].join(';'));

  const hint = document.createElement('div');
  hint.id = 'rtfc-capture-hint';
  hint.setAttribute('style', 'font-size:10px;color:#777;line-height:1.4;');
  hint.innerHTML = 'Dans la fenêtre de permission, choisissez votre périphérique d\u2019entrée. ' +
    'Pour le son de l\u2019onglet : sélectionnez un périphérique « Monitor » / loopback.';

  bar.appendChild(btn);
  bar.appendChild(hint);

  const header = panel.querySelector('#rtfc-header');
  if (header) header.insertAdjacentElement('afterend', bar);
  else panel.insertBefore(bar, panel.firstChild);

  btn.onclick = capStart;
}

function capUpdateButton(on) {
  const btn = document.getElementById('rtfc-capture-btn');
  if (btn) {
    btn.textContent = on ? '⏹ Arrêter la capture audio' : '🎙 Activer la capture audio';
    if (on) {
      btn.style.background = 'rgba(248,113,113,0.12)';
      btn.style.color = '#f87171';
      btn.style.borderColor = 'rgba(248,113,113,0.4)';
      btn.onclick = () => { capStop(); capBrowserAPI.runtime.sendMessage({ type: 'CAPTURE_ENDED' }).catch(() => {}); };
    } else {
      btn.style.background = 'rgba(74,222,128,0.12)';
      btn.style.color = '#4ade80';
      btn.style.borderColor = 'rgba(74,222,128,0.4)';
      btn.onclick = capStart;
    }
  }
  const hint = document.getElementById('rtfc-capture-hint');
  if (hint) hint.style.display = on ? 'none' : '';
}

async function capStart() {
  if (capRunning) return;

  // getUserMedia exige un geste utilisateur (le clic sur ce bouton) sous Firefox.
  try {
    capStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  } catch (err) {
    capBrowserAPI.runtime.sendMessage({
      type: 'CAPTURE_ERROR',
      message: 'Micro refusé ou indisponible : ' + err.message,
    }).catch(() => {});
    return;
  }

  const tracks = capStream.getAudioTracks();
  if (!tracks.length) {
    capBrowserAPI.runtime.sendMessage({
      type: 'CAPTURE_ERROR',
      message: 'Aucune piste audio disponible.',
    }).catch(() => {});
    capStop();
    return;
  }

  // AudioContext à 16 kHz : rééchantillonne automatiquement vers la fréquence
  // attendue par Deepgram.
  capAudioCtx = new AudioContext({ sampleRate: 16000 });
  if (capAudioCtx.state === 'suspended') {
    try { await capAudioCtx.resume(); } catch (e) {}
  }

  capSource = capAudioCtx.createMediaStreamSource(capStream);
  capGain   = capAudioCtx.createGain();
  capGain.gain.value = 0; // graphe maintenu actif mais SILENCIEUX (pas de larsen)

  // Charge le processeur audio depuis un FICHIER (via runtime.getURL) : déclaré en
  // web_accessible_resources, ce chargement contourne la CSP des sites tiers.
  try {
    await capAudioCtx.audioWorklet.addModule(
      capBrowserAPI.runtime.getURL('src/content/pcm-worklet.js')
    );
  } catch (err) {
    capBrowserAPI.runtime.sendMessage({
      type: 'CAPTURE_ERROR',
      message: 'Échec du chargement du module audio : ' + err.message,
    }).catch(() => {});
    capStop();
    return;
  }

  capWorkletNode = new AudioWorkletNode(capAudioCtx, 'rtfc-pcm-processor');
  capWorkletNode.port.onmessage = (e) => {
    // e.data = ArrayBuffer PCM Int16 (même format que l'ancien chunk)
    capBrowserAPI.runtime.sendMessage({ type: 'AUDIO_CHUNK', chunk: e.data }).catch(() => {});
  };

  capSource.connect(capWorkletNode);
  capWorkletNode.connect(capGain);
  capGain.connect(capAudioCtx.destination);

  // Si l'utilisateur coupe le périphérique / la piste se termine
  tracks[0].addEventListener('ended', () => {
    capBrowserAPI.runtime.sendMessage({ type: 'CAPTURE_ENDED' }).catch(() => {});
    capStop();
  });

  capRunning = true;
  capBrowserAPI.runtime.sendMessage({ type: 'CAPTURE_STARTED' }).catch(() => {});
  capUpdateButton(true);
}

function capStop() {
  capRunning = false;

  if (capWorkletNode) {
    try { capWorkletNode.disconnect(); } catch (e) {}
    if (capWorkletNode.port) capWorkletNode.port.onmessage = null;
    capWorkletNode = null;
  }
  if (capSource) { try { capSource.disconnect(); } catch (e) {} capSource = null; }
  if (capGain)   { try { capGain.disconnect();   } catch (e) {} capGain = null; }
  if (capAudioCtx) { try { capAudioCtx.close(); } catch (e) {} capAudioCtx = null; }
  if (capStream) { capStream.getTracks().forEach(t => t.stop()); capStream = null; }

  capUpdateButton(false);
}

capBrowserAPI.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_FACTCHECK') {
    capInjectBar(0);
  } else if (msg.type === 'STOP_FACTCHECK') {
    capStop();
  }
});
