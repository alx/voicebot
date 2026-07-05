# Open-Source Release Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the WhatsApp voice bot repo (`/home/alx/code/voicebot`) for public release by removing personal/environment-specific information, purging dead WAHA/FastAPI-era code, fixing a real missing-dependency bug, wiring up existing-but-unused robustness limits, adding basic concurrency/timeout protection, and bringing repo hygiene (LICENSE, lockfile, docs) up to open-source norms.

**Architecture:** No architectural change. This is a cleanup/hardening pass across the existing hybrid Node.js (`bot/`) + Python (`src/`) codebase: Node's `whatsapp-web.js` client still spawns the Python pipeline as a subprocess per voice message; Python still runs STT (faster-whisper) → LLM (remote OpenAI-compatible API) → TTS (Piper) synchronously. Changes are additive/subtractive, not structural.

**Tech Stack:** Node.js 18+ (`whatsapp-web.js`, built-in `node:test`), Python 3.8+ (`faster-whisper`, `piper-tts`, `pydub`, `pytest`), bash.

## Global Constraints

- No hardcoded personal IPs, hostnames, or absolute filesystem paths (e.g. `100.86.147.125`, `/home/alx/...`) may remain anywhere in tracked files.
- New/changed env vars: `LLM_BASE_URL` (default `http://localhost:8081`), `LLM_MODEL_NAME` (default `Qwen3VL-8B-Instruct-Q4_K_M.gguf`), `PIPELINE_TIMEOUT_MS` (default `90000`). All optional with working defaults — nothing new is required to run the bot.
- `requirements.txt` must only list packages actually imported/used somewhere in `src/`.
- Python tests live at repo root under `tests/` (not `tests/step1/`, which stays untouched — those are pre-existing manual example scripts, out of scope). Run with `pytest` from the repo root.
- Node tests live alongside their modules in `bot/` as `*.test.js`, using Node's built-in `node:test` (no new npm test dependency). Run with `npm test` from `bot/`.
- License: MIT, matching `bot/package.json`'s existing `"license": "MIT"` declaration.
- Every task's file edits must leave the repo in a working state — no task should require a later task to fix a broken import.

---

### Task 1: Fix Python dependencies in `requirements.txt`

**Files:**
- Modify: `requirements.txt`
- Test: manual (no automated test needed — this is a static dependency list; correctness is verified by the venv setup in Task 2 succeeding)

**Interfaces:**
- Produces: a `requirements.txt` that installs everything `src/` actually imports (`faster_whisper`, `piper` CLI via `piper-tts`, `pydub`, `requests`, `python-dotenv`) plus `pytest` for the test suite added in later tasks, with no unused packages.

- [ ] **Step 1: Confirm current dead/missing dependencies**

Run: `cat requirements.txt`

Current content is:
```
# Web Framework
fastapi==0.104.1
uvicorn[standard]==0.24.0
pydantic==2.5.0

# Existing Pipeline Dependencies
faster-whisper==1.0.3
requests==2.32.5

# Audio Processing
pydub==0.25.1

# Utilities
python-multipart==0.0.6
python-dotenv==1.0.0
```
`fastapi`, `uvicorn`, `pydantic`, `python-multipart` are unused (leftover from an abandoned FastAPI/WAHA webhook design — nothing in `src/` imports them). `piper-tts` is missing entirely, even though `src/pipeline.py` shells out to the `piper` CLI binary it provides — a fresh `pip install -r requirements.txt` would leave TTS non-functional.

- [ ] **Step 2: Rewrite `requirements.txt`**

Overwrite `requirements.txt` with:
```
# Voice Pipeline Dependencies
faster-whisper==1.0.3
piper-tts==1.3.0
requests==2.32.5

# Audio Processing
pydub==0.25.1

# Utilities
python-dotenv==1.0.0

# Testing
pytest==8.3.3
```

- [ ] **Step 3: Verify by reading the file back**

Run: `cat requirements.txt`
Expected: no `fastapi`, `uvicorn`, `pydantic`, or `python-multipart` lines; `piper-tts==1.3.0` and `pytest==8.3.3` present.

- [ ] **Step 4: Commit**

```bash
git add requirements.txt
git commit -m "fix: correct Python dependencies (add missing piper-tts, drop unused FastAPI stack)"
```

---

### Task 2: Set up the Python virtual environment for development/testing

**Files:**
- Create: `.venv/` (gitignored already — not committed)
- Test: the install itself is the test — if it fails, the task fails

**Interfaces:**
- Consumes: `requirements.txt` from Task 1
- Produces: an activated `.venv` with all of `requirements.txt` installed, available for every later Python task in this plan (`source .venv/bin/activate` before running `pytest`)

- [ ] **Step 1: Create the virtual environment**

Run: `cd /home/alx/code/voicebot && python3 -m venv .venv`
Expected: no output, `.venv/` directory created.

- [ ] **Step 2: Install dependencies**

Run:
```bash
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```
Expected: successful install of all packages (this may take a few minutes — `piper-tts` and `faster-whisper` pull in `onnxruntime`/`ctranslate2`). No errors.

- [ ] **Step 3: Verify key tools are importable**

Run:
```bash
source .venv/bin/activate
python -c "import faster_whisper, pydub, dotenv, pytest; print('ok')"
which piper
```
Expected: prints `ok`, and `which piper` shows a path inside `.venv/bin/piper` (installed by `piper-tts`).

No commit needed — `.venv/` is gitignored and there are no file changes to track.

---

### Task 3: Genericize LLM config and remove WAHA/dead-TTS config

**Files:**
- Modify: `src/config.py`
- Modify: `tests/step1/config.py`
- Modify: `.env.example`
- Test: `tests/test_config.py` (new)

**Interfaces:**
- Produces: `config.LLM_API_URL`, `config.LLM_HEALTH_URL` derived from `config.LLM_BASE_URL` (env var, default `http://localhost:8081`); `config.LLM_MODEL_NAME` overridable via env var. `config.WAHA_URL`, `config.WAHA_SESSION`, `config.WAHA_WEBHOOK_PORT`, `config.VOICEBOT_CHAT_ID`, `config.TTS_MODEL_NAME`, `config.TTS_SPEAKER_WAV` no longer exist.

