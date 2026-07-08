# Persistent Python Worker + LLM Backend Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the spawn-per-message Python subprocess model with a single long-lived `src/worker.py` process speaking JSON-lines over stdin/stdout, and split the two LLM backends out of `VoicePipeline` into a `src/llm_backends.py` strategy module.

**Architecture:** `bot/pipeline-client.js` currently spawns `python -m src.pipeline_cli` fresh for every message. This plan adds `src/worker.py` (built once, loops on stdin) and rewrites `pipeline-client.js`'s internals to spawn that worker lazily on first use, keep it alive, correlate requests/responses by id, and respawn it transparently on timeout or crash. The public API (`runVoicePipeline`, `runTextPipeline`) is unchanged, so `voice-handler.js` and `text-handler.js` (built in the prior slice) need no changes. On the Python side, `query_llm`/`query_sillytavern` move out of `VoicePipeline` into `DirectBackend`/`SillyTavernBackend` classes in `src/llm_backends.py`, selected once at construction time via `create_backend(config)`.

**Tech Stack:** Node 18+ ESM with `node:test` (run via `npm --prefix bot test`), Python with pytest (run via `uv run --python .venv/bin/python -m pytest tests/` — this repo always invokes its venv through `uv run`, never the interpreter path directly).

**Spec:** `docs/superpowers/specs/2026-07-07-persistent-python-worker-design.md`

**Depends on:** slice 1 (`docs/superpowers/plans/2026-07-07-pipeline-client-extraction.md`, merged into `main`) — this plan builds on `bot/pipeline-client.js`, `bot/notify-error.js`, and the already-refactored handlers.

## Global Constraints

- Protocol: one JSON object per line, UTF-8, `\n`-terminated. Requests carry `{"id": <int>, "type": "voice"|"text", ...}`. Responses echo `id` and carry `success` plus payload fields flattened at the top level (not nested under a `result` key) — e.g. `{"id":1,"success":true,"transcription":"…","language":"…","llm_response":"…","output_audio_path":"…","timing":{…}}`.
- `error_type` vocabulary is exactly: `pipeline_error`, `file_not_found`, `validation_error`, `unexpected_error` (reused verbatim from the existing CLI).
- A line that cannot be parsed as JSON, or whose `type` is not `"voice"`/`"text"`, must produce an error response (`success: false`) — it must never crash or exit the worker process.
- The worker processes requests strictly sequentially (no concurrency) — the Node-side queue already guarantees one in-flight message at a time.
- `bot/pipeline-client.js`'s public API stays exactly `runVoicePipeline(audioPath, logPrefix)` / `runTextPipeline(text, logPrefix)`. `bot/voice-handler.js` and `bot/text-handler.js` must not change.
- The worker is spawned lazily on the first request, kept alive across requests, and transparently respawned after a crash or a timeout-triggered kill (next request after either gets a fresh process).
- Timeout kill sequence: SIGTERM, then SIGKILL after a short grace period.
- `DirectBackend.get_reply(text)` drops the unused `language` parameter that `query_llm` used to accept — nothing consumes it.
- Out of scope: concurrent request processing in the worker, any HTTP transport, changes to `st-bridge`, changes to handler behavior or user-facing message text.
- `src/pipeline_cli.py` keeps working unchanged as a manual-testing tool; it is no longer invoked by the bot.
- All existing tests must keep passing (`npm --prefix bot test`, `npm --prefix st-bridge test`, `uv run --python .venv/bin/python -m pytest tests/`), except tests explicitly updated by a task here.
- Commit messages follow the repo convention (`feat:`/`fix:`/`refactor:`/`test:`/`docs:` prefixes) and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Always run Python via `uv run --python .venv/bin/python -m ...`, never `.venv/bin/python` directly.

---

### Task 1: Extract LLM backends into `src/llm_backends.py`

**Files:**
- Create: `src/llm_backends.py`
- Create: `tests/test_llm_backends.py`
- Modify: `src/pipeline.py` (full new content for the touched sections below)
- Modify: `tests/test_pipeline.py` (full replacement — see Step 5)

