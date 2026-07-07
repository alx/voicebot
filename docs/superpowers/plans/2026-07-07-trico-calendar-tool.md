# Trico Calendar Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three whitelisted calendar tools (`add_event`, `list_events`, `remove_event`) to Trico's tool bridge, backed by a local `.ics` file, closing out the phase-2 follow-up from the persona/tool-bridge design.

**Architecture:** A new `st-bridge/calendar.js` module owns all read/modify/write logic against `assistant-data/calendar.ics`, using `node-ical` to parse and `ics` to regenerate the file on every mutation (read-modify-write-whole-file). `st-bridge/tools.js`'s `TOOLS` registry gets three new entries that delegate directly to this module's exported functions — no changes needed to `tool-runner.js`, `config.js`, or `index.js`, since they already gate every registered tool through `ST_BRIDGE_TOOLS_ENABLED`, the one-tool-per-turn cap, and the blocklist filter. One small prerequisite refactor (Task 1) extracts `ToolError` into its own module so `tools.js` and `calendar.js` can both depend on it without a circular import.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert/strict`, `node-ical` (parsing), `ics` (generation), both installed via `npm install` in Task 2.

## Global Constraints

- Events stored as iCalendar `VEVENT`s in `assistant-data/calendar.ics`, inside the existing `TOOL_ROOT` scope (`config.root` — no new env var).
- **Local floating time** — no timezone offset/`Z` suffix on stored times.
- `date` format `YYYY-MM-DD`, must be a real calendar date; `time` format `HH:MM` 24-hour (hours 00-23, minutes 00-59); `title` non-empty, ≤ 200 characters.
- `list_events` filter argument is exactly one of `today` | `week` | `all`; `week` = today through +6 days inclusive; results sorted chronologically by date then time.
- `remove_event` matches on the first 8 characters of an event's UUID; no match → `ToolError`.
- Every validation failure throws `ToolError` (never a raw `Error`), so the existing tool-runner error-note injection handles it automatically.
- No changes to `tool-runner.js`, `config.js`, `index.js`, or any Python file — feature is additive within `st-bridge`.
- `trico.json`'s `system_prompt` must document every tool name in `tools.js`'s `TOOLS` registry (already enforced by the existing `trico.test.js`).

---

### Task 1: Extract `ToolError` to avoid a circular import

**Files:**
- Create: `st-bridge/tool-error.js`
- Modify: `st-bridge/tools.js:1-5`

**Interfaces:**
- Produces: `export class ToolError extends Error {}` from `st-bridge/tool-error.js`, re-exported unchanged from `st-bridge/tools.js` so every existing consumer (`tool-runner.js`, `tools.test.js`, `tool-runner.test.js`) keeps working without modification. Consumed directly by Task 2's `calendar.js`.

- [ ] **Step 1: Create `st-bridge/tool-error.js`**

```javascript
export class ToolError extends Error {}
```

- [ ] **Step 2: Update `st-bridge/tools.js` to re-export it**

In `st-bridge/tools.js`, replace:

```javascript
export class ToolError extends Error {}
```

with:

```javascript
export { ToolError } from './tool-error.js';
```

- [ ] **Step 3: Run the full test suite to confirm nothing broke**

Run: `cd st-bridge && node --test`
Expected: PASS — all 36 existing tests still pass (`ToolError` is now defined in `tool-error.js` but every existing `import { ToolError } from './tools.js'` still resolves via the re-export).

- [ ] **Step 4: Commit**

```bash
git add st-bridge/tool-error.js st-bridge/tools.js
git commit -m "refactor: extract ToolError into its own module to avoid a future circular import"
```

---

### Task 2: Calendar module (`add_event` / `list_events` / `remove_event` logic)

**Files:**
- Create: `st-bridge/calendar.js`
- Test: `st-bridge/calendar.test.js`
- Modify: `st-bridge/package.json` (via `npm install`)

**Interfaces:**
- Consumes: `ToolError` from `st-bridge/tool-error.js` (Task 1).
- Produces:
  - `export async function addEvent(args: string[], config: { root: string }): Promise<string>`
  - `export async function listEvents(args: string[], config: { root: string }): Promise<string>`
  - `export async function removeEvent(args: string[], config: { root: string }): Promise<string>`
  - Signature order `(args, config)` matches the `(args, config, timeoutMs)` shape `runTool` already calls every whitelisted tool with, so Task 3 can register these directly with no wrapper.

- [ ] **Step 1: Install the two new dependencies**

```bash
cd st-bridge && npm install ics node-ical
```

Expected: `st-bridge/package.json` gains `"ics"` and `"node-ical"` under `dependencies`; `package-lock.json` updates.

- [ ] **Step 2: Write the failing tests**

Create `st-bridge/calendar.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { addEvent, listEvents, removeEvent } from './calendar.js';