- [ ] **Step 1: Write the failing test**

Create `tests/test_config.py`:
```python
import importlib
import os

import pytest


def _reload_config():
    from src import config
    importlib.reload(config)
    return config


def test_llm_base_url_defaults_to_localhost(monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    config = _reload_config()
    assert config.LLM_API_URL == "http://localhost:8081/v1/chat/completions"
    assert config.LLM_HEALTH_URL == "http://localhost:8081/health"


def test_llm_base_url_override(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "http://example.internal:9000")
    config = _reload_config()
    assert config.LLM_API_URL == "http://example.internal:9000/v1/chat/completions"
    assert config.LLM_HEALTH_URL == "http://example.internal:9000/health"


def test_dead_waha_and_tts_config_removed():
    config = _reload_config()
    for attr in (
        "WAHA_URL",
        "WAHA_SESSION",
        "WAHA_WEBHOOK_PORT",
        "VOICEBOT_CHAT_ID",
        "TTS_MODEL_NAME",
        "TTS_SPEAKER_WAV",
    ):
        assert not hasattr(config, attr), f"{attr} should have been removed"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `source .venv/bin/activate && pytest tests/test_config.py -v`
Expected: `test_llm_base_url_defaults_to_localhost` and `test_llm_base_url_override` FAIL (current code has hardcoded IP, not `LLM_BASE_URL`-derived); `test_dead_waha_and_tts_config_removed` FAILS (those attributes still exist).

- [ ] **Step 3: Rewrite `src/config.py`**

Overwrite `src/config.py` with:
```python
"""
Configuration file for Voice Bot STT->LLM->TTS Pipeline
"""
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Project paths
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_INPUT_DIR = os.path.join(PROJECT_ROOT, "audio", "input")
AUDIO_OUTPUT_DIR = os.path.join(PROJECT_ROOT, "audio", "output")
TEMP_AUDIO_DIR = os.path.join(PROJECT_ROOT, "audio", "temp")
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
LOGS_DIR = os.path.join(PROJECT_ROOT, "logs")

# GPU configuration
CUDA_DEVICE = "cuda:0"  # Use GPU 0 only
os.environ["CUDA_VISIBLE_DEVICES"] = "0"

# STT Configuration (faster-whisper)
STT_MODEL_SIZE = "small"  # Options: tiny, base, small, medium, large
STT_LANGUAGE = "fr"       # French language code (or None for auto-detect)
STT_COMPUTE_TYPE = "int8"  # Options: float16, int8, float32
STT_DEVICE = "cpu"        # Using CPU due to cuDNN issues
STT_BEAM_SIZE = 5         # Accuracy vs speed tradeoff (1-10)
STT_DOWNLOAD_ROOT = os.path.join(MODELS_DIR, "faster-whisper")

# LLM Configuration (llama-server / any OpenAI-compatible chat completions API)
# Point this at your own LLM server, e.g. llama-server, ollama, vLLM, LM Studio
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://localhost:8081")
LLM_API_URL = f"{LLM_BASE_URL}/v1/chat/completions"
LLM_HEALTH_URL = f"{LLM_BASE_URL}/health"
LLM_MODEL_NAME = os.getenv("LLM_MODEL_NAME", "Qwen3VL-8B-Instruct-Q4_K_M.gguf")
LLM_TEMPERATURE = 0.7
LLM_MAX_TOKENS = 200
LLM_TIMEOUT = 60          # seconds

# TTS Configuration (Piper)
TTS_LANGUAGE = "fr"       # Default output language (fr or en)
TTS_DEVICE = "cpu"        # Using CPU to avoid GPU memory conflicts

# System prompt for LLM
SYSTEM_PROMPT = """Tu es un assistant vocal bilingue (français/anglais).
Réponds de manière concise (2-3 phrases maximum) dans la langue utilisée par l'utilisateur.
Tes réponses seront converties en audio, donc sois naturel et conversationnel."""

# Audio Processing
AUDIO_DOWNLOAD_TIMEOUT = 30  # seconds
AUDIO_MAX_SIZE_MB = 10

# Status Messages (French)
STATUS_MESSAGES = {
    "received": "🎤 Message vocal reçu, traitement en cours...",
    "transcription": "📝 Transcription: {}",
    "llm_response": "🤖 Réponse: {}",
    "error": "❌ Erreur: {}",
    "processing": "⚙️ Traitement...",
}

# Error Handling
ENABLE_ERROR_NOTIFICATIONS = True
MAX_RETRIES = 3
RETRY_DELAY = 2  # seconds

# Logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")  # DEBUG, INFO, WARNING, ERROR
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `source .venv/bin/activate && pytest tests/test_config.py -v`
Expected: all 3 tests PASS.

- [ ] **Step 5: Fix the same hardcoded IP in `tests/step1/config.py`**

In `tests/step1/config.py`, replace:
```python
# LLM Configuration (llama-server OpenAI-compatible API)
LLM_API_URL = "http://100.86.147.125:8081/v1/chat/completions"
LLM_HEALTH_URL = "http://100.86.147.125:8081/health"
```
with:
```python
# LLM Configuration (llama-server OpenAI-compatible API)
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://localhost:8081")
LLM_API_URL = f"{LLM_BASE_URL}/v1/chat/completions"
LLM_HEALTH_URL = f"{LLM_BASE_URL}/health"
```
(`os` is already imported at the top of this file.)

Verify: `grep -n "100.86.147.125" tests/step1/config.py` → no output.

- [ ] **Step 6: Document the new env vars in `.env.example`**

In `.env.example`, after the existing `VOICEBOT_GROUP_ID=` block, add:
```bash
# LLM server (OpenAI-compatible chat completions API — e.g. llama-server, ollama, vLLM)
# Defaults to http://localhost:8081 if not set
# LLM_BASE_URL=http://localhost:8081
# LLM_MODEL_NAME=your-model-name.gguf
```

- [ ] **Step 7: Confirm no hardcoded IP remains anywhere in the repo**

