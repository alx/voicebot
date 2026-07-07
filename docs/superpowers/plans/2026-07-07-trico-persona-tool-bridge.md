# Trico Persona + Tool-Calling Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a SillyTavern character card, "Trico" (French-only, family-friendly), plus a marker-based tool-calling bridge in `st-bridge` that lets it run a small whitelisted set of real local Linux commands, scoped to a safe directory.

**Architecture:** `st-bridge` already sends one message to a live SillyTavern chat and returns one reply (`sendMessageAndAwaitReply` in `chat-client.js`). We add a thin orchestration layer (`tool-runner.js`) that wraps that primitive: send the user's message, check if the reply is a `[TOOL: ...]` marker, and if so run the whitelisted command (`tools.js`), inject the result back into the same chat, and return SillyTavern's *next* reply as the final answer. A blocklist filter (`blocklist.js`) is applied to whatever text ultimately leaves `st-bridge`. No changes to the Python pipeline — `st-bridge`'s public `/reply` contract is unchanged.

**Tech Stack:** Node.js (ESM, `"type": "module"`), Node's built-in `node:test` + `node:assert/strict` test runner (matches existing `st-bridge` tests), `child_process.execFile`, `fs/promises`.

## Global Constraints

- Persona replies **always in French**, regardless of the language used to address it.
- Family-friendly tone: no profanity/adult/violent content; inappropriate requests are refused gently, in French.
- **Max one tool round-trip per user turn** — no chained/recursive tool calls.
- File-related tools (`list_dir`, `read_file`, `write_file`, `search_files`) are restricted to the `assistant-data/` root; requests that escape it via `..`, absolute paths, or symlinks must be rejected before any filesystem access.
- All whitelisted commands run via fixed `argv` arrays (`execFile`), **never** shell-string interpolation.
- Tool output is truncated to 2000 characters; execution is bounded by `ST_BRIDGE_TOOL_TIMEOUT_MS` (default `10000`).
- The blocklist filter applies only to the **final** reply returned to the pipeline, never to intermediate `[TOOL: ...]`/`[RÉSULTAT] ...` messages.
- No changes to `src/pipeline.py` or any Python file — this feature is entirely inside `st-bridge`.

---

### Task 1: Scoped directory and config plumbing

**Files:**
- Create: `assistant-data/.gitkeep`
- Modify: `.gitignore`
- Modify: `st-bridge/config.js`
- Modify: `st-bridge/.env.example`

**Interfaces:**
- Produces: `config.default.TOOLS_ENABLED` (boolean), `config.default.TOOL_ROOT` (absolute path string), `config.default.TOOL_TIMEOUT_MS` (number) — consumed by Task 5's `index.js` wiring.

- [ ] **Step 1: Create the scoped directory placeholder**

```bash
mkdir -p assistant-data
touch assistant-data/.gitkeep
```

- [ ] **Step 2: Ignore assistant-data contents but keep the directory tracked**

Add to `.gitignore`, right after the existing `_site/` line:

```
# Trico's scoped tool working directory (files it reads/writes at runtime)
assistant-data/*
!assistant-data/.gitkeep
```

- [ ] **Step 3: Add tool config to `st-bridge/config.js`**

Modify `st-bridge/config.js` — replace its `export default { ... }` block with:

```javascript
export default {
    PORT: parseInt(process.env.ST_BRIDGE_PORT || '8091', 10),
    ST_BASE_URL: process.env.ST_BASE_URL || 'http://localhost:8000',
    ST_CHARACTER_NAME: process.env.ST_CHARACTER_NAME || '',
    USER_DATA_DIR: path.join(__dirname, '.browser-data'),
    REPLY_TIMEOUT_MS: parseInt(process.env.ST_REPLY_TIMEOUT_MS || '60000', 10),
    TOOLS_ENABLED: process.env.ST_BRIDGE_TOOLS_ENABLED === 'true',
    TOOL_ROOT: path.resolve(__dirname, process.env.ST_BRIDGE_TOOL_ROOT || '../assistant-data'),
    TOOL_TIMEOUT_MS: parseInt(process.env.ST_BRIDGE_TOOL_TIMEOUT_MS || '10000', 10),
};
```