**Interfaces:**
- Produces (used by Task 2 and by `src/pipeline.py` itself):
  - `class VoicePipelineError(Exception)` — moves here from `src/pipeline.py`; `src/pipeline.py` re-exports it so `from src.pipeline import VoicePipeline, VoicePipelineError` keeps working unchanged for `src/pipeline_cli.py`, `src/worker.py` (Task 2), and existing tests.
  - `create_backend(config) -> DirectBackend | SillyTavernBackend` — picks by `getattr(config, "LLM_BACKEND", "direct")` (uses `getattr` with a default so callers that build a partial config object, as several existing tests do, don't need to set `LLM_BACKEND` explicitly).
  - `DirectBackend(config)` with `.get_reply(text: str) -> str` — runs the startup LLM health check in its constructor (moved from `VoicePipeline.__init__`, so it now only runs when `DirectBackend` is actually selected, not unconditionally as before).
  - `SillyTavernBackend(config)` with `.get_reply(text: str) -> str`.
  - `_strip_narration(text: str) -> str` — moves here verbatim.
- `VoicePipeline.backend` — set once in `__init__` via `create_backend(config_module)`; `run_pipeline` and `run_text_pipeline` call `self.backend.get_reply(...)` instead of branching on `config.LLM_BACKEND` themselves. `VoicePipeline.query_llm` and `VoicePipeline.query_sillytavern` no longer exist.

Note the intentional behavior refinement: previously `VoicePipeline.__init__` always ran the direct-LLM health check, even when `LLM_BACKEND="sillytavern"` (a pre-existing quirk). After this change, only `DirectBackend`'s constructor runs it, so it only fires when that backend is actually selected. This is a deliberate consequence of correctly encapsulating the health check inside the backend that uses it — not an unreviewed regression.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_llm_backends.py`:

```python
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest
import requests

from src.llm_backends import (
    DirectBackend,
    SillyTavernBackend,
    VoicePipelineError,
    create_backend,
    _strip_narration,
)


def _st_config(**overrides):
    defaults = {"ST_BRIDGE_URL": "http://localhost:8091", "ST_BRIDGE_TIMEOUT": 60}
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _direct_config(**overrides):
    defaults = {
        "LLM_API_URL": "http://localhost:8081/v1/chat/completions",
        "LLM_HEALTH_URL": "http://localhost:8081/health",
        "LLM_MODEL_NAME": "test-model",
        "SYSTEM_PROMPT": "Tu es un assistant.",
        "LLM_TEMPERATURE": 0.7,
        "LLM_MAX_TOKENS": 200,
        "LLM_TIMEOUT": 60,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_direct_backend(**overrides):
    with patch("src.llm_backends.requests.get", side_effect=requests.exceptions.ConnectionError("refused")):
        return DirectBackend(_direct_config(**overrides))


def test_create_backend_returns_direct_by_default():
    backend = create_backend(_direct_config(LLM_BACKEND="direct"))
    assert isinstance(backend, DirectBackend)


def test_create_backend_returns_direct_when_llm_backend_missing():
    config = _direct_config()  # no LLM_BACKEND attribute at all
    backend = create_backend(config)
    assert isinstance(backend, DirectBackend)


def test_create_backend_returns_sillytavern_when_configured():
    backend = create_backend(_st_config(LLM_BACKEND="sillytavern"))
    assert isinstance(backend, SillyTavernBackend)


def test_direct_backend_checks_health_on_construction():
    with patch("src.llm_backends.requests.get") as mock_get:
        mock_get.return_value = MagicMock(status_code=200)
        DirectBackend(_direct_config())
    mock_get.assert_called_once_with("http://localhost:8081/health", timeout=5)


def test_direct_backend_construction_tolerates_failed_health_check():
    backend = _make_direct_backend()
    assert isinstance(backend, DirectBackend)


def test_direct_backend_get_reply_returns_llm_content():
    backend = _make_direct_backend()
    mock_response = MagicMock()
    mock_response.json.return_value = {"choices": [{"message": {"content": "Bonjour!"}}]}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response) as mock_post:
        result = backend.get_reply("Salut")

    assert result == "Bonjour!"
    mock_post.assert_called_once_with(
        "http://localhost:8081/v1/chat/completions",
        json={
            "model": "test-model",
            "messages": [
                {"role": "system", "content": "Tu es un assistant."},
                {"role": "user", "content": "Salut"},
            ],
            "temperature": 0.7,
            "max_tokens": 200,
        },
        timeout=60,
    )


def test_direct_backend_get_reply_raises_on_request_exception():
    backend = _make_direct_backend()

    with patch(
        "src.llm_backends.requests.post",
        side_effect=requests.exceptions.ConnectionError("refused"),
    ):
        with pytest.raises(VoicePipelineError, match="LLM query failed"):
            backend.get_reply("Salut")


def test_direct_backend_get_reply_raises_on_empty_response():
    backend = _make_direct_backend()
    mock_response = MagicMock()
    mock_response.json.return_value = {"choices": [{"message": {"content": "   "}}]}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Empty LLM response"):
            backend.get_reply("Salut")


def test_sillytavern_backend_returns_reply_on_success():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "Bonjour!"}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response) as mock_post:
        result = backend.get_reply("Salut")

    assert result == "Bonjour!"
    mock_post.assert_called_once_with(
        "http://localhost:8091/reply",
        json={"text": "Salut"},
        timeout=60,
    )


def test_sillytavern_backend_raises_on_request_exception():
    backend = SillyTavernBackend(_st_config())

    with patch(
        "src.llm_backends.requests.post",
        side_effect=requests.exceptions.ConnectionError("refused"),
    ):
        with pytest.raises(VoicePipelineError, match="SillyTavern bridge query failed"):
            backend.get_reply("Salut")


def test_sillytavern_backend_raises_on_empty_reply():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "   "}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Empty SillyTavern reply"):
            backend.get_reply("Salut")


def test_sillytavern_backend_raises_on_malformed_json():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"unexpected": "shape"}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Malformed SillyTavern bridge response"):
            backend.get_reply("Salut")


def test_sillytavern_backend_raises_on_non_string_reply():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": None}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Malformed SillyTavern bridge response"):
            backend.get_reply("Salut")


def test_sillytavern_backend_strips_narration_from_reply():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "*sourit* Bonjour !"}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        result = backend.get_reply("Salut")

    assert result == "Bonjour !"


def test_strip_narration_removes_asterisk_wrapped_asides():
    assert _strip_narration("*sourit* Bonjour !") == "Bonjour !"


def test_strip_narration_returns_original_text_when_entirely_narration():
    assert _strip_narration("*hausse les épaules*") == "*hausse les épaules*"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --python .venv/bin/python -m pytest tests/test_llm_backends.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.llm_backends'`.

- [ ] **Step 3: Write `src/llm_backends.py`**

```python
"""
LLM backend strategies for VoicePipeline: query an OpenAI-compatible chat
completions endpoint directly, or route the reply through a SillyTavern
persona bridge (st-bridge). Selected once at pipeline construction time via
create_backend(config).
"""
import re
import time
import logging

import requests

logger = logging.getLogger(__name__)


class VoicePipelineError(Exception):
    """Custom exception for pipeline errors"""
    pass


_ACTION_TEXT_PATTERN = re.compile(r'\*[^*]+\*')


def _strip_narration(text: str) -> str:
    """
    Remove *action/narration* asides some roleplay personas still emit despite
    being instructed to reply with spoken dialogue only. Safety net for the
    SillyTavern route on top of the persona-level instruction (chat Author's
    Note / variables) — not a substitute for it, since dialogue that isn't
    asterisk-wrapped passes through untouched.
    """
    cleaned = _ACTION_TEXT_PATTERN.sub('', text)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned or text


class DirectBackend:
    """Queries an OpenAI-compatible chat completions endpoint directly."""

    def __init__(self, config):
        self.config = config
        self._check_health()

    def _check_health(self):
        logger.info(f"Testing LLM: {self.config.LLM_API_URL}")
        start = time.time()
        try:
            response = requests.get(self.config.LLM_HEALTH_URL, timeout=5)
            if response.status_code == 200:
                logger.info(f"   ✓ Connected in {time.time() - start:.2f}s")
            else:
                raise Exception(f"Health check failed: {response.status_code}")
        except Exception as e:
            logger.warning(f"   ⚠ LLM health check failed: {e}")
            logger.warning(f"   Pipeline will continue, but LLM queries may fail")

    def get_reply(self, text: str) -> str:
        """
        Query LLM via llama-server OpenAI-compatible API

        Args:
            text: User input text

        Returns:
            LLM response text

        Raises:
            VoicePipelineError: If LLM query fails
        """
        logger.info(f"[LLM] Querying: {self.config.LLM_MODEL_NAME}")
        start = time.time()

        payload = {
            "model": self.config.LLM_MODEL_NAME,
            "messages": [
                {"role": "system", "content": self.config.SYSTEM_PROMPT},
                {"role": "user", "content": text}
            ],
            "temperature": self.config.LLM_TEMPERATURE,
            "max_tokens": self.config.LLM_MAX_TOKENS
        }

        try:
            response = requests.post(
                self.config.LLM_API_URL,
                json=payload,
                timeout=self.config.LLM_TIMEOUT
            )
            response.raise_for_status()

            data = response.json()
            llm_response = data["choices"][0]["message"]["content"].strip()

            elapsed = time.time() - start
            logger.info(f"[LLM] ✓ Completed in {elapsed:.2f}s")
            logger.info(f"[LLM] Response: \"{llm_response}\"")

            if not llm_response.strip():
                raise VoicePipelineError("Empty LLM response")

            return llm_response

        except requests.exceptions.RequestException as e:
            logger.error(f"[LLM] ✗ LLM query failed: {e}")
            raise VoicePipelineError(f"LLM query failed: {e}")


class SillyTavernBackend:
    """Routes replies through the SillyTavern persona bridge (st-bridge)."""

    def __init__(self, config):
        self.config = config

    def get_reply(self, text: str) -> str:
        """
        Get a persona-driven reply via the SillyTavern bridge

        Args:
            text: User input text

        Returns:
            SillyTavern reply text

        Raises:
            VoicePipelineError: If the bridge call fails
        """
        logger.info(f"[LLM] Querying SillyTavern bridge: {self.config.ST_BRIDGE_URL}")
        start = time.time()

        try:
            response = requests.post(
                f"{self.config.ST_BRIDGE_URL}/reply",
                json={"text": text},
                timeout=self.config.ST_BRIDGE_TIMEOUT
            )
            response.raise_for_status()

            data = response.json()
            try:
                reply = data["reply"].strip()
            except (KeyError, TypeError, AttributeError) as e:
                raise VoicePipelineError(f"Malformed SillyTavern bridge response: {e}")

            if not reply:
                raise VoicePipelineError("Empty SillyTavern reply")

            reply = _strip_narration(reply)

            elapsed = time.time() - start
            logger.info(f"[LLM] ✓ SillyTavern reply in {elapsed:.2f}s")
            logger.info(f"[LLM] Response: \"{reply}\"")

            return reply

        except requests.exceptions.RequestException as e:
            logger.error(f"[LLM] ✗ SillyTavern bridge query failed: {e}")
            raise VoicePipelineError(f"SillyTavern bridge query failed: {e}")


def create_backend(config):
    """Select a backend instance based on config.LLM_BACKEND (defaults to direct)."""
    if getattr(config, "LLM_BACKEND", "direct") == "sillytavern":
        return SillyTavernBackend(config)
    return DirectBackend(config)
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `uv run --python .venv/bin/python -m pytest tests/test_llm_backends.py -v`
Expected: PASS (16 tests).

- [ ] **Step 5: Rewrite `src/pipeline.py`**

Replace the entire content of `src/pipeline.py` with:

```python
"""
Voice Pipeline - STT->LLM->TTS with structured output
Refactored from test_pipeline.py for production use
"""
import os
import time
import subprocess
import logging
from datetime import datetime
from pathlib import Path
from faster_whisper import WhisperModel
from typing import Dict, Any, Tuple

from src.llm_backends import VoicePipelineError, create_backend

logger = logging.getLogger(__name__)


class VoicePipeline:
    """Voice processing pipeline: STT → LLM → TTS"""

    def __init__(self, config_module):
        """
        Initialize all pipeline components

        Args:
            config_module: Configuration module with all settings
        """
        self.config = config_module
        logger.info("=" * 60)
        logger.info("Voice Pipeline Initializing...")
        logger.info("=" * 60)

        # Ensure CUDA device is set
        os.environ["CUDA_VISIBLE_DEVICES"] = "0"

        self.backend = create_backend(config_module)

        logger.info("Pipeline ready (STT/TTS load lazily on first use)")

        logger.info("\n" + "=" * 60)
        logger.info("Pipeline Ready!")
        logger.info("=" * 60 + "\n")

    def _ensure_stt(self):
        """Lazily load the faster-whisper model on first use."""
        if getattr(self, "stt_model", None) is not None:
            return

        local_model_path = getattr(self.config, "STT_LOCAL_MODEL_PATH", None)
        use_local_path = local_model_path and os.path.isdir(local_model_path)
        logger.info(
            f"Loading STT: faster-whisper "
            f"({local_model_path if use_local_path else self.config.STT_MODEL_SIZE})"
        )
        start = time.time()
        try:
            if use_local_path:
                self.stt_model = WhisperModel(
                    model_size_or_path=local_model_path,
                    device=self.config.STT_DEVICE,
                    compute_type=self.config.STT_COMPUTE_TYPE,
                )
            else:
                self.stt_model = WhisperModel(
                    model_size_or_path=self.config.STT_MODEL_SIZE,
                    device=self.config.STT_DEVICE,
                    compute_type=self.config.STT_COMPUTE_TYPE,
                    download_root=self.config.STT_DOWNLOAD_ROOT
                )
            logger.info(f"   ✓ Loaded in {time.time() - start:.2f}s")
        except Exception as e:
            logger.error(f"   ✗ Failed to load STT model: {e}")
            raise VoicePipelineError(f"STT initialization failed: {e}")

    def transcribe_audio(self, audio_path: str) -> Tuple[str, str]:
        """
        Step 1: Transcribe audio to text using faster-whisper

        Args:
            audio_path: Path to audio file

        Returns:
            Tuple of (transcribed_text, detected_language)

        Raises:
            VoicePipelineError: If transcription fails
        """
        self._ensure_stt()
        logger.info(f"[STT] Transcribing: {Path(audio_path).name}")
        start = time.time()

        try:
            segments, info = self.stt_model.transcribe(
                audio=audio_path,
                language=self.config.STT_LANGUAGE,
                beam_size=self.config.STT_BEAM_SIZE,
                vad_filter=True,  # Voice activity detection
                vad_parameters=dict(min_silence_duration_ms=500)
            )

            # Collect all segments
            transcription = " ".join([segment.text.strip() for segment in segments])
            detected_lang = info.language if self.config.STT_LANGUAGE is None else self.config.STT_LANGUAGE

            elapsed = time.time() - start
            logger.info(f"[STT] ✓ Completed in {elapsed:.2f}s")
            logger.info(f"[STT] Language: {detected_lang}")
            logger.info(f"[STT] Text: \"{transcription}\"")

            if not transcription.strip():
                raise VoicePipelineError("Empty transcription (no speech detected)")

            return transcription, detected_lang

        except Exception as e:
            logger.error(f"[STT] ✗ Transcription failed: {e}")
            raise VoicePipelineError(f"STT failed: {e}")

    def _ensure_tts(self):
        """Lazily validate the Piper model path on first use."""
        if getattr(self, "piper_model", None) is not None:
            return

        piper_model = self.config.TTS_MODEL_PATH
        if not os.path.exists(piper_model):
            logger.error(f"   ✗ ERROR: Piper model not found at {piper_model}")
            raise VoicePipelineError(f"Piper model not found: {piper_model}")
        self.piper_model = piper_model

    def synthesize_speech(self, text: str, language: str, output_path: str):
        """
        Step 3: Synthesize speech using Piper TTS

        Args:
            text: Text to synthesize
            language: Language code
            output_path: Output audio file path

        Raises:
            VoicePipelineError: If synthesis fails
        """
        self._ensure_tts()
        logger.info(f"[TTS] Synthesizing speech ({language}) with Piper")
        start = time.time()

        try:
            # Ensure output directory exists
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # Use Piper via command line
            result = subprocess.run(
                ["piper", "--model", self.piper_model, "--output_file", output_path],
                input=text.encode('utf-8'),
                capture_output=True,
                check=True
            )

            elapsed = time.time() - start
            file_size = os.path.getsize(output_path) / 1024  # KB
            logger.info(f"[TTS] ✓ Completed in {elapsed:.2f}s")
            logger.info(f"[TTS] Saved: {output_path} ({file_size:.1f} KB)")

        except subprocess.CalledProcessError as e:
            logger.error(f"[TTS] ✗ TTS failed: {e}")
            logger.error(f"[TTS] stderr: {e.stderr.decode() if e.stderr else 'N/A'}")
            raise VoicePipelineError(f"TTS failed: {e}")
        except Exception as e:
            logger.error(f"[TTS] ✗ TTS error: {e}")
            raise VoicePipelineError(f"TTS error: {e}")

    def run_pipeline(self, input_wav: str, output_path: str = None) -> Dict[str, Any]:
        """
        Execute complete STT->LLM->TTS pipeline

        Args:
            input_wav: Path to input audio file
            output_path: Optional output path (auto-generated if not provided)

        Returns:
            Dict with:
                - transcription: str
                - language: str
                - llm_response: str
                - output_audio_path: str
                - timing: dict with stt, llm, tts, total times

        Raises:
            VoicePipelineError: If any step fails
        """
        # Validate input
        if not os.path.exists(input_wav):
            raise FileNotFoundError(f"Input file not found: {input_wav}")

        # Generate output filename with timestamp if not provided
        if output_path is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            input_name = Path(input_wav).stem
            output_filename = f"{input_name}_response_{timestamp}.wav"
            output_path = os.path.join(self.config.AUDIO_OUTPUT_DIR, output_filename)

        # Ensure output directory exists
        os.makedirs(self.config.AUDIO_OUTPUT_DIR, exist_ok=True)

        logger.info("\n" + "=" * 60)
        logger.info(f"PIPELINE EXECUTION START")
        logger.info(f"Input: {input_wav}")
        logger.info("=" * 60 + "\n")

        pipeline_start = time.time()
        timing = {}

        try:
            # Step 1: STT
            stt_start = time.time()
            transcription, detected_lang = self.transcribe_audio(input_wav)
            timing['stt'] = time.time() - stt_start

            # Step 2: LLM
            llm_start = time.time()
            llm_response = self.backend.get_reply(transcription)
            timing['llm'] = time.time() - llm_start

            # Step 3: TTS
            tts_start = time.time()
            self.synthesize_speech(llm_response, detected_lang, output_path)
            timing['tts'] = time.time() - tts_start

            timing['total'] = time.time() - pipeline_start

            logger.info("=" * 60)
            logger.info(f"PIPELINE EXECUTION COMPLETE")
            logger.info(f"Total Time: {timing['total']:.2f}s")
            logger.info(f"Output: {output_path}")
            logger.info("=" * 60 + "\n")

            return {
                "transcription": transcription,
                "language": detected_lang,
                "llm_response": llm_response,
                "output_audio_path": output_path,
                "timing": timing
            }

        except Exception as e:
            logger.error("\n" + "=" * 60)
            logger.error(f"PIPELINE FAILED: {e}")
            logger.error("=" * 60 + "\n")
            raise

    def run_text_pipeline(self, text: str) -> Dict[str, Any]:
        """
        Execute the reply-only pipeline for typed input: LLM step only, no STT/TTS.

        Args:
            text: User input text

        Returns:
            Dict with:
                - llm_response: str
                - timing: dict with llm, total times

        Raises:
            VoicePipelineError: If the input is empty or the backend call fails
        """
        if not text.strip():
            raise VoicePipelineError("Empty text input")

        logger.info("\n" + "=" * 60)
        logger.info(f"TEXT PIPELINE EXECUTION START")
        logger.info("=" * 60 + "\n")

        pipeline_start = time.time()
        timing = {}

        try:
            llm_start = time.time()
            llm_response = self.backend.get_reply(text)
            timing['llm'] = time.time() - llm_start
            timing['total'] = time.time() - pipeline_start

            logger.info("=" * 60)
            logger.info(f"TEXT PIPELINE EXECUTION COMPLETE")
            logger.info(f"Total Time: {timing['total']:.2f}s")
            logger.info("=" * 60 + "\n")

            return {
                "llm_response": llm_response,
                "timing": timing
            }

        except Exception as e:
            logger.error("\n" + "=" * 60)
            logger.error(f"TEXT PIPELINE FAILED: {e}")
            logger.error("=" * 60 + "\n")
            raise
```

- [ ] **Step 6: Rewrite `tests/test_pipeline.py`**

Replace the entire content of `tests/test_pipeline.py` with:

```python
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest
import requests

from src.pipeline import VoicePipeline, VoicePipelineError


def _make_pipeline(**config_overrides):
    """Build a VoicePipeline without running its heavy __init__ (no real STT/TTS/LLM)."""
    pipeline = VoicePipeline.__new__(VoicePipeline)
    pipeline.config = SimpleNamespace(**config_overrides)
    return pipeline


def test_run_pipeline_calls_backend_get_reply(tmp_path):
    input_wav = tmp_path / "input.wav"
    input_wav.write_bytes(b"fake audio")

    pipeline = _make_pipeline(AUDIO_OUTPUT_DIR=str(tmp_path / "output"))
    pipeline.backend = MagicMock()
    pipeline.backend.get_reply.return_value = "salut!"

    with patch.object(pipeline, "transcribe_audio", return_value=("bonjour", "fr")), \
         patch.object(pipeline, "synthesize_speech"):
        result = pipeline.run_pipeline(str(input_wav))

    pipeline.backend.get_reply.assert_called_once_with("bonjour")
    assert result["llm_response"] == "salut!"


def test_init_does_not_load_stt_model():
    """Constructing VoicePipeline must not touch WhisperModel until transcribe_audio() is called."""
    config = SimpleNamespace(
        STT_LOCAL_MODEL_PATH="/nonexistent/path",
        STT_MODEL_SIZE="small",
        STT_DEVICE="cpu",
        STT_COMPUTE_TYPE="int8",
        STT_DOWNLOAD_ROOT="/nonexistent/download-root",
        LLM_API_URL="http://localhost:8081/v1/chat/completions",
        LLM_HEALTH_URL="http://localhost:8081/health",
        LLM_BACKEND="direct",
        PROJECT_ROOT="/nonexistent/project-root",
    )
    with patch("src.llm_backends.requests.get", side_effect=requests.exceptions.ConnectionError("refused")), \
         patch("src.pipeline.WhisperModel") as mock_whisper:
        pipeline = VoicePipeline(config)

    mock_whisper.assert_not_called()
    assert not hasattr(pipeline, "stt_model")


def test_transcribe_audio_loads_stt_model_on_first_call(tmp_path):
    """transcribe_audio() must load the model lazily via _ensure_stt()."""
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"fake audio")

    config = SimpleNamespace(
        STT_LOCAL_MODEL_PATH="/nonexistent/path",
        STT_MODEL_SIZE="small",
        STT_DEVICE="cpu",
        STT_COMPUTE_TYPE="int8",
        STT_DOWNLOAD_ROOT="/nonexistent/download-root",
        STT_LANGUAGE="fr",
        STT_BEAM_SIZE=5,
    )
    pipeline = VoicePipeline.__new__(VoicePipeline)
    pipeline.config = config

    mock_segment = SimpleNamespace(text=" bonjour ")
    mock_model = MagicMock()
    mock_model.transcribe.return_value = ([mock_segment], SimpleNamespace(language="fr"))

    with patch("src.pipeline.WhisperModel", return_value=mock_model) as mock_whisper_cls:
        text, lang = pipeline.transcribe_audio(str(audio_path))
        # Second call must not reload the model
        pipeline.transcribe_audio(str(audio_path))

    mock_whisper_cls.assert_called_once()
    assert text == "bonjour"
    assert lang == "fr"


