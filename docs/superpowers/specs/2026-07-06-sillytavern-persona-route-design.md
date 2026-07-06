# SillyTavern Persona Route — Design

## Goal

Add an optional alternate path for the pipeline's LLM step that routes through a live SillyTavern instance instead of calling the raw LLM API directly — so replies can come from a real chat persona (character card, personality, memory) defined and maintained in SillyTavern, with multi-turn conversation memory, rather than the current stateless one-shot system prompt.

## Scope

- A new `st-bridge` Node service that drives a real SillyTavern web UI via Puppeteer and exposes a small local HTTP API.
- A new `query_sillytavern()` method in `src/pipeline.py`, selected via a config flag (`LLM_BACKEND`), that calls `st-bridge` instead of the direct LLM API.
- One shared conversation/history for the whole configured WhatsApp group (matches the bot's existing single-group scope — no per-sender identity is tracked today).
- A setup guide (`docs/SILLYTAVERN_SETUP.md`) covering installing SillyTavern, connecting it to an LLM backend, creating a persona/character, and configuring `st-bridge` to point at that character's chat.
- Out of scope: per-sender sessions, automatic fallback from SillyTavern back to the direct LLM path on failure, world-info/lorebook-specific guidance beyond linking SillyTavern's own docs, dynamic character switching mid-conversation, remote/network security hardening beyond a documented caveat.

## Why browser automation (not a REST/plugin integration)

SillyTavern is architected as the *client* that connects out to LLM backends (Chat Completion sources); it does not expose an official, stable REST endpoint for a third party to say "send this message to character X, get a reply with history." The persona/world-info/memory injection logic lives in SillyTavern's front-end JS, not in a server-callable API. A custom server plugin could add an HTTP endpoint to SillyTavern's Node server, but it's unclear such a plugin can trigger full persona-aware generation without also shipping a companion browser-side extension — a real risk of hitting a wall mid-implementation.

Driving the actual web UI with Puppeteer sidesteps this entirely: it uses SillyTavern exactly as a human would, so persona injection, world info, instruct templates, and multi-turn history (SillyTavern's own per-character chat log) all work with zero reimplementation. This is also consistent with the existing codebase, which already automates a web client (whatsapp-web.js) via Puppeteer for the WhatsApp side.

## Architecture

A third component sits alongside the existing Node bot and Python pipeline:

```
WhatsApp → whatsapp-web.js → Node bot → Python pipeline ─┬→ query_llm()          (direct, existing)
                                                          └→ query_sillytavern() → st-bridge (Puppeteer) → SillyTavern UI → LLM
```

`query_llm()` remains the default; the SillyTavern route is opt-in via config.

## Components

### 1. `config.py` additions

```python
LLM_BACKEND = os.getenv("LLM_BACKEND", "direct")  # "direct" | "sillytavern"
ST_BRIDGE_URL = os.getenv("ST_BRIDGE_URL", "http://localhost:8091")
ST_BRIDGE_TIMEOUT = 60  # seconds
```

### 2. `src/pipeline.py` changes

- New method `query_sillytavern(user_text: str) -> str`: POSTs `{"text": user_text}` to `f"{self.config.ST_BRIDGE_URL}/reply"`, returns the `reply` field from the JSON response. Raises `VoicePipelineError` on request failure, timeout, non-200 status, or empty reply — mirroring `query_llm()`'s existing error contract exactly.
- `run_pipeline()`'s Step 2 branches on `self.config.LLM_BACKEND`:
  ```python
  if self.config.LLM_BACKEND == "sillytavern":
      llm_response = self.query_sillytavern(transcription)
  else:
      llm_response = self.query_llm(transcription, detected_lang)
  ```
- No changes to STT (Step 1) or TTS (Step 3) — the SillyTavern route only replaces the LLM step's *source*, not the surrounding pipeline shape or the `run_pipeline()` return contract.

### 3. `st-bridge/` — new standalone Node service

```
st-bridge/
  package.json     # puppeteer, express (or similar minimal HTTP server)
  server.js         # HTTP API + browser lifecycle
  .env.example      # ST_BASE_URL, ST_CHARACTER_NAME, PORT, etc.
```

**Startup behavior:**
1. Launch one headless Chromium instance (same launch-arg pattern as `bot/index.js`'s Puppeteer config), with a persistent user-data-dir so SillyTavern's browser-side session/login survives restarts (analogous to whatsapp-web.js's `LocalAuth`).
2. Navigate to the configured SillyTavern instance (`ST_BASE_URL`) and open the chat for the configured character (`ST_CHARACTER_NAME`).
3. Keep this single page open for the lifetime of the process — this *is* the shared group conversation's persistent session.

**HTTP API:**
- `POST /reply` — body `{"text": "<user message>"}`. Types the text into SillyTavern's chat input, submits it, waits for generation to complete (polls for the "generating" indicator to clear or a new assistant message to appear, up to a configurable timeout), scrapes the latest assistant message's text, responds `{"reply": "<text>"}`.
- Defensive single-flight guard: reject/queue a second `/reply` while one is in-flight (belt-and-suspenders — the Node bot's `voiceQueue` already serializes calls end-to-end, so this should never actually be hit in normal operation).

**Known fragility (explicit, not hidden):** the DOM selectors for the chat input, generation-in-progress indicator, and message list depend on whatever SillyTavern version is actually installed and can break across SillyTavern UI updates. These get determined by inspecting the real running instance during implementation, and should be isolated in one place in `server.js` so a future SillyTavern upgrade only requires updating selectors, not the API contract.

### 4. Process management

`st-bridge` runs as its own long-lived process, separate from the Node bot and Python pipeline (which is invoked per-message as a subprocess). Documented as a new step in `start_bot.sh` / README quick-start: start `st-bridge` before the WhatsApp bot when `LLM_BACKEND=sillytavern`.

### 5. `docs/SILLYTAVERN_SETUP.md` — new setup guide

Step-by-step, covering:
1. Installing and running SillyTavern (clone, `npm install`, run with `--listen` if network-exposed).
2. Connecting SillyTavern itself to an LLM backend (its own Chat Completion source config — can point at the same `llama-server` the bot already uses, via SillyTavern's "Custom (OpenAI-compatible)" source).
3. Creating a character/persona: name, description, personality, scenario, example dialogue.
4. Starting a chat with that character (this is the chat `st-bridge` will keep open).
5. Configuring `st-bridge/.env` (`ST_BASE_URL`, `ST_CHARACTER_NAME`) and the bot's `.env` (`LLM_BACKEND=sillytavern`, `ST_BRIDGE_URL`).
6. A callout that if SillyTavern runs on a separate machine, exposing it over a network is the user's responsibility to secure (VPN, reverse proxy with auth, etc.) — not handled by this integration.

## Data Flow

```
Voice message → STT (unchanged) → transcription text
  → LLM_BACKEND == "sillytavern"?
      yes → query_sillytavern(text)
              → POST st-bridge /reply {text}
                  → st-bridge types text into open SillyTavern chat tab
                  → waits for generation to finish
                  → scrapes reply text
              → returns {reply}
      no  → query_llm(text, lang)   (existing direct call, unchanged)
  → llm_response → TTS (unchanged) → audio reply
```

## Error Handling

- `st-bridge` unreachable, timeout, or scrape failure → `query_sillytavern()` raises `VoicePipelineError`, exactly like a failed `query_llm()` call today → surfaced to the WhatsApp group via the existing `❌ Erreur` status message. No new error-handling path needed in the Node bot or `voice-handler.js`.
- **No automatic fallback** to the direct LLM path when the SillyTavern route fails. When `LLM_BACKEND=sillytavern` is set, failures stay visible rather than silently degrading to a different (non-persona) response, which would be confusing to the user receiving replies.

## Concurrency

The Node bot's `voiceQueue` (`bot/queue.js`) already serializes voice message handling to one at a time end-to-end, so `st-bridge` will only ever receive one `/reply` request at a time in normal operation. The single-flight guard in `st-bridge` is defensive insurance, not load-bearing.

## Testing

- `src/pipeline.py`: unit tests for the `LLM_BACKEND` branch in `run_pipeline()` and for `query_sillytavern()`'s error handling, mocking the HTTP call to `st-bridge` the same way existing tests would mock `query_llm()`.
- `st-bridge`: browser automation against a real SillyTavern UI is inherently hard to unit test (same limitation as `whatsapp-web.js` in this codebase). Verification here is manual/integration: run `st-bridge` against a real SillyTavern instance and confirm a round-trip reply.

## Non-Goals (YAGNI)

- Per-sender conversation sessions (the bot has no per-sender identity plumbed through today; adding it is a separate, larger change).
- Automatic fallback between backends on failure.
- World-info/lorebook-specific guidance beyond linking SillyTavern's own docs.
- Dynamic character switching mid-conversation.
- Network security hardening for a remote SillyTavern deployment (documented as the user's responsibility).
