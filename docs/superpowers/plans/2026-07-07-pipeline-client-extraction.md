# Pipeline-Client Extraction + Config Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated Node→Python subprocess seam into `bot/pipeline-client.js`, share the error-notification catch-block, give `voice-handler.js` tests, and prune dead keys from `src/config.py` — with zero user-visible behavior change.

**Architecture:** `bot/voice-handler.js` and `bot/text-handler.js` each contain a private copy of "spawn `src.pipeline_cli` with a timeout, parse stdout JSON, throw on embedded error" and an identical error-notification catch-block. Both move into two small modules (`pipeline-client.js`, `notify-error.js`) that the handlers call. On the Python side, `src/config.py` loses keys nothing references and gains `TTS_MODEL_PATH` so `pipeline.py` stops hardcoding the Piper path.

**Tech Stack:** Node 18+ ESM with `node:test` (run via `npm test` in `bot/`), Python with pytest (run via `.venv/bin/python -m pytest tests/`).

**Spec:** `docs/superpowers/specs/2026-07-07-pipeline-client-extraction-design.md`

## Global Constraints

- Behavior is unchanged: same subprocess argv, same user-facing messages, same error text.
- All existing tests must keep passing (`npm --prefix bot test` and `.venv/bin/python -m pytest tests/`), except tests explicitly updated by a task here.
- Commit messages follow the repo convention (`feat:`/`fix:`/`refactor:`/`test:`/`docs:` prefixes) and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The `--text=<value>` single-token packing MUST be preserved exactly (argparse misparses dash-leading values otherwise); its explanatory comment moves with it.
- `tests/step1/` is legacy and excluded by `pytest.ini` (`norecursedirs`); it has its own `config.py` copy — its references do NOT count as usages of `src/config.py` keys.

---

### Task 1: Create `bot/pipeline-client.js`

**Files:**
- Create: `bot/pipeline-client.js`
- Create: `bot/pipeline-client.test.js`

**Interfaces:**
- Consumes: `runWithTimeout(cmd, args, spawnOptions, timeoutMs, { onStderr })` from `bot/subprocess-timeout.js` (existing, resolves `{ stdout }`); `config.PYTHON_CMD`, `config.PIPELINE_TIMEOUT_MS` from `bot/config.js`.
- Produces (used by Tasks 3 and 4):
  - `runVoicePipeline(audioPath: string, logPrefix?: string) => Promise<object>`
  - `runTextPipeline(text: string, logPrefix?: string) => Promise<object>`
  - `buildTextPipelineArgs(text: string) => string[]`
  - `buildVoicePipelineArgs(audioPath: string) => string[]`
  - `parsePipelineOutput(stdout: string) => object` (throws on unparseable output or embedded `error` field)

- [ ] **Step 1: Write the failing tests**

Create `bot/pipeline-client.test.js`. The two `--text=` packing tests are moved verbatim from `bot/text-handler.test.js` (they will be deleted from there in Task 3), with the import path changed:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTextPipelineArgs,
    buildVoicePipelineArgs,
    parsePipelineOutput
} from './pipeline-client.js';

test('packs dash-prefixed text into a single --text=<value> argv token', () => {
    // Regression test: node's spawn (no shell) passes each array element as
    // its own argv token. If the text value were a separate token from
    // `--text`, Python's argparse would misparse a dash-leading body like
    // `-_-` as a new option flag instead of the value of --text, causing the
    // subprocess to exit with code 2 for perfectly benign input.
    const args = buildTextPipelineArgs('-_-');

    assert.ok(
        args.includes('--text=-_-'),
        `expected args to contain the single token "--text=-_-", got ${JSON.stringify(args)}`
    );
    assert.equal(args.includes('--text'), false);
    assert.equal(args.includes('-_-'), false);
});

test('packs ordinary text into a single --text=<value> argv token', () => {
    const args = buildTextPipelineArgs('Quel temps fait-il ?');
    assert.ok(args.includes('--text=Quel temps fait-il ?'));
});

test('voice args request JSON output in OGG format for WhatsApp', () => {
    const args = buildVoicePipelineArgs('/tmp/x.ogg');
    assert.deepEqual(args, ['-m', 'src.pipeline_cli', '/tmp/x.ogg', '--json', '--output-format', 'ogg']);
});

test('parsePipelineOutput returns the parsed result object', () => {
    const result = parsePipelineOutput('{"success": true, "llm_response": "salut"}');
    assert.equal(result.llm_response, 'salut');
});