def test_synthesize_speech_checks_piper_model_on_first_call(tmp_path):
    """synthesize_speech() must validate/set self.piper_model lazily via _ensure_tts()."""
    config = SimpleNamespace(TTS_MODEL_PATH=str(tmp_path / "fr_FR-siwis-medium.onnx"))
    pipeline = VoicePipeline.__new__(VoicePipeline)
    pipeline.config = config

    with pytest.raises(VoicePipelineError, match="Piper model not found"):
        pipeline.synthesize_speech("bonjour", "fr", str(tmp_path / "out.wav"))


def test_run_text_pipeline_calls_backend_get_reply():
    pipeline = _make_pipeline()
    pipeline.backend = MagicMock()
    pipeline.backend.get_reply.return_value = "salut!"

    result = pipeline.run_text_pipeline("bonjour")

    pipeline.backend.get_reply.assert_called_once_with("bonjour")
    assert result["llm_response"] == "salut!"
    assert "llm" in result["timing"]
    assert "total" in result["timing"]


def test_run_text_pipeline_raises_on_empty_text():
    pipeline = _make_pipeline()
    pipeline.backend = MagicMock()

    with pytest.raises(VoicePipelineError, match="Empty text input"):
        pipeline.run_text_pipeline("   ")
```

- [ ] **Step 7: Run the full Python suite**

Run: `uv run --python .venv/bin/python -m pytest tests/ -v`
Expected: ALL tests pass (`test_llm_backends.py`'s 18 new tests, `test_pipeline.py`'s 6 tests, plus the unaffected `test_audio_validation.py`, `test_config.py`, `test_pipeline_cli.py`).

- [ ] **Step 8: Commit**

```bash
git add src/llm_backends.py src/pipeline.py tests/test_llm_backends.py tests/test_pipeline.py
git commit -m "refactor: extract LLM backend strategies into src/llm_backends.py

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Add the persistent worker (`src/worker.py`)

