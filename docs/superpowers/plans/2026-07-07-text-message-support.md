# Text-Message Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let group members type to the bot; every text message in the configured group gets a text-only reply from the same reply logic the voice pipeline uses (direct LLM or SillyTavern/Trico backend).

**Architecture:** Extend `src/pipeline.py` with a lazy-loaded STT/TTS init and a new `run_text_pipeline()` that reuses the existing backend switch. `src/pipeline_cli.py` gains a `--text` mode. On the Node side, a new `bot/text-handler.js` mirrors `voice-handler.js`, sharing the existing voice queue, and a new `sendTracked` helper in `bot/message-tracker.js` generalizes echo protection to all outgoing messages (text and voice).

**Tech Stack:** Python (pytest, `unittest.mock`), Node.js (`node:test`, `node:assert/strict`), existing `runWithTimeout` subprocess wrapper.

## Global Constraints

- Reply medium: text only, one message, no TTS, no status messages (per spec).
- Trigger: every text message (`type === 'chat'`) in the configured group, non-empty after trim.
- Both backends (`LLM_BACKEND=direct` and `LLM_BACKEND=sillytavern`) must work.
- Text and voice messages share one queue (the SillyTavern bridge drives a single conversation, must never handle two jobs concurrently).
- `TEXT_MAX_CHARS` default 1000, env-overridable, defined once in `src/config.py` and mirrored in `bot/config.js`.
- JSON envelope for text mode: `{"success": true, "llm_response": ..., "timing": ...}` — no `transcription` or `output_audio_path` keys. Error envelope unchanged: `{"success": false, "error": ..., "error_type": ...}`.
- Lazy STT/TTS loading must not change voice-flow behavior (models still load on first use, same errors raised).

---

### Task 1: Lazy STT/TTS loading in `VoicePipeline.__init__`

**Files:**
- Modify: `src/pipeline.py:43-113` (`__init__`), `src/pipeline.py:115-156` (`transcribe_audio`), `src/pipeline.py:256-294` (`synthesize_speech`)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `VoicePipeline._ensure_stt()` (loads `self.stt_model` once, idempotent), `VoicePipeline._ensure_tts()` (validates/sets `self.piper_model` once, idempotent). Both are called internally by `transcribe_audio()` and `synthesize_speech()` respectively — no other task calls them directly, but Task 3 relies on `VoicePipeline.__init__` no longer loading Whisper/Piper.

