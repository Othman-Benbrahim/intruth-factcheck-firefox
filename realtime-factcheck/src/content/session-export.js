// session-export.js
// Journalisation de session + export Markdown.
// Chargé après overlay.js — expose logVerdict(), startSession(), stopSession(),
// exportPDF() comme globaux.
// NB : la fonction garde le nom exportPDF() pour rester branchée au bouton de
// overlay.js, mais elle produit désormais un fichier MARKDOWN (.md), pas du HTML.

const sessionLog = [];
let sessionStartTime = null;

function logVerdict(result) {
  sessionLog.push({
    timestamp: new Date().toISOString(),
    secondsElapsed: sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0,
    claim: result.claim,
    verdict: result.verdict,
    confidence: result.confidence,
    explanation: result.explanation,
    speakerConfidence: result.speaker_confidence,
    speakerExplanation: result.speaker_confidence_explanation,
    speakerName: result.speaker || null,
    sources: result.sources ?? [],
  });
}

function startSession() {
  sessionLog.length = 0;
  sessionStartTime = Date.now();
}

function stopSession() {
  sessionStartTime = null;
}

// ── Helpers Markdown ──────────────────────────────────────────────────────────

function mdEscape(s) {
  // échappe les caractères Markdown qui casseraient le rendu
  return String(s ?? '').replace(/([\\`*_{}\[\]<>|])/g, '\\$1');
}

function mdInline(s) {
  // pour le texte courant : on aplatit les retours à la ligne puis on échappe
  return mdEscape(String(s ?? '').replace(/\s*\n\s*/g, ' ').trim());
}

function mdTimestamp(secondsElapsed) {
  const total = secondsElapsed || 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function verdictEmoji(v, c) {
  if (c === 'LOW') return '🟡';
  switch (v) {
    case 'TRUE':               return '✅';
    case 'SUBSTANTIALLY TRUE': return '🟢';
    case 'FALSE':              return '❌';
    case 'MISLEADING':         return '⚠️';
    case 'UNVERIFIABLE':       return '❔';
    default:                   return '•';
  }
}

function verdictLabelFr(v) {
  switch (v) {
    case 'TRUE':               return 'VRAI';
    case 'SUBSTANTIALLY TRUE': return 'SUBSTANTIELLEMENT VRAI';
    case 'FALSE':              return 'FAUX';
    case 'MISLEADING':         return 'TROMPEUR / HORS CONTEXTE';
    case 'UNVERIFIABLE':       return 'INVÉRIFIABLE';
    default:                   return v || '—';
  }
}

// ── Construction du Markdown ──────────────────────────────────────────────────

function buildMarkdown() {
  const pageTitle  = document.title || 'Fact Check Session';
  const exportDate = new Date().toLocaleString();

  const count = (v) => sessionLog.filter(e => e.verdict === v).length;

  const lines = [];
  lines.push('# Rapport de fact-checking');
  lines.push('');
  lines.push('- **Source :** ' + mdInline(pageTitle));
  lines.push('- **Exporté le :** ' + exportDate);
  lines.push('- **Affirmations détectées :** ' + sessionLog.length);
  lines.push('');
  lines.push('## Résumé');
  lines.push('');
  lines.push('| Verdict | Nombre |');
  lines.push('|---|---|');
  lines.push('| ✅ Vrai | ' + count('TRUE') + ' |');
  lines.push('| 🟢 Substantiellement vrai | ' + count('SUBSTANTIALLY TRUE') + ' |');
  lines.push('| ❌ Faux | ' + count('FALSE') + ' |');
  lines.push('| ⚠️ Trompeur / hors contexte | ' + count('MISLEADING') + ' |');
  lines.push('| ❔ Invérifiable | ' + count('UNVERIFIABLE') + ' |');
  lines.push('');

  // groupement par locuteur (les "Speaker N" non résolus et "Other" → Inconnu)
  const groups = {};
  const order  = [];
  sessionLog.forEach((entry, i) => {
    const raw = entry.speakerName;
    const spk = (raw && !raw.match(/^Speaker\s*\d+$/i) && raw !== 'Other') ? raw : 'Inconnu';
    if (!groups[spk]) { groups[spk] = []; order.push(spk); }
    groups[spk].push({ entry, i });
  });

  lines.push('## Affirmations');
  lines.push('');

  order.forEach((spk) => {
    const items = groups[spk];
    lines.push('### ' + mdInline(spk) + ' — ' + items.length + ' affirmation' + (items.length !== 1 ? 's' : ''));
    lines.push('');

    items.forEach(({ entry, i }) => {
      const ts   = mdTimestamp(entry.secondsElapsed);
      const head = verdictEmoji(entry.verdict, entry.confidence) +
        ' **#' + (i + 1) + ' · ' + verdictLabelFr(entry.verdict) + '**' +
        ' · certitude : ' + (entry.confidence || 'N/A') +
        ' · `' + ts + '`';
      lines.push(head);
      lines.push('');
      lines.push('> ' + mdInline(entry.claim));
      lines.push('');
      if (entry.explanation) {
        lines.push(mdInline(entry.explanation));
        lines.push('');
      }
      lines.push('- **Conviction du locuteur :** ' + (entry.speakerConfidence || 'N/A'));
      if (entry.sources && entry.sources.length) {
        const srcs = entry.sources.map((url, j) => {
          return /^https?:\/\//.test(url) ? '[Source ' + (j + 1) + '](' + url + ')' : mdInline(url);
        }).join(' · ');
        lines.push('- **Sources :** ' + srcs);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    });
  });

  lines.push('_Généré par InTruth. Le fact-checking automatique est imparfait : en cas de doute, vérifiez les sources primaires._');
  lines.push('');

  return lines.join('\n');
}

// ── Export (Markdown) ─────────────────────────────────────────────────────────

function exportPDF() {
  if (!sessionLog.length) {
    alert('Aucune affirmation détectée pour le moment.');
    return;
  }

  const md   = buildMarkdown();
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url  = URL.createObjectURL(blob);

  const d = new Date();
  const stamp = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');

  const a = document.createElement('a');
  a.href     = url;
  a.download = 'factcheck-report-' + stamp + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