**Files:**
- Create: `src/worker.py`
- Create: `tests/test_worker.py`

**Interfaces:**
- Consumes: `VoicePipeline(config)`, `VoicePipeline.run_pipeline(audio_path: str) -> dict`, `VoicePipeline.run_text_pipeline(text: str) -> dict`, `VoicePipelineError` — all from `src.pipeline` (unchanged surface after Task 1). `validate_audio_file(path, max_size_mb, max_duration_sec)` and `convert_wav_to_ogg_opus(wav_path, ogg_path)` from `src.audio_converter` (both pre-existing, unchanged). `config.TEXT_MAX_CHARS`, `config.AUDIO_MAX_SIZE_MB`, `config.AUDIO_MAX_DURATION_SEC` from `src.config`.
- Produces (used by manual testing and by the protocol Task 3 implements on the Node side):
  - `dispatch_line(pipeline, line: str) -> dict` — parses one request line, dispatches it, and returns a response dict. Never raises.
  - `handle_request(pipeline, request: dict) -> dict` — runs one already-parsed request, returns payload fields only (no `id`/`success`).
  - `main()` — the stdin-read loop; not unit tested directly (covered via `dispatch_line`), only exercised by manual smoke testing.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_worker.py`:

```python
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from src.pipeline import VoicePipelineError
from src.worker import dispatch_line, handle_request