Today `__init__` eagerly loads the Whisper model and checks for the Piper model file, and also does an LLM health check. We keep the LLM health check in `__init__` (it's already best-effort/non-blocking), but move STT/TTS loading to first use so `--text` mode skips a ~2-4s model load entirely.

- [ ] **Step 1: Write the failing test for lazy STT loading**

Add to `tests/test_pipeline.py`:

```python
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
        PROJECT_ROOT="/nonexistent/project-root",
    )
    with patch("src.pipeline.requests.get", side_effect=requests.exceptions.ConnectionError("refused")), \
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
    config = SimpleNamespace(PROJECT_ROOT=str(tmp_path))
    pipeline = VoicePipeline.__new__(VoicePipeline)
    pipeline.config = config

    with pytest.raises(VoicePipelineError, match="Piper model not found"):
        pipeline.synthesize_speech("bonjour", "fr", str(tmp_path / "out.wav"))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source .venv/bin/activate && pytest tests/test_pipeline.py -k "lazy or loads_stt_model or checks_piper_model or init_does_not_load" -v`
Expected: FAIL — `VoicePipeline.__init__` still eagerly loads `WhisperModel` and checks for the Piper file, so `mock_whisper.assert_not_called()` fails and `pipeline.piper_model` is unset before any call.

- [ ] **Step 3: Move STT loading out of `__init__` into `_ensure_stt()`**

In `src/pipeline.py`, replace the STT block in `__init__` (lines 58-83) with nothing (delete it — STT loading no longer happens in `__init__`), and add a new method plus call it from `transcribe_audio`:

```python
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
```

Update `transcribe_audio` (currently starting at line 115) to call `self._ensure_stt()` as its first line inside the `try` block... actually call it before the `try`, since a load failure should raise `VoicePipelineError` directly (it already does inside `_ensure_stt`) rather than being wrapped again. Add the call as the first statement of the method body, before the existing `logger.info(f"[STT] Transcribing: ...")` line:

```python
    def transcribe_audio(self, audio_path: str) -> Tuple[str, str]:
        """
        Step 1: Transcribe audio to text using faster-whisper
        ...
        """
        self._ensure_stt()
        logger.info(f"[STT] Transcribing: {Path(audio_path).name}")
```

- [ ] **Step 4: Move TTS check out of `__init__` into `_ensure_tts()`**

Replace the TTS block in `__init__` (lines 98-109) with nothing, and add:

```python
    def _ensure_tts(self):
        """Lazily validate the Piper model path on first use."""
        if getattr(self, "piper_model", None) is not None:
            return

        piper_model = os.path.join(self.config.PROJECT_ROOT, "models", "piper", "fr_FR-siwis-medium.onnx")
        if not os.path.exists(piper_model):
            logger.error(f"   ✗ ERROR: Piper model not found at {piper_model}")
            raise VoicePipelineError(f"Piper model not found: {piper_model}")
        self.piper_model = piper_model
```

Update `synthesize_speech` (currently starting at line 256) to call `self._ensure_tts()` as its first statement:

```python
    def synthesize_speech(self, text: str, language: str, output_path: str):
        """
        Step 3: Synthesize speech using Piper TTS
        ...
        """
        self._ensure_tts()
        logger.info(f"[TTS] Synthesizing speech ({language}) with Piper")
```

Also update the `__init__` log banner: since STT is `[1/3]` and TTS is `[3/3]` no longer describes what happens in `__init__` (only the LLM health check remains eager), simplify the remaining `__init__` body to just the health check without step numbering:

```python
        # Test LLM connection
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

        logger.info("Pipeline ready (STT/TTS load lazily on first use)")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `source .venv/bin/activate && pytest tests/test_pipeline.py -v`
Expected: PASS (all tests, including the pre-existing ones — `_make_pipeline` in the existing tests already bypasses `__init__` via `VoicePipeline.__new__`, so they're unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.py tests/test_pipeline.py
git commit -m "refactor: load STT/TTS models lazily on first use"
```

---

### Task 2: `TEXT_MAX_CHARS` config

**Files:**
- Modify: `src/config.py:60-63` (Audio Processing section), `bot/config.js:26-34`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `src.config.TEXT_MAX_CHARS` (int, default 1000, from env `TEXT_MAX_CHARS`), `bot/config.js` default export gains `TEXT_MAX_CHARS` (int, same default/env var). Task 3 (`pipeline_cli.py --text`) and Task 6 (`bot/text-handler.js`) both read this.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_config.py`:

```python
def test_text_max_chars_defaults_to_1000(monkeypatch):
    monkeypatch.delenv("TEXT_MAX_CHARS", raising=False)
    config = _reload_config()
    assert config.TEXT_MAX_CHARS == 1000


def test_text_max_chars_override(monkeypatch):
    monkeypatch.setenv("TEXT_MAX_CHARS", "500")
    config = _reload_config()
    assert config.TEXT_MAX_CHARS == 500
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source .venv/bin/activate && pytest tests/test_config.py -k text_max_chars -v`
Expected: FAIL with `AttributeError: module 'src.config' has no attribute 'TEXT_MAX_CHARS'`

- [ ] **Step 3: Add `TEXT_MAX_CHARS` to `src/config.py`**

In `src/config.py`, in the "Audio Processing" section (after line 63, `AUDIO_MAX_DURATION_SEC = 300`), add:

```python

# Text message processing
TEXT_MAX_CHARS = int(os.getenv("TEXT_MAX_CHARS", "1000"))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source .venv/bin/activate && pytest tests/test_config.py -v`
Expected: PASS

- [ ] **Step 5: Add matching `TEXT_MAX_CHARS` to `bot/config.js`**

In `bot/config.js`, add to the default export object (after `PIPELINE_TIMEOUT_MS`, line 33):

```javascript
    PIPELINE_TIMEOUT_MS: parseInt(process.env.PIPELINE_TIMEOUT_MS || '90000', 10),

    // Max characters allowed in a text message before Trico rejects it without calling Python
    TEXT_MAX_CHARS: parseInt(process.env.TEXT_MAX_CHARS || '1000', 10)
```

(Note: this replaces the trailing line so there's a comma after `PIPELINE_TIMEOUT_MS`'s value — the object's last property was previously `PIPELINE_TIMEOUT_MS`.)

- [ ] **Step 6: Commit**

```bash
git add src/config.py bot/config.js tests/test_config.py
git commit -m "feat: add TEXT_MAX_CHARS config shared by Python and Node"
```

---

### Task 3: `run_text_pipeline()` on `VoicePipeline`

**Files:**
- Modify: `src/pipeline.py` (add method after `run_pipeline`, currently ending at line 376)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `self.config.LLM_BACKEND`, `self.query_sillytavern(text)`, `self.query_llm(text, language)` (all pre-existing).
- Produces: `VoicePipeline.run_text_pipeline(text: str) -> Dict[str, Any]` returning `{"llm_response": str, "timing": {"llm": float, "total": float}}`. Raises `VoicePipelineError` on empty input or backend failure. Task 4 (`pipeline_cli.py --text`) calls this directly.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_pipeline.py`:

```python
def test_run_text_pipeline_dispatches_to_direct_llm_by_default():
    pipeline = _make_pipeline(LLM_BACKEND="direct")

    with patch.object(pipeline, "query_llm", return_value="salut!") as mock_direct, \
         patch.object(pipeline, "query_sillytavern") as mock_st:
        result = pipeline.run_text_pipeline("bonjour")

    mock_direct.assert_called_once_with("bonjour", None)
    mock_st.assert_not_called()
    assert result["llm_response"] == "salut!"
    assert "llm" in result["timing"]
    assert "total" in result["timing"]


def test_run_text_pipeline_dispatches_to_sillytavern_when_configured():
    pipeline = _make_pipeline(LLM_BACKEND="sillytavern")

    with patch.object(pipeline, "query_sillytavern", return_value="salut!") as mock_st, \
         patch.object(pipeline, "query_llm") as mock_direct:
        result = pipeline.run_text_pipeline("bonjour")

    mock_st.assert_called_once_with("bonjour")
    mock_direct.assert_not_called()
    assert result["llm_response"] == "salut!"


def test_run_text_pipeline_raises_on_empty_text():
    pipeline = _make_pipeline()

    with pytest.raises(VoicePipelineError, match="Empty text input"):
        pipeline.run_text_pipeline("   ")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source .venv/bin/activate && pytest tests/test_pipeline.py -k run_text_pipeline -v`
Expected: FAIL with `AttributeError: 'VoicePipeline' object has no attribute 'run_text_pipeline'`

- [ ] **Step 3: Implement `run_text_pipeline`**

Add to `src/pipeline.py`, after `run_pipeline` (after line 376, before the end of the class):

```python
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
            if self.config.LLM_BACKEND == "sillytavern":
                llm_response = self.query_sillytavern(text)
            else:
                llm_response = self.query_llm(text, None)
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

Note: `query_llm(user_text, language)` uses `language` only for logging (`src/pipeline.py:172` logs the model name, not the language — check: `language` param is accepted but not referenced in the request payload or logic other than being part of the signature). Passing `None` is safe since it's unused in the request body.

- [ ] **Step 4: Run tests to verify they pass**

Run: `source .venv/bin/activate && pytest tests/test_pipeline.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.py tests/test_pipeline.py
git commit -m "feat: add run_text_pipeline for text-only replies"
```

---

### Task 4: `--text` mode in `pipeline_cli.py`

**Files:**
- Modify: `src/pipeline_cli.py`
- Test: `tests/test_pipeline_cli.py` (new file)

**Interfaces:**
- Consumes: `VoicePipeline.run_text_pipeline(text) -> dict` (Task 3), `config.TEXT_MAX_CHARS` (Task 2).
- Produces: CLI flag `--text <message>`, mutually exclusive with the positional `audio_file`. JSON output on success: `{"success": true, "llm_response": ..., "timing": ...}`. Task 5 (Node `text-handler.js`) invokes this via `python -m src.pipeline_cli --text "<body>" --json`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_pipeline_cli.py`:

```python
import json
import subprocess
import sys

import pytest


def run_cli(args):
    return subprocess.run(
        [sys.executable, "-m", "src.pipeline_cli"] + args,
        capture_output=True,
        text=True,
    )


def test_text_and_audio_file_are_mutually_exclusive():
    result = run_cli(["some.wav", "--text", "hello", "--json"])
    assert result.returncode != 0
    assert "not allowed with argument" in result.stderr or "one of the arguments" in result.stderr


def test_requires_either_text_or_audio_file():
    result = run_cli(["--json"])
    assert result.returncode != 0


def test_text_over_max_chars_rejected(monkeypatch):
    monkeypatch.setenv("TEXT_MAX_CHARS", "10")
    result = run_cli(["--text", "this message is way over ten characters", "--json"])
    assert result.returncode == 1
    output = json.loads(result.stdout)
    assert output["success"] is False
    assert output["error_type"] == "validation_error"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source .venv/bin/activate && pytest tests/test_pipeline_cli.py -v`
Expected: FAIL — `--text` is not a recognized argument yet (argparse error differs, or `audio_file` is still required positional causing a different failure mode).

- [ ] **Step 3: Update argument parsing in `src/pipeline_cli.py`**

Replace the positional `audio_file` argument (lines 32-35) and add `--text`, making them a mutually exclusive required group. Replace:

```python
    parser.add_argument(
        'audio_file',
        help='Input audio file path (OGG, WAV, MP3, etc.)'
    )
```

with:

```python
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument(
        'audio_file',
        nargs='?',
        help='Input audio file path (OGG, WAV, MP3, etc.)'
    )
    input_group.add_argument(
        '--text',
        help='Text message to reply to (skips STT, text-only reply)'
    )
```

- [ ] **Step 4: Branch `main()` on `args.text` vs `args.audio_file`**

In `src/pipeline_cli.py`, replace the body of the `try` block (lines 60-125) with a branch. The audio path keeps its existing logic unchanged; a new text path is added before it:

```python
    try:
        if args.text:
            if len(args.text) > config.TEXT_MAX_CHARS:
                raise ValueError(
                    f"Text message too long: {len(args.text)} chars "
                    f"(max {config.TEXT_MAX_CHARS})"
                )

            logger.info(f"Processing text message ({len(args.text)} chars)")

            pipeline = VoicePipeline(config)
            result = pipeline.run_text_pipeline(args.text)

            if args.json:
                json_output = {
                    "success": True,
                    "llm_response": result["llm_response"],
                    "timing": result["timing"]
                }
                print(json.dumps(json_output))
            else:
                print("\n" + "=" * 60)
                print("Text Pipeline Result:")
                print("=" * 60)
                print(f"LLM Response: {result['llm_response']}")
                print(f"\nTiming:")
                print(f"  LLM: {result['timing']['llm']:.2f}s")
                print(f"  Total: {result['timing']['total']:.2f}s")
                print("=" * 60 + "\n")

            sys.exit(0)

        # Validate input file exists
        audio_path = Path(args.audio_file)
        if not audio_path.exists():
            raise FileNotFoundError(f"Audio file not found: {args.audio_file}")

        logger.info(f"Processing audio file: {args.audio_file}")

        # Validate before loading any models — reject bad input cheaply
        validate_audio_file(
            str(audio_path),
            max_size_mb=config.AUDIO_MAX_SIZE_MB,
            max_duration_sec=config.AUDIO_MAX_DURATION_SEC
        )

        # Initialize pipeline (logs to stderr)
        pipeline = VoicePipeline(config)

        # Run pipeline
        result = pipeline.run_pipeline(str(audio_path.absolute()))

        # Convert WAV to OGG/Opus if requested (for WhatsApp compatibility)
        if args.output_format == 'ogg':
            import os
            from src.audio_converter import convert_wav_to_ogg_opus

            wav_path = result['output_audio_path']
            ogg_path = wav_path.replace('.wav', '.ogg')

            logger.info(f"Converting WAV to OGG/Opus for WhatsApp: {ogg_path}")
            convert_wav_to_ogg_opus(wav_path, ogg_path)

            # Clean up intermediate WAV file
            os.remove(wav_path)

            # Update result to point to OGG file
            result['output_audio_path'] = ogg_path

        if args.json:
            # Output JSON to stdout for Node.js
            json_output = {
                "success": True,
                "transcription": result["transcription"],
                "language": result["language"],
                "llm_response": result["llm_response"],
                "output_audio_path": result["output_audio_path"],
                "timing": result["timing"]
            }
            print(json.dumps(json_output))
        else:
            # Human-readable output
            print("\n" + "=" * 60)
            print("Pipeline Result:")
            print("=" * 60)
            print(f"Transcription: {result['transcription']}")
            print(f"Language: {result['language']}")
            print(f"LLM Response: {result['llm_response']}")
            print(f"Output Audio: {result['output_audio_path']}")
            print(f"\nTiming:")
            print(f"  STT: {result['timing']['stt']:.2f}s")
            print(f"  LLM: {result['timing']['llm']:.2f}s")
            print(f"  TTS: {result['timing']['tts']:.2f}s")
            print(f"  Total: {result['timing']['total']:.2f}s")
            print("=" * 60 + "\n")

        sys.exit(0)
```

The `except` blocks below (`VoicePipelineError`, `FileNotFoundError`, `ValueError`, generic `Exception`) are unchanged — the new `ValueError` raised for over-length text is already caught by the existing `except ValueError as e:` block (lines 157-170), which already emits `"error_type": "validation_error"`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `source .venv/bin/activate && pytest tests/test_pipeline_cli.py -v`
Expected: PASS

Note: `test_text_over_max_chars_rejected` and the other subprocess-based tests will attempt to construct `VoicePipeline` only in cases that pass validation — the over-length case fails validation before `VoicePipeline(config)` is called, so it doesn't need real models. Good — no mocking required for that test.

- [ ] **Step 6: Run full pytest suite to check nothing else broke**

Run: `source .venv/bin/activate && pytest -v`
Expected: PASS (all tests across the suite)

- [ ] **Step 7: Commit**

```bash
git add src/pipeline_cli.py tests/test_pipeline_cli.py
git commit -m "feat: add --text mode to pipeline_cli for text-only replies"
```

---

### Task 5: Generalize echo protection into `sendTracked`

**Files:**
- Create: `bot/message-tracker.js`
- Modify: `bot/voice-handler.js` (replace direct `chat.sendMessage` calls), `bot/index.js` (pass tracker instead of raw `sentReplyIds` set, keep the skip-check)
- Test: `bot/message-tracker.test.js` (new file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `bot/message-tracker.js` exports `createMessageTracker()` returning `{ sendTracked(chat, content, options), wasSent(messageId), release(messageId) }`. `sendTracked` calls `chat.sendMessage(content, options)`, records the returned message's id, and returns the sent message. `wasSent(id)` checks membership. `release(id)` removes it (call after a match, mirroring today's delete-on-match behavior in `bot/index.js:100-103`). Task 6 (`text-handler.js`) and Task 7 (`voice-handler.js` update) both use `sendTracked`; Task 7 also updates `bot/index.js` to use `wasSent`/`release` instead of the raw `Set`.

- [ ] **Step 1: Write the failing test**

Create `bot/message-tracker.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageTracker } from './message-tracker.js';

function makeFakeChat(sentId) {
    return {
        sendMessage: async (content, options) => ({
            id: { id: sentId },
            content,
            options
        })
    };
}

test('sendTracked records the sent message id', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat('msg-1');

    const sent = await tracker.sendTracked(chat, 'hello');

    assert.equal(sent.id.id, 'msg-1');
    assert.equal(tracker.wasSent('msg-1'), true);
});

test('wasSent returns false for unknown ids', () => {
    const tracker = createMessageTracker();
    assert.equal(tracker.wasSent('never-sent'), false);
});

test('release removes the id so it is only consumed once', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat('msg-2');

    await tracker.sendTracked(chat, 'hello');
    assert.equal(tracker.wasSent('msg-2'), true);

    tracker.release('msg-2');
    assert.equal(tracker.wasSent('msg-2'), false);
});

test('sendTracked forwards options to chat.sendMessage', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat('msg-3');

    const sent = await tracker.sendTracked(chat, 'audio-content', { sendAudioAsVoice: true });

    assert.deepEqual(sent.options, { sendAudioAsVoice: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npm test -- message-tracker.test.js`
Expected: FAIL — `bot/message-tracker.js` does not exist yet (module not found).

- [ ] **Step 3: Implement `bot/message-tracker.js`**

```javascript
/**
 * Tracks message IDs the bot itself has sent, so the bot's own outgoing
 * messages (text replies, status updates, voice replies) don't get
 * re-processed when whatsapp-web.js echoes them back via message_create.
 * @returns {{
 *   sendTracked: (chat: Chat, content: any, options?: object) => Promise<Message>,
 *   wasSent: (messageId: string) => boolean,
 *   release: (messageId: string) => void
 * }}
 */
export function createMessageTracker() {
    const sentIds = new Set();

    async function sendTracked(chat, content, options) {
        const sent = await chat.sendMessage(content, options);
        if (sent?.id?.id) {
            sentIds.add(sent.id.id);
        }
        return sent;
    }

    function wasSent(messageId) {
        return sentIds.has(messageId);
    }

    function release(messageId) {
        sentIds.delete(messageId);
    }

    return { sendTracked, wasSent, release };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bot && npm test -- message-tracker.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bot/message-tracker.js bot/message-tracker.test.js
git commit -m "feat: add message-tracker module to generalize echo protection"
```

---

### Task 6: Wire `message-tracker` into `bot/index.js` and `bot/voice-handler.js`

**Files:**
- Modify: `bot/index.js:31-133`, `bot/voice-handler.js` (all `chat.sendMessage` calls and the `sentReplyIds` parameter)
- Test: manual verification via existing `bot` test suite (no new tests — this task rewires existing tested behavior; regression coverage is `bot/queue.test.js` plus Task 5's tests). If `bot/voice-handler.js` has no existing test file, skip adding one here (none currently exists per the repo listing) — this task is a mechanical rewire, not new logic.

**Interfaces:**
- Consumes: `createMessageTracker()` from Task 5.
- Produces: `handleVoiceMessage(msg, chat, client, tracker)` — the fourth parameter changes from a raw `Set` (`sentReplyIds`) to a `tracker` object with `sendTracked`. Task 7 (`text-handler.js`) receives the same `tracker` instance from `bot/index.js`.

- [ ] **Step 1: Update `bot/index.js` to create and use a shared tracker**

In `bot/index.js`, replace the `sentReplyIds` declaration (lines 33-36):

```javascript
// IDs of voice replies the bot itself sent, so message_create (which fires for
// fromMe messages too) doesn't re-queue the bot's own audio reply as a new
// incoming voice message.
const sentReplyIds = new Set();
```

with:

```javascript
// Tracks every message the bot itself sends (text or voice), so message_create
// (which fires for fromMe messages too) doesn't re-queue the bot's own replies
// as new incoming messages.
const tracker = createMessageTracker();
```

Add the import near the top (after line 6, `import config from './config.js';`):

```javascript
import { createMessageTracker } from './message-tracker.js';
```

Replace the skip-check (lines 99-103):

```javascript
        // Skip the bot's own voice reply echoed back via message_create
        if (sentReplyIds.has(msg.id.id)) {
            sentReplyIds.delete(msg.id.id);
            return;
        }
```

with:

```javascript
        // Skip the bot's own reply echoed back via message_create
        if (tracker.wasSent(msg.id.id)) {
            tracker.release(msg.id.id);
            return;
        }
```

Replace the `voiceQueue.enqueue` calls (lines 119 and 125) to pass `tracker` instead of `sentReplyIds`:

```javascript
            voiceQueue.enqueue(() => handleVoiceMessage(msg, chat, client, tracker)).catch((error) => {
```

(both occurrences — `ptt` branch and `audio` branch).

- [ ] **Step 2: Update `bot/voice-handler.js` to use the tracker**

In `bot/voice-handler.js`, update the JSDoc and signature (lines 8-15):

```javascript
/**
 * Handle incoming voice message
 * @param {Message} msg - WhatsApp message object
 * @param {Chat} chat - WhatsApp chat object
 * @param {Client} client - WhatsApp client
 * @param {{ sendTracked: Function }} tracker - Tracks bot-sent messages to ignore on echo
 */
export async function handleVoiceMessage(msg, chat, client, tracker) {
```

Replace every `await chat.sendMessage(...)` call with `await tracker.sendTracked(chat, ...)`:

- Line 26: `await chat.sendMessage(config.STATUS_MESSAGES.received);` → `await tracker.sendTracked(chat, config.STATUS_MESSAGES.received);`
- Line 60: `await chat.sendMessage(transcriptionMsg);` → `await tracker.sendTracked(chat, transcriptionMsg);`
- Line 68: `await chat.sendMessage(llmMsg);` → `await tracker.sendTracked(chat, llmMsg);`
- Lines 73-78, replace:
  ```javascript
        const sentReply = await chat.sendMessage(audioMedia, {
            sendAudioAsVoice: true
        });
        if (sentReplyIds && sentReply?.id?.id) {
            sentReplyIds.add(sentReply.id.id);
        }
  ```
  with:
  ```javascript
        await tracker.sendTracked(chat, audioMedia, {
            sendAudioAsVoice: true
        });
  ```
- Line 96: `await chat.sendMessage(errorMsg);` (inside the `catch` block's error-notification) → `await tracker.sendTracked(chat, errorMsg);`

- [ ] **Step 3: Run the full Node test suite**

Run: `cd bot && npm test`
Expected: PASS (all existing tests — `queue.test.js`, `subprocess-timeout.test.js` — are unaffected since they don't touch `index.js`/`voice-handler.js` directly)

- [ ] **Step 4: Commit**

```bash
git add bot/index.js bot/voice-handler.js
git commit -m "refactor: route bot replies through message-tracker for echo protection"
```

---

### Task 7: `bot/text-handler.js` and wiring in `bot/index.js`

**Files:**
- Create: `bot/text-handler.js`
- Modify: `bot/index.js` (add text branch to `message_create` handler)
- Test: `bot/text-handler.test.js` (new file)

**Interfaces:**
- Consumes: `tracker.sendTracked` (Task 5/6), `runWithTimeout` (existing, `bot/subprocess-timeout.js`), `config.TEXT_MAX_CHARS` and `config.PYTHON_CMD`/`config.PIPELINE_TIMEOUT_MS` (existing + Task 2).
- Produces: `handleTextMessage(msg, chat, client, tracker)` (exported), used by `bot/index.js`'s `message_create` handler.

- [ ] **Step 1: Write the failing tests**

Create `bot/text-handler.test.js`. This mirrors the mocking style used for subprocess calls — since `bot/text-handler.js` will call `runWithTimeout` internally, test at the level of a fake `chat` and a stubbed `callPythonPipeline`-equivalent isn't directly injectable without refactor, so instead test the length-rejection path (pure, no subprocess) and structure the handler so the subprocess call is a separate exported function that can be monkeypatched isn't idiomatic in Node ESM. Use `node:test`'s module mocking via dependency injection instead: export `callTextPipeline` separately so it can be tested in isolation, and test `handleTextMessage`'s orchestration by passing a fake `runPipeline` function.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTextMessage } from './text-handler.js';
import { createMessageTracker } from './message-tracker.js';

function makeFakeChat() {
    const sent = [];
    let counter = 0;
    return {
        sent,
        sendMessage: async (content) => {
            counter += 1;
            const id = { id: `sent-${counter}` };
            sent.push(content);
            return { id };
        }
    };
}

test('rejects over-length messages without calling the pipeline', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const msg = { body: 'x'.repeat(2000), id: { id: 'incoming-1' } };
    let pipelineCalled = false;

    await handleTextMessage(msg, chat, tracker, {
        maxChars: 1000,
        runPipeline: async () => {
            pipelineCalled = true;
            return { llm_response: 'should not be reached' };
        }
    });

    assert.equal(pipelineCalled, false);
    assert.equal(chat.sent.length, 1);
    assert.match(chat.sent[0], /trop long|too long/i);
});

test('sends the pipeline llm_response as a single text reply', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const msg = { body: 'Quel temps fait-il ?', id: { id: 'incoming-2' } };

    await handleTextMessage(msg, chat, tracker, {
        maxChars: 1000,
        runPipeline: async (text) => {
            assert.equal(text, 'Quel temps fait-il ?');
            return { llm_response: 'Il fait beau!', timing: { llm: 1.2, total: 1.3 } };
        }
    });

    assert.deepEqual(chat.sent, ['Il fait beau!']);
});

test('sends the configured error message when the pipeline fails', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const msg = { body: 'hello', id: { id: 'incoming-3' } };

    await handleTextMessage(msg, chat, tracker, {
        maxChars: 1000,
        runPipeline: async () => {
            throw new Error('pipeline exploded');
        }
    });

    assert.equal(chat.sent.length, 1);
    assert.match(chat.sent[0], /pipeline exploded/);
});

