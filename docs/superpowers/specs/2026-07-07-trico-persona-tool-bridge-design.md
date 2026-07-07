# Trico Persona + Tool-Calling Bridge — Design

## Goal

Ship a ready-to-import SillyTavern persona, **Trico**, for use in a family-friendly
chatroom: a warm, French-only assistant that can also run a small whitelisted set
of real local Linux tools (system info, network checks, and file read/write/search
inside a scoped scratch folder) — not just roleplay about doing them.

This is phase 1 of two. A local file-based calendar tool (read/write events) is
explicitly deferred to a follow-up spec that registers a new tool against the
infrastructure built here.

## Scope

- A character card (`st-bridge/personas/trico.json`) importable directly into
  SillyTavern.
- A marker-based tool-calling convention (`[TOOL: name arg1 arg2]`) that Trico's
  system prompt teaches it to use, and that `st-bridge` detects in ST replies.
- A tool-runner in `st-bridge` that validates and executes whitelisted commands,
  re-injects results into the SillyTavern chat, and returns Trico's final
  French-language reply to the Python pipeline — unchanged on the Python side.
- A scoped directory (`assistant-data/`) that is the only filesystem root the
  file-related tools can read from or write to, with hard path-escape protection.
- A code-level family-friendly keyword filter as defense-in-depth on top of the
  persona's own instructions.
- Test files for marker parsing, whitelist validation (including path-traversal
  rejection), and the blocklist filter.
- Out of scope (this phase): calendar read/write tool, chained/recursive tool
  calls (max one tool round-trip per user turn), per-sender tool permissions,
  any tool beyond the whitelist below, network exposure hardening beyond what's
  already documented for `st-bridge`/SillyTavern.

## Architecture

Builds on the existing SillyTavern persona route
([2026-07-06-sillytavern-persona-route-design.md](2026-07-06-sillytavern-persona-route-design.md)).
No changes to the Python pipeline — `st-bridge` still receives one message and
returns one final reply per request; the tool round-trip (if any) happens
entirely inside `st-bridge`, against the live SillyTavern chat.

```
Python pipeline → st-bridge ──1── send user message ──→ SillyTavern chat (Trico)
                            ←──2── reply ───────────────
                  [reply matches [TOOL: ...] marker?]
                            ──3── run whitelisted command locally
                            ──4── inject "[RÉSULTAT] ..." message ──→ SillyTavern chat
                            ←──5── Trico's real French reply ───────
                  ← final reply returned to Python pipeline
```

## Components

### 1. Character card — `st-bridge/personas/trico.json`

SillyTavern v2 character card spec (name, description, personality, scenario,
first message, example dialogue, system prompt). Key instructions baked into
the card:

- **Always reply in French**, regardless of the language used to address it —
  stated as a hard rule, not just a personality trait.
- **Family-friendly tone**: cheerful, patient, encouraging; no profanity or
  adult/violent content; gently declines and redirects inappropriate requests,
  in French.
- **Tool awareness**: explains Trico has access to a small set of real tools
  and must trigger them with `[TOOL: name arg1 arg2]` on its own line (nothing
  else in that message) rather than pretending to run something itself.
- Imported into SillyTavern via drag-and-drop / "Import Character" like any
  other character card — no new SillyTavern-side config needed beyond what
  `docs/SILLYTAVERN_SETUP.md` already documents.

### 2. Tool-runner — `st-bridge/tool-runner.js`

- Parses ST replies for the `[TOOL: name arg1 arg2]` marker (regex-based, one
  match per reply).
- Looks up `name` in the whitelist (`st-bridge/tools.js`); unknown tool or
  invalid args short-circuits to injecting a French error note
  (`[RÉSULTAT] Outil inconnu ou invalide.`) — never falls through to executing
  anything unvalidated.
- Executes via `child_process` with a **fixed argv array** (never a shell
  string), a timeout (`ST_BRIDGE_TOOL_TIMEOUT_MS`, default 10000ms), and output
  truncation (2000 chars) before re-injecting.
- Injects the result into the SillyTavern chat as `[RÉSULTAT] <output or
  error>`, reads Trico's next reply, and returns *that* as the final answer.
- Hard cap: **one tool round-trip per user turn** — the reply to a
  tool-result injection is never itself scanned for another marker.

### 3. Whitelist — `st-bridge/tools.js`

All entries validate arguments *before* executing; anything failing validation
routes to the tool-runner's French error note instead of running.

| Marker name | Command | Validation |
|---|---|---|
| `disk_usage` | `df -h` | no args |
| `memory` | `free -h` | no args |
| `uptime` | `uptime` | no args |
| `datetime` | `date` | no args |
| `list_dir` | `ls -la <resolved path>` | path must resolve inside `assistant-data/` |
| `ping` | `ping -c 3 <host>` | host matched against a strict hostname/IPv4 regex; no shell metacharacters accepted |
| `local_ip` | `ip addr show` | no args |
| `read_file` | reads file at `<resolved path>` | path resolves inside root; size-capped |
| `write_file` | writes file at `<resolved path>` | path resolves inside root; content size-capped |
| `search_files` | `grep -rn <pattern> <resolved root>` | pattern passed as a discrete argv element, never interpolated into a shell string |

**Path-escape protection** (shared helper used by every file/list/search tool):
resolve the requested path against the real, symlink-resolved
`assistant-data/` root and reject if the resolved path does not have that root
as a strict prefix — this rejects `..` traversal, absolute paths, and symlinks
that point outside the root, before any filesystem access happens.

### 4. Scoped directory — `assistant-data/`

New directory at the repo root, gitignored (with a `.gitkeep` so it exists in
checkouts), used as the sole root for `list_dir`/`read_file`/`write_file`/
`search_files`.

### 5. Family-friendly filter — `st-bridge/blocklist.json`

- Plain JSON array of disallowed words/phrases (French + English), loaded at
  startup, user-editable without touching code.
- Applied only to Trico's **final** reply (the one returned to the pipeline),
  not to intermediate tool-marker/result messages.
- On match: reply is replaced with a canned French redirect (e.g. *"Je ne peux
  pas répondre à ça, mais je suis là pour t'aider autrement !"*); the match
  (word + timestamp, not full message) is logged.
- Defense-in-depth on top of the persona's own instructions from component 1.

### 6. Config — `st-bridge/.env.example` additions

```bash
ST_BRIDGE_TOOLS_ENABLED=true
ST_BRIDGE_TOOL_ROOT=../assistant-data
ST_BRIDGE_TOOL_TIMEOUT_MS=10000
```

### 7. Docs — `docs/SILLYTAVERN_SETUP.md`

New section covering: importing `trico.json` as the character in step 3 of the
existing guide, enabling tools via the env vars above, the full whitelist
table, and where the blocklist file lives for editing.

## Testing

- `st-bridge/tool-runner.test.js` — marker parsing (valid/invalid/absent),
  one-round-trip cap, timeout handling, error-note injection on invalid/unknown
  tool calls.
- `st-bridge/tools.test.js` — per-tool arg/path validation; path-traversal
  rejection (`..`, absolute paths, symlink escape) for the file/list/search
  tools; host-format rejection for `ping`.
- `st-bridge/blocklist.test.js` — blocklist match replaces the reply verbatim;
  non-matching replies pass through untouched.
- All follow the existing `node --test` convention already used by
  `chat-client.test.js` / `server.test.js`.

## Follow-up (phase 2, separate spec)

Local file-based calendar read/write tool (e.g. a JSON or `.ics` file under
`assistant-data/`), registered as a new entry in the same whitelist mechanism
built here — no changes to the marker convention or tool-runner expected.