Run: `grep -rn "100.86.147.125" --include="*.py" --include="*.js" --include="*.md" --include="*.sh" .`
Expected: no output (empty).

- [ ] **Step 8: Commit**

```bash
git add src/config.py tests/step1/config.py .env.example tests/test_config.py
git commit -m "feat: make LLM server configurable via LLM_BASE_URL, remove dead WAHA/TTS config"
```

---

### Task 4: Wire up audio size/duration validation

**Files:**
- Modify: `src/audio_converter.py`
- Modify: `src/config.py`
- Modify: `src/pipeline_cli.py`
- Test: `tests/test_audio_validation.py` (new)

**Interfaces:**
- Consumes: `config.AUDIO_MAX_SIZE_MB` (from Task 3's `src/config.py`)
- Produces: `config.AUDIO_MAX_DURATION_SEC` (new); `validate_audio_file(file_path, max_size_mb=10, max_duration_sec=300)` (generalized signature — `max_duration_sec` replaces the hardcoded `300`); `pipeline_cli.py` calls this before constructing `VoicePipeline`, exiting with a `validation_error` JSON payload on failure instead of proceeding to load models.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_audio_validation.py`:
```python
import wave

import pytest

from src.audio_converter import validate_audio_file


def _write_silent_wav(path, duration_sec, frame_rate=16000):
    n_frames = int(duration_sec * frame_rate)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(frame_rate)
        wav_file.writeframes(b"\x00\x00" * n_frames)


def test_validate_audio_file_rejects_oversized_file(tmp_path):
    big_file = tmp_path / "big.wav"
    big_file.write_bytes(b"\x00" * (2 * 1024 * 1024))  # 2MB of zero bytes

    with pytest.raises(ValueError, match="too large"):
        validate_audio_file(str(big_file), max_size_mb=1)


def test_validate_audio_file_accepts_normal_file(tmp_path):
    normal_file = tmp_path / "normal.wav"
    _write_silent_wav(normal_file, duration_sec=2)

    assert validate_audio_file(str(normal_file), max_size_mb=10, max_duration_sec=300) is True


def test_validate_audio_file_rejects_too_long_duration(tmp_path):
    long_file = tmp_path / "long.wav"
    _write_silent_wav(long_file, duration_sec=5)

    with pytest.raises(ValueError, match="Invalid audio file"):
        validate_audio_file(str(long_file), max_size_mb=10, max_duration_sec=1)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source .venv/bin/activate && pytest tests/test_audio_validation.py -v`
Expected: `test_validate_audio_file_rejects_oversized_file` and `test_validate_audio_file_accepts_normal_file` PASS already (current default behavior happens to match); `test_validate_audio_file_rejects_too_long_duration` FAILS with a `TypeError` — `validate_audio_file()` doesn't accept a `max_duration_sec` keyword yet.

- [ ] **Step 3: Generalize `validate_audio_file` in `src/audio_converter.py`**

Replace the `validate_audio_file` function:
```python
def validate_audio_file(file_path: str, max_size_mb: int = 10) -> bool:
    """
    Validate audio file (size, format, duration)

    Args:
        file_path: Path to audio file
        max_size_mb: Maximum file size in MB

    Returns:
        True if valid, False otherwise

    Raises:
        ValueError: If file is invalid with reason
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    # Check file size
    file_size_mb = os.path.getsize(file_path) / (1024 * 1024)
    if file_size_mb > max_size_mb:
        raise ValueError(f"File too large: {file_size_mb:.2f}MB (max {max_size_mb}MB)")

    try:
        # Load and validate with pydub
        audio = AudioSegment.from_file(file_path)
        duration_sec = len(audio) / 1000.0

        # Limit duration to 5 minutes (300 seconds)
        if duration_sec > 300:
            raise ValueError(f"Audio too long: {duration_sec:.1f}s (max 300s)")

        # Check if audio has content (not silent/empty)
        if duration_sec < 0.1:
            raise ValueError("Audio too short (< 0.1s)")

        logger.debug(f"Audio validated: {file_path} ({duration_sec:.1f}s, {file_size_mb:.2f}MB)")
        return True

    except Exception as e:
        logger.error(f"Audio validation failed: {e}")
        raise ValueError(f"Invalid audio file: {e}")
```
with:
```python
def validate_audio_file(file_path: str, max_size_mb: int = 10, max_duration_sec: float = 300) -> bool:
    """
    Validate audio file (size, format, duration)

    Args:
        file_path: Path to audio file
        max_size_mb: Maximum file size in MB
        max_duration_sec: Maximum audio duration in seconds

    Returns:
        True if valid, False otherwise

    Raises:
        ValueError: If file is invalid with reason
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    # Check file size
    file_size_mb = os.path.getsize(file_path) / (1024 * 1024)
    if file_size_mb > max_size_mb:
        raise ValueError(f"File too large: {file_size_mb:.2f}MB (max {max_size_mb}MB)")

    try:
        # Load and validate with pydub
        audio = AudioSegment.from_file(file_path)
        duration_sec = len(audio) / 1000.0

        if duration_sec > max_duration_sec:
            raise ValueError(f"Audio too long: {duration_sec:.1f}s (max {max_duration_sec}s)")

        # Check if audio has content (not silent/empty)
        if duration_sec < 0.1:
            raise ValueError("Audio too short (< 0.1s)")

        logger.debug(f"Audio validated: {file_path} ({duration_sec:.1f}s, {file_size_mb:.2f}MB)")
        return True

    except Exception as e:
        logger.error(f"Audio validation failed: {e}")
        raise ValueError(f"Invalid audio file: {e}")
```

- [ ] **Step 4: Add `AUDIO_MAX_DURATION_SEC` to `src/config.py`**

In `src/config.py`, replace:
```python
# Audio Processing
AUDIO_DOWNLOAD_TIMEOUT = 30  # seconds
AUDIO_MAX_SIZE_MB = 10
```
with:
```python
# Audio Processing
AUDIO_DOWNLOAD_TIMEOUT = 30  # seconds
AUDIO_MAX_SIZE_MB = 10
AUDIO_MAX_DURATION_SEC = 300  # 5 minutes
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `source .venv/bin/activate && pytest tests/test_audio_validation.py -v`
Expected: all 3 tests PASS.

- [ ] **Step 6: Wire validation into `src/pipeline_cli.py`**

In `src/pipeline_cli.py`, add the import alongside the existing pipeline imports:
```python
# Import pipeline components
from src.pipeline import VoicePipeline, VoicePipelineError
from src import config
```
becomes:
```python
# Import pipeline components
from src.pipeline import VoicePipeline, VoicePipelineError
from src.audio_converter import validate_audio_file
from src import config
```

Then, in `main()`, replace:
```python
        logger.info(f"Processing audio file: {args.audio_file}")

        # Initialize pipeline (logs to stderr)
        pipeline = VoicePipeline(config)
```
with:
```python
        logger.info(f"Processing audio file: {args.audio_file}")

        # Validate before loading any models — reject bad input cheaply
        validate_audio_file(
            str(audio_path),
            max_size_mb=config.AUDIO_MAX_SIZE_MB,
            max_duration_sec=config.AUDIO_MAX_DURATION_SEC
        )

        # Initialize pipeline (logs to stderr)
        pipeline = VoicePipeline(config)
```

Then add a new `except ValueError` block. Replace:
```python
    except FileNotFoundError as e:
        logger.error(f"File error: {e}")

        if args.json:
            error_output = {
                "success": False,
                "error": str(e),
                "error_type": "file_not_found"
            }
            print(json.dumps(error_output))
        else:
            print(f"\n❌ File Error: {e}\n", file=sys.stderr)

        sys.exit(1)
```
with:
```python
    except FileNotFoundError as e:
        logger.error(f"File error: {e}")

        if args.json:
            error_output = {
                "success": False,
                "error": str(e),
                "error_type": "file_not_found"
            }
            print(json.dumps(error_output))
        else:
            print(f"\n❌ File Error: {e}\n", file=sys.stderr)

        sys.exit(1)

    except ValueError as e:
        logger.error(f"Validation error: {e}")

        if args.json:
            error_output = {
                "success": False,
                "error": str(e),
                "error_type": "validation_error"
            }
            print(json.dumps(error_output))
        else:
            print(f"\n❌ Validation Error: {e}\n", file=sys.stderr)

        sys.exit(1)
```

- [ ] **Step 7: Manually verify the wiring rejects oversized input before model load**

Run:
```bash
source .venv/bin/activate
head -c 11000000 /dev/urandom > /tmp/oversized.wav
python -m src.pipeline_cli /tmp/oversized.wav --json
rm /tmp/oversized.wav
```
Expected: JSON output within a second or two (no multi-second model-loading delay), containing `"success": false` and `"error_type": "validation_error"`. If `piper`/model files aren't set up yet in this environment, you should still see the validation error appear well before any STT-model-loading log lines — confirming validation runs first.

- [ ] **Step 8: Commit**

```bash
git add src/audio_converter.py src/config.py src/pipeline_cli.py tests/test_audio_validation.py
git commit -m "feat: enforce audio size/duration limits before running the pipeline"
```

---

### Task 5: Use `LLM_BASE_URL` in `start_bot.sh`'s connectivity check

**Files:**
- Modify: `start_bot.sh`

**Interfaces:**
- Consumes: `LLM_BASE_URL` env var convention from Task 3 (default `http://localhost:8081`)

- [ ] **Step 1: Manually verify current (broken) behavior**

Run: `grep -n "100.86.147.125" start_bot.sh`
Expected: two matches (the `curl` check and its warning message) — this is the hardcoded IP to remove.

- [ ] **Step 2: Edit `start_bot.sh`**

Replace:
```bash
# Check LLM connectivity (optional warning)
echo ""
echo "Checking LLM connectivity..."
if curl -s "http://100.86.147.125:8081/health" > /dev/null 2>&1; then
    echo "✓ LLM accessible"
else
    echo "⚠️  Warning: LLM not accessible at http://100.86.147.125:8081"
    echo "   Voice processing may fail without LLM"
fi
```
with:
```bash
# Load LLM_BASE_URL from .env if set (falls back to the same default as src/config.py)
set -a
source .env
set +a
LLM_BASE_URL="${LLM_BASE_URL:-http://localhost:8081}"

# Check LLM connectivity (optional warning)
echo ""
echo "Checking LLM connectivity..."
if curl -s "${LLM_BASE_URL}/health" > /dev/null 2>&1; then
    echo "✓ LLM accessible"
else
    echo "⚠️  Warning: LLM not accessible at ${LLM_BASE_URL}"
    echo "   Voice processing may fail without LLM"
fi
```

- [ ] **Step 3: Verify the env var resolution logic works**

Run:
```bash
cd /home/alx/code/voicebot
echo "LLM_BASE_URL=http://example.test:9999" > /tmp/test.env
bash -c 'set -a; source /tmp/test.env; set +a; echo "${LLM_BASE_URL:-http://localhost:8081}"'
rm /tmp/test.env
```
Expected output: `http://example.test:9999`

Run also without the var set:
```bash
bash -c 'echo "${LLM_BASE_URL:-http://localhost:8081}"'
```
Expected output: `http://localhost:8081`

- [ ] **Step 4: Confirm no hardcoded IP remains in the script**

Run: `grep -n "100.86.147.125" start_bot.sh`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add start_bot.sh
git commit -m "fix: read LLM_BASE_URL from .env in start_bot.sh instead of a hardcoded IP"
```

---

### Task 6: Add a subprocess timeout for the Python pipeline call

**Files:**
- Create: `bot/subprocess-timeout.js`
- Create: `bot/subprocess-timeout.test.js`
- Modify: `bot/config.js`
- Modify: `bot/voice-handler.js`
- Modify: `bot/package.json`
- Modify: `.env.example`

**Interfaces:**
- Produces: `runWithTimeout(command, args, options, timeoutMs, callbacks?)` → `Promise<{ stdout: string, stderr: string }>`, rejecting (and killing the child process) if it doesn't finish within `timeoutMs`. `callbacks.onStdout`/`callbacks.onStderr` are optional streaming hooks. `config.PIPELINE_TIMEOUT_MS` (new, default `90000`).
- Consumes (in `voice-handler.js`): `config.PYTHON_CMD`, `config.PIPELINE_TIMEOUT_MS` from `bot/config.js`.

- [ ] **Step 1: Write the failing test**

Create `bot/subprocess-timeout.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithTimeout } from './subprocess-timeout.js';