def _make_pipeline(**overrides):
    config = SimpleNamespace(
        TEXT_MAX_CHARS=1000,
        AUDIO_MAX_SIZE_MB=10,
        AUDIO_MAX_DURATION_SEC=300,
    )
    pipeline = MagicMock()
    pipeline.config = config
    for key, value in overrides.items():
        setattr(pipeline, key, value)
    return pipeline


def test_dispatch_line_text_request_success():
    pipeline = _make_pipeline()
    pipeline.run_text_pipeline.return_value = {"llm_response": "salut", "timing": {"llm": 1, "total": 1}}

    response = dispatch_line(pipeline, '{"id": 1, "type": "text", "text": "bonjour"}')

    assert response == {"id": 1, "success": True, "llm_response": "salut", "timing": {"llm": 1, "total": 1}}
    pipeline.run_text_pipeline.assert_called_once_with("bonjour")


def test_dispatch_line_text_over_max_chars_returns_validation_error():
    pipeline = _make_pipeline()

    response = dispatch_line(pipeline, '{"id": 2, "type": "text", "text": "' + "x" * 1001 + '"}')

    assert response["id"] == 2
    assert response["success"] is False
    assert response["error_type"] == "validation_error"
    assert "too long" in response["error"]
    pipeline.run_text_pipeline.assert_not_called()


def test_dispatch_line_voice_request_success_wav_no_conversion(tmp_path):
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"fake audio")
    pipeline = _make_pipeline()
    pipeline.run_pipeline.return_value = {
        "transcription": "bonjour",
        "language": "fr",
        "llm_response": "salut",
        "output_audio_path": str(tmp_path / "out.wav"),
        "timing": {"stt": 1, "llm": 1, "tts": 1, "total": 3},
    }

    with patch("src.worker.validate_audio_file") as mock_validate:
        response = dispatch_line(
            pipeline,
            f'{{"id": 3, "type": "voice", "audio_path": "{audio_path}"}}',
        )

    mock_validate.assert_called_once_with(str(audio_path), max_size_mb=10, max_duration_sec=300)
    assert response["success"] is True
    assert response["output_audio_path"].endswith("out.wav")


def test_dispatch_line_voice_request_converts_to_ogg(tmp_path):
    audio_path = tmp_path / "input.ogg"
    audio_path.write_bytes(b"fake audio")
    wav_output = tmp_path / "out.wav"
    pipeline = _make_pipeline()
    pipeline.run_pipeline.return_value = {
        "transcription": "bonjour",
        "language": "fr",
        "llm_response": "salut",
        "output_audio_path": str(wav_output),
        "timing": {"stt": 1, "llm": 1, "tts": 1, "total": 3},
    }

    with patch("src.worker.validate_audio_file"), \
         patch("src.worker.convert_wav_to_ogg_opus") as mock_convert, \
         patch("src.worker.os.remove") as mock_remove:
        response = dispatch_line(
            pipeline,
            f'{{"id": 4, "type": "voice", "audio_path": "{audio_path}", "output_format": "ogg"}}',
        )

    expected_ogg = str(wav_output).replace(".wav", ".ogg")
    mock_convert.assert_called_once_with(str(wav_output), expected_ogg)
    mock_remove.assert_called_once_with(str(wav_output))
    assert response["output_audio_path"] == expected_ogg


