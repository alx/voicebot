# Design: Preparing WhatsApp Voice Bot for Public (Open-Source) Release

**Date**: 2026-07-05
**Status**: Approved

## Context

This is a personal WhatsApp voice bot (STT → LLM → TTS pipeline, hybrid Node.js + Python) built through a couple of iterations — an earlier WAHA/FastAPI webhook design, then rewritten around `whatsapp-web.js`. Git history is a single squashed "first commit," so there's no incremental history to lean on.

The goal of this project is to **open-source the code** (publish the repo publicly, e.g. on GitHub, so others can read/run/fork it) — not to operate it as a long-running public-facing service. That said, since other people will self-host this from the published repo, it's worth fixing a few robustness gaps that any self-hoster would hit quickly, in addition to the cleanup/portability work open-sourcing requires.

## Goals

1. Remove personal/environment-specific information (hardcoded IP, absolute paths, personal dev-log docs) so the repo is safe and sensible to publish.
2. Remove dead code left over from the abandoned WAHA/FastAPI architecture, and fix a real dependency bug (`piper-tts` is missing from `requirements.txt`, so TTS wouldn't actually work in a fresh install).
3. Add basic robustness so a self-hoster's bot doesn't fall over on the first oversized voice note or overlapping message: audio validation, subprocess timeout, serialized processing.
4. Bring repo hygiene up to open-source norms: LICENSE file, committed lockfile, an accurate README including a Piper model setup step and a disclaimer about `whatsapp-web.js`'s unofficial/ToS-risk status.

## Non-goals

- Turning this into a hardened, multi-tenant public service (rate limiting per external user, auth, horizontal scaling). Out of scope — this is a self-hosted personal bot template, not a SaaS.
- Rewriting the architecture to a persistent Python worker (removing per-message Whisper model reload). Explicitly deferred — documented as a known limitation instead.
- Multi-language support / i18n. The bot is French-first by design; instead of building language switching, the three places to change (`STT_LANGUAGE`, `SYSTEM_PROMPT`, Piper voice model) will be documented under a "Customization" README section.
- Rewriting git history. The existing squashed history is left as-is.

## Sections

### 1. Config & secrets portability

**Problem**: `src/config.py`, `bot/config.js` (indirectly, via `.env`), and `start_bot.sh` reference `http://100.86.147.125:8081` directly — the author's personal Tailscale-networked LLM server. This can't ship in a public repo as a literal value.

**Change**:
- Add `LLM_BASE_URL` (default `http://localhost:8081`) and `LLM_MODEL_NAME` to `.env.example` / `.env`.
- `src/config.py`: derive `LLM_API_URL` / `LLM_HEALTH_URL` from `LLM_BASE_URL` via `os.getenv`, instead of hardcoding the IP.
- `start_bot.sh`: read the same env var for its connectivity-check `curl`, instead of the hardcoded IP.

### 2. Dead code / cruft removal

**Problem**: Leftovers from the abandoned WAHA/FastAPI webhook architecture remain in the repo, and `requirements.txt` is missing a dependency the pipeline actually needs.

**Change**:
- `requirements.txt`: remove `fastapi`, `uvicorn`, `pydantic`, `python-multipart` (unused — nothing in `src/` imports them). Add `piper-tts` (currently missing entirely; `pipeline.py` shells out to the `piper` CLI, so a fresh `pip install -r requirements.txt` would leave TTS non-functional).
- `src/config.py`: remove `WAHA_URL`, `WAHA_SESSION`, `WAHA_WEBHOOK_PORT`, `VOICEBOT_CHAT_ID` (and its `warnings.warn`), and `TTS_MODEL_NAME` / `TTS_SPEAKER_WAV` (references XTTS v2, which is never used — Piper is hardcoded in `pipeline.py::synthesize_speech`).
- `src/__init__.py`: drop "with WAHA Integration" from the docstring.
- `README.md`: remove the "Advantages Over WAHA" and "Files Changed from WAHA Version" sections.
- `docs/STATUS.md`: remove (personal dev log with absolute paths and a dated point-in-time status). Fold anything still relevant (e.g. expected latency numbers) into README as a brief "Performance" note.

### 3. Robustness fixes

**Problem**: Existing safety limits aren't wired up, and the message-handling path has no protection against a hung subprocess or concurrent processing.

**Change**:
- **Audio validation**: call the existing (but currently unused) `audio_converter.validate_audio_file()` from `pipeline_cli.py` before `run_pipeline()` runs, using `config.AUDIO_MAX_SIZE_MB` and a max-duration constant. Rejects oversized/too-long voice notes with a clean JSON error instead of running a multi-minute transcription.
- **Subprocess timeout**: `voice-handler.js::callPythonPipeline()` gets a timeout (configurable, default ~90s). On timeout, kill the subprocess and reject with a clear error that gets surfaced to the WhatsApp chat via the existing error-notification path.
- **Serialized processing**: add a simple in-process queue (promise chain) around `handleVoiceMessage` in `voice-handler.js` (or its caller in `index.js`) so voice messages are processed one at a time — no two Whisper model loads competing for the same CPU/GPU concurrently.

### 4. Repo hygiene & docs

**Change**:
- Add a root `LICENSE` file (MIT), matching what `package.json`/README already declare.
- Un-ignore and commit `bot/package-lock.json` for reproducible installs.
- Rewrite `README.md`:
  - Reflect the env-var LLM config from Section 1.
  - Add a step for downloading/installing the Piper voice model + `piper` CLI (currently completely undocumented — a fresh clone has no path to a working TTS binary).
  - Add a short disclaimer that `whatsapp-web.js` is an unofficial WhatsApp client (violates WhatsApp's ToS in the strict sense, carries a small ban risk) — material information for anyone self-hosting.
  - Add a "Customization" section documenting the 3 places to change for another language (`STT_LANGUAGE`, `SYSTEM_PROMPT`, Piper voice model).
  - Add a brief "Known limitations" note covering: per-message Whisper reload overhead (not a persistent worker), single-instance/no-horizontal-scaling, no per-user rate limiting.

## Testing

- Manual: run `start_bot.sh` end-to-end after config changes, confirm `.env.example` → `.env` flow still works with a local/self-hosted LLM.
- Manual: send an oversized/too-long voice note, confirm validation rejects it cleanly instead of hanging.
- Manual: send two voice messages in quick succession, confirm they're processed sequentially, not concurrently.
- `tests/step1/*` manual scripts remain as-is (left in place, out of scope for this change per earlier decision).