async function makeTempRoot() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'trico-calendar-'));
}

function dateOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

test('addEvent creates calendar.ics on first call', async () => {
    const root = await makeTempRoot();
    const result = await addEvent(['2026-07-10', '14:00', 'Rendez-vous', 'dentiste'], { root });
    assert.equal(result, 'Événement ajouté : Rendez-vous dentiste (2026-07-10 14:00)');
    const exists = await fs.access(path.join(root, 'calendar.ics')).then(() => true, () => false);
    assert.ok(exists);
});

test('addEvent appends to an existing calendar.ics', async () => {
    const root = await makeTempRoot();
    await addEvent(['2026-07-10', '14:00', 'Premier'], { root });
    await addEvent(['2026-07-11', '09:00', 'Second'], { root });
    const listing = await listEvents(['all'], { root });
    assert.match(listing, /Premier/);
    assert.match(listing, /Second/);
});

test('addEvent rejects a malformed date', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        addEvent(['2026-13-40', '14:00', 'Titre'], { root }),
        /Date invalide/
    );
});

test('addEvent rejects a malformed time', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        addEvent(['2026-07-10', '25:99', 'Titre'], { root }),
        /Heure invalide/
    );
});

test('addEvent rejects an empty title', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        addEvent(['2026-07-10', '14:00'], { root }),
        /titre/
    );
});

test('listEvents rejects an invalid filter', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        listEvents(['bogus'], { root }),
        /Filtre invalide/
    );
});

test('listEvents returns a friendly message when there are no events', async () => {
    const root = await makeTempRoot();
    const result = await listEvents(['all'], { root });
    assert.equal(result, 'Aucun événement trouvé.');
});