- [ ] **Step 4: Document the new env vars**

Append to `st-bridge/.env.example`:

```bash

# Enable Trico's whitelisted local tool execution ("true" to enable)
ST_BRIDGE_TOOLS_ENABLED=true

# Directory tool file operations are scoped to (resolved relative to st-bridge/)
ST_BRIDGE_TOOL_ROOT=../assistant-data

# Max time (ms) a single whitelisted command may run before it's killed
ST_BRIDGE_TOOL_TIMEOUT_MS=10000
```

- [ ] **Step 5: Verify config loads correctly**

Run:
```bash
cd st-bridge && ST_BRIDGE_TOOLS_ENABLED=true node -e "import('./config.js').then(c => console.log(c.default))"
```
Expected: prints an object including `TOOLS_ENABLED: true`, `TOOL_ROOT` as an absolute path ending in `assistant-data`, and `TOOL_TIMEOUT_MS: 10000`.

- [ ] **Step 6: Commit**

```bash
git add assistant-data/.gitkeep .gitignore st-bridge/config.js st-bridge/.env.example
git commit -m "feat: add scoped tool directory and tool config to st-bridge"
```

---

### Task 2: Whitelisted tool registry (`tools.js`)

**Files:**
- Create: `st-bridge/tools.js`
- Test: `st-bridge/tools.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (uses `child_process`, `fs/promises`, `path` directly).
- Produces:
  - `export class ToolError extends Error {}`
  - `export async function resolveScopedPath(root: string, requestedPath: string, opts: { mustExist: boolean }): Promise<string>` — throws `ToolError` if the path escapes `root`.
  - `export const TOOLS: Record<string, (args: string[], config: { root: string }, timeoutMs?: number) => Promise<string>>`
  - `export async function runTool(name: string, args: string[], config: { root: string }, timeoutMs: number): Promise<string>` — throws `ToolError` for unknown tool names or validation failures.
  - Consumed by Task 3 (`tool-runner.js`) and Task 6's persona test.

- [ ] **Step 1: Write the failing tests**

Create `st-bridge/tools.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { TOOLS, runTool, resolveScopedPath, ToolError } from './tools.js';

async function makeTempRoot() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'trico-tools-'));
}

test('runTool rejects an unknown tool name', async () => {
    await assert.rejects(
        runTool('does_not_exist', [], { root: '/tmp' }, 1000),
        ToolError
    );
});

test('disk_usage returns non-empty output', async () => {
    const output = await runTool('disk_usage', [], { root: '/tmp' }, 5000);
    assert.ok(output.length > 0);
});

test('ping rejects a host containing shell metacharacters', async () => {
    await assert.rejects(
        runTool('ping', ['; rm -rf /'], { root: '/tmp' }, 1000),
        ToolError
    );
});

test('ping rejects a missing host argument', async () => {
    await assert.rejects(
        runTool('ping', [], { root: '/tmp' }, 1000),
        ToolError
    );
});

test('resolveScopedPath allows a path inside the root', async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello');
    const resolved = await resolveScopedPath(root, 'notes.txt', { mustExist: true });
    assert.equal(resolved, path.join(root, 'notes.txt'));
});

test('resolveScopedPath rejects ../ traversal', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        resolveScopedPath(root, '../outside.txt', { mustExist: false }),
        ToolError
    );
});

test('resolveScopedPath rejects an absolute path outside the root', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        resolveScopedPath(root, '/etc/passwd', { mustExist: true }),
        ToolError
    );
});

test('resolveScopedPath rejects a symlink that escapes the root', async () => {
    const root = await makeTempRoot();
    const outsideDir = await makeTempRoot();
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'nope');
    await fs.symlink(outsideDir, path.join(root, 'escape'));
    await assert.rejects(
        resolveScopedPath(root, 'escape/secret.txt', { mustExist: true }),
        ToolError
    );
});

