# SillyTavern Persona Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, config-toggled path (`LLM_BACKEND=sillytavern`) where the pipeline's LLM step is answered by a live SillyTavern persona instead of a raw LLM call, via a new `st-bridge` Node service that drives the real SillyTavern web UI with Puppeteer.

**Architecture:** `src/pipeline.py` gains a `query_sillytavern()` method that POSTs the transcribed text to `st-bridge`'s `/reply` endpoint; `st-bridge` keeps one persistent headless-Chromium tab open on a specific SillyTavern character's chat and types/scrapes messages through it. `run_pipeline()` branches between `query_llm()` (existing, default) and `query_sillytavern()` based on `config.LLM_BACKEND`.

**Tech Stack:** Python (`requests`, `pytest`), Node.js ESM (`node:http`, `node:test`, `puppeteer`, `dotenv`) — matching the conventions already used in `src/` and `bot/`.

## Global Constraints

- Default behavior is unchanged: `LLM_BACKEND` defaults to `"direct"` — the SillyTavern route is strictly opt-in.
- No automatic fallback from the SillyTavern route to the direct LLM path on failure (spec: errors must stay visible).
- One shared conversation/session for the whole configured WhatsApp group — no per-sender identity tracking.
- `st-bridge` must not add a hard dependency on the direct-LLM path or on `bot/`'s `node_modules` — it is its own standalone Node project, same isolation pattern as `docsbuild/`.
- Match existing code style: Python stdlib + `requests`, no new Python test dependency; Node ESM (`"type": "module"`), `node:test` + `node:assert/strict`, no test framework dependency.

---

### Task 1: Python config additions for the SillyTavern backend

**Files:**
- Modify: `src/config.py` (add after the LLM Configuration block, around line 38)
- Test: `tests/test_config.py`

**Interfaces:**
- Produces: `config.LLM_BACKEND` (`str`, `"direct"` or `"sillytavern"`), `config.ST_BRIDGE_URL` (`str`), `config.ST_BRIDGE_TIMEOUT` (`int`, seconds) — consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_config.py`:

```python
def test_llm_backend_defaults_to_direct(monkeypatch):
    monkeypatch.delenv("LLM_BACKEND", raising=False)
    config = _reload_config()
    assert config.LLM_BACKEND == "direct"


def test_llm_backend_override(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "sillytavern")
    config = _reload_config()
    assert config.LLM_BACKEND == "sillytavern"


def test_st_bridge_url_defaults_to_localhost(monkeypatch):
    monkeypatch.delenv("ST_BRIDGE_URL", raising=False)
    config = _reload_config()
    assert config.ST_BRIDGE_URL == "http://localhost:8091"


def test_st_bridge_url_override(monkeypatch):
    monkeypatch.setenv("ST_BRIDGE_URL", "http://example.internal:9100")
    config = _reload_config()
    assert config.ST_BRIDGE_URL == "http://example.internal:9100"


def test_st_bridge_timeout_is_an_int():
    config = _reload_config()
    assert config.ST_BRIDGE_TIMEOUT == 60
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source .venv/bin/activate && pytest tests/test_config.py -v`
Expected: FAIL — `AttributeError: module 'src.config' has no attribute 'LLM_BACKEND'` (and similar for the other new attributes).

- [ ] **Step 3: Add the config values**

In `src/config.py`, immediately after the existing `LLM_TIMEOUT = 60          # seconds` line (end of the LLM Configuration block), add:

```python

# SillyTavern persona route (optional alternate backend for the LLM step)
# "direct" calls LLM_API_URL as today; "sillytavern" routes through st-bridge instead
LLM_BACKEND = os.getenv("LLM_BACKEND", "direct")
ST_BRIDGE_URL = os.getenv("ST_BRIDGE_URL", "http://localhost:8091")
ST_BRIDGE_TIMEOUT = 60  # seconds
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source .venv/bin/activate && pytest tests/test_config.py -v`
Expected: PASS (all tests in the file, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/config.py tests/test_config.py
git commit -m "feat: add SillyTavern backend config (LLM_BACKEND, ST_BRIDGE_URL)"
```

---

### Task 2: Pipeline dispatch to the SillyTavern bridge

**Files:**
- Modify: `src/pipeline.py:129-181` (add new method after `query_llm`), `src/pipeline.py:269-272` (`run_pipeline`'s Step 2 dispatch)
- Test: `tests/test_pipeline.py` (new file)

**Interfaces:**
- Consumes: `config.LLM_BACKEND`, `config.ST_BRIDGE_URL`, `config.ST_BRIDGE_TIMEOUT` (Task 1).
- Produces: `VoicePipeline.query_sillytavern(user_text: str) -> str`, raising `VoicePipelineError` on failure — same contract as `query_llm`. `run_pipeline()`'s return shape is unchanged.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_pipeline.py`:

```python
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest
import requests

from src.pipeline import VoicePipeline, VoicePipelineError


def _make_pipeline(**config_overrides):
    """Build a VoicePipeline without running its heavy __init__ (no real STT/TTS/LLM)."""
    pipeline = VoicePipeline.__new__(VoicePipeline)
    pipeline.config = SimpleNamespace(
        ST_BRIDGE_URL="http://localhost:8091",
        ST_BRIDGE_TIMEOUT=60,
        LLM_BACKEND="direct",
        **config_overrides,
    )
    return pipeline


def test_query_sillytavern_returns_reply_on_success():
    pipeline = _make_pipeline()
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "Bonjour!"}
    mock_response.raise_for_status.return_value = None

    with patch("src.pipeline.requests.post", return_value=mock_response) as mock_post:
        result = pipeline.query_sillytavern("Salut")

    assert result == "Bonjour!"
    mock_post.assert_called_once_with(
        "http://localhost:8091/reply",
        json={"text": "Salut"},
        timeout=60,
    )


def test_query_sillytavern_raises_on_request_exception():
    pipeline = _make_pipeline()

    with patch(
        "src.pipeline.requests.post",
        side_effect=requests.exceptions.ConnectionError("refused"),
    ):
        with pytest.raises(VoicePipelineError, match="SillyTavern bridge query failed"):
            pipeline.query_sillytavern("Salut")


def test_query_sillytavern_raises_on_empty_reply():
    pipeline = _make_pipeline()
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "   "}
    mock_response.raise_for_status.return_value = None

    with patch("src.pipeline.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Empty SillyTavern reply"):
            pipeline.query_sillytavern("Salut")


def test_run_pipeline_dispatches_to_sillytavern_when_configured(tmp_path):
    input_wav = tmp_path / "input.wav"
    input_wav.write_bytes(b"fake audio")

    pipeline = _make_pipeline(
        LLM_BACKEND="sillytavern",
        AUDIO_OUTPUT_DIR=str(tmp_path / "output"),
    )

    with patch.object(pipeline, "transcribe_audio", return_value=("bonjour", "fr")), \
         patch.object(pipeline, "query_sillytavern", return_value="salut!") as mock_st, \
         patch.object(pipeline, "query_llm") as mock_direct, \
         patch.object(pipeline, "synthesize_speech"):
        result = pipeline.run_pipeline(str(input_wav))

    mock_st.assert_called_once_with("bonjour")
    mock_direct.assert_not_called()
    assert result["llm_response"] == "salut!"


def test_run_pipeline_dispatches_to_direct_llm_by_default(tmp_path):
    input_wav = tmp_path / "input.wav"
    input_wav.write_bytes(b"fake audio")

    pipeline = _make_pipeline(
        LLM_BACKEND="direct",
        AUDIO_OUTPUT_DIR=str(tmp_path / "output"),
    )

    with patch.object(pipeline, "transcribe_audio", return_value=("bonjour", "fr")), \
         patch.object(pipeline, "query_llm", return_value="salut!") as mock_direct, \
         patch.object(pipeline, "query_sillytavern") as mock_st, \
         patch.object(pipeline, "synthesize_speech"):
        result = pipeline.run_pipeline(str(input_wav))

    mock_direct.assert_called_once_with("bonjour", "fr")
    mock_st.assert_not_called()
    assert result["llm_response"] == "salut!"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source .venv/bin/activate && pytest tests/test_pipeline.py -v`
Expected: FAIL — `AttributeError: 'VoicePipeline' object has no attribute 'query_sillytavern'`

- [ ] **Step 3: Add `query_sillytavern` and wire the dispatch**

In `src/pipeline.py`, add this method immediately after `query_llm` (after the closing of the method that ends at line 180, i.e. right before `def synthesize_speech`):

```python
    def query_sillytavern(self, user_text: str) -> str:
        """
        Alternate Step 2: Get a persona-driven reply via the SillyTavern bridge

        Args:
            user_text: User input text

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
                json={"text": user_text},
                timeout=self.config.ST_BRIDGE_TIMEOUT
            )
            response.raise_for_status()

            data = response.json()
            reply = data["reply"].strip()

            elapsed = time.time() - start
            logger.info(f"[LLM] ✓ SillyTavern reply in {elapsed:.2f}s")
            logger.info(f"[LLM] Response: \"{reply}\"")

            if not reply:
                raise VoicePipelineError("Empty SillyTavern reply")

            return reply

        except requests.exceptions.RequestException as e:
            logger.error(f"[LLM] ✗ SillyTavern bridge query failed: {e}")
            raise VoicePipelineError(f"SillyTavern bridge query failed: {e}")
```

Then in `run_pipeline()`, replace:

```python
            # Step 2: LLM
            llm_start = time.time()
            llm_response = self.query_llm(transcription, detected_lang)
            timing['llm'] = time.time() - llm_start
```

with:

```python
            # Step 2: LLM
            llm_start = time.time()
            if self.config.LLM_BACKEND == "sillytavern":
                llm_response = self.query_sillytavern(transcription)
            else:
                llm_response = self.query_llm(transcription, detected_lang)
            timing['llm'] = time.time() - llm_start
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source .venv/bin/activate && pytest tests/test_pipeline.py -v`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Run the full Python test suite to check for regressions**

Run: `source .venv/bin/activate && pytest -v`
Expected: PASS (no regressions in `test_config.py`, `test_audio_validation.py`)

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.py tests/test_pipeline.py
git commit -m "feat: dispatch LLM step to SillyTavern bridge when LLM_BACKEND=sillytavern"
```

---

### Task 3: `st-bridge` project scaffold + chat orchestration logic

**Files:**
- Create: `st-bridge/package.json`
- Create: `st-bridge/.env.example`
- Create: `st-bridge/chat-client.js`
- Test: `st-bridge/chat-client.test.js`

**Interfaces:**
- Produces: `ChatAdapter` typedef — `{ submitMessage(text: string): Promise<void>, isReplyReady(): Promise<boolean>, getLatestMessageText(): Promise<string> }` — and `sendMessageAndAwaitReply(adapter: ChatAdapter, text: string, options: { timeoutMs: number, pollIntervalMs?: number }): Promise<string>`. Consumed by Task 4 (real adapter) and Task 6 (wiring).

- [ ] **Step 1: Create the project scaffold**

Create `st-bridge/package.json`:

```json
{
  "name": "st-bridge",
  "version": "1.0.0",
  "description": "Puppeteer bridge that drives a live SillyTavern chat to answer voicebot pipeline queries with a persona",
  "type": "module",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node --test"
  },
  "license": "MIT",
  "dependencies": {
    "dotenv": "^16.0.3",
    "puppeteer": "^23.0.0"
  }
}
```

Create `st-bridge/.env.example`:

```bash
# Port st-bridge listens on for the Python pipeline to call
ST_BRIDGE_PORT=8091