test('parsePipelineOutput throws a descriptive error on non-JSON output', () => {
    assert.throws(
        () => parsePipelineOutput('Traceback (most recent call last):'),
        /Failed to parse pipeline output/
    );
});

test('parsePipelineOutput throws the embedded pipeline error', () => {
    assert.throws(
        () => parsePipelineOutput('{"success": false, "error": "STT failed: boom"}'),
        /STT failed: boom/
    );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix bot test`
Expected: the new file FAILS with `Cannot find module './pipeline-client.js'`; all other test files still pass.

- [ ] **Step 3: Write the implementation**

Create `bot/pipeline-client.js`:

```js
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { runWithTimeout } from './subprocess-timeout.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Build the argv for invoking the Python pipeline CLI in --text mode.
 *
 * The text value is packed into a single `--text=<value>` token rather than
 * passed as two separate argv entries (`--text`, value). This is required
 * because Node's `spawn` (no shell) hands the array straight through as
 * argv, so a value that itself starts with a dash (e.g. the emoticon `-_-`)
 * would otherwise be misparsed by Python's argparse as a new option flag
 * instead of the value of `--text`.
 * @param {string} text - The message body to reply to
 * @returns {string[]} argv array (excluding the interpreter/command itself)
 */
export function buildTextPipelineArgs(text) {
    return ['-m', 'src.pipeline_cli', `--text=${text}`, '--json'];
}

/**
 * Build the argv for invoking the Python pipeline CLI on a voice message.
 * @param {string} audioPath - Path to the downloaded voice note
 * @returns {string[]} argv array (excluding the interpreter/command itself)
 */
export function buildVoicePipelineArgs(audioPath) {
    return ['-m', 'src.pipeline_cli', audioPath, '--json', '--output-format', 'ogg'];
}

/**
 * Parse the pipeline subprocess stdout: must be a JSON object, and an
 * embedded `error` field (the CLI's failure envelope) is surfaced as a throw.
 * @param {string} stdout
 * @returns {object} parsed pipeline result
 */
export function parsePipelineOutput(stdout) {
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

async function runPipeline(args, logPrefix) {
    const { stdout } = await runWithTimeout(
        config.PYTHON_CMD,
        args,
        { cwd: REPO_ROOT },
        config.PIPELINE_TIMEOUT_MS,
        {
            onStderr: (chunk) => console.error(`${logPrefix} [Python stderr]:`, chunk.trim())
        }
    );
    return parsePipelineOutput(stdout);
}

/**
 * Run the full STT->LLM->TTS pipeline on a voice note.
 * @param {string} audioPath - Path to the downloaded voice note
 * @param {string} [logPrefix] - Log prefix for correlating output
 * @returns {Promise<{transcription: string, language: string, llm_response: string, output_audio_path: string, timing: object}>}
 */
export function runVoicePipeline(audioPath, logPrefix = '') {
    return runPipeline(buildVoicePipelineArgs(audioPath), logPrefix);
}

/**
 * Run the text-only reply pipeline (LLM step, no STT/TTS).
 * @param {string} text - The message body to reply to
 * @param {string} [logPrefix] - Log prefix for correlating output
 * @returns {Promise<{llm_response: string, timing: object}>}
 */
export function runTextPipeline(text, logPrefix = '') {
    return runPipeline(buildTextPipelineArgs(text), logPrefix);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix bot test`
Expected: ALL tests pass (the duplicated `--text=` tests exist in both `pipeline-client.test.js` and `text-handler.test.js` at this point — that's fine, Task 3 removes the old copies).

- [ ] **Step 5: Commit**

```bash
git add bot/pipeline-client.js bot/pipeline-client.test.js
git commit -m "feat: add pipeline-client module owning the Node->Python subprocess seam

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Create `bot/notify-error.js`

**Files:**
- Create: `bot/notify-error.js`
- Create: `bot/notify-error.test.js`

**Interfaces:**
- Consumes: `config.ENABLE_ERROR_NOTIFICATIONS`, `config.STATUS_MESSAGES.error` from `bot/config.js`; `tracker.sendTracked(chat, content)` from `bot/message-tracker.js`.
- Produces (used by Tasks 3 and 4): `notifyError(chat, tracker, error, logPrefix?) => Promise<void>` — never throws.

- [ ] **Step 1: Write the failing tests**

Create `bot/notify-error.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyError } from './notify-error.js';
import { createMessageTracker } from './message-tracker.js';

function makeFakeChat() {
    const sent = [];
    let counter = 0;
    return {
        sent,
        sendMessage: async (content) => {
            counter += 1;
            sent.push(content);
            return { id: { id: `sent-${counter}` } };
        }
    };
}

test('sends the configured error message with the error text substituted', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();

    await notifyError(chat, tracker, new Error('pipeline exploded'), '[t1]');

    assert.equal(chat.sent.length, 1);
    assert.match(chat.sent[0], /Erreur/);
    assert.match(chat.sent[0], /pipeline exploded/);
});

test('registers the error message with the tracker to avoid echo loops', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();

    await notifyError(chat, tracker, new Error('boom'), '[t2]');

    assert.equal(tracker.wasSent('sent-1'), true);
});

test('resolves without throwing when sending the notification itself fails', async () => {
    const tracker = createMessageTracker();
    const chat = {
        sendMessage: async () => {
            throw new Error('connection lost');
        }
    };

    await assert.doesNotReject(notifyError(chat, tracker, new Error('boom'), '[t3]'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix bot test`
Expected: the new file FAILS with `Cannot find module './notify-error.js'`.

- [ ] **Step 3: Write the implementation**

Create `bot/notify-error.js`:

```js
import config from './config.js';

/**
 * Log a handler error and (if enabled) notify the chat with the configured
 * error status message. Never throws: a failure to send the notification is
 * logged and swallowed, since there is nothing further to do about it.
 * @param {Chat} chat - WhatsApp chat object
 * @param {{ sendTracked: Function }} tracker - Tracks bot-sent messages to ignore on echo
 * @param {Error} error - The error to report
 * @param {string} [logPrefix] - Log prefix for correlating output
 */
export async function notifyError(chat, tracker, error, logPrefix = '') {
    console.error(`${logPrefix} ✗ Error:`, error.message);

    if (!config.ENABLE_ERROR_NOTIFICATIONS) {
        return;
    }

    const errorMsg = config.STATUS_MESSAGES.error.replace('{}', error.message);
    try {
        await tracker.sendTracked(chat, errorMsg);
    } catch (sendError) {
        console.error(`${logPrefix} Failed to send error notification:`, sendError.message);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix bot test`
Expected: ALL tests pass.

- [ ] **Step 5: Commit**

```bash
git add bot/notify-error.js bot/notify-error.test.js
git commit -m "feat: add shared notify-error helper for handler catch-blocks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Refactor `bot/text-handler.js` onto the shared modules

**Files:**
- Modify: `bot/text-handler.js` (full rewrite below)
- Modify: `bot/text-handler.test.js` (delete two moved tests, update imports)

**Interfaces:**
- Consumes: `runTextPipeline` from Task 1, `notifyError` from Task 2.
- Produces: `handleTextMessage(msg, chat, client, tracker, deps?)` — signature unchanged; `buildTextPipelineArgs` is NO LONGER exported from this file (it lives in `pipeline-client.js`).

- [ ] **Step 1: Update the test file first**

In `bot/text-handler.test.js`:
1. Delete the two tests `'packs dash-prefixed text into a single --text=<value> argv token'` and `'packs ordinary text into a single --text=<value> argv token'` (moved to `pipeline-client.test.js` in Task 1).
2. Change the import line from:

```js
import { handleTextMessage, buildTextPipelineArgs } from './text-handler.js';
```

to:

```js
import { handleTextMessage } from './text-handler.js';
```

The four remaining behavior tests stay untouched.

- [ ] **Step 2: Rewrite the handler**

Replace the entire content of `bot/text-handler.js` with:

```js
import config from './config.js';
import { runTextPipeline } from './pipeline-client.js';
import { notifyError } from './notify-error.js';

/**
 * Handle an incoming text message: reject if too long, otherwise run it
 * through the Python reply pipeline and send the text-only response.
 * @param {Message} msg - WhatsApp message object
 * @param {Chat} chat - WhatsApp chat object
 * @param {Client} client - WhatsApp client (unused; kept for signature parity with handleVoiceMessage)
 * @param {{ sendTracked: Function }} tracker - Tracks bot-sent messages to ignore on echo
 * @param {{ maxChars?: number, runPipeline?: Function }} [deps] - Injectable overrides for testing
 */
export async function handleTextMessage(msg, chat, client, tracker, deps = {}) {
    const logPrefix = `[${msg.id.id.substring(0, 8)}]`;
    const maxChars = deps.maxChars ?? config.TEXT_MAX_CHARS;
    const runPipeline = deps.runPipeline ?? ((text) => runTextPipeline(text, logPrefix));

    const body = msg.body.trim();

    if (body.length > maxChars) {
        console.log(`${logPrefix} Text message rejected: ${body.length} chars (max ${maxChars})`);
        await tracker.sendTracked(chat, `❌ Message trop long (max ${maxChars} caractères).`);
        return;
    }

    console.log(`${logPrefix} Processing text message from ${chat.name || chat.id?._serialized}`);

    try {
        const result = await runPipeline(body);
        await tracker.sendTracked(chat, result.llm_response);
        console.log(`${logPrefix} ✓ Complete`);
    } catch (error) {
        await notifyError(chat, tracker, error, logPrefix);
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm --prefix bot test`
Expected: ALL tests pass; the `--text=` packing tests now run only from `pipeline-client.test.js`.

- [ ] **Step 4: Commit**

```bash
git add bot/text-handler.js bot/text-handler.test.js
git commit -m "refactor: route text-handler through pipeline-client and notify-error

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Refactor `bot/voice-handler.js` with a DI seam and tests

**Files:**
- Modify: `bot/voice-handler.js` (full rewrite below)
- Create: `bot/voice-handler.test.js`

**Interfaces:**
- Consumes: `runVoicePipeline` from Task 1, `notifyError` from Task 2.
- Produces: `handleVoiceMessage(msg, chat, client, tracker, deps?)` where `deps` accepts `{ runPipeline?, tempDir?, mediaFromFile? }`. Callers passing four args (as `bot/index.js` does) are unaffected.

- [ ] **Step 1: Write the failing tests**

Create `bot/voice-handler.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { handleVoiceMessage } from './voice-handler.js';
import { createMessageTracker } from './message-tracker.js';

function makeFakeChat() {
    const sent = [];
    let counter = 0;
    return {
        sent,
        name: 'Test Group',
        sendMessage: async (content) => {
            counter += 1;
            sent.push(content);
            return { id: { id: `sent-${counter}` } };
        }
    };
}

function makeVoiceMsg(id = 'incoming-1') {
    return {
        id: { id },
        downloadMedia: async () => ({
            data: Buffer.from('fake-ogg-bytes').toString('base64')
        })
    };
}

async function makeTempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'voice-handler-test-'));
}

test('happy path sends ack, transcription, llm response, then voice audio', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const tempDir = await makeTempDir();
    const sentinel = { fake: 'media' };
    let pipelineAudioPath = null;
    let audioExistedDuringPipeline = false;

    await handleVoiceMessage(makeVoiceMsg(), chat, null, tracker, {
        tempDir,
        runPipeline: async (audioPath) => {
            pipelineAudioPath = audioPath;
            audioExistedDuringPipeline = await fs.access(audioPath).then(() => true, () => false);
            return {
                transcription: 'bonjour tout le monde',
                language: 'fr',
                llm_response: 'Salut!',
                output_audio_path: '/nonexistent/reply.ogg',
                timing: { stt: 1, llm: 2, tts: 3, total: 6 }
            };
        },
        mediaFromFile: (filePath) => {
            assert.equal(filePath, '/nonexistent/reply.ogg');
            return sentinel;
        }
    });

    assert.equal(chat.sent.length, 4);
    assert.match(chat.sent[0], /vocal reçu/);
    assert.match(chat.sent[1], /bonjour tout le monde/);
    assert.match(chat.sent[2], /Salut!/);
    assert.equal(chat.sent[3], sentinel);

    assert.ok(pipelineAudioPath.startsWith(tempDir), 'audio saved under the injected temp dir');
    assert.equal(audioExistedDuringPipeline, true);
});

test('cleans up the temp audio file after success', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const tempDir = await makeTempDir();

    await handleVoiceMessage(makeVoiceMsg('incoming-2'), chat, null, tracker, {
        tempDir,
        runPipeline: async () => ({
            transcription: 't', language: 'fr', llm_response: 'r',
            output_audio_path: '/nonexistent/reply.ogg', timing: {}
        }),
        mediaFromFile: () => ({})
    });

    assert.deepEqual(await fs.readdir(tempDir), []);
});

test('pipeline failure sends an error notification and still cleans up', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const tempDir = await makeTempDir();

    await handleVoiceMessage(makeVoiceMsg('incoming-3'), chat, null, tracker, {
        tempDir,
        runPipeline: async () => {
            throw new Error('pipeline exploded');
        }
    });

    assert.equal(chat.sent.length, 2); // ack + error notification
    assert.match(chat.sent[1], /pipeline exploded/);
    assert.deepEqual(await fs.readdir(tempDir), []);
});

test('failed media download sends an error notification', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const tempDir = await makeTempDir();
    const msg = { id: { id: 'incoming-4' }, downloadMedia: async () => null };

    await handleVoiceMessage(msg, chat, null, tracker, {
        tempDir,
        runPipeline: async () => {
            throw new Error('should not be reached');
        }
    });

    assert.equal(chat.sent.length, 2); // ack + error notification
    assert.match(chat.sent[1], /Failed to download media/);
});

test('registers every sent message with the tracker to avoid echo loops', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const tempDir = await makeTempDir();

    await handleVoiceMessage(makeVoiceMsg('incoming-5'), chat, null, tracker, {
        tempDir,
        runPipeline: async () => ({
            transcription: 't', language: 'fr', llm_response: 'r',
            output_audio_path: '/nonexistent/reply.ogg', timing: {}
        }),
        mediaFromFile: () => ({})
    });

    for (const id of ['sent-1', 'sent-2', 'sent-3', 'sent-4']) {
        assert.equal(tracker.wasSent(id), true, `${id} should be tracked`);
    }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix bot test`
Expected: `voice-handler.test.js` FAILS — current `handleVoiceMessage` ignores the fifth `deps` argument, so it tries to write into `config.TEMP_DIR` and spawn real Python. All other files pass.

- [ ] **Step 3: Rewrite the handler**

Replace the entire content of `bot/voice-handler.js` with:

```js
import fs from 'fs/promises';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import config from './config.js';
import { runVoicePipeline } from './pipeline-client.js';
import { notifyError } from './notify-error.js';

/**
 * Handle incoming voice message: download the audio, run it through the
 * STT->LLM->TTS pipeline, and send the staged status replies plus the voice
 * response.
 * @param {Message} msg - WhatsApp message object
 * @param {Chat} chat - WhatsApp chat object
 * @param {Client} client - WhatsApp client (unused; kept for signature parity)
 * @param {{ sendTracked: Function }} tracker - Tracks bot-sent messages to ignore on echo
 * @param {{ runPipeline?: Function, tempDir?: string, mediaFromFile?: Function }} [deps] - Injectable overrides for testing
 */
export async function handleVoiceMessage(msg, chat, client, tracker, deps = {}) {
    const messageId = msg.id.id.substring(0, 8);
    const logPrefix = `[${messageId}]`;
    const runPipeline = deps.runPipeline ?? ((audioPath) => runVoicePipeline(audioPath, logPrefix));
    const tempDir = deps.tempDir ?? config.TEMP_DIR;
    const mediaFromFile = deps.mediaFromFile ?? ((filePath) => MessageMedia.fromFilePath(filePath));

    console.log(`${logPrefix} Processing voice message from ${chat.name || chat.id._serialized}`);

    let tempAudioPath = null;

    try {
        // Stage 1: Acknowledge receipt
        await tracker.sendTracked(chat, config.STATUS_MESSAGES.received);

        // Stage 2: Download audio
        const media = await msg.downloadMedia();
        if (!media) {
            throw new Error('Failed to download media');
        }

        tempAudioPath = path.join(tempDir, `whatsapp_${Date.now()}_${messageId}.ogg`);
        await fs.writeFile(tempAudioPath, media.data, 'base64');
        console.log(`${logPrefix} Audio saved to ${tempAudioPath}`);

        // Stage 3: Run the Python pipeline
        const result = await runPipeline(tempAudioPath);

        // Stage 4: Send transcription
        await tracker.sendTracked(
            chat,
            config.STATUS_MESSAGES.transcription.replace('{}', result.transcription)
        );

        // Stage 5: Send LLM response
        await tracker.sendTracked(
            chat,
            config.STATUS_MESSAGES.llm_response.replace('{}', result.llm_response)
        );

        // Stage 6: Send voice audio
        const audioMedia = mediaFromFile(result.output_audio_path);
        await tracker.sendTracked(chat, audioMedia, { sendAudioAsVoice: true });

        console.log(`${logPrefix} ✓ Complete (${result.timing?.total ?? 'unknown'}s)`);
        console.log(`${logPrefix} Timing - STT: ${result.timing?.stt}s, LLM: ${result.timing?.llm}s, TTS: ${result.timing?.tts}s`);

    } catch (error) {
        await notifyError(chat, tracker, error, logPrefix);
    } finally {
        // Cleanup temporary audio file
        if (tempAudioPath) {
            try {
                await fs.unlink(tempAudioPath);
                console.log(`${logPrefix} Cleaned up ${tempAudioPath}`);
            } catch (cleanupError) {
                console.warn(`${logPrefix} Failed to cleanup ${tempAudioPath}:`, cleanupError.message);
            }
        }
    }
}
```

Note what disappeared versus the old file: the private `callPythonPipeline` function (now `runVoicePipeline` in `pipeline-client.js`), the redundant `if (result.error) throw` check (now inside `parsePipelineOutput`), and the inline catch-block (now `notifyError`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix bot test`
Expected: ALL tests pass.

- [ ] **Step 5: Commit**

```bash
git add bot/voice-handler.js bot/voice-handler.test.js
git commit -m "refactor: route voice-handler through pipeline-client with injectable deps and tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Prune dead keys from `src/config.py` and add `TTS_MODEL_PATH`

**Files:**
- Modify: `src/config.py`
- Modify: `src/pipeline.py:252-259` (`_ensure_tts`)
- Modify: `tests/test_config.py`
- Modify: `tests/test_pipeline.py:175-183` (`test_synthesize_speech_checks_piper_model_on_first_call`)

**Interfaces:**
- Produces: `config.TTS_MODEL_PATH: str` — absolute path to the Piper voice model, consumed by `VoicePipeline._ensure_tts`.
- Removes: `STATUS_MESSAGES`, `MAX_RETRIES`, `RETRY_DELAY`, `AUDIO_DOWNLOAD_TIMEOUT`, `LOGS_DIR`, `ENABLE_ERROR_NOTIFICATIONS`, `TTS_LANGUAGE`, `TTS_DEVICE`, `AUDIO_INPUT_DIR`, `TEMP_AUDIO_DIR`, `CUDA_DEVICE` from `src.config` (each re-verified dead in the next step before deletion).

- [ ] **Step 1: Re-verify each key is dead before deleting**

Run (each key in turn; `tests/step1/` has its own config copy and doesn't count — see Global Constraints):

```bash
for key in STATUS_MESSAGES MAX_RETRIES RETRY_DELAY AUDIO_DOWNLOAD_TIMEOUT LOGS_DIR \
           ENABLE_ERROR_NOTIFICATIONS TTS_LANGUAGE TTS_DEVICE AUDIO_INPUT_DIR \
           TEMP_AUDIO_DIR CUDA_DEVICE; do
    echo "== $key =="
    grep -rn "$key" src/ tests/ bot/ st-bridge/ scripts/ \
        --include='*.py' --include='*.js' --include='*.sh' \
        | grep -v 'src/config.py' | grep -v 'tests/step1/'
done
```

Expected: no output under any key heading. If a key DOES show a real usage, keep that key, drop it from the deletion list in the following steps, and note it in the commit message.

- [ ] **Step 2: Write the failing tests**

Append to `tests/test_config.py` (it already imports `os` at the top):

```python
def test_dead_pipeline_config_removed_slice1():
    config = _reload_config()
    for attr in (
        "STATUS_MESSAGES",
        "MAX_RETRIES",
        "RETRY_DELAY",
        "AUDIO_DOWNLOAD_TIMEOUT",
        "LOGS_DIR",
        "ENABLE_ERROR_NOTIFICATIONS",
        "TTS_LANGUAGE",
        "TTS_DEVICE",
        "AUDIO_INPUT_DIR",
        "TEMP_AUDIO_DIR",
        "CUDA_DEVICE",
    ):
        assert not hasattr(config, attr), f"{attr} should have been removed"


def test_tts_model_path_points_at_bundled_piper_voice():
    config = _reload_config()
    assert config.TTS_MODEL_PATH == os.path.join(
        config.MODELS_DIR, "piper", "fr_FR-siwis-medium.onnx"
    )
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_config.py -v`
Expected: the two new tests FAIL (`STATUS_MESSAGES should have been removed` / `has no attribute 'TTS_MODEL_PATH'`); all existing tests pass.

- [ ] **Step 4: Edit `src/config.py`**

Delete these lines/blocks (keep the `os.environ["CUDA_VISIBLE_DEVICES"] = "0"` line — only the unused `CUDA_DEVICE = "cuda:0"` constant goes):

- `AUDIO_INPUT_DIR = ...` and `TEMP_AUDIO_DIR = ...` (keep `AUDIO_OUTPUT_DIR` — used by `pipeline.py`)
- `LOGS_DIR = ...`
- `CUDA_DEVICE = "cuda:0"`
- `TTS_LANGUAGE = ...` and `TTS_DEVICE = ...` (the whole "TTS Configuration" pair; replace with `TTS_MODEL_PATH` below)
- `AUDIO_DOWNLOAD_TIMEOUT = ...`
- the entire `STATUS_MESSAGES = { ... }` dict and its `# Status Messages (French)` comment
- `ENABLE_ERROR_NOTIFICATIONS = ...`, `MAX_RETRIES = ...`, `RETRY_DELAY = ...` and the `# Error Handling` comment

Replace the TTS section with:

```python
# TTS Configuration (Piper)
TTS_MODEL_PATH = os.path.join(MODELS_DIR, "piper", "fr_FR-siwis-medium.onnx")
```

- [ ] **Step 5: Use `TTS_MODEL_PATH` in `_ensure_tts`**

In `src/pipeline.py`, replace:

```python
        piper_model = os.path.join(self.config.PROJECT_ROOT, "models", "piper", "fr_FR-siwis-medium.onnx")
```

with:

```python
        piper_model = self.config.TTS_MODEL_PATH
```

- [ ] **Step 6: Update the TTS test's config stub**

In `tests/test_pipeline.py`, `test_synthesize_speech_checks_piper_model_on_first_call` builds `SimpleNamespace(PROJECT_ROOT=str(tmp_path))`. Change that line to:

```python
    config = SimpleNamespace(TTS_MODEL_PATH=str(tmp_path / "fr_FR-siwis-medium.onnx"))
```

(The test still passes a path that doesn't exist, so the `Piper model not found` assertion is unchanged.)

- [ ] **Step 7: Run the full Python suite**

Run: `.venv/bin/python -m pytest tests/ -v`
Expected: ALL tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/config.py src/pipeline.py tests/test_config.py tests/test_pipeline.py
git commit -m "refactor: prune dead pipeline config keys and move Piper path into config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Document config ownership in the three config files

**Files:**
- Modify: `bot/config.js` (header comment)
- Modify: `src/config.py` (docstring)
- Modify: `st-bridge/config.js` (header comment)

**Interfaces:** none — comments only, no code change.

- [ ] **Step 1: Add the ownership headers**

At the top of `bot/config.js` (above the imports), add:

```js
// Config scope: WhatsApp-side behavior only — group targeting, user-facing
// status messages, and Python subprocess invocation limits.
//
// Deliberately duplicated with src/config.py: TEXT_MAX_CHARS (same
// TEXT_MAX_CHARS env var on both sides), so Node can reject oversized
// messages without spawning Python while Python still enforces the limit
// for direct CLI use.
```

Replace the module docstring of `src/config.py` with:

```python
"""
Configuration for the Python STT->LLM->TTS pipeline.

Config scope: pipeline behavior only — model selection, LLM endpoints,
audio limits. WhatsApp-side settings live in bot/config.js; SillyTavern
bridge settings live in st-bridge/config.js.

Deliberately duplicated with bot/config.js: TEXT_MAX_CHARS (same
TEXT_MAX_CHARS env var on both sides), so Node can reject oversized
messages without spawning Python while Python still enforces the limit
for direct CLI use.
"""
```

At the top of `st-bridge/config.js` (above the imports), add:

```js
// Config scope: SillyTavern bridge only — server port, ST connection,
// reply timeouts, and tool-calling settings. WhatsApp-side settings live
// in ../bot/config.js; pipeline settings live in ../src/config.py.
```

- [ ] **Step 2: Run both suites to confirm nothing broke**

Run: `npm --prefix bot test && .venv/bin/python -m pytest tests/`
Expected: ALL tests pass.

- [ ] **Step 3: Commit**

```bash
git add bot/config.js src/config.py st-bridge/config.js
git commit -m "docs: document config-file ownership and the deliberate TEXT_MAX_CHARS duplication

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