test('write_file then read_file round-trips content inside the root', async () => {
    const root = await makeTempRoot();
    await TOOLS.write_file(['note.txt', 'bonjour', 'le', 'monde'], { root });
    const content = await TOOLS.read_file(['note.txt'], { root });
    assert.equal(content, 'bonjour le monde');
});

test('write_file rejects content larger than the size cap', async () => {
    const root = await makeTempRoot();
    const tooBig = 'a'.repeat(100_001);
    await assert.rejects(
        TOOLS.write_file(['big.txt', tooBig], { root }),
        ToolError
    );
});

test('search_files finds a matching line inside the root', async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, 'haystack.txt'), 'bonjour le monde\nautre ligne');
    const output = await TOOLS.search_files(['bonjour', '.'], { root }, 5000);
    assert.ok(output.includes('bonjour'));
});

test('list_dir rejects a path escaping the root', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        TOOLS.list_dir(['../'], { root }, 5000),
        ToolError
    );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd st-bridge && node --test tools.test.js`
Expected: FAIL — `tools.js` does not exist yet (`Cannot find module`).

- [ ] **Step 3: Implement `st-bridge/tools.js`**

```javascript
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

export class ToolError extends Error {}

const HOSTNAME_RE = /^[a-zA-Z0-9.-]{1,253}$/;
const MAX_OUTPUT_CHARS = 2000;
const MAX_FILE_BYTES = 100_000;

