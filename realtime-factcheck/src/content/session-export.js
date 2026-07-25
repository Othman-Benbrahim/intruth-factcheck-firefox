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

// ── Lecture de la mémoire de session (background) ───────────────────────────
// L'historique vit désormais dans le background : il survit à une navigation
// ou à un rechargement de la page. On retombe sur le journal local si le
// background ne répond pas.

function entriesFromSession(session) {
  if (!session || !Array.isArray(session.events)) return [];
  return session.events
    .filter(e => e.type === 'CLAIM')
    .map(e => ({
      timestamp:      new Date(e.createdAt).toISOString(),
      secondsElapsed: Math.round((e.offsetMs || 0) / 1000),
      claim:          e.text,
      verdict:        e.verdict,
      confidence:     e.confidence,
      explanation:    e.explanation,
      speakerConfidence: e.speakerConfidence,
      speakerName:    e.speaker || (e.speakerId && session.speakers ? session.speakers[e.speakerId] : null),
      sources:        e.sources || [],
      corroboration:  e.corroboration || null,
      status:         e.status,
      mediaTimestamp: e.mediaTimestamp || null,
    }));
}

function discourseFromSession(session) {
  if (!session || !Array.isArray(session.events)) return [];
  return session.events
    .filter(e => e.type === 'PREDICTION' || e.type === 'COMMITMENT')
    .map(e => ({
      type:    e.type,
      text:    e.text,
      speaker: e.speaker || (e.speakerId && session.speakers ? session.speakers[e.speakerId] : null),
      horizon: e.horizon || null,
      secondsElapsed: Math.round((e.offsetMs || 0) / 1000),
    }));
}

function requestSession() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res || null);
      });
    } catch (_) { resolve(null); }
  });
}

function buildReviewSection(review) {
  if (!review) return [];
  const LABELS = {
    FALSE_DILEMMA: 'Faux dilemme',
    WHATABOUTISM:  'Contre-accusation',
    AD_HOMINEM:    'Attaque personnelle',
  };
  const lines = [];
  lines.push('## Revue de session');
  lines.push('');
  if (review.summary) { lines.push(mdInline(review.summary)); lines.push(''); }

  if (review.patterns && review.patterns.length) {
    lines.push('**Constantes observées**');
    lines.push('');
    review.patterns.forEach(p => lines.push('- ' + mdInline(p)));
    lines.push('');
  }

  lines.push('**Procédés rhétoriques relevés**');
  lines.push('');
  if (review.findings && review.findings.length) {
    review.findings.forEach(f => {
      lines.push('- **' + (LABELS[f.type] || f.type) + '**' + (f.speaker ? ' · ' + mdInline(f.speaker) : ''));
      lines.push('  > ' + mdInline(f.quote));
      lines.push('  ' + mdInline(f.criterion));
      lines.push('');
    });
  } else {
    lines.push('_Aucun procédé retenu. Les constats non étayés par une citation exacte sont écartés automatiquement._');
    lines.push('');
  }

  if (review.unresolved && review.unresolved.length) {
    lines.push('**Affirmations restées sans vérification**');
    lines.push('');
    review.unresolved.forEach(u => lines.push('- ' + mdInline(u)));
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  return lines;
}

function buildDiscourseSection(items) {
  if (!items || !items.length) return [];
  const label = (t) => (t === 'PREDICTION' ? 'Prédiction' : 'Engagement');
  const lines = [];
  lines.push('## Prédictions et engagements');
  lines.push('');
  lines.push('_Consignés sans verdict : ces énoncés ne sont ni vrais ni faux au moment où ils sont prononcés. Ils sont relevés pour pouvoir être réexaminés plus tard._');
  lines.push('');
  items.forEach((it) => {
    const head = '**' + label(it.type) + '**' +
      (it.speaker ? ' · ' + mdInline(it.speaker) : '') +
      ' · `' + mdTimestamp(it.secondsElapsed) + '`' +
      (it.horizon ? ' · échéance : ' + mdInline(it.horizon) : '');
    lines.push(head);
    lines.push('');
    lines.push('> ' + mdInline(it.text));
    lines.push('');
  });
  lines.push('---');
  lines.push('');
  return lines;
}

function buildMarkdown(entries, meta) {
  const rows = Array.isArray(entries) && entries.length ? entries : sessionLog;
  const pageTitle  = (meta && meta.title) || document.title || 'Fact Check Session';
  const exportDate = new Date().toLocaleString();

  const count = (v) => rows.filter(e => e.verdict === v).length;

  const lines = [];
  lines.push('# Rapport de fact-checking');
  lines.push('');
  lines.push('- **Source :** ' + mdInline(pageTitle));
  lines.push('- **Exporté le :** ' + exportDate);
  lines.push('- **Affirmations détectées :** ' + rows.length);
  if (meta && meta.durationMs) {
    const mn = Math.floor(meta.durationMs / 60000);
    lines.push('- **Durée de session :** ' + mn + ' min');
  }
  const enAttente = rows.filter(e => e.status === 'pending').length;
  if (enAttente) lines.push('- **Vérifications encore en cours :** ' + enAttente);
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
  rows.forEach((entry, i) => {
    const raw = entry.speakerName;
    const spk = (raw && !raw.match(/^Speaker\s*\d+$/i) && raw !== 'Other') ? raw : 'Inconnu';
    if (!groups[spk]) { groups[spk] = []; order.push(spk); }
    groups[spk].push({ entry, i });
  });

  if (meta && meta.review) {
    lines.push(...buildReviewSection(meta.review));
  }

  if (meta && meta.discourse && meta.discourse.length) {
    lines.push(...buildDiscourseSection(meta.discourse));
  }

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
      if (entry.corroboration) {
        const c = entry.corroboration;
        const bits = [c.band || '?', (c.voices || 0) + ' voix indépendante' + ((c.voices || 0) > 1 ? 's' : '')];
        if (c.primaries) bits.push(c.primaries + ' source' + (c.primaries > 1 ? 's' : '') + ' primaire' + (c.primaries > 1 ? 's' : ''));
        if (c.circular)  bits.push('reprise circulaire détectée');
        lines.push('- **Corroboration :** ' + bits.join(' · '));
      }
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

async function exportPDF() {
  const res     = await requestSession();
  const entries = entriesFromSession(res && res.session);
  const rows    = entries.length ? entries : sessionLog;

  if (!rows.length) {
    alert('Aucune affirmation détectée pour le moment.');
    return;
  }

  const meta = {
    title:      (res && res.session && res.session.source && res.session.source.title) || document.title,
    durationMs: (res && res.summary && res.summary.durationMs) || 0,
    discourse:  discourseFromSession(res && res.session),
    review:     (res && res.session && res.session.review) || null,
  };

  const md   = buildMarkdown(rows, meta);
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
