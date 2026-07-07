# Persistent Python Worker + LLM Backend Split — Design

## Goal

Replace the spawn-per-message Python subprocess model with a single
long-lived Python worker, so models load once per bot lifetime instead of
once per message, and split the two LLM backends out of `VoicePipeline` into
a strategy module.

Today every voice or text message spawns a fresh `python -m src.pipeline_cli`
process, which re-creates `VoicePipeline`, re-runs the LLM health check, and
(for voice) reloads the Whisper model from disk — several seconds of avoidable
latency per message.

This is slice 2 of two. It depends on slice 1
([2026-07-07-pipeline-client-extraction-design.md](2026-07-07-pipeline-client-extraction-design.md)),
which concentrates the Node→Python seam in `bot/pipeline-client.js`; this
slice swaps that module's internals without touching the handlers.

## Scope

- New `src/worker.py`: long-lived process speaking JSON-lines over
  stdin/stdout.
- New `src/llm_backends.py`: backend strategy objects replacing the
  `LLM_BACKEND` branching inside `VoicePipeline`.
- Rewritten internals of `bot/pipeline-client.js`: spawn-once, request/response
  correlation, crash respawn, timeout kill.
- `src/pipeline_cli.py` is kept as a manual-testing tool but no longer invoked
  by the bot; README architecture section updated accordingly.
- Out of scope: concurrent request processing in the worker (the Node queue
  already serializes messages), any HTTP transport, changes to `st-bridge`,
  changes to handler behavior or user-facing messages.

## Architecture

```
node bot/index.js ──spawn once (first request)──▶ python -m src.worker
        │                                              │
        │  {"id":1,"type":"voice","audio_path":…,      │  VoicePipeline built once;
        │   "output_format":"ogg"}\n                   │  Whisper/health check load
        │ ───────────────── stdin ──────────────────▶  │  once, reused thereafter
        │ ◀──────────────── stdout ─────────────────   │
        │  {"id":1,"success":true,"transcription":…}\n │  logs → stderr (unchanged)
```

### Protocol (JSON-lines)

One JSON object per line, UTF-8, `\n`-terminated. Worker stdout carries only
protocol lines; all logging stays on stderr, as `pipeline_cli` does today.

Requests:

```json
{"id": 1, "type": "voice", "audio_path": "/…/x.ogg", "output_format": "ogg"}
{"id": 2, "type": "text",  "text": "bonjour"}
```

Responses echo the request `id`:

```json
{"id": 1, "success": true, "transcription": "…", "language": "fr",
 "llm_response": "…", "output_audio_path": "/…/x_response.ogg", "timing": {…}}
{"id": 2, "success": false, "error": "…", "error_type": "validation_error"}
```

`error_type` reuses the existing CLI vocabulary: `pipeline_error`,
`file_not_found`, `validation_error`, `unexpected_error`. A line that cannot
be parsed as JSON, or that lacks a valid `type`, produces a
`{"id": <id or null>, "success": false, …}` response rather than killing the
worker.

### `src/worker.py`

- Builds one `VoicePipeline` at startup, then loops: read line → dispatch →
  write response line → flush.
- Sequential processing only; the Node-side queue already guarantees one
  in-flight message at a time.
- Request validation moves here from the CLI: voice requests run
  `validate_audio_file` (size/duration limits) before touching models; text
  requests enforce `TEXT_MAX_CHARS`. Cheap rejection is preserved.
- Voice requests honor `output_format: "ogg"` with the same WAV→OGG conversion
  and intermediate-file cleanup the CLI does today.
- Per-request exceptions are caught and mapped to error responses; the worker
  exits only on EOF (Node closed stdin) or an unrecoverable startup failure.

### `bot/pipeline-client.js` (internals rewritten, API unchanged)

Public API stays `runVoicePipeline(audioPath, logPrefix)` /
`runTextPipeline(text, logPrefix)` — the handlers do not change.

- **Spawn-once:** the worker is spawned lazily on the first request and kept
  for the process lifetime. Worker stderr is forwarded to the bot log.
- **Correlation:** a monotonically increasing `id` and a pending-request map
  `id → {resolve, reject, timer}`; stdout is split on newlines and each line
  resolved against the map. (With sequential processing this is nearly FIFO,
  but id-matching keeps the client correct regardless.)
- **Timeout:** each request arms a `PIPELINE_TIMEOUT_MS` timer. On timeout the
  client kills the worker (SIGKILL after a short SIGTERM grace, mirroring
  `subprocess-timeout.js`), rejects the pending request with a timeout error,
  and clears its handle so the next request respawns a fresh worker. This
  preserves today's hung-pipeline protection.
- **Crash:** if the worker exits unexpectedly, all pending requests reject and
  the next request respawns it. No retry is attempted automatically — the user
  sees the same error notification a failed spawn produces today and can
  resend the message.
- `subprocess-timeout.js` remains in place for any other callers/tests but the
  pipeline path no longer uses it.

### `src/llm_backends.py`

```python
def create_backend(config) -> Backend  # chosen by config.LLM_BACKEND
```

- `DirectBackend.get_reply(text)` — today's `query_llm` (OpenAI-compatible
  chat completions), including the startup health check, which moves here.
- `SillyTavernBackend.get_reply(text)` — today's `query_sillytavern` plus
  `_strip_narration`, which move here with their tests.

`VoicePipeline.__init__` calls `create_backend(config)` once; `run_pipeline`
and `run_text_pipeline` both call `self.backend.get_reply(...)`, eliminating
the duplicated `if config.LLM_BACKEND == "sillytavern"` branches. Adding a
future backend means one new class in one file.

Note: `DirectBackend.get_reply` drops the unused `language` parameter that
`query_llm` currently accepts; nothing consumes it.

### Fate of `pipeline_cli.py`

Kept as a manual-testing entry point with unchanged behavior (it now simply
constructs the pipeline the same way the worker does, via the backend module).
The README architecture diagram and the "one message at a time / hung
subprocess killed after a timeout" feature wording are updated to describe the
worker model.

## Error handling

- Worker-level: every per-request failure becomes an error response line; the
  handlers surface it through the existing `notifyError` path, so user-facing
  messages are unchanged.
- Client-level: timeout and crash both reject with descriptive errors and
  leave the client in a state where the next message transparently respawns
  the worker.
- Startup failure (e.g. missing Python deps): the first request rejects with
  the spawn/exit error, same visibility as a failed CLI spawn today.

## Testing

Python (`tests/test_worker.py`):

- Feed request lines to the worker's dispatch function with a stubbed
  `VoicePipeline`; assert success and error response envelopes, id echoing,
  unparseable-line handling, and text/voice validation rejections.

Python (`tests/test_llm_backends.py`):

- Backend selection by `LLM_BACKEND`; migrate the existing
  `query_llm`/`query_sillytavern`/`_strip_narration` test cases to the new
  module.

Node (`bot/pipeline-client.test.js`):

- Against a small fake worker script (a Node or Python one-liner):
  1. normal request/response round-trip,
  2. worker crash mid-request → pending request rejects, next request
     respawns,
  3. hang → timeout fires, worker is killed, next request respawns.

Existing handler tests pass unchanged — the seam they mock is the slice-1
client API, which this slice does not alter.