function truncate(text) {
    return text.length > MAX_OUTPUT_CHARS
        ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[...tronqué...]`
        : text;
}

function execFileCapture(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(
            cmd,
            args,
            { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new ToolError(`${cmd} failed: ${stderr || error.message}`));
                    return;
                }
                resolve(stdout);
            }
        );
    });
}

function validateHost(host) {
    if (!host || !HOSTNAME_RE.test(host)) {
        throw new ToolError(`Invalid host: ${host ?? '(missing)'}`);
    }
    return host;
}

export async function resolveScopedPath(root, requestedPath, { mustExist }) {
    const rootReal = await fs.realpath(root);
    const lexical = path.resolve(rootReal, requestedPath || '.');
    if (lexical !== rootReal && !lexical.startsWith(rootReal + path.sep)) {
        throw new ToolError('Path escapes the scoped root');
    }

    const checkTarget = mustExist ? lexical : path.dirname(lexical);
    let real;
    try {
        real = await fs.realpath(checkTarget);
    } catch {
        throw new ToolError(`Path does not exist: ${requestedPath}`);
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new ToolError('Path escapes the scoped root');
    }

    return lexical;
}

export const TOOLS = {
    disk_usage: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('df', ['-h'], timeoutMs)),

    memory: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('free', ['-h'], timeoutMs)),

    uptime: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('uptime', [], timeoutMs)),

    datetime: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('date', [], timeoutMs)),

    local_ip: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('ip', ['addr', 'show'], timeoutMs)),

    ping: async (args, _config, timeoutMs) => {
        const host = validateHost(args[0]);
        return truncate(await execFileCapture('ping', ['-c', '3', host], timeoutMs));
    },

    list_dir: async (args, config, timeoutMs) => {
        const target = await resolveScopedPath(config.root, args[0], { mustExist: true });
        return truncate(await execFileCapture('ls', ['-la', target], timeoutMs));
    },

    read_file: async (args, config) => {
        const target = await resolveScopedPath(config.root, args[0], { mustExist: true });
        const content = await fs.readFile(target, 'utf8');
        return truncate(content);
    },

    write_file: async (args, config) => {
        const [requestedPath, ...contentParts] = args;
        if (!requestedPath) {
            throw new ToolError('Missing file path');
        }
        const content = contentParts.join(' ');
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
            throw new ToolError('Content too large');
        }
        const target = await resolveScopedPath(config.root, requestedPath, { mustExist: false });
        await fs.writeFile(target, content, 'utf8');
        return `Fichier écrit : ${requestedPath}`;
    },

    search_files: async (args, config, timeoutMs) => {
        const [pattern, ...rest] = args;
        if (!pattern) {
            throw new ToolError('Missing search pattern');
        }
        const target = await resolveScopedPath(config.root, rest[0], { mustExist: true });
        return truncate(await execFileCapture('grep', ['-rn', pattern, target], timeoutMs));
    },
};

export async function runTool(name, args, config, timeoutMs) {
    const tool = TOOLS[name];
    if (!tool) {
        throw new ToolError(`Unknown tool: ${name}`);
    }
    return tool(args, config, timeoutMs);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd st-bridge && node --test tools.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add st-bridge/tools.js st-bridge/tools.test.js
git commit -m "feat: add whitelisted local tool registry with scoped path validation"
```

---

### Task 3: Marker parsing and tool orchestration (`tool-runner.js`)

**Files:**
- Create: `st-bridge/tool-runner.js`
- Test: `st-bridge/tool-runner.test.js`

**Interfaces:**
- Consumes: `runTool(name, args, config, timeoutMs)` and `ToolError` from `st-bridge/tools.js` (Task 2).
- Produces:
  - `export function parseToolMarker(text: string): { name: string, args: string[] } | null`
  - `export async function sendMessageWithTools(adapter, text: string, sendFn: (adapter, text: string, opts: { timeoutMs: number }) => Promise<string>, options: { timeoutMs: number, toolsEnabled: boolean, toolConfig: { root: string }, toolTimeoutMs: number }): Promise<string>`
  - Consumed by Task 5 (`index.js`), where `sendFn` will be `sendMessageAndAwaitReply` from `chat-client.js`.

- [ ] **Step 1: Write the failing tests**

Create `st-bridge/tool-runner.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parseToolMarker, sendMessageWithTools } from './tool-runner.js';

async function makeTempRoot() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'trico-runner-'));
}

function queueSendFn(replies) {
    const calls = [];
    return {
        calls,
        fn: async (adapter, text) => {
            calls.push(text);
            return replies[calls.length - 1];
        },
    };
}

test('parseToolMarker parses a well-formed marker', () => {
    const result = parseToolMarker('[TOOL: read_file notes.txt]');
    assert.deepEqual(result, { name: 'read_file', args: ['notes.txt'] });
});

test('parseToolMarker parses a marker with no arguments', () => {
    const result = parseToolMarker('  [TOOL: disk_usage]  ');
    assert.deepEqual(result, { name: 'disk_usage', args: [] });
});

test('parseToolMarker returns null for plain text', () => {
    assert.equal(parseToolMarker('Bonjour, comment vas-tu ?'), null);
});

test('sendMessageWithTools returns the first reply when tools are disabled', async () => {
    const { fn, calls } = queueSendFn(['[TOOL: disk_usage]']);
    const result = await sendMessageWithTools({}, 'Salut', fn, {
        timeoutMs: 1000,
        toolsEnabled: false,
        toolConfig: { root: '/tmp' },
        toolTimeoutMs: 1000,
    });
    assert.equal(result, '[TOOL: disk_usage]');
    assert.equal(calls.length, 1);
});

test('sendMessageWithTools returns the first reply when it is not a tool marker', async () => {
    const { fn, calls } = queueSendFn(['Bonjour !']);
    const result = await sendMessageWithTools({}, 'Salut', fn, {
        timeoutMs: 1000,
        toolsEnabled: true,
        toolConfig: { root: '/tmp' },
        toolTimeoutMs: 1000,
    });
    assert.equal(result, 'Bonjour !');
    assert.equal(calls.length, 1);
});

test('sendMessageWithTools executes a valid tool and returns the second reply', async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, 'notes.txt'), 'il reste 20 Go');

    const { fn, calls } = queueSendFn([
        '[TOOL: read_file notes.txt]',
        'Il te reste 20 Go de libre !',
    ]);

    const result = await sendMessageWithTools({}, 'Il reste de la place ?', fn, {
        timeoutMs: 1000,
        toolsEnabled: true,
        toolConfig: { root },
        toolTimeoutMs: 1000,
    });

    assert.equal(result, 'Il te reste 20 Go de libre !');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 'Il reste de la place ?');
    assert.equal(calls[1], '[RÉSULTAT] il reste 20 Go');
});

test('sendMessageWithTools injects a French error note for an unknown tool', async () => {
    const { fn, calls } = queueSendFn([
        '[TOOL: does_not_exist]',
        'Désolé, cet outil n\'existe pas.',
    ]);

    const result = await sendMessageWithTools({}, 'Fais un truc bizarre', fn, {
        timeoutMs: 1000,
        toolsEnabled: true,
        toolConfig: { root: '/tmp' },
        toolTimeoutMs: 1000,
    });

    assert.equal(result, "Désolé, cet outil n'existe pas.");
    assert.equal(calls.length, 2);
    assert.match(calls[1], /^\[RÉSULTAT\] Erreur :/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd st-bridge && node --test tool-runner.test.js`
Expected: FAIL — `tool-runner.js` does not exist yet.

- [ ] **Step 3: Implement `st-bridge/tool-runner.js`**

```javascript
import { runTool, ToolError } from './tools.js';

const TOOL_MARKER_RE = /^\[TOOL:\s*([a-zA-Z_]+)\s*([^\]]*)\]$/;

export function parseToolMarker(text) {
    const trimmed = text.trim();
    const match = TOOL_MARKER_RE.exec(trimmed);
    if (!match) {
        return null;
    }
    const name = match[1];
    const rawArgs = match[2].trim();
    const args = rawArgs.length > 0 ? rawArgs.split(/\s+/) : [];
    return { name, args };
}

export async function sendMessageWithTools(adapter, text, sendFn, options) {
    const firstReply = await sendFn(adapter, text, { timeoutMs: options.timeoutMs });

    if (!options.toolsEnabled) {
        return firstReply;
    }

    const marker = parseToolMarker(firstReply);
    if (!marker) {
        return firstReply;
    }

    let resultText;
    try {
        resultText = await runTool(marker.name, marker.args, options.toolConfig, options.toolTimeoutMs);
    } catch (error) {
        resultText = error instanceof ToolError
            ? `Erreur : ${error.message}`
            : 'Erreur : outil indisponible.';
    }

    const injected = `[RÉSULTAT] ${resultText}`;
    return sendFn(adapter, injected, { timeoutMs: options.timeoutMs });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd st-bridge && node --test tool-runner.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add st-bridge/tool-runner.js st-bridge/tool-runner.test.js
git commit -m "feat: add tool-marker parsing and one-round-trip tool orchestration"
```

---

### Task 4: Family-friendly blocklist filter (`blocklist.js`)

**Files:**
- Create: `st-bridge/blocklist.js`
- Create: `st-bridge/blocklist.json`
- Test: `st-bridge/blocklist.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function loadBlocklist(filePath?: string): string[]`
  - `export function applyBlocklist(text: string, blocklist: string[]): string`
  - `export const REFUSAL_MESSAGE: string`
  - Consumed by Task 5 (`index.js`).

- [ ] **Step 1: Write the failing tests**

Create `st-bridge/blocklist.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadBlocklist, applyBlocklist, REFUSAL_MESSAGE } from './blocklist.js';

test('loadBlocklist reads a JSON array of words from a file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trico-blocklist-'));
    const file = path.join(dir, 'blocklist.json');
    await fs.writeFile(file, JSON.stringify(['motinterdit']));

    const blocklist = loadBlocklist(file);
    assert.deepEqual(blocklist, ['motinterdit']);
});

test('loadBlocklist throws when the file is not a JSON array of strings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trico-blocklist-'));
    const file = path.join(dir, 'blocklist.json');
    await fs.writeFile(file, JSON.stringify({ not: 'an array' }));

    assert.throws(() => loadBlocklist(file));
});

test('applyBlocklist replaces text containing a blocked word (case-insensitive)', () => {
    const result = applyBlocklist('Tu es vraiment MotInterdit aujourd\'hui', ['motinterdit']);
    assert.equal(result, REFUSAL_MESSAGE);
});

test('applyBlocklist returns the original text when nothing matches', () => {
    const result = applyBlocklist('Bonjour, comment vas-tu ?', ['motinterdit']);
    assert.equal(result, 'Bonjour, comment vas-tu ?');
});

test('the shipped blocklist.json is a valid JSON array of strings', async () => {
    const blocklist = loadBlocklist();
    assert.ok(Array.isArray(blocklist));
    assert.ok(blocklist.every((word) => typeof word === 'string'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd st-bridge && node --test blocklist.test.js`
Expected: FAIL — `blocklist.js` does not exist yet.

- [ ] **Step 3: Implement `st-bridge/blocklist.js`**

```javascript
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BLOCKLIST_PATH = path.join(__dirname, 'blocklist.json');

export const REFUSAL_MESSAGE =
    "Je ne peux pas répondre à ça, mais je suis là pour t'aider autrement !";

export function loadBlocklist(filePath = DEFAULT_BLOCKLIST_PATH) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const words = JSON.parse(raw);
    if (!Array.isArray(words) || !words.every((word) => typeof word === 'string')) {
        throw new Error('blocklist file must be a JSON array of strings');
    }
    return words;
}

export function applyBlocklist(text, blocklist) {
    const lower = text.toLowerCase();
    const matched = blocklist.some((word) => lower.includes(word.toLowerCase()));
    if (matched) {
        console.log(`[blocklist] reply blocked at ${new Date().toISOString()}`);
        return REFUSAL_MESSAGE;
    }
    return text;
}
```

- [ ] **Step 4: Create the starter blocklist**

Create `st-bridge/blocklist.json`:

```json
[
    "merde",
    "putain",
    "connard",
    "connasse",
    "salope",
    "encul"
]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd st-bridge && node --test blocklist.test.js`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add st-bridge/blocklist.js st-bridge/blocklist.json st-bridge/blocklist.test.js
git commit -m "feat: add family-friendly blocklist filter for final replies"
```

---

### Task 5: Wire tools and blocklist into `index.js`

**Files:**
- Modify: `st-bridge/index.js`

**Interfaces:**
- Consumes: `sendMessageWithTools` (Task 3), `loadBlocklist`/`applyBlocklist` (Task 4), `config.default.TOOLS_ENABLED`/`TOOL_ROOT`/`TOOL_TIMEOUT_MS` (Task 1).
- Produces: the composed `replyFn` passed to `createServer` — same external shape as before (`(text: string) => Promise<string>`), so `server.js` and the Python pipeline need no changes.

- [ ] **Step 1: Modify `st-bridge/index.js`**

Replace the imports at the top of `st-bridge/index.js`:

```javascript
import puppeteer from 'puppeteer';
import config from './config.js';
import { selectCharacter, createPageAdapter } from './puppeteer-adapter.js';
import { sendMessageAndAwaitReply } from './chat-client.js';
import { sendMessageWithTools } from './tool-runner.js';
import { loadBlocklist, applyBlocklist } from './blocklist.js';
import { createServer } from './server.js';
```

Replace the `replyFn` definition inside `main()`:

```javascript
    const adapter = createPageAdapter(page);
    const blocklist = loadBlocklist();
    const replyFn = async (text) => {
        const reply = await sendMessageWithTools(adapter, text, sendMessageAndAwaitReply, {
            timeoutMs: config.REPLY_TIMEOUT_MS,
            toolsEnabled: config.TOOLS_ENABLED,
            toolConfig: { root: config.TOOL_ROOT },
            toolTimeoutMs: config.TOOL_TIMEOUT_MS,
        });
        return applyBlocklist(reply, blocklist);
    };
```

- [ ] **Step 2: Verify the file is syntactically valid**

Run: `cd st-bridge && node --check index.js`
Expected: no output (exit code 0) — a syntax check only, since `index.js` launches a real browser on import and has no existing test file (behavior is already covered by `tool-runner.test.js` and `blocklist.test.js`).

- [ ] **Step 3: Run the full st-bridge test suite**

Run: `cd st-bridge && node --test`
Expected: PASS — all existing and new test files (`chat-client.test.js`, `server.test.js`, `tools.test.js`, `tool-runner.test.js`, `blocklist.test.js`) pass.

- [ ] **Step 4: Commit**

```bash
git add st-bridge/index.js
git commit -m "feat: compose tool execution and blocklist filtering into st-bridge's reply path"
```

---

### Task 6: Trico character card

**Files:**
- Create: `st-bridge/personas/trico.json`
- Test: `st-bridge/personas/trico.test.js`

**Interfaces:**
- Consumes: `TOOLS` from `st-bridge/tools.js` (Task 2), to assert every whitelisted tool name is documented in the card's `system_prompt`.
- Produces: `st-bridge/personas/trico.json`, importable into SillyTavern as a v2 character card.

- [ ] **Step 1: Write the failing tests**

Create `st-bridge/personas/trico.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TOOLS } from '../tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cardPath = path.join(__dirname, 'trico.json');