def test_dispatch_line_missing_audio_path_returns_validation_error():
    pipeline = _make_pipeline()

    response = dispatch_line(pipeline, '{"id": 5, "type": "voice"}')

    assert response == {
        "id": 5,
        "success": False,
        "error": "Missing audio_path for voice request",
        "error_type": "validation_error",
    }


def test_dispatch_line_unparseable_json_returns_validation_error():
    pipeline = _make_pipeline()

    response = dispatch_line(pipeline, "not json")

    assert response["id"] is None
    assert response["success"] is False
    assert response["error_type"] == "validation_error"


def test_dispatch_line_unknown_type_echoes_id_and_returns_validation_error():
    pipeline = _make_pipeline()

    response = dispatch_line(pipeline, '{"id": 6, "type": "bogus"}')

    assert response["id"] == 6
    assert response["success"] is False
    assert response["error_type"] == "validation_error"


def test_dispatch_line_maps_voice_pipeline_error_to_pipeline_error_type(tmp_path):
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"fake audio")
    pipeline = _make_pipeline()
    pipeline.run_pipeline.side_effect = VoicePipelineError("STT failed: boom")

    with patch("src.worker.validate_audio_file"):
        response = dispatch_line(pipeline, f'{{"id": 7, "type": "voice", "audio_path": "{audio_path}"}}')

    assert response == {"id": 7, "success": False, "error": "STT failed: boom", "error_type": "pipeline_error"}


def test_dispatch_line_maps_file_not_found_to_file_not_found_type():
    pipeline = _make_pipeline()

    with patch("src.worker.validate_audio_file", side_effect=FileNotFoundError("Audio file not found: /nope.wav")):
        response = dispatch_line(pipeline, '{"id": 8, "type": "voice", "audio_path": "/nope.wav"}')

    assert response == {
        "id": 8,
        "success": False,
        "error": "Audio file not found: /nope.wav",
        "error_type": "file_not_found",
    }


def test_dispatch_line_maps_unexpected_exception_to_unexpected_error_type():
    pipeline = _make_pipeline()
    pipeline.run_text_pipeline.side_effect = RuntimeError("boom")

    response = dispatch_line(pipeline, '{"id": 9, "type": "text", "text": "bonjour"}')

    assert response == {"id": 9, "success": False, "error": "boom", "error_type": "unexpected_error"}


def test_handle_request_text_returns_only_payload_fields():
    pipeline = _make_pipeline()
    pipeline.run_text_pipeline.return_value = {"llm_response": "salut", "timing": {"llm": 1, "total": 1}}

    result = handle_request(pipeline, {"type": "text", "text": "bonjour"})

    assert result == {"llm_response": "salut", "timing": {"llm": 1, "total": 1}}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --python .venv/bin/python -m pytest tests/test_worker.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.worker'`.

- [ ] **Step 3: Write `src/worker.py`**

```python
"""
Persistent Python worker: reads JSON-line requests from stdin, dispatches
them to a long-lived VoicePipeline, and writes JSON-line responses to
stdout. Replaces the spawn-per-message src.pipeline_cli invocation so
models load once per bot lifetime instead of once per message.

Protocol: one JSON object per line, UTF-8, newline-terminated. Requests
carry {"id": int, "type": "voice"|"text", ...}; responses echo the id and
carry {"success": bool, ...} plus payload fields flattened at the top
level. All logging goes to stderr; stdout carries only protocol lines.
"""
import sys
import os
import json
import logging

from src.pipeline import VoicePipeline, VoicePipelineError
from src.audio_converter import validate_audio_file, convert_wav_to_ogg_opus
from src import config

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger(__name__)


def handle_request(pipeline: VoicePipeline, request: dict) -> dict:
    """Run one already-parsed request against the pipeline and return its
    payload fields (without id/success — dispatch_line adds those)."""
    if request["type"] == "text":
        text = request.get("text", "")
        if len(text) > pipeline.config.TEXT_MAX_CHARS:
            raise ValueError(
                f"Text message too long: {len(text)} chars "
                f"(max {pipeline.config.TEXT_MAX_CHARS})"
            )
        result = pipeline.run_text_pipeline(text)
        return {"llm_response": result["llm_response"], "timing": result["timing"]}

    audio_path = request.get("audio_path")
    if not audio_path:
        raise ValueError("Missing audio_path for voice request")

    validate_audio_file(
        audio_path,
        max_size_mb=pipeline.config.AUDIO_MAX_SIZE_MB,
        max_duration_sec=pipeline.config.AUDIO_MAX_DURATION_SEC,
    )

    result = pipeline.run_pipeline(audio_path)

    if request.get("output_format") == "ogg":
        wav_path = result["output_audio_path"]
        ogg_path = wav_path.replace(".wav", ".ogg")
        convert_wav_to_ogg_opus(wav_path, ogg_path)
        os.remove(wav_path)
        result["output_audio_path"] = ogg_path

    return {
        "transcription": result["transcription"],
        "language": result["language"],
        "llm_response": result["llm_response"],
        "output_audio_path": result["output_audio_path"],
        "timing": result["timing"],
    }


def dispatch_line(pipeline: VoicePipeline, line: str) -> dict:
    """Parse one request line and return a response dict. Never raises —
    every failure mode is mapped to an error response so a bad request
    can't kill the worker process."""
    try:
        request = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return {
            "id": None,
            "success": False,
            "error": "Malformed JSON request",
            "error_type": "validation_error",
        }

    request_id = request.get("id") if isinstance(request, dict) else None
    request_type = request.get("type") if isinstance(request, dict) else None

    if request_type not in ("voice", "text"):
        return {
            "id": request_id,
            "success": False,
            "error": f"Unknown request type: {request_type!r}",
            "error_type": "validation_error",
        }

    try:
        result = handle_request(pipeline, request)
        return {"id": request_id, "success": True, **result}
    except VoicePipelineError as e:
        return {"id": request_id, "success": False, "error": str(e), "error_type": "pipeline_error"}
    except FileNotFoundError as e:
        return {"id": request_id, "success": False, "error": str(e), "error_type": "file_not_found"}
    except ValueError as e:
        return {"id": request_id, "success": False, "error": str(e), "error_type": "validation_error"}
    except Exception as e:
        logger.error(f"Unexpected error handling request {request_id}: {e}", exc_info=True)
        return {"id": request_id, "success": False, "error": str(e), "error_type": "unexpected_error"}


def main():
    logger.info("Starting persistent pipeline worker")
    pipeline = VoicePipeline(config)
    logger.info("Worker ready, reading requests from stdin")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        response = dispatch_line(pipeline, line)
        print(json.dumps(response), flush=True)

    logger.info("Stdin closed, worker exiting")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `uv run --python .venv/bin/python -m pytest tests/test_worker.py -v`
Expected: PASS (11 tests).

- [ ] **Step 5: Run the full Python suite**

Run: `uv run --python .venv/bin/python -m pytest tests/ -v`
Expected: ALL tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/worker.py tests/test_worker.py
git commit -m "feat: add persistent JSON-lines pipeline worker

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Rewrite `bot/pipeline-client.js` to spawn a persistent worker

**Files:**
- Modify: `bot/pipeline-client.js` (full replacement)
- Modify: `bot/pipeline-client.test.js` (full replacement)
- Create: `bot/fixtures/fake-worker.js`

**Interfaces:**
- Consumes: `config.PYTHON_CMD`, `config.PIPELINE_TIMEOUT_MS` from `bot/config.js` (both pre-existing, unchanged).
- Produces (public API, unchanged from before this task — `bot/voice-handler.js` and `bot/text-handler.js` need no changes):
  - `runVoicePipeline(audioPath: string, logPrefix?: string) => Promise<{transcription, language, llm_response, output_audio_path, timing}>`
  - `runTextPipeline(text: string, logPrefix?: string) => Promise<{llm_response, timing}>`
- Also produces (new, used only by this task's own tests — not consumed by any handler):
  - `createWorkerClient(options?: { command?: string, args?: string[], cwd?: string, timeoutMs?: number }) => { runVoice(audioPath, logPrefix?), runText(text, logPrefix?) }` — builds an isolated client instance with its own worker process and pending-request state, so tests can point it at a fake worker fixture without touching the production singleton or interfering with each other.
- This task removes `buildTextPipelineArgs`, `buildVoicePipelineArgs`, and `parsePipelineOutput` from `pipeline-client.js` entirely (and their tests). Those built argv for the one-shot `pipeline_cli` invocation, which the bot no longer performs — `src/pipeline_cli.py` remains available as a manual-testing tool, but the bot now always spawns `-m src.worker` and speaks the JSON-lines protocol instead of passing CLI flags.

- [ ] **Step 1: Write the fake worker fixture**

Create `bot/fixtures/fake-worker.js`:

```js
// Fake worker used by pipeline-client.test.js to exercise the persistent
// worker protocol (spawn, correlation, timeout, crash) without depending on
// a real Python environment. Reads JSON-line requests from stdin; behavior
// is driven by the request's `text` field so tests can trigger each case:
//   - text === "CRASH": exits immediately without responding
//   - text === "HANG": never responds
//   - anything else: echoes back `echo:<text>` as llm_response
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
    if (!line.trim()) return;
    const request = JSON.parse(line);

    if (request.text === 'CRASH') {
        process.exit(1);
    }
    if (request.text === 'HANG') {
        return;
    }

    const response = { id: request.id, success: true, llm_response: `echo:${request.text}`, timing: {} };
    process.stdout.write(JSON.stringify(response) + '\n');
});
```

- [ ] **Step 2: Write the failing tests**

Replace the entire content of `bot/pipeline-client.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWorkerClient } from './pipeline-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fake-worker.js');