test('resolves with stdout when the process exits quickly', async () => {
    const result = await runWithTimeout(process.execPath, ['-e', 'console.log("hello")'], {}, 5000);
    assert.equal(result.stdout.trim(), 'hello');
});

test('rejects when the process exceeds the timeout, and kills it', async () => {
    await assert.rejects(
        runWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], {}, 200),
        /timed out/
    );
});

test('rejects when the process exits non-zero', async () => {
    await assert.rejects(
        runWithTimeout(process.execPath, ['-e', 'process.exit(1)'], {}, 5000),
        /exited with code 1/
    );
});

test('streams stderr via the onStderr callback', async () => {
    const chunks = [];
    await runWithTimeout(
        process.execPath,
        ['-e', 'process.stderr.write("warn text")'],
        {},
        5000,
        { onStderr: (text) => chunks.push(text) }
    );
    assert.ok(chunks.join('').includes('warn text'));
});
```

- [ ] **Step 2: Add a test script to `bot/package.json`**

In `bot/package.json`, replace:
```json
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js"
  },
```
with:
```json
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "test": "node --test"
  },
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd bot && npm test`
Expected: FAIL — `subprocess-timeout.js` doesn't exist yet (module not found error).

- [ ] **Step 4: Create `bot/subprocess-timeout.js`**

```javascript
import { spawn } from 'child_process';