test('trico.json is a valid SillyTavern v2 character card', () => {
    const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.data.name, 'Trico');
    assert.ok(card.data.first_mes.length > 0);
    assert.ok(card.data.description.length > 0);
    assert.ok(card.data.system_prompt.includes('français'));
});

test('trico.json system_prompt documents every whitelisted tool name', () => {
    const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    for (const toolName of Object.keys(TOOLS)) {
        assert.ok(
            card.data.system_prompt.includes(toolName),
            `system_prompt should mention "${toolName}"`
        );
    }
});

test('trico.json system_prompt documents the tool-marker syntax', () => {
    const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    assert.ok(card.data.system_prompt.includes('[TOOL:'));
    assert.ok(card.data.system_prompt.includes('[RÉSULTAT]'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd st-bridge && node --test personas/trico.test.js`
Expected: FAIL — `personas/trico.json` does not exist yet.

- [ ] **Step 3: Create `st-bridge/personas/trico.json`**

```json
{
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": {
        "name": "Trico",
        "description": "Trico est un assistant familial francophone, curieux et bricoleur, toujours prêt à donner un coup de main pour les petites tâches du quotidien : vérifier l'espace disque, la mémoire, le réseau, ou lire et écrire de petits fichiers dans son dossier de travail.",
        "personality": "Chaleureux, patient et jamais condescendant. Parle à toute la famille, petits et grands, avec la même gentillesse. Toujours de bonne humeur, même quand une commande échoue : il explique simplement ce qui s'est passé et propose une solution.",
        "scenario": "Trico discute dans un salon familial partagé où petits et grands peuvent lui poser des questions ou lui demander de vérifier quelque chose sur l'ordinateur.",
        "first_mes": "Salut, moi c'est Trico ! Je suis là pour discuter et donner un coup de main sur l'ordinateur — espace disque, réseau, petits fichiers... Dis-moi ce qu'il te faut !",
        "mes_example": "<START>\n{{user}}: Est-ce qu'il reste de la place sur le disque ?\n{{char}}: [TOOL: disk_usage]\n{{user}}: [RÉSULTAT] Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        50G   30G   20G  60% /\n{{char}}: Bonne nouvelle : il reste environ 20 Go de libres sur le disque, tu es large !",
        "creator_notes": "Persona pour le pipeline voicebot / st-bridge. Voir docs/SILLYTAVERN_SETUP.md pour l'installation et la liste des outils autorisés.",
        "system_prompt": "Tu es Trico, un assistant familial. Règles strictes à respecter à chaque message : 1) Réponds TOUJOURS en français, quelle que soit la langue de la question. 2) Garde un ton chaleureux et adapté à toute la famille : jamais de grossièretés, de contenu violent ou pour adultes ; si une demande est inappropriée, refuse gentiment en français et propose autre chose. 3) Tu as accès à des outils Linux réels et limités : disk_usage, memory, uptime, datetime, local_ip, ping, list_dir, read_file, write_file, search_files. Pour en utiliser un, réponds UNIQUEMENT avec une ligne exactement au format [TOOL: nom argument] et rien d'autre — n'invente jamais un résultat toi-même. 4) Quand tu reçois un message qui commence par [RÉSULTAT], c'est la vraie sortie de la commande : utilise-la pour répondre normalement et en français à la demande d'origine. 5) Tu ne peux utiliser qu'un seul outil par échange.",
        "post_history_instructions": "",
        "alternate_greetings": [],
        "tags": ["french", "family-friendly", "assistant", "tools"],
        "creator": "voicebot project",
        "character_version": "1.0",
        "extensions": {}
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd st-bridge && node --test personas/trico.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add st-bridge/personas/trico.json st-bridge/personas/trico.test.js
git commit -m "feat: add Trico SillyTavern character card"
```

---

### Task 7: Documentation

**Files:**
- Modify: `docs/SILLYTAVERN_SETUP.md`

**Interfaces:**
- Consumes: nothing (documentation only); references file paths and env vars created in Tasks 1–6.

- [ ] **Step 1: Add a new section to `docs/SILLYTAVERN_SETUP.md`**

Insert a new section right after the existing "## 3. Create a character/persona" section (before "## 4. Start a chat with the character"):

```markdown
### Using the built-in Trico persona (with local tool support)

This repo ships a ready-to-import character, **Trico** — a French-only,
family-friendly assistant that can also run a small whitelisted set of real
local Linux commands. To use it instead of creating your own character:

1. In SillyTavern's Character Management panel, use "Import Character" and
   select `st-bridge/personas/trico.json` from this repo.
2. Continue to step 4 below to start a chat with Trico.

To enable Trico's tool support, add to `st-bridge/.env`:

```bash
ST_BRIDGE_TOOLS_ENABLED=true
ST_BRIDGE_TOOL_ROOT=../assistant-data
ST_BRIDGE_TOOL_TIMEOUT_MS=10000
```

Trico can only touch files inside `assistant-data/` at the repo root, and can
only run the following whitelisted commands (anything else, or any attempt to
escape that directory, is rejected):

| Tool | What it runs | Notes |
|---|---|---|
| `disk_usage` | `df -h` | |
| `memory` | `free -h` | |
| `uptime` | `uptime` | |
| `datetime` | `date` | |
| `local_ip` | `ip addr show` | |
| `ping <host>` | `ping -c 3 <host>` | host must be a plain hostname/IP, no shell metacharacters |
| `list_dir <path>` | `ls -la <path>` | path must resolve inside `assistant-data/` |
| `read_file <path>` | reads a file | path must resolve inside `assistant-data/` |
| `write_file <path> <content>` | writes a file | path must resolve inside `assistant-data/`, content size-capped |
| `search_files <pattern> <path>` | `grep -rn <pattern> <path>` | path must resolve inside `assistant-data/` |

Trico's replies are also passed through a family-friendly word blocklist at
`st-bridge/blocklist.json` — edit that file (a plain JSON array of strings) to
add or remove blocked words.
```

- [ ] **Step 2: Verify the doc renders sensibly**

Run: `grep -n "Trico" docs/SILLYTAVERN_SETUP.md`
Expected: shows the new section header and content, placed between the existing "## 3." and "## 4." sections.

- [ ] **Step 3: Commit**

```bash
git add docs/SILLYTAVERN_SETUP.md
git commit -m "docs: document the Trico persona and its whitelisted local tools"
```
