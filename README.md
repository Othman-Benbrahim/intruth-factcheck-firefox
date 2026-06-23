# InTruth — Firefox Real-Time Fact-Checking Extension

> **Note**  
> This repository is a Firefox adaptation of the original [InTruth](https://github.com/rpanigrahi222/intruth-factcheck) project by Risha Panigrahi.  
> This version focuses on real-time transcription, bilingual French/English support, and configurable LLM-based fact-checking.

## Overview

**InTruth** is a Firefox extension for real-time fact-checking of spoken content: political debates, interviews, livestreams, conferences, speeches, press briefings, and video discussions.

The extension captures the audio of the active tab, sends it to Deepgram for live transcription, extracts factual claims from the transcript with a configured LLM, and displays verdicts directly on the page through an overlay.

The project is designed as a **Bring Your Own Key** tool: users provide their own API keys, and the extension stores them locally in the browser.

---

## Main Features

### Real-time audio transcription

InTruth captures tab audio and sends it to Deepgram through a WebSocket connection.

The current version is configured for **French + English transcription** using a multilingual Deepgram setup:

```txt
model = nova-3
language = multi
```

This allows the extension to handle French, English, and mixed French/English speech more reliably.

### Live claim detection

The extension does not analyze raw audio directly. It analyzes the text produced by Deepgram.

The pipeline is:

```txt
tab audio
→ Deepgram transcription
→ final transcript chunks
→ sentence window
→ LLM claim extraction
→ JSON parsing
→ verdict display
→ optional web grounding
```

Only factual, checkable claims are extracted. Opinions, rhetorical statements, vague predictions, and subjective judgments should normally be ignored.

### LLM-based fact-checking

InTruth can use:

- Anthropic-compatible models;
- OpenAI-compatible endpoints;
- local OpenAI-compatible servers such as LM Studio;
- cloud OpenAI-compatible providers such as FantasyAI, if configured in the manifest for testing.

The LLM is expected to return structured JSON verdicts.

### Bilingual claim handling

The current pipeline supports French and English claims. When possible, the LLM can return:

```json
{
  "claim": "original claim",
  "claim_fr": "French version",
  "claim_en": "English version",
  "verdict": "UNVERIFIABLE",
  "speaker": "Speaker 1",
  "explanation": "Short explanation",
  "confidence": 0.5
}
```

This helps the extension search and reason across French and English sources.

### Runtime status and error handling

The extension now includes more robust handling for:

- invalid LLM API keys;
- unreachable endpoints;
- malformed LLM responses;
- empty LLM responses;
- unsupported reasoning-model behavior;
- Deepgram connection errors;
- model responses that do not contain valid JSON.

Important runtime errors are surfaced to the UI instead of failing silently.

---

## Important: use a non-reasoning model

This is critical.

InTruth expects the LLM response to be available in the OpenAI-compatible response field:

```js
choices[0].message.content
```

Some reasoning/thinking models return their internal reasoning in a field such as:

```js
choices[0].message.reasoning
```

while leaving:

```js
choices[0].message.content
```

empty.

When that happens, InTruth receives a valid API response, but no usable final answer. The result is usually an error such as:

```txt
Endpoint LLM: response received but text content not found.
```

or:

```txt
LLM: empty response, no exploitable analysis received.
```

### Recommended model behavior

Use a model that:

- returns the final answer in `choices[0].message.content`;
- follows short JSON instructions reliably;
- is not reasoning-only;
- does not hide the final answer inside a `reasoning` field;
- can return compact JSON arrays.

### Avoid for now

Avoid models that:

- only produce chain-of-thought/reasoning output;
- return empty `message.content`;
- require special parameters to expose final answers;
- do not reliably follow JSON-only instructions.

### Practical test

Before using the extension in a real video, test your model with a simple sentence:

```txt
La capitale de la France est Paris.
```

A working model should produce at least one parsed claim and one verdict.

---

## Supported verdicts

The LLM should classify claims using one of these labels:

```txt
TRUE
SUBSTANTIALLY TRUE
FALSE
MISLEADING
UNVERIFIABLE
```

The UI may display these verdicts in a user-friendly form.

---

## What counts as a verifiable claim?

### Checked

Examples of claims that can be checked:

- “France has more than 60 million inhabitants.”
- “Donald Trump was president of the United States.”
- “Inflation reached 9.1% in the United States in 2022.”
- “This law was passed by the Senate in 2021.”
- “Iran signed the JCPOA in 2015.”

### Ignored

Examples of claims that should usually be ignored:

- “This policy is terrible.”
- “My opponent is dishonest.”
- “This will destroy the economy.”
- “I have the best plan.”
- “People are worried.”

These are opinions, predictions, value judgments, or vague statements rather than directly checkable factual claims.

---

## Configuration

### Required API keys

You need:

1. a **Deepgram API key** for transcription;
2. an **LLM API key** for claim extraction and verdict generation.

Depending on your setup, you may also need:

3. a **Serper API key** if web search grounding is enabled in your version.

### LLM providers

The popup supports two main provider modes:

```txt
Anthropic
OpenAI-compatible / LM Studio
```

Use **OpenAI-compatible / LM Studio** for providers such as:

- LM Studio local server;
- OpenAI-compatible local endpoints;
- FantasyAI;
- other cloud providers exposing `/chat/completions`.

### FantasyAI test configuration

For FantasyAI, use the OpenAI-compatible mode.

Recommended base endpoint:

```txt
https://fantasyai.cloud/api/v1
```

Do not paste the full chat-completions URL unless your service-worker is specifically designed to handle it.

The service-worker normally builds:

```txt
<base_url>/chat/completions
```

So the final request becomes:

```txt
https://fantasyai.cloud/api/v1/chat/completions
```

### Firefox manifest permissions

For cloud providers, Firefox needs the provider domain in `host_permissions`.

For a test version using FantasyAI, add:

```json
"https://fantasyai.cloud/*"
```

For Deepgram, add:

```json
"https://api.deepgram.com/*"
```

A typical test configuration may include:

```json
"host_permissions": [
  "https://api.anthropic.com/*",
  "https://google.serper.dev/*",
  "https://api.deepgram.com/*",
  "https://fantasyai.cloud/*",
  "https://fonts.googleapis.com/*",
  "https://fonts.gstatic.com/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
]
```

If you use another cloud LLM provider, add its domain too:

```json
"https://your-provider-domain.com/*"
```

---

## Installation

### Manual Firefox installation

1. Clone the repository:

```bash
git clone https://github.com/Othman-Benbrahim/intruth-factcheck-firefox.git
```

2. Open Firefox.

3. Go to:

```txt
about:debugging#/runtime/this-firefox
```

4. Click:

```txt
Load Temporary Add-on
```

5. Select the extension `manifest.json` file.

For this repository, the manifest is located in:

```txt
realtime-factcheck/manifest.json
```

6. Open a compatible video page.

7. Click the InTruth extension icon.

8. Enter your API keys and LLM configuration.

9. Start fact-checking.

---

## Usage

1. Open a video, livestream, debate, speech, interview, or press conference.
2. Click the extension icon.
3. Configure:
   - Deepgram API key;
   - LLM provider;
   - LLM endpoint;
   - LLM model;
   - LLM API key.
4. Start the session.
5. The overlay appears on the page.
6. The transcript is generated in real time.
7. The service-worker groups final transcript chunks.
8. The LLM extracts checkable claims.
9. Verdicts appear in the overlay.

---

## How the pipeline works

### 1. Audio capture

The content script captures audio from the active tab after the user starts a session.

### 2. Deepgram transcription

Audio chunks are streamed to Deepgram.

The extension uses a multilingual transcription mode so French and English speech can be handled in the same session.

### 3. Final transcript chunks

The service-worker listens for final Deepgram segments.

Only final text chunks are sent into the claim-analysis pipeline.

### 4. Sentence window

The service-worker groups final transcript chunks into a short window before analysis.

This reduces noise and gives the LLM enough context to detect meaningful factual statements.

### 5. LLM analysis

The LLM receives the transcript window and returns a JSON array of possible claims and verdicts.

### 6. JSON parsing

The service-worker parses the response.

The parser is designed to tolerate common LLM formatting issues, such as:

- Markdown code fences;
- text around JSON;
- object instead of array;
- small JSON formatting errors;
- compact partial results.

### 7. Verdict display

When valid claims are found, the service-worker sends them to the overlay.

### 8. Optional grounding

If enabled, the extension can run search-based grounding and update verdicts with sources.

---

## Troubleshooting

### Deepgram transcribes but no verdict appears

This means audio and transcription are working. The issue is probably after transcription:

```txt
transcript OK
→ sentence window OK
→ LLM call or JSON parsing issue
```

Check:

- whether your LLM endpoint is correct;
- whether your model returns content in `choices[0].message.content`;
- whether the model is non-reasoning;
- whether the model follows JSON-only instructions;
- whether the transcript contains actual factual claims.

### Error: content text not found

If you see an error like:

```txt
Endpoint LLM: response received but text content not found.
```

then the API responded, but the extension could not find usable text.

Common cause:

```js
choices[0].message.content === ""
choices[0].message.reasoning !== ""
```

This usually means the selected model is a reasoning/thinking model.

Use a non-reasoning chat/instruct model instead.

### Error: JSON invalid

This means the model answered, but the answer was not valid JSON.

Try:

- a smaller/faster model that follows formatting instructions;
- a non-reasoning model;
- shorter transcript windows;
- simpler prompts;
- a model known to return structured JSON reliably.

### FantasyAI endpoint issues

Use:

```txt
https://fantasyai.cloud/api/v1
```

as the base URL.

Avoid accidentally creating:

```txt
/chat/completions/chat/completions
```

in the final request URL.

### Local LM Studio

If using LM Studio, use an endpoint similar to:

```txt
http://localhost:1234/v1
```

or:

```txt
http://127.0.0.1:1234/v1
```

Make sure the model is loaded and the server is running.

### Firefox permission issue

If a cloud request is blocked, add the provider domain to `host_permissions` in `manifest.json`.

Example:

```json
"https://fantasyai.cloud/*"
```

Then reload the temporary extension in Firefox.

---

## Privacy

- API keys are stored locally in Firefox storage.
- The extension author does not receive user keys.
- Audio is sent to Deepgram for transcription.
- Transcript chunks are sent to the configured LLM provider for analysis.
- If web grounding is enabled, claim queries may be sent to a search provider.
- Users should review the privacy policies of their chosen API providers.

---

## Limitations

Real-time fact-checking is difficult.

InTruth can produce:

- false positives;
- missed claims;
- incomplete verdicts;
- outdated analysis;
- overconfident judgments;
- errors caused by poor transcription;
- errors caused by ambiguous speech;
- errors caused by LLM formatting failures.

The extension is an assistance tool, not an authority.

Always consult primary sources for important claims.

---

## Recommended test phrase

After configuration, test the pipeline with:

```txt
La capitale de la France est Paris.
```

Expected behavior:

```txt
Deepgram transcribes the sentence
→ LLM extracts the claim
→ JSON is parsed
→ a verdict appears in the overlay
```

If this does not work, the problem is likely in the LLM configuration or model behavior.

---

## Project structure

Typical structure:

```txt
realtime-factcheck/
├── manifest.json
├── src/
│   ├── background/
│   │   └── service-worker.js
│   ├── content/
│   │   ├── overlay.js
│   │   ├── capture.js
│   │   ├── lexical-features.js
│   │   └── session-export.js
│   └── popup/
│       ├── popup.html
│       ├── popup.css
│       └── popup.js
└── assets/
```

Key files:

- `service-worker.js`: Deepgram WebSocket, LLM calls, claim extraction, verdict routing.
- `overlay.js`: on-page UI for transcript, claims, verdicts, and runtime errors.
- `popup.js`: provider configuration, key validation, start/stop controls.
- `manifest.json`: Firefox permissions and extension configuration.

---

## Development notes

When debugging the pipeline, check the order:

```txt
Deepgram connected
→ transcript received
→ sentence window updated
→ evaluateClaims started
→ LLM HTTP response received
→ content extracted
→ JSON parsed
→ verdicts sent
```

If the pipeline stops at `content extracted`, check the model response shape.

If it stops at `JSON parsed`, check whether the model returns valid JSON.

If verdicts are sent but not shown, inspect `overlay.js`.

---

## License

MIT License. See `LICENSE`.