/**
 * Spawn a command, collecting stdout/stderr, and reject if it doesn't
 * finish within timeoutMs (killing the process in that case).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import('child_process').SpawnOptions} options
 * @param {number} timeoutMs
 * @param {{ onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void }} [callbacks]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function runWithTimeout(command, args, options, timeoutMs, callbacks = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, options);

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`Process timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
        }, timeoutMs);

        child.stdout?.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            callbacks.onStdout?.(text);
        });

        child.stderr?.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            callbacks.onStderr?.(text);
        });

        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Failed to spawn process: ${error.message}`));
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`Process exited with code ${code}: ${stderr}`));
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd bot && npm test`
Expected: all 4 tests in `subprocess-timeout.test.js` PASS.

- [ ] **Step 6: Add `PIPELINE_TIMEOUT_MS` to `bot/config.js`**

In `bot/config.js`, replace:
```javascript
    // Enable/disable error notifications in chat
    ENABLE_ERROR_NOTIFICATIONS: true,

    // Python command (can be overridden via env var)
    PYTHON_CMD: process.env.PYTHON_CMD || 'python'
};
```
with:
```javascript
    // Enable/disable error notifications in chat
    ENABLE_ERROR_NOTIFICATIONS: true,

    // Python command (can be overridden via env var)
    PYTHON_CMD: process.env.PYTHON_CMD || 'python',

    // Max time to wait for the Python pipeline before killing it (ms)
    PIPELINE_TIMEOUT_MS: parseInt(process.env.PIPELINE_TIMEOUT_MS || '90000', 10)
};
```

- [ ] **Step 7: Use `runWithTimeout` in `bot/voice-handler.js`**

Replace the top imports:
```javascript
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import config from './config.js';
```
with:
```javascript
import fs from 'fs/promises';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import config from './config.js';
import { runWithTimeout } from './subprocess-timeout.js';
```

Replace the entire `callPythonPipeline` function (everything from its JSDoc comment to its closing brace) with:
```javascript
/**
 * Call Python pipeline as subprocess, killing it if it exceeds the configured timeout
 * @param {string} audioPath - Path to audio file
 * @param {string} logPrefix - Log prefix for debugging
 * @returns {Promise<Object>} Pipeline result with transcription, llm_response, output_audio_path
 */
async function callPythonPipeline(audioPath, logPrefix = '') {
    const { stdout } = await runWithTimeout(
        config.PYTHON_CMD,
        ['-m', 'src.pipeline_cli', audioPath, '--json', '--output-format', 'ogg'],
        { cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..') },
        config.PIPELINE_TIMEOUT_MS,
        {
            onStderr: (text) => console.error(`${logPrefix} [Python stderr]:`, text.trim())
        }
    );

    try {
        return JSON.parse(stdout);
    } catch (parseError) {
        throw new Error(`Failed to parse pipeline output: ${parseError.message}\nOutput: ${stdout}`);
    }
}
```

- [ ] **Step 8: Document the new env var in `.env.example`**

Add:
```bash
# Optional: max time (ms) to wait for the Python pipeline before killing it
# PIPELINE_TIMEOUT_MS=90000
```

- [ ] **Step 9: Run the full Node test suite**

Run: `cd bot && npm test`
Expected: all tests PASS (no regressions).

- [ ] **Step 10: Commit**

```bash
git add bot/subprocess-timeout.js bot/subprocess-timeout.test.js bot/config.js bot/voice-handler.js bot/package.json .env.example
git commit -m "feat: add a timeout that kills a hung Python pipeline subprocess"
```

---

### Task 7: Serialize voice message processing with a queue

**Files:**
- Create: `bot/queue.js`
- Create: `bot/queue.test.js`
- Modify: `bot/index.js`

**Interfaces:**
- Produces: `createQueue()` → `{ enqueue(task: () => Promise<any>): Promise<any> }`. Tasks passed to `enqueue` run strictly one at a time, in the order enqueued; a rejected task does not block subsequent tasks.
- Consumes (in `index.js`): wraps calls to `handleVoiceMessage` from `bot/voice-handler.js` (unchanged from Task 6).

- [ ] **Step 1: Write the failing test**

Create `bot/queue.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from './queue.js';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('runs tasks sequentially, not concurrently', async () => {
    const queue = createQueue();
    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    function makeTask(id, ms) {
        return async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await delay(ms);
            order.push(id);
            concurrent--;
        };
    }

    await Promise.all([
        queue.enqueue(makeTask('a', 30)),
        queue.enqueue(makeTask('b', 10)),
        queue.enqueue(makeTask('c', 20)),
    ]);

    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(maxConcurrent, 1);
});