test('listEvents "today" only returns events dated today', async () => {
    const root = await makeTempRoot();
    await addEvent([dateOffset(0), '09:00', 'Aujourd\'hui'], { root });
    await addEvent([dateOffset(3), '09:00', 'Dans trois jours'], { root });

    const result = await listEvents(['today'], { root });
    assert.match(result, /Aujourd'hui/);
    assert.doesNotMatch(result, /Dans trois jours/);
});

test('listEvents "week" includes today through +6 days but not beyond', async () => {
    const root = await makeTempRoot();
    await addEvent([dateOffset(0), '09:00', 'Aujourd\'hui'], { root });
    await addEvent([dateOffset(6), '09:00', 'Dans six jours'], { root });
    await addEvent([dateOffset(10), '09:00', 'Dans dix jours'], { root });

    const result = await listEvents(['week'], { root });
    assert.match(result, /Aujourd'hui/);
    assert.match(result, /Dans six jours/);
    assert.doesNotMatch(result, /Dans dix jours/);
});

test('listEvents sorts results chronologically', async () => {
    const root = await makeTempRoot();
    await addEvent([dateOffset(2), '09:00', 'Second'], { root });
    await addEvent([dateOffset(1), '09:00', 'Premier'], { root });

    const result = await listEvents(['all'], { root });
    assert.ok(result.indexOf('Premier') < result.indexOf('Second'));
});

test('removeEvent rejects an unknown id', async () => {
    const root = await makeTempRoot();
    await addEvent(['2026-07-10', '14:00', 'Titre'], { root });
    await assert.rejects(
        removeEvent(['deadbeef'], { root }),
        /Aucun événement avec cet identifiant/
    );
});

test('round-trip: add two events, remove one by its listed id, confirm only the other remains', async () => {
    const root = await makeTempRoot();
    await addEvent([dateOffset(1), '09:00', 'Garder'], { root });
    await addEvent([dateOffset(2), '10:00', 'Supprimer'], { root });

    const before = await listEvents(['all'], { root });
    const idMatch = before.match(/\[([0-9a-f]{8})\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} Supprimer/);
    assert.ok(idMatch, `expected to find an id for "Supprimer" in:\n${before}`);

    const removeResult = await removeEvent([idMatch[1]], { root });
    assert.match(removeResult, /Événement supprimé : Supprimer/);

    const after = await listEvents(['all'], { root });
    assert.match(after, /Garder/);
    assert.doesNotMatch(after, /Supprimer/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd st-bridge && node --test calendar.test.js`
Expected: FAIL — `calendar.js` does not exist yet.

- [ ] **Step 4: Implement `st-bridge/calendar.js`**

```javascript
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import ical from 'node-ical';
import { createEvents } from 'ics';
import { ToolError } from './tool-error.js';

const CALENDAR_FILENAME = 'calendar.ics';
const MAX_TITLE_LENGTH = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function calendarPath(root) {
    return path.join(root, CALENDAR_FILENAME);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatTime(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

async function readEvents(root) {
    let raw;
    try {
        raw = await fs.readFile(calendarPath(root), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    const parsed = ical.sync.parseICS(raw);
    return Object.values(parsed)
        .filter((item) => item.type === 'VEVENT')
        .map((item) => ({
            id: item.uid,
            date: formatDate(item.start),
            time: formatTime(item.start),
            title: item.summary,
        }));
}

async function writeEvents(root, events) {
    const icsEvents = events.map((event) => {
        const [year, month, day] = event.date.split('-').map(Number);
        const [hour, minute] = event.time.split(':').map(Number);
        return {
            uid: event.id,
            title: event.title,
            start: [year, month, day, hour, minute],
            startInputType: 'local',
            startOutputType: 'local',
            duration: { minutes: 30 },
        };
    });

    const { error, value } = createEvents(icsEvents, { productId: 'trico/calendar' });
    if (error) {
        throw new ToolError(`Impossible d'écrire le calendrier : ${error.message}`);
    }
    await fs.writeFile(calendarPath(root), value, 'utf8');
}

function validateDate(date) {
    if (!date || !DATE_RE.test(date)) {
        throw new ToolError(`Date invalide (attendu AAAA-MM-JJ) : ${date ?? '(manquante)'}`);
    }
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
        throw new ToolError(`Date invalide : ${date}`);
    }
    return date;
}

function validateTime(time) {
    if (!time || !TIME_RE.test(time)) {
        throw new ToolError(`Heure invalide (attendu HH:MM) : ${time ?? '(manquante)'}`);
    }
    return time;
}

function validateTitle(title) {
    if (!title || title.length === 0) {
        throw new ToolError('Le titre est obligatoire');
    }
    if (title.length > MAX_TITLE_LENGTH) {
        throw new ToolError(`Titre trop long (max ${MAX_TITLE_LENGTH} caractères)`);
    }
    return title;
}

export async function addEvent(args, config) {
    const [date, time, ...titleParts] = args;
    validateDate(date);
    validateTime(time);
    const title = validateTitle(titleParts.join(' '));

    const events = await readEvents(config.root);
    events.push({ id: crypto.randomUUID(), date, time, title });
    await writeEvents(config.root, events);

    return `Événement ajouté : ${title} (${date} ${time})`;
}

export async function listEvents(args, config) {
    const [filter] = args;
    if (!['today', 'week', 'all'].includes(filter)) {
        throw new ToolError(`Filtre invalide (attendu today, week ou all) : ${filter ?? '(manquant)'}`);
    }

    const events = await readEvents(config.root);
    const today = formatDate(new Date());
    const weekEnd = formatDate(new Date(Date.now() + 6 * DAY_MS));

    const filtered = events.filter((event) => {
        if (filter === 'all') return true;
        if (filter === 'today') return event.date === today;
        return event.date >= today && event.date <= weekEnd;
    });

    filtered.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    if (filtered.length === 0) {
        return 'Aucun événement trouvé.';
    }

    return filtered
        .map((event) => `[${event.id.slice(0, 8)}] ${event.date} ${event.time} ${event.title}`)
        .join('\n');
}

export async function removeEvent(args, config) {
    const [id8] = args;
    if (!id8) {
        throw new ToolError('Identifiant manquant');
    }

    const events = await readEvents(config.root);
    const index = events.findIndex((event) => event.id.startsWith(id8));
    if (index === -1) {
        throw new ToolError('Aucun événement avec cet identifiant.');
    }

    const [removed] = events.splice(index, 1);
    await writeEvents(config.root, events);

    return `Événement supprimé : ${removed.title} (${removed.date} ${removed.time})`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd st-bridge && node --test calendar.test.js`
Expected: PASS — all tests green.

- [ ] **Step 6: Run the full suite once**

Run: `cd st-bridge && node --test`
Expected: PASS — all existing tests plus the new `calendar.test.js` tests.

- [ ] **Step 7: Commit**

```bash
git add st-bridge/package.json st-bridge/package-lock.json st-bridge/calendar.js st-bridge/calendar.test.js
git commit -m "feat: add local .ics-backed calendar module (add/list/remove events)"
```

---

### Task 3: Register the calendar tools in the whitelist

**Files:**
- Modify: `st-bridge/tools.js`
- Test: `st-bridge/tools.test.js`

**Interfaces:**
- Consumes: `addEvent`, `listEvents`, `removeEvent` from `st-bridge/calendar.js` (Task 2).
- Produces: `TOOLS.add_event`, `TOOLS.list_events`, `TOOLS.remove_event` — reachable via `runTool('add_event', args, config, timeoutMs)` etc., exactly like every other whitelisted tool. Consumed by Task 4's persona-card test (`trico.test.js`, unchanged, already iterates `Object.keys(TOOLS)`).

- [ ] **Step 1: Write the failing tests**

`st-bridge/tools.test.js` already imports `runTool`, `fs/promises`, `os`, and `path` at the top of the file (from the original tool-bridge plan). Append the following helper and test cases to the end of `st-bridge/tools.test.js`, reusing those existing imports — do not add duplicate imports:

```javascript
async function makeCalendarRoot() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'trico-tools-calendar-'));
}

test('runTool dispatches add_event to the calendar module', async () => {
    const root = await makeCalendarRoot();
    const result = await runTool('add_event', ['2026-07-10', '14:00', 'Dentiste'], { root }, 5000);
    assert.match(result, /Événement ajouté : Dentiste/);
});

test('runTool dispatches list_events to the calendar module', async () => {
    const root = await makeCalendarRoot();
    await runTool('add_event', ['2026-07-10', '14:00', 'Dentiste'], { root }, 5000);
    const result = await runTool('list_events', ['all'], { root }, 5000);
    assert.match(result, /Dentiste/);
});

test('runTool dispatches remove_event to the calendar module', async () => {
    const root = await makeCalendarRoot();
    await runTool('add_event', ['2026-07-10', '14:00', 'Dentiste'], { root }, 5000);
    const listing = await runTool('list_events', ['all'], { root }, 5000);
    const idMatch = listing.match(/\[([0-9a-f]{8})\]/);
    const result = await runTool('remove_event', [idMatch[1]], { root }, 5000);
    assert.match(result, /Événement supprimé : Dentiste/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd st-bridge && node --test tools.test.js`
Expected: FAIL — `runTool('add_event', ...)` rejects with `Unknown tool: add_event`.

- [ ] **Step 3: Register the tools in `st-bridge/tools.js`**

Add the import near the top of `st-bridge/tools.js` (alongside the existing `child_process`/`fs`/`path` imports):

```javascript
import { addEvent, listEvents, removeEvent } from './calendar.js';
```

Add three entries to the `TOOLS` object in `st-bridge/tools.js`, after the existing `search_files` entry and before the closing `};`:

```javascript

    add_event: addEvent,
    list_events: listEvents,
    remove_event: removeEvent,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd st-bridge && node --test tools.test.js`
Expected: PASS — all tests green, including the three new dispatch tests.

- [ ] **Step 5: Run the full suite once**

Run: `cd st-bridge && node --test`
Expected: PASS — full suite green.

- [ ] **Step 6: Commit**

```bash
git add st-bridge/tools.js st-bridge/tools.test.js
git commit -m "feat: register calendar tools in the st-bridge tool whitelist"
```

---

### Task 4: Update the Trico persona card

**Files:**
- Modify: `st-bridge/personas/trico.json`

**Interfaces:**
- Consumes: `TOOLS` from `st-bridge/tools.js` (Task 3) — indirectly, via the existing `st-bridge/personas/trico.test.js` (unchanged), which iterates `Object.keys(TOOLS)` and asserts each name appears in `system_prompt`. This task's own verification is that existing test.

- [ ] **Step 1: Confirm the existing persona test currently fails against the updated whitelist**

Run: `cd st-bridge && node --test personas/trico.test.js`
Expected: FAIL — `trico.test.js`'s "documents every whitelisted tool name" test now fails because `system_prompt` doesn't yet mention `add_event`, `list_events`, or `remove_event` (added to `TOOLS` in Task 3).

- [ ] **Step 2: Update `st-bridge/personas/trico.json`**

In `st-bridge/personas/trico.json`, replace the `system_prompt` value:

```json
"Tu es Trico, un assistant familial. Règles strictes à respecter à chaque message : 1) Réponds TOUJOURS en français, quelle que soit la langue de la question. 2) Garde un ton chaleureux et adapté à toute la famille : jamais de grossièretés, de contenu violent ou pour adultes ; si une demande est inappropriée, refuse gentiment en français et propose autre chose. 3) Tu as accès à des outils Linux réels et limités : disk_usage, memory, uptime, datetime, local_ip, ping, list_dir, read_file, write_file, search_files, add_event, list_events, remove_event. Pour en utiliser un, réponds UNIQUEMENT avec une ligne exactement au format [TOOL: nom argument] et rien d'autre — n'invente jamais un résultat toi-même. 4) Quand tu reçois un message qui commence par [RÉSULTAT], c'est la vraie sortie de la commande : utilise-la pour répondre normalement et en français à la demande d'origine. 5) Tu ne peux utiliser qu'un seul outil par échange. 6) Pour le calendrier : add_event attend une date (AAAA-MM-JJ), une heure (HH:MM) puis un titre, par exemple [TOOL: add_event 2026-07-10 14:00 Rendez-vous dentiste] ; list_events attend today, week ou all, par exemple [TOOL: list_events week] ; remove_event attend l'identifiant affiché par list_events, par exemple [TOOL: remove_event a1b2c3d4]."
```

Replace the `mes_example` value (extends the existing disk_usage example with a calendar round-trip):

```json
"mes_example": "<START>\n{{user}}: Est-ce qu'il reste de la place sur le disque ?\n{{char}}: [TOOL: disk_usage]\n{{user}}: [RÉSULTAT] Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        50G   30G   20G  60% /\n{{char}}: Bonne nouvelle : il reste environ 20 Go de libres sur le disque, tu es large !\n<START>\n{{user}}: Ajoute un rendez-vous dentiste le 10 juillet 2026 à 14h.\n{{char}}: [TOOL: add_event 2026-07-10 14:00 Rendez-vous dentiste]\n{{user}}: [RÉSULTAT] Événement ajouté : Rendez-vous dentiste (2026-07-10 14:00)\n{{char}}: C'est noté ! Ton rendez-vous dentiste est ajouté pour le 10 juillet à 14h."
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd st-bridge && node --test personas/trico.test.js`
Expected: PASS — `system_prompt` now mentions every `TOOLS` key.

- [ ] **Step 4: Run the full suite once**

Run: `cd st-bridge && node --test`
Expected: PASS — full suite green (should now be 36 + 3 + 3 = 42 or more tests, exact count not load-bearing, just confirm 0 failures).

- [ ] **Step 5: Commit**

```bash
git add st-bridge/personas/trico.json
git commit -m "feat: document calendar tools in the Trico persona card"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/SILLYTAVERN_SETUP.md`

**Interfaces:**
- Consumes: nothing (documentation only); references the tool names and syntax finalized in Tasks 2-4.

- [ ] **Step 1: Add three rows to the whitelist table**

In `docs/SILLYTAVERN_SETUP.md`, in the "Using the built-in Trico persona" section's whitelist table (added by the original persona/tool-bridge plan), add three rows after the existing `search_files` row:

```markdown
| `add_event <date> <heure> <titre>` | ajoute un événement | date `AAAA-MM-JJ`, heure `HH:MM`, titre non vide (≤ 200 caractères) ; stocké dans `assistant-data/calendar.ics` |
| `list_events <today\|week\|all>` | liste les événements | `today` = aujourd'hui, `week` = les 7 prochains jours, `all` = tout, triés par date |
| `remove_event <id>` | supprime un événement | `id` = les 8 premiers caractères affichés par `list_events` |
```

- [ ] **Step 2: Verify the doc renders sensibly**

Run: `grep -n "add_event\|list_events\|remove_event" docs/SILLYTAVERN_SETUP.md`
Expected: shows the three new table rows inside the existing whitelist table.

- [ ] **Step 3: Commit**

```bash
git add docs/SILLYTAVERN_SETUP.md
git commit -m "docs: document the calendar tools in the SillyTavern setup guide"
```