# Base URL of the running SillyTavern instance
ST_BASE_URL=http://localhost:8000

# Exact display name of the character/persona to chat with
# (must match the name shown in SillyTavern's character list)
ST_CHARACTER_NAME=

# Max time (ms) to wait for SillyTavern to finish generating a reply
ST_REPLY_TIMEOUT_MS=60000
```

- [ ] **Step 2: Write the failing test for the orchestration logic**

Create `st-bridge/chat-client.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessageAndAwaitReply } from './chat-client.js';

function makeAdapter({ readyAfterPolls = 1, replyText = 'hello' } = {}) {
    let polls = 0;
    return {
        submitted: [],
        async submitMessage(text) {
            this.submitted.push(text);
        },
        async isReplyReady() {
            polls++;
            return polls > readyAfterPolls;
        },
        async getLatestMessageText() {
            return replyText;
        },
    };
}

test('returns the reply once the adapter reports it is ready', async () => {
    const adapter = makeAdapter({ readyAfterPolls: 2, replyText: 'Bonjour!' });

    const reply = await sendMessageAndAwaitReply(adapter, 'Salut', {
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });

    assert.equal(reply, 'Bonjour!');
    assert.deepEqual(adapter.submitted, ['Salut']);
});

test('throws when the reply never becomes ready before the timeout', async () => {
    const adapter = {
        async submitMessage() {},
        async isReplyReady() {
            return false;
        },
        async getLatestMessageText() {
            return 'unused';
        },
    };

    await assert.rejects(
        sendMessageAndAwaitReply(adapter, 'Salut', { timeoutMs: 50, pollIntervalMs: 10 }),
        /Timed out waiting for SillyTavern reply/
    );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd st-bridge && node --test`
Expected: FAIL — `Cannot find module './chat-client.js'`

- [ ] **Step 4: Implement `chat-client.js`**

Create `st-bridge/chat-client.js`:

```js
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {Object} ChatAdapter
 * @property {(text: string) => Promise<void>} submitMessage
 * @property {() => Promise<boolean>} isReplyReady
 * @property {() => Promise<string>} getLatestMessageText
 */

/**
 * Submit a message through the given chat adapter and wait for its reply.
 *
 * @param {ChatAdapter} adapter
 * @param {string} text
 * @param {{ timeoutMs: number, pollIntervalMs?: number }} options
 * @returns {Promise<string>} the reply text
 */
export async function sendMessageAndAwaitReply(adapter, text, options) {
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const timeoutMs = options.timeoutMs;

    await adapter.submitMessage(text);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await adapter.isReplyReady()) {
            return adapter.getLatestMessageText();
        }
        await delay(pollIntervalMs);
    }

    throw new Error(`Timed out waiting for SillyTavern reply after ${timeoutMs}ms`);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd st-bridge && node --test`
Expected: PASS (both tests)

- [ ] **Step 6: Commit**

```bash
git add st-bridge/package.json st-bridge/.env.example st-bridge/chat-client.js st-bridge/chat-client.test.js
git commit -m "feat: scaffold st-bridge with chat orchestration logic"
```

---

### Task 4: Real SillyTavern DOM adapter

**Files:**
- Create: `st-bridge/puppeteer-adapter.js`

**Interfaces:**
- Consumes: `ChatAdapter` typedef (Task 3).
- Produces: `selectCharacter(page, characterName): Promise<void>` and `createPageAdapter(page): ChatAdapter`. Consumed by Task 6.

This task's DOM selectors were confirmed by inspecting SillyTavern's actual source (`public/index.html` and `public/script.js` in the `SillyTavern/SillyTavern` GitHub repo, `release` branch):

- Chat input: `#send_textarea` (`public/index.html:8092`)
- Send button: `#send_but`, with a click handler that triggers sending (`public/index.html:8108`, `public/script.js:11100`)
- Message list: `#chat .mes` — each message is a `.mes` div with a `.mes_text` child holding the rendered text (`public/index.html:7378`, `public/scripts/chats.js`)
- Generation-in-progress indicator: `#mes_stop`, whose inline `style.display` is set to `'flex'` while generating and `'none'` when idle, via `showStopButton()`/`hideStopButton()` (`public/script.js:3469-3476`)
- Character list entries: `#rm_print_characters_block .character_select`, each containing a `.ch_name` element with the character's display name; clicking a `.character_select` element opens a chat with that character (`public/script.js:937-945, 11132-11134`)

This is real, source-grounded code — but since it drives a live third-party UI, it is verified by manual/integration testing against a running SillyTavern instance (Task 7), not by unit tests, per the design spec.

- [ ] **Step 1: Implement `puppeteer-adapter.js`**

Create `st-bridge/puppeteer-adapter.js`:

```js
const SELECTORS = {
    chatInput: '#send_textarea',
    sendButton: '#send_but',
    generatingIndicator: '#mes_stop',
    characterEntries: '#rm_print_characters_block .character_select',
    messages: '#chat .mes',
};

/**
 * Select a character by its display name from SillyTavern's character list panel.
 * @param {import('puppeteer').Page} page
 * @param {string} characterName
 */
export async function selectCharacter(page, characterName) {
    const found = await page.evaluate(
        (selector, name) => {
            const entries = Array.from(document.querySelectorAll(selector));
            const match = entries.find(
                (el) => el.querySelector('.ch_name')?.textContent?.trim() === name
            );
            if (!match) return false;
            match.click();
            return true;
        },
        SELECTORS.characterEntries,
        characterName
    );

    if (!found) {
        throw new Error(`Character "${characterName}" not found in SillyTavern's character list`);
    }
}