test('a failing task does not block later tasks', async () => {
    const queue = createQueue();
    const results = [];

    const first = queue.enqueue(async () => {
        throw new Error('boom');
    });
    const second = queue.enqueue(async () => {
        results.push('ran');
        return 'ok';
    });

    await assert.rejects(first, /boom/);
    assert.equal(await second, 'ok');
    assert.deepEqual(results, ['ran']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bot && npm test`
Expected: FAIL — `queue.js` doesn't exist yet.

- [ ] **Step 3: Create `bot/queue.js`**

```javascript
/**
 * Creates a simple FIFO queue that runs one async task at a time.
 * @returns {{ enqueue: (task: () => Promise<any>) => Promise<any> }}
 */
export function createQueue() {
    let tail = Promise.resolve();

    function enqueue(task) {
        const result = tail.then(() => task());
        // Swallow errors in the chain so one failed task doesn't block the next
        tail = result.catch(() => {});
        return result;
    }

    return { enqueue };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bot && npm test`
Expected: both tests in `queue.test.js` PASS, plus all previously-added tests still PASS.

- [ ] **Step 5: Wire the queue into `bot/index.js`**

Add the import near the top, alongside the other local imports:
```javascript
import { handleVoiceMessage } from './voice-handler.js';
import config from './config.js';
```
becomes:
```javascript
import { handleVoiceMessage } from './voice-handler.js';
import { createQueue } from './queue.js';
import config from './config.js';
```

Add a queue instance after the `client` is constructed (right before the `client.on('qr', ...)` block):
```javascript
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        headless: true
    }
});

const voiceQueue = createQueue();
```

Replace the message handler's processing calls:
```javascript
        // Filter: only process voice messages (ptt = push-to-talk)
        if (msg.hasMedia && msg.type === 'ptt') {
            console.log(`\nVoice message received! Processing...`);
            await handleVoiceMessage(msg, chat, client);
        } else if (msg.hasMedia && msg.type === 'audio') {
            // Also handle regular audio messages
            console.log(`\nAudio message received! Processing...`);
            await handleVoiceMessage(msg, chat, client);
        }
```
with:
```javascript
        // Filter: only process voice messages (ptt = push-to-talk)
        if (msg.hasMedia && msg.type === 'ptt') {
            console.log(`\nVoice message received! Queued for processing...`);
            voiceQueue.enqueue(() => handleVoiceMessage(msg, chat, client));
        } else if (msg.hasMedia && msg.type === 'audio') {
            // Also handle regular audio messages
            console.log(`\nAudio message received! Queued for processing...`);
            voiceQueue.enqueue(() => handleVoiceMessage(msg, chat, client));
        }
```
(Note: `handleVoiceMessage` already catches and reports its own errors internally via `chat.sendMessage`, so it's intentionally not awaited here — the message handler moves on immediately, and the queue guarantees only one runs at a time.)

- [ ] **Step 6: Run the full Node test suite**

Run: `cd bot && npm test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add bot/queue.js bot/queue.test.js bot/index.js
git commit -m "feat: process voice messages one at a time via a queue"
```

---

### Task 8: Add a root `LICENSE` file

**Files:**
- Create: `LICENSE`

**Interfaces:** none (static file)

- [ ] **Step 1: Confirm the declared license**

Run: `grep -n "license" bot/package.json README.md`
Expected: both show `MIT`.

- [ ] **Step 2: Create `LICENSE`**

```
MIT License

Copyright (c) 2026 Alexandre Girard Davila

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Commit**

```bash
git add LICENSE
git commit -m "chore: add MIT LICENSE file"
```

---

### Task 9: Commit `bot/package-lock.json` for reproducible installs

**Files:**
- Modify: `.gitignore`
- Create (tracked): `bot/package-lock.json`

**Interfaces:** none

- [ ] **Step 1: Generate the lockfile**

Run: `cd bot && npm install`
Expected: `bot/package-lock.json` is created/updated (it may already exist locally from prior development, untracked — `npm install` will refresh it against the current `package.json`).

- [ ] **Step 2: Un-ignore `package-lock.json` in `.gitignore`**

In `.gitignore`, replace:
```
# Node.js
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
package-lock.json
yarn.lock
```
with:
```
# Node.js
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
yarn.lock
```

- [ ] **Step 3: Verify the lockfile is now trackable**

Run: `cd /home/alx/code/voicebot && git status --short bot/package-lock.json`
Expected: shows `??` (untracked, ready to add) — not ignored.

- [ ] **Step 4: Commit**

```bash
git add .gitignore bot/package-lock.json
git commit -m "chore: commit package-lock.json for reproducible installs"
```

---

### Task 10: Clean up remaining docs cruft

**Files:**
- Delete: `docs/STATUS.md`
- Modify: `docs/GET_GROUP_ID.md`
- Modify: `src/__init__.py`

**Interfaces:** none

- [ ] **Step 1: Remove the personal dev-log**

`docs/STATUS.md` is a dated (2025-12-12), point-in-time personal dev log referencing the absolute path `/home/alx/code/voice_bot/`. Its only content worth keeping (expected component latencies) is carried forward into the README rewrite in Task 11.

Run: `git rm docs/STATUS.md`

- [ ] **Step 2: Fix broken script path references in `docs/GET_GROUP_ID.md`**

The doc references `./get_group_id.sh`, but the actual script lives at `scripts/get_group_id.sh`. Fix all four occurrences (lines 10, 26, 46, 151) by replacing each:
```
./get_group_id.sh
```
with:
```
./scripts/get_group_id.sh
```
(Do this as one `replace_all`-style edit across the file — all four instances are identical text.)

- [ ] **Step 3: Fix personal absolute paths in `docs/GET_GROUP_ID.md`**

Replace:
```
## Files Created

- `/home/alx/code/voice_bot/bot/get_group_id.js` - Node.js script that connects to WhatsApp
- `/home/alx/code/voice_bot/get_group_id.sh` - Shell wrapper for easy execution
```
with:
```
## Files Created

- `bot/get_group_id.js` - Node.js script that connects to WhatsApp
- `scripts/get_group_id.sh` - Shell wrapper for easy execution
```

- [ ] **Step 4: Fix the WAHA reference in `src/__init__.py`**

Replace:
```python
"""
WhatsApp Voice Bot - STT->LLM->TTS Pipeline with WAHA Integration
"""

__version__ = "1.0.0"
```
with:
```python
"""
WhatsApp Voice Bot - STT->LLM->TTS Pipeline
"""

__version__ = "1.0.0"
```

- [ ] **Step 5: Confirm no personal paths or WAHA references remain in docs**

Run: `grep -rln "WAHA\|/home/alx" docs/ src/__init__.py`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add -u docs/STATUS.md docs/GET_GROUP_ID.md src/__init__.py
git commit -m "docs: remove personal dev-log and fix stale paths/references"
```

---

### Task 11: Rewrite `README.md`

**Files:**
- Modify: `README.md`

**Interfaces:** none (documentation only)

**Depends on:** Tasks 1–10 (documents the env vars, scripts, and tests they introduced).

- [ ] **Step 1: Overwrite `README.md`**

```markdown
# WhatsApp Voice Bot - whatsapp-web.js

A WhatsApp voice bot that processes voice messages through an STT→LLM→TTS pipeline using whatsapp-web.js.

> **Note on whatsapp-web.js:** this bot connects via [whatsapp-web.js](https://wwebjs.dev/), an unofficial client that automates WhatsApp Web. It is not sanctioned by WhatsApp/Meta and using it technically violates WhatsApp's Terms of Service — accounts *can* be banned for automated use, though this is commonly used for personal/small-group bots. Use at your own risk, ideally with a number you don't mind losing.

## Architecture

**Hybrid Node.js + Python:**
- **Node.js**: Handles WhatsApp connection (whatsapp-web.js library)
- **Python**: Handles voice processing (STT→LLM→TTS pipeline)

```
WhatsApp → whatsapp-web.js → Node.js bot → Python subprocess → Response
                (receives)     (processes)    (STT/LLM/TTS)     (sends back)
```

## Features

- 🎤 Receives voice messages from WhatsApp groups
- 📝 Transcribes speech using faster-whisper (French by default)
- 🤖 Generates responses using any OpenAI-compatible LLM server
- 🔊 Synthesizes speech using Piper TTS
- ✅ Sends 4 status updates: acknowledgment, transcription, LLM response, audio
- 🔐 QR code authentication (once), session persisted
- ❌ Graceful error handling with user notifications
- 🚦 Oversized/overlong voice notes rejected before they hit the pipeline; only one message processed at a time; a hung pipeline subprocess is killed after a timeout

## Prerequisites

1. **Node.js** (v18+)
   ```bash
   node --version  # Check if installed
   ```

2. **Python 3.8+** with virtual environment
   ```bash
   python3 --version
   ```

3. **Chromium/Chrome** (for whatsapp-web.js)
   ```bash
   sudo apt install chromium-browser  # Ubuntu/Debian
   ```

4. **ffmpeg** (for audio processing)
   ```bash
   sudo apt install ffmpeg
   ```

5. **An OpenAI-compatible LLM server** (e.g. [llama-server](https://github.com/ggerganov/llama.cpp), [ollama](https://ollama.com/), vLLM, LM Studio) reachable over HTTP. Defaults to `http://localhost:8081`; override with `LLM_BASE_URL` in `.env` if it runs elsewhere.

6. **Piper TTS voice model** — see step 5 below.

## Quick Start

### 1. Install Dependencies

**Node.js:**
```bash
cd bot
npm install
```

**Python:**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Download a Piper voice model

`piper-tts` (installed above) provides the `piper` CLI, but voices are downloaded separately. This project defaults to the French `fr_FR-siwis-medium` voice:

```bash
mkdir -p models/piper
source .venv/bin/activate
python -m piper.download_voices fr_FR-siwis-medium --download-dir models/piper
```

This creates `models/piper/fr_FR-siwis-medium.onnx` and its `.onnx.json` config, which `src/pipeline.py` expects. Browse other voices at the [Piper voices catalog](https://github.com/rhasspy/piper/blob/master/VOICES.md) — see "Customization" below for using a different language/voice.

### 3. Configure Environment

```bash
# Create .env from template
cp .env.example .env

# Edit .env (VOICEBOT_GROUP_ID is optional on first run; LLM_BASE_URL only needed
# if your LLM server isn't at http://localhost:8081)
nano .env
```

### 4. Start the Bot

```bash
./start_bot.sh
```

**On first run:**
1. A QR code will appear in the terminal
2. Open WhatsApp on your phone → Settings → Linked Devices
3. Tap "Link a Device" and scan the QR code
4. Wait for "WhatsApp bot ready!"

**After authentication:**
- Session saved in `.wwebjs_auth/` (no QR code needed again)
- Send a test message to any group to see chat IDs in logs
- Update `.env` with your target group ID
- Restart bot

### 5. Find Your Group ID

**Option A: Use the Group ID Finder Script (Recommended)**

Run the provided script to list all your groups:
```bash
./scripts/get_group_id.sh
```

This will display all your WhatsApp groups with their IDs. Copy the ID you want to use.

See [docs/GET_GROUP_ID.md](docs/GET_GROUP_ID.md) for detailed instructions.

**Option B: Manual Method**

Send a message to your target WhatsApp group. The bot will log:
```
Incoming message from chat: 120363123456789@g.us (Group Name)
```

Copy this ID to `.env`:
```bash
VOICEBOT_GROUP_ID=120363123456789@g.us
```

Restart the bot.

### 6. Test with Voice Message

1. Send a voice message to the configured group
2. Bot will respond with 4 messages:
   - 🎤 "Message vocal reçu..."
   - 📝 "Transcription: {your speech}"
   - 🤖 "Réponse: {LLM answer}"
   - 🔊 Voice audio file

## Project Structure

```
voicebot/
├── bot/                          # Node.js WhatsApp bot
│   ├── index.js                  # Main bot entry point
│   ├── voice-handler.js          # Voice message processing
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
│
├── tests/                        # Python test suite (run: pytest)
├── tests/step1/                  # Manual example scripts (STT/TTS tried individually)
├── docs/                         # Setup guides
├── audio/                        # Runtime audio files (gitignored)
├── models/                       # AI models (gitignored)
├── LICENSE
├── .env                          # Your local configuration (gitignored)
└── start_bot.sh                  # Startup script
```

## Configuration

### Environment Variables (.env)

```bash
# WhatsApp group ID (format: 120363123456789@g.us)
VOICEBOT_GROUP_ID=

# Optional: LLM server, if not http://localhost:8081
# LLM_BASE_URL=http://localhost:8081
# LLM_MODEL_NAME=your-model-name.gguf

# Optional: max time (ms) to wait for the Python pipeline before killing it
# PIPELINE_TIMEOUT_MS=90000

# Optional: Python command override
# PYTHON_CMD=python3

# Optional: Override default logging level
# LOG_LEVEL=INFO
```

### Status Messages

Edit `bot/config.js` to customize messages sent to users:

```javascript
STATUS_MESSAGES: {
    received: "🎤 Message vocal reçu, traitement en cours...",
    transcription: "📝 Transcription: {}",
    llm_response: "🤖 Réponse: {}",
    error: "❌ Erreur: {}"
}
```

## Customization

This bot defaults to French. To use another language, change these three places:

1. `src/config.py`: `STT_LANGUAGE` (or `None` for auto-detect) and `SYSTEM_PROMPT`
2. `src/pipeline.py`: `synthesize_speech()`'s hardcoded Piper model path (`models/piper/fr_FR-siwis-medium.onnx`)
3. Download the corresponding Piper voice for your target language (see step 2 in Quick Start)

## Testing

### Automated tests

```bash
# Python (pytest)
source .venv/bin/activate
pytest

# Node (built-in test runner)
cd bot
npm test
```

### Test Python Pipeline Directly

```bash
source .venv/bin/activate
python -m src.pipeline_cli path/to/audio.wav --json
# Expected output: JSON with transcription, llm_response, output_audio_path
```

### Manual component scripts

`tests/step1/` has small standalone scripts for trying STT/TTS individually (not part of the automated suite):
```bash
cd tests/step1
python create_sample_audio.py       # generates sample French WAV files
python test_stt_only.py ../../audio/input/sample_greeting.wav
```

## Troubleshooting

### QR Code Not Showing

```bash
# Check if Node.js and dependencies installed
cd bot && npm install

# Try running directly
cd bot && node index.js
```

### "Chromium not found" Error

```bash
# Install Chromium
sudo apt install chromium-browser  # Ubuntu/Debian
sudo yum install chromium          # CentOS/RHEL
```

### Session Expired / QR Code Again

```bash
# Delete session data and re-authenticate
rm -rf bot/.wwebjs_auth/
./start_bot.sh
```

### Python Pipeline Fails

```bash
# Test Python pipeline manually
source .venv/bin/activate
python -m src.pipeline_cli path/to/audio.wav --json

# Check LLM connectivity (uses LLM_BASE_URL from .env, default localhost:8081)
curl "${LLM_BASE_URL:-http://localhost:8081}/health"
```

### Bot Not Responding to Voice Messages

1. Check bot is running and authenticated
2. Verify `VOICEBOT_GROUP_ID` is correct in `.env`
3. Send voice message to configured group (not individual chat)
4. Check bot logs for errors

## Performance

Approximate latency per voice message (French, small Whisper model, CPU STT/TTS):
- Download: ~0.5s
- STT: ~1.5-2s
- LLM: ~2-3s (depends on your LLM server/hardware)
- TTS: ~1s
- Upload + status: ~0.5s
- **Total: ~6-7 seconds per voice message**

## Known Limitations

- **No persistent model**: each voice message spawns a new Python subprocess that reloads the Whisper model from disk. This adds latency vs. a long-running worker process — a reasonable target for a future improvement, not implemented here to keep the architecture simple.
- **Single-instance, no horizontal scaling**: one bot process, one WhatsApp session. Not designed for multiple concurrent group deployments from one codebase instance.
- **No per-user rate limiting**: anyone in the configured group can trigger the pipeline; there's no cooldown or quota per sender, only the global one-at-a-time queue.
- **Unofficial WhatsApp client**: see the note at the top of this README.

## Development

### Run with Auto-Reload

```bash
cd bot
npm run dev  # Watches for file changes
```

### Debug Mode

```bash
# Enable verbose logging
LOG_LEVEL=DEBUG ./start_bot.sh
```

## Support

For issues:
1. Check logs in terminal
2. Test Python pipeline: `python -m src.pipeline_cli path/to/audio.wav --json`
3. Verify Node.js and Python both working
4. Check `.env` configuration

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- **whatsapp-web.js**: WhatsApp Web client library (https://wwebjs.dev/)
- **faster-whisper**: Fast STT (https://github.com/guillaumekln/faster-whisper)
- **Piper TTS**: Fast TTS (https://github.com/rhasspy/piper)
```

- [ ] **Step 2: Verify no stale references remain**

Run: `grep -n "WAHA\|100.86.147.125\|/home/alx" README.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for public release (env config, Piper setup, ToS note, limitations)"
```

---

## Final Verification

- [ ] **Run the full test suite one more time end to end**

```bash
cd /home/alx/code/voicebot
source .venv/bin/activate
pytest -v
deactivate
cd bot && npm test && cd ..
```
Expected: all Python and Node tests PASS.

- [ ] **Sweep for any remaining personal/environment-specific info**

```bash
grep -rn "100.86.147.125\|/home/alx" --include="*.py" --include="*.js" --include="*.md" --include="*.sh" --include="*.json" .
```
Expected: no output.

- [ ] **Confirm git status is clean**

```bash
git status
```
Expected: working tree clean, all 11 task commits present in `git log`.