function makeTestClient(timeoutMs = 1000) {
    return createWorkerClient({
        command: process.execPath,
        args: [FIXTURE_PATH],
        timeoutMs
    });
}

test('round-trips a normal text request through the worker protocol', async () => {
    const client = makeTestClient();
    const result = await client.runText('bonjour');
    assert.equal(result.llm_response, 'echo:bonjour');
});

test('rejects the pending request when the worker crashes, then respawns for the next request', async () => {
    const client = makeTestClient();

    await assert.rejects(client.runText('CRASH'), /Python worker exited/);

    const result = await client.runText('salut');
    assert.equal(result.llm_response, 'echo:salut');
});

test('rejects with a timeout and kills the worker when it hangs, then respawns for the next request', async () => {
    const client = makeTestClient(200);

    await assert.rejects(client.runText('HANG'), /timed out after 200ms/);

    const result = await client.runText('salut');
    assert.equal(result.llm_response, 'echo:salut');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm --prefix bot test`
Expected: `pipeline-client.test.js` FAILS — `createWorkerClient` doesn't exist yet in the current `pipeline-client.js`. All other test files still pass.

- [ ] **Step 4: Rewrite `bot/pipeline-client.js`**

Replace the entire content of `bot/pipeline-client.js` with:

```js
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import config from './config.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KILL_GRACE_MS = 500;

function killWorker(state) {
    try {
        state.process.kill('SIGTERM');
    } catch {
        return;
    }
    const forceKillTimer = setTimeout(() => {
        try {
            state.process.kill('SIGKILL');
        } catch {
            // already exited
        }
    }, KILL_GRACE_MS);
    state.process.once('exit', () => clearTimeout(forceKillTimer));
}

function rejectAllPending(state, error) {
    for (const pending of state.pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    state.pendingRequests.clear();
}

function handleWorkerLine(state, line) {
    let response;
    try {
        response = JSON.parse(line);
    } catch (parseError) {
        console.error('[worker] Failed to parse response line:', line);
        return;
    }

    const pending = state.pendingRequests.get(response.id);
    if (!pending) {
        console.error('[worker] Received response for unknown request id:', response.id);
        return;
    }

    state.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);

    if (response.success === false) {
        pending.reject(new Error(response.error));
        return;
    }

    const { id, success, error, error_type, ...result } = response;
    pending.resolve(result);
}

/**
 * Create an isolated client for the persistent Python worker protocol. The
 * production client (below) is one instance of this; tests create their own
 * instances pointed at a fake worker script so they don't share process
 * state with each other or with production code.
 * @param {{ command?: string, args?: string[], cwd?: string, timeoutMs?: number }} [options]
 */
export function createWorkerClient(options = {}) {
    const command = options.command ?? config.PYTHON_CMD;
    const args = options.args ?? ['-m', 'src.worker'];
    const cwd = options.cwd ?? REPO_ROOT;
    const timeoutMs = options.timeoutMs ?? config.PIPELINE_TIMEOUT_MS;

    let worker = null;

    function getWorker() {
        if (worker) return worker;

        const child = spawn(command, args, { cwd });
        const state = {
            process: child,
            pendingRequests: new Map(),
            nextId: 1,
            buffer: ''
        };

        child.stdin.on('error', (err) => {
            console.error('[worker] stdin error:', err.message);
        });

        child.stdout.on('data', (chunk) => {
            state.buffer += chunk.toString();
            let newlineIndex;
            while ((newlineIndex = state.buffer.indexOf('\n')) !== -1) {
                const line = state.buffer.slice(0, newlineIndex);
                state.buffer = state.buffer.slice(newlineIndex + 1);
                if (line.trim().length > 0) {
                    handleWorkerLine(state, line);
                }
            }
        });

        child.stderr.on('data', (chunk) => {
            console.error('[worker stderr]:', chunk.toString().trim());
        });

        child.on('exit', (code, signal) => {
            rejectAllPending(state, new Error(`Python worker exited (code=${code}, signal=${signal})`));
            if (worker === state) {
                worker = null;
            }
        });

        child.on('error', (spawnError) => {
            rejectAllPending(state, new Error(`Failed to spawn Python worker: ${spawnError.message}`));
            if (worker === state) {
                worker = null;
            }
        });

        worker = state;
        return state;
    }

    function sendRequest(request, logPrefix) {
        const state = getWorker();
        const id = state.nextId++;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                state.pendingRequests.delete(id);
                console.error(`${logPrefix} Pipeline worker timed out after ${timeoutMs}ms`);
                killWorker(state);
                if (worker === state) {
                    worker = null;
                }
                reject(new Error(`Pipeline worker timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            state.pendingRequests.set(id, { resolve, reject, timer });

            const line = JSON.stringify({ ...request, id }) + '\n';
            try {
                state.process.stdin.write(line, (writeError) => {
                    if (writeError) {
                        state.pendingRequests.delete(id);
                        clearTimeout(timer);
                        reject(new Error(`Failed to write to Python worker: ${writeError.message}`));
                    }
                });
            } catch (writeError) {
                state.pendingRequests.delete(id);
                clearTimeout(timer);
                reject(new Error(`Failed to write to Python worker: ${writeError.message}`));
            }
        });
    }

    return {
        runVoice(audioPath, logPrefix = '') {
            return sendRequest({ type: 'voice', audio_path: audioPath, output_format: 'ogg' }, logPrefix);
        },
        runText(text, logPrefix = '') {
            return sendRequest({ type: 'text', text }, logPrefix);
        }
    };
}

const defaultClient = createWorkerClient();

/**
 * Run the full STT->LLM->TTS pipeline on a voice note via the persistent
 * Python worker.
 * @param {string} audioPath - Path to the downloaded voice note
 * @param {string} [logPrefix] - Log prefix for correlating output
 * @returns {Promise<{transcription: string, language: string, llm_response: string, output_audio_path: string, timing: object}>}
 */
export function runVoicePipeline(audioPath, logPrefix = '') {
    return defaultClient.runVoice(audioPath, logPrefix);
}

/**
 * Run the text-only reply pipeline (LLM step, no STT/TTS) via the
 * persistent Python worker.
 * @param {string} text - The message body to reply to
 * @param {string} [logPrefix] - Log prefix for correlating output
 * @returns {Promise<{llm_response: string, timing: object}>}
 */
export function runTextPipeline(text, logPrefix = '') {
    return defaultClient.runText(text, logPrefix);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix bot test`
Expected: ALL tests pass, including the 3 new `pipeline-client.test.js` cases.

- [ ] **Step 6: Commit**

```bash
git add bot/pipeline-client.js bot/pipeline-client.test.js bot/fixtures/fake-worker.js
git commit -m "refactor: spawn a persistent worker in pipeline-client.js instead of per message

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Update README for the worker architecture

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only, no code change.

- [ ] **Step 1: Update the architecture diagram**

Find (around line 13-16):

```
```
WhatsApp → whatsapp-web.js → Node.js bot → Python subprocess → Response
                (receives)     (processes)    (STT/LLM/TTS)     (sends back)
```
```

Replace with:

```
```
WhatsApp → whatsapp-web.js → Node.js bot → Python worker (persistent) → Response
                (receives)     (processes)   (STT/LLM/TTS, spawned once)  (sends back)
```
```

- [ ] **Step 2: Update the feature bullet about subprocess timeout**

Find (around line 28):

```
- 🚦 Oversized/overlong voice notes rejected before they hit the pipeline; only one message processed at a time; a hung pipeline subprocess is killed after a timeout
```

Replace with:

```
- 🚦 Oversized/overlong voice notes rejected before they hit the pipeline; only one message processed at a time; the Python pipeline runs as a persistent worker (spawned once, not per message) that is killed and transparently respawned if it hangs past a timeout
```

- [ ] **Step 3: Update the Project Structure listing**

Find the `bot/` block (around line 153-163):

```
├── bot/                          # Node.js WhatsApp bot
│   ├── index.js                  # Main bot entry point
│   ├── voice-handler.js          # Voice message processing
│   ├── text-handler.js           # Text message processing
│   ├── message-tracker.js        # Tracks bot-sent messages to avoid echo loops
│   ├── subprocess-timeout.js     # Timeout/kill wrapper for the Python subprocess
│   ├── queue.js                  # Serializes voice message processing
│   ├── *.test.js                 # Node test suite (run: npm test)
│   ├── config.js                 # Bot configuration
│   ├── package.json              # Node dependencies
│   └── .wwebjs_auth/             # Session data (auto-created)
│
├── src/                          # Python pipeline
│   ├── pipeline.py                # VoicePipeline class
│   ├── pipeline_cli.py            # CLI wrapper for Node integration
│   ├── audio_converter.py         # Format conversion + validation
│   └── config.py                  # Python config
```

Replace with:

```
├── bot/                          # Node.js WhatsApp bot
│   ├── index.js                  # Main bot entry point
│   ├── voice-handler.js          # Voice message processing
│   ├── text-handler.js           # Text message processing
│   ├── pipeline-client.js        # Persistent Python worker client (spawn, protocol, timeout/crash recovery)
│   ├── notify-error.js           # Shared error-notification helper
│   ├── message-tracker.js        # Tracks bot-sent messages to avoid echo loops
│   ├── subprocess-timeout.js     # Timeout/kill wrapper for subprocess calls
│   ├── queue.js                  # Serializes voice message processing
│   ├── *.test.js                 # Node test suite (run: npm test)
│   ├── config.js                 # Bot configuration
│   ├── package.json              # Node dependencies
│   └── .wwebjs_auth/             # Session data (auto-created)
│
├── src/                          # Python pipeline
│   ├── pipeline.py                # VoicePipeline class
│   ├── worker.py                  # Persistent worker: JSON-lines protocol over stdin/stdout
│   ├── llm_backends.py            # Direct / SillyTavern LLM backend strategies
│   ├── pipeline_cli.py            # CLI wrapper for manual testing (no longer used by the bot)
│   ├── audio_converter.py         # Format conversion + validation
│   └── config.py                  # Python config
```

- [ ] **Step 4: Remove the now-resolved "No persistent model" limitation**

Find (in the `## Known Limitations` section):

```
- **No persistent model**: each voice message spawns a new Python subprocess that reloads the Whisper model from disk. This adds latency vs. a long-running worker process — a reasonable target for a future improvement, not implemented here to keep the architecture simple.
- **Single-instance, no horizontal scaling**: one bot process, one WhatsApp session. Not designed for multiple concurrent group deployments from one codebase instance.
```

Replace with:

```
- **Single-instance, no horizontal scaling**: one bot process, one WhatsApp session. Not designed for multiple concurrent group deployments from one codebase instance.
```

- [ ] **Step 5: Verify nothing else broke**

Run: `npm --prefix bot test && npm --prefix st-bridge test && uv run --python .venv/bin/python -m pytest tests/`
Expected: ALL tests pass (README changes don't affect any test).

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: describe the persistent worker architecture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
