// pcm-worklet.js  (AudioWorkletProcessor)
// Tourne sur le thread audio dédié (pas le thread principal de la page) → plus de
// risque de saccade. Convertit le flux en PCM Int16 mono et le poste au thread
// principal par paquets de 4096 échantillons, soit la même cadence (~4 messages/s
// à 16 kHz) que l'ancien ScriptProcessor. La conversion float32→int16 est
// rigoureusement identique à l'implémentation précédente.

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(4096);
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true; // pas d'entrée ce tour-ci → on reste actif

    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._pos++] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
      if (this._pos === this._buf.length) {
        const out = this._buf.slice(0);                 // copie transférable
        this.port.postMessage(out.buffer, [out.buffer]); // transfert (zéro-copie)
        this._pos = 0;
      }
    }
    return true; // garde le processeur vivant
  }
}

registerProcessor('rtfc-pcm-processor', PCMProcessor);