test('registers the sent reply with the tracker to avoid echo loops', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const msg = { body: 'hi', id: { id: 'incoming-4' } };

    await handleTextMessage(msg, chat, tracker, {
        maxChars: 1000,
        runPipeline: async () => ({ llm_response: 'yo', timing: {} })
    });

    assert.equal(tracker.wasSent('sent-1'), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bot && npm test -- text-handler.test.js`
Expected: FAIL — `bot/text-handler.js` does not exist.

- [ ] **Step 3: Implement `bot/text-handler.js`**

```javascript
import path from 'path';
import config from './config.js';
import { runWithTimeout } from './subprocess-timeout.js';

/**
 * Call the Python pipeline in --text mode as a subprocess.
 * @param {string} text - The message body to reply to
 * @param {string} logPrefix - Log prefix for debugging
 * @returns {Promise<{llm_response: string, timing: object}>}
 */
async function callTextPipeline(text, logPrefix = '') {
    const { stdout } = await runWithTimeout(
        config.PYTHON_CMD,
        ['-m', 'src.pipeline_cli', '--text', text, '--json'],
        { cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..') },
        config.PIPELINE_TIMEOUT_MS,
        {
            onStderr: (chunk) => console.error(`${logPrefix} [Python stderr]:`, chunk.trim())
        }
    );

    let result;
    try {
        result = JSON.parse(stdout);
    } catch (parseError) {
        throw new Error(`Failed to parse pipeline output: ${parseError.message}\nOutput: ${stdout}`);
    }

    if (result.error) {
        throw new Error(result.error);
    }

    return result;
}

/**
 * Handle an incoming text message: reject if too long, otherwise run it
 * through the Python reply pipeline and send the text-only response.
 * @param {Message} msg - WhatsApp message object
 * @param {Chat} chat - WhatsApp chat object
 * @param {{ sendTracked: Function }} tracker - Tracks bot-sent messages to ignore on echo
 * @param {{ maxChars?: number, runPipeline?: Function }} [deps] - Injectable overrides for testing
 */
export async function handleTextMessage(msg, chat, tracker, deps = {}) {
    const maxChars = deps.maxChars ?? config.TEXT_MAX_CHARS;
    const runPipeline = deps.runPipeline ?? ((text) => callTextPipeline(text, `[${msg.id.id.substring(0, 8)}]`));

    const body = msg.body.trim();
    const logPrefix = `[${msg.id.id.substring(0, 8)}]`;

    if (body.length > maxChars) {
        console.log(`${logPrefix} Text message rejected: ${body.length} chars (max ${maxChars})`);
        await tracker.sendTracked(chat, `❌ Message trop long (max ${maxChars} caractères).`);
        return;
    }

    console.log(`${logPrefix} Processing text message from ${chat.name || chat.id._serialized}`);

    try {
        const result = await runPipeline(body);
        await tracker.sendTracked(chat, result.llm_response);
        console.log(`${logPrefix} ✓ Complete`);
    } catch (error) {
        console.error(`${logPrefix} ✗ Error:`, error.message);

        if (config.ENABLE_ERROR_NOTIFICATIONS) {
            const errorMsg = config.STATUS_MESSAGES.error.replace('{}', error.message);
            try {
                await tracker.sendTracked(chat, errorMsg);
            } catch (sendError) {
                console.error(`${logPrefix} Failed to send error notification:`, sendError.message);
            }
        }
    }
}
```

Note: the error-path test expects `chat.sent[0]` to match `/pipeline exploded/` — `config.STATUS_MESSAGES.error` is `"❌ Erreur: {}"`, so the replaced message is `"❌ Erreur: pipeline exploded"`, which matches.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npm test -- text-handler.test.js`
Expected: PASS

- [ ] **Step 5: Wire the text branch into `bot/index.js`**

In `bot/index.js`, add the import (alongside the existing `handleVoiceMessage` import, line 4):

```javascript
import { handleVoiceMessage } from './voice-handler.js';
import { handleTextMessage } from './text-handler.js';
```

Add a text branch after the existing voice/audio branches (after the `else if (msg.hasMedia && msg.type === 'audio')` block, before the closing of the `try`, i.e. after line 128's closing brace of that `else if`):

```javascript
        } else if (msg.type === 'chat' && msg.body && msg.body.trim().length > 0) {
            console.log(`\nText message received! Queued for processing...`);
            voiceQueue.enqueue(() => handleTextMessage(msg, chat, tracker)).catch((error) => {
                console.error(`Unexpected error in queued text message handler:`, error);
            });
        }
```

(This sits as a third branch in the existing `if (msg.hasMedia && msg.type === 'ptt') { ... } else if (msg.hasMedia && msg.type === 'audio') { ... } else if (...)` chain — same queue, same error-swallow pattern as the voice branches.)

- [ ] **Step 6: Run the full Node test suite**

Run: `cd bot && npm test`
Expected: PASS (all tests, including `message-tracker.test.js`, `text-handler.test.js`, `queue.test.js`, `subprocess-timeout.test.js`)

- [ ] **Step 7: Commit**

```bash
git add bot/text-handler.js bot/text-handler.test.js bot/index.js
git commit -m "feat: handle text messages via shared queue and text-only pipeline reply"
```

---

### Task 8: Documentation updates

**Files:**
- Modify: `README.md` (Features list, Project Structure, Testing section)
- Modify: `docs/SILLYTAVERN_SETUP.md`
- Modify: `.env.example` (if it references `PIPELINE_TIMEOUT_MS`/similar — add `TEXT_MAX_CHARS`)

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing consumed by other tasks — this is the terminal task.

- [ ] **Step 1: Update README features list**

In `README.md`, in the "Features" section (around line 18-27), add a bullet after the existing voice-related bullets (after line 24, the "4 status updates" bullet):

```markdown
- 💬 Also replies to typed text messages in the group (text-only reply, no TTS)
```

- [ ] **Step 2: Update README project structure**

In `README.md`, in the "Project Structure" tree under `bot/` (around line 152-160), add the new files:

```
│   ├── voice-handler.js          # Voice message processing
│   ├── text-handler.js           # Text message processing
│   ├── message-tracker.js        # Tracks bot-sent messages to avoid echo loops
```

- [ ] **Step 3: Update README testing section**

In `README.md`, in "Test Python Pipeline Directly" (around line 249-255), add a text-mode example after the existing one:

````markdown
### Test Python Pipeline Directly

```bash
source .venv/bin/activate
python -m src.pipeline_cli path/to/audio.wav --json
# Expected output: JSON with transcription, llm_response, output_audio_path

python -m src.pipeline_cli --text "Bonjour Trico" --json
# Expected output: JSON with llm_response, timing (no transcription/audio — text-only reply)
```
````

- [ ] **Step 4: Check `.env.example` for the new var**

Run: `grep -n "PIPELINE_TIMEOUT_MS\|TEXT_MAX_CHARS" /home/alx/code/voicebot/.env.example`

If `.env.example` documents `PIPELINE_TIMEOUT_MS` as an optional override, add a matching commented-out line nearby:

```bash
# Optional: max characters allowed in a typed text message before it's rejected
# TEXT_MAX_CHARS=1000
```

- [ ] **Step 5: Update `docs/SILLYTAVERN_SETUP.md`**

Read the file first to find the right insertion point (likely near where it describes how replies work), then add a short note that typed messages also reach the persona, e.g.:

```markdown
Typed text messages in the group reach Trico the same way voice messages do —
they're queued on the same worker and answered with a text-only reply (no
voice synthesis).
```

- [ ] **Step 6: Commit**

```bash
git add README.md docs/SILLYTAVERN_SETUP.md .env.example
git commit -m "docs: document text-message support"
```

---

## Post-plan verification

- [ ] Run `source .venv/bin/activate && pytest -v` — full Python suite passes.
- [ ] Run `cd bot && npm test` — full Node suite passes.
- [ ] Manually smoke-test: start the bot against a real LLM server, type a message in the configured WhatsApp group, confirm a single text reply arrives and no echo loop occurs (send a second message, confirm the bot doesn't reply to its own prior reply).
