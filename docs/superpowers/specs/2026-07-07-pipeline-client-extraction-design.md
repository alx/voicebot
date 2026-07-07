# Pipeline-Client Extraction + Config Pruning — Design

## Goal

Remove the duplication between `bot/voice-handler.js` and `bot/text-handler.js`
by extracting the Node→Python invocation seam into a single module, bring
`voice-handler` up to the same testability standard as `text-handler`, and
prune confirmed-dead configuration from `src/config.py`.

This is slice 1 of two. Slice 2
([2026-07-07-persistent-python-worker-design.md](2026-07-07-persistent-python-worker-design.md))
replaces the spawn-per-message model with a persistent worker; this slice
creates the exact module whose internals slice 2 will swap, so the handlers
never have to change again.

Behavior is unchanged throughout this slice. All existing tests must keep
passing.

## Scope

- New `bot/pipeline-client.js` owning subprocess invocation and result parsing.
- New shared error-notification helper used by both handlers.
- Dependency-injection seam and a test file for `voice-handler.js`.
- Dead-key removal and light documentation in the three config files.
- Out of scope: any change to the spawn-per-message model (slice 2), any
  change to the Python pipeline logic, any user-visible behavior change.

## Design

### `bot/pipeline-client.js` (new)

Exports:

- `runVoicePipeline(audioPath, logPrefix)` — spawns
  `python -m src.pipeline_cli <audioPath> --json --output-format ogg`.
- `runTextPipeline(text, logPrefix)` — spawns
  `python -m src.pipeline_cli --text=<text> --json`.
- `buildTextPipelineArgs(text)` — moved verbatim from `text-handler.js`,
  including the comment explaining the single-token `--text=` packing
  (argparse flag-ambiguity protection for values starting with `-`).

Both run functions share one internal implementation: compute the repo-root
cwd, call `runWithTimeout` with `config.PYTHON_CMD`, `config.PIPELINE_TIMEOUT_MS`
and an `onStderr` forwarder prefixed with `logPrefix`, parse stdout as JSON
(wrapping parse failures in a descriptive error that includes the raw output),
and throw if the parsed result carries an `error` field. This consolidates the
currently near-identical `callPythonPipeline` (voice-handler) and
`callTextPipeline` (text-handler).

### Shared error notification

The catch-block duplicated verbatim in both handlers — log the error, and if
`config.ENABLE_ERROR_NOTIFICATIONS`, format `config.STATUS_MESSAGES.error`
and send it via `tracker.sendTracked`, swallowing (but logging) send
failures — becomes one exported helper:

```js
notifyError(chat, tracker, error, logPrefix)
```

It lives in a small `bot/notify-error.js` module (or inside
`pipeline-client.js` if, at implementation time, a separate file feels like
overkill for ~15 lines — implementer's choice; a separate file is the default).

### `voice-handler.js` testability

`handleVoiceMessage` gains the same optional trailing `deps = {}` parameter
`handleTextMessage` already has, with an injectable `runPipeline` override
(defaulting to `runVoicePipeline`). New `bot/voice-handler.test.js` covers:

1. Happy path: acknowledgment, transcription, LLM response, and voice audio
   are sent via `tracker.sendTracked` in that order.
2. Pipeline error: the error notification is sent and the handler does not
   throw.
3. Temp-file cleanup runs on both success and failure paths.

Tests stub `msg.downloadMedia()` and the filesystem interactions the same way
the existing handler tests stub their collaborators.

### Config pruning (`src/config.py`)

Delete keys with no references outside `config.py` itself. Confirmed dead by
grep across `src/` and `tests/`:

- `STATUS_MESSAGES` (the live copy is in `bot/config.js`)
- `MAX_RETRIES`, `RETRY_DELAY`
- `AUDIO_DOWNLOAD_TIMEOUT`
- `LOGS_DIR`
- `ENABLE_ERROR_NOTIFICATIONS` (the live copy is in `bot/config.js`)
- `TTS_LANGUAGE`, `TTS_DEVICE`

Each deletion is re-verified by grep at implementation time before removal;
`AUDIO_INPUT_DIR` is checked the same way and deleted if also unreferenced.

Add `TTS_MODEL_PATH` (defaulting to
`models/piper/fr_FR-siwis-medium.onnx` under `PROJECT_ROOT`) and use it in
`VoicePipeline._ensure_tts` instead of the path currently hardcoded there.

### Config ownership documentation

Each of the three config files gets a short header comment stating its scope:

- `bot/config.js` — WhatsApp-side behavior: group targeting, status messages,
  subprocess invocation limits.
- `src/config.py` — pipeline behavior: model selection, LLM endpoints, audio
  limits.
- `st-bridge/config.js` — SillyTavern bridge: ports, timeouts, tool settings.

The header also notes the one deliberately duplicated value: `TEXT_MAX_CHARS`
exists in both `bot/config.js` and `src/config.py` (both env-overridable via
the same `TEXT_MAX_CHARS` variable) so that Node can reject oversized messages
without spawning Python, while Python still enforces the limit for direct CLI
use.

## Error handling

Unchanged by design: the same errors produce the same user-facing messages.
The only structural change is where the code lives.

## Testing

- All existing `bot/*.test.js` and `tests/*.py` must pass unchanged (except
  `test_config.py`, updated if it references deleted keys).
- New: `bot/voice-handler.test.js` (three cases above).
- New or extended: unit tests for `pipeline-client.js` argument building and
  JSON/error parsing, migrating the relevant cases from
  `text-handler.test.js` where they now belong.