/**
 * Build a ChatAdapter (see chat-client.js) backed by a real, already-open SillyTavern page.
 * @param {import('puppeteer').Page} page
 * @returns {import('./chat-client.js').ChatAdapter}
 */
export function createPageAdapter(page) {
    let countBeforeSubmit = 0;

    return {
        async submitMessage(text) {
            countBeforeSubmit = await page.$$eval(SELECTORS.messages, (els) => els.length);
            await page.click(SELECTORS.chatInput);
            await page.type(SELECTORS.chatInput, text);
            await page.click(SELECTORS.sendButton);
        },
        async isReplyReady() {
            const count = await page.$$eval(SELECTORS.messages, (els) => els.length);
            if (count <= countBeforeSubmit) {
                return false;
            }

            const generating = await page
                .$eval(SELECTORS.generatingIndicator, (el) => el.style.display === 'flex')
                .catch(() => false);
            return !generating;
        },
        async getLatestMessageText() {
            return page.$$eval(SELECTORS.messages, (els) => {
                const last = els[els.length - 1];
                return last?.querySelector('.mes_text')?.textContent?.trim() ?? '';
            });
        },
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add st-bridge/puppeteer-adapter.js
git commit -m "feat: add Puppeteer adapter driving the real SillyTavern chat UI"
```

---

### Task 5: HTTP server layer

**Files:**
- Create: `st-bridge/server.js`
- Test: `st-bridge/server.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (takes a generic `replyFn`, decoupled from Puppeteer).
- Produces: `createServer(replyFn: (text: string) => Promise<string>): http.Server`, exposing `GET /health` and `POST /reply {text}` → `{reply}`. Consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

Create `st-bridge/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createServer } from './server.js';

function postJson(port, path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(
            {
                port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
            }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function getJson(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ port, path }, (res) => {
            let raw = '';
            res.on('data', (chunk) => {
                raw += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }).on('error', reject);
    });
}

function withServer(replyFn, fn) {
    return new Promise((resolve, reject) => {
        const server = createServer(replyFn);
        server.listen(0, async () => {
            try {
                await fn(server.address().port);
                resolve();
            } catch (error) {
                reject(error);
            } finally {
                server.close();
            }
        });
    });
}

test('POST /reply returns the reply from replyFn', async () => {
    await withServer(
        async (text) => `echo: ${text}`,
        async (port) => {
            const { status, body } = await postJson(port, '/reply', { text: 'hi' });
            assert.equal(status, 200);
            assert.deepEqual(body, { reply: 'echo: hi' });
        }
    );
});

test('POST /reply with missing text returns 400', async () => {
    await withServer(
        async () => 'unused',
        async (port) => {
            const { status, body } = await postJson(port, '/reply', {});
            assert.equal(status, 400);
            assert.equal(body.error, 'Missing "text" field');
        }
    );
});

test('POST /reply while busy returns 409', async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });

    await withServer(
        async (text) => {
            await gate;
            return `echo: ${text}`;
        },
        async (port) => {
            const first = postJson(port, '/reply', { text: 'one' });
            await new Promise((resolve) => setTimeout(resolve, 20));
            const second = await postJson(port, '/reply', { text: 'two' });
            assert.equal(second.status, 409);
            release();
            const firstResult = await first;
            assert.equal(firstResult.status, 200);
        }
    );
});

test('GET /health returns ok', async () => {
    await withServer(
        async () => 'unused',
        async (port) => {
            const result = await getJson(port, '/health');
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, { status: 'ok' });
        }
    );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd st-bridge && node --test`
Expected: FAIL — `Cannot find module './server.js'`

- [ ] **Step 3: Implement `server.js`**

Create `st-bridge/server.js`:

```js
import http from 'http';

/**
 * @param {(text: string) => Promise<string>} replyFn
 * @returns {import('http').Server}
 */
export function createServer(replyFn) {
    let busy = false;

    return http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }

        if (req.method !== 'POST' || req.url !== '/reply') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        if (busy) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Busy processing another request' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', async () => {
            busy = true;
            try {
                const parsed = JSON.parse(body || '{}');
                if (!parsed.text || typeof parsed.text !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing "text" field' }));
                    return;
                }

                const reply = await replyFn(parsed.text);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reply }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            } finally {
                busy = false;
            }
        });
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd st-bridge && node --test`
Expected: PASS (all tests in `chat-client.test.js` and `server.test.js`)

- [ ] **Step 5: Commit**

```bash
git add st-bridge/server.js st-bridge/server.test.js
git commit -m "feat: add st-bridge HTTP server with /reply and /health endpoints"
```

---

### Task 6: `st-bridge` config + entry point wiring

**Files:**
- Create: `st-bridge/config.js`
- Create: `st-bridge/index.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `selectCharacter`, `createPageAdapter` (Task 4); `sendMessageAndAwaitReply` (Task 3); `createServer` (Task 5).
- Produces: the runnable `st-bridge` process (`npm start`) — no further consumers within this plan; this is the integration point exercised manually in Task 7.

- [ ] **Step 1: Add `.gitignore` entries for st-bridge's local state**

Add to `.gitignore` (after the existing `node_modules/` line):

```
st-bridge/.env
st-bridge/.browser-data/
```

- [ ] **Step 2: Implement `st-bridge/config.js`**

Create `st-bridge/config.js`:

```js
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

export default {
    PORT: parseInt(process.env.ST_BRIDGE_PORT || '8091', 10),
    ST_BASE_URL: process.env.ST_BASE_URL || 'http://localhost:8000',
    ST_CHARACTER_NAME: process.env.ST_CHARACTER_NAME || '',
    USER_DATA_DIR: path.join(__dirname, '.browser-data'),
    REPLY_TIMEOUT_MS: parseInt(process.env.ST_REPLY_TIMEOUT_MS || '60000', 10),
};
```

- [ ] **Step 3: Implement `st-bridge/index.js`**

Create `st-bridge/index.js`:

```js
import puppeteer from 'puppeteer';
import config from './config.js';
import { selectCharacter, createPageAdapter } from './puppeteer-adapter.js';
import { sendMessageAndAwaitReply } from './chat-client.js';
import { createServer } from './server.js';

async function main() {
    if (!config.ST_CHARACTER_NAME) {
        throw new Error('ST_CHARACTER_NAME must be set in st-bridge/.env');
    }

    console.log(`Launching browser and connecting to SillyTavern at ${config.ST_BASE_URL}...`);
    const browser = await puppeteer.launch({
        headless: true,
        userDataDir: config.USER_DATA_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(config.ST_BASE_URL, { waitUntil: 'networkidle0' });

    console.log(`Selecting character "${config.ST_CHARACTER_NAME}"...`);
    await selectCharacter(page, config.ST_CHARACTER_NAME);

    const adapter = createPageAdapter(page);
    const replyFn = (text) =>
        sendMessageAndAwaitReply(adapter, text, { timeoutMs: config.REPLY_TIMEOUT_MS });

    const server = createServer(replyFn);
    server.listen(config.PORT, () => {
        console.log(`st-bridge listening on port ${config.PORT}`);
    });

    async function shutdown() {
        console.log('\nShutting down st-bridge...');
        server.close();
        await browser.close();
        process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error('st-bridge failed to start:', error);
    process.exit(1);
});
```

- [ ] **Step 4: Install dependencies**

Run: `cd st-bridge && npm install`
Expected: succeeds (downloads `puppeteer`, `dotenv`, and Puppeteer's bundled Chromium — this step needs network access and may take a few minutes).

- [ ] **Step 5: Run the full st-bridge test suite**

Run: `cd st-bridge && npm test`
Expected: PASS (all tests from Tasks 3 and 5; `index.js` and `puppeteer-adapter.js` are not unit tested, per the design spec's testing section — they're exercised in Task 7)

- [ ] **Step 6: Commit**

```bash
git add st-bridge/config.js st-bridge/index.js .gitignore
git commit -m "feat: wire st-bridge entry point (Puppeteer launch + HTTP server)"
```

---

### Task 7: Setup guide + process wiring in the main project

**Files:**
- Create: `docs/SILLYTAVERN_SETUP.md`
- Modify: `.env.example` (repo root)
- Modify: `start_bot.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: `st-bridge` (Task 6) as a runnable process; `LLM_BACKEND`/`ST_BRIDGE_URL` (Task 1) as the config surface documented here.
- Produces: nothing consumed elsewhere in this plan — this is documentation plus operational wiring, the last task.

- [ ] **Step 1: Add SillyTavern variables to the root `.env.example`**

Add to `.env.example` (repo root), after the `LOG_LEVEL` line:

```bash

# Optional: route the LLM step through a SillyTavern persona instead of calling the LLM directly
# See docs/SILLYTAVERN_SETUP.md for full setup instructions
# LLM_BACKEND=sillytavern
# ST_BRIDGE_URL=http://localhost:8091
```

- [ ] **Step 2: Add an st-bridge connectivity check to `start_bot.sh`**

In `start_bot.sh`, immediately after the existing "Check LLM connectivity" block (after the `fi` that closes it, before the "Check if chromium/puppeteer dependencies are available" section), add:

```bash

# Check SillyTavern bridge connectivity if the persona route is enabled
if [ "${LLM_BACKEND:-direct}" = "sillytavern" ]; then
    ST_BRIDGE_URL="${ST_BRIDGE_URL:-http://localhost:8091}"
    echo ""
    echo "Checking SillyTavern bridge connectivity..."
    if curl -s "${ST_BRIDGE_URL}/health" > /dev/null 2>&1; then
        echo "✓ st-bridge accessible"
    else
        echo "⚠️  Warning: st-bridge not accessible at ${ST_BRIDGE_URL}"
        echo "   Start it with: cd st-bridge && npm start"
        echo "   See docs/SILLYTAVERN_SETUP.md for full setup instructions"
    fi
fi
```

- [ ] **Step 3: Write the setup guide**

Create `docs/SILLYTAVERN_SETUP.md`:

```markdown
# Using a SillyTavern Persona for the LLM Step

By default, the voice pipeline sends each transcription straight to the LLM
with a fixed system prompt (`SYSTEM_PROMPT` in `src/config.py`) and no memory
between messages. Setting `LLM_BACKEND=sillytavern` instead routes that step
through a live [SillyTavern](https://github.com/SillyTavern/SillyTavern)
instance, so replies come from a real character/persona you define there —
with SillyTavern's own multi-turn chat history.

This works by having a small companion service, `st-bridge/`, drive
SillyTavern's actual web UI with a headless browser (the same approach this
project already uses for WhatsApp itself). It types each message into
SillyTavern's chat box and reads the reply back out, so persona behavior,
example dialogue, and conversation memory all come from SillyTavern directly
— nothing is reimplemented on the Python/Node side.

## 1. Install and run SillyTavern

```bash
git clone https://github.com/SillyTavern/SillyTavern.git
cd SillyTavern
npm install
npm start
```

By default this serves the UI at `http://localhost:8000`. If `st-bridge` will
run on a *different* machine than SillyTavern, edit SillyTavern's
`config.yaml` and set `listen: true` so it accepts connections from other
hosts — and see the security note at the bottom of this guide before doing
so.

## 2. Connect SillyTavern to an LLM

SillyTavern needs its own connection to an LLM backend (separate from this
bot's own `LLM_BASE_URL` — though it can point at the exact same server):

1. Open SillyTavern in a browser, click the "API Connections" plug icon.
2. Choose **Chat Completion** as the API, and **Custom (OpenAI-compatible)**
   as the source.
3. Enter your LLM server's URL (e.g. `http://localhost:8081/v1`) — do not
   add `/chat/completions` to the end.
4. Click "Connect" and confirm it shows as connected.

## 3. Create a character/persona

1. Click the "Character Management" icon in the left panel.
2. Click "Create New Character".
3. Fill in: **Name**, **Description**, **Personality**, **Scenario**, and
   optionally **Example Dialogue** and a **First Message**. This is the
   persona `st-bridge` will talk to.
4. Save the character.

## 4. Start a chat with the character

Click the character in the character list to open a chat with them. This is
the chat `st-bridge` will keep open and reuse for every voice message.

## 5. Configure and start `st-bridge`

```bash
cd st-bridge
cp .env.example .env
```

Edit `st-bridge/.env`:

```bash
ST_BRIDGE_PORT=8091
ST_BASE_URL=http://localhost:8000
ST_CHARACTER_NAME=<exact name you gave the character in step 3>
ST_REPLY_TIMEOUT_MS=60000
```

Install and start it:

```bash
npm install
npm start
```

On startup it launches a headless browser, opens SillyTavern, selects the
configured character, and listens for requests from the Python pipeline.
Leave this process running alongside the WhatsApp bot.

## 6. Enable the route in the bot's `.env`

In the project's root `.env`:

```bash
LLM_BACKEND=sillytavern
ST_BRIDGE_URL=http://localhost:8091
```

Restart the bot (`./start_bot.sh`). Voice messages will now be answered by
the SillyTavern persona instead of the direct LLM call.

## Notes and limitations

- **One shared conversation.** All voice messages in the configured WhatsApp
  group share a single SillyTavern chat/history — there's no per-sender
  memory.
- **No automatic fallback.** If `st-bridge` is down or SillyTavern fails to
  reply in time, the bot reports an error instead of silently falling back
  to the direct LLM path.
- **UI-dependent.** `st-bridge` drives SillyTavern's actual web page, so a
  SillyTavern update that changes its chat UI's markup can break it. If
  replies stop working after upgrading SillyTavern, check `st-bridge`'s
  selectors in `st-bridge/puppeteer-adapter.js` against the new markup.
- **Network security.** If SillyTavern or `st-bridge` are exposed beyond
  `localhost` (e.g. `st-bridge` running on a different machine than
  SillyTavern), securing that connection (VPN, reverse proxy with auth,
  firewall rules) is your responsibility — this integration does not add
  any authentication of its own.
```

- [ ] **Step 4: Link the guide from the README**

In `README.md`, in the "Project Structure" section's directory tree, add a line for `st-bridge/` after the `src/` block:

```
├── st-bridge/                    # Optional: SillyTavern persona bridge (see docs/SILLYTAVERN_SETUP.md)
│   ├── index.js                   # Entry point: launches browser + HTTP server
│   ├── chat-client.js             # Chat orchestration (submit + poll for reply)
│   ├── puppeteer-adapter.js       # Real SillyTavern DOM glue
│   ├── server.js                  # HTTP API (/reply, /health)
│   └── config.js                  # st-bridge configuration
│
```

In the "Customization" section of `README.md`, add a new subsection right after it:

```markdown
## Optional: SillyTavern Persona Route

Instead of the default direct LLM call, the pipeline can route replies
through a real chat persona defined in [SillyTavern](https://github.com/SillyTavern/SillyTavern),
with multi-turn conversation memory. See
[docs/SILLYTAVERN_SETUP.md](docs/SILLYTAVERN_SETUP.md) for setup instructions.
```

- [ ] **Step 5: Commit**

```bash
git add docs/SILLYTAVERN_SETUP.md .env.example start_bot.sh README.md
git commit -m "docs: add SillyTavern persona route setup guide"
```

---

## Post-plan verification (manual/integration — not automatable)

Once Tasks 1–7 are complete, confirm the whole path works end-to-end against a real SillyTavern instance:

1. Follow `docs/SILLYTAVERN_SETUP.md` to stand up SillyTavern with a test character and start `st-bridge`.
2. `curl http://localhost:8091/health` → expect `{"status":"ok"}`.
3. `curl -X POST http://localhost:8091/reply -H 'Content-Type: application/json' -d '{"text":"Bonjour"}'` → expect a `{"reply": "..."}` response containing the character's actual reply, and confirm (via the SillyTavern browser UI, if you attach one, or by re-querying) that a second message gets a reply that shows awareness of the first.
4. Set `LLM_BACKEND=sillytavern` in the root `.env`, restart the bot, and send a real voice message to the configured WhatsApp group — confirm the "🤖 Réponse" message reflects the persona rather than the default assistant.
5. Stop `st-bridge` and send another voice message — confirm the bot reports the `❌ Erreur` message rather than hanging or silently falling back.
