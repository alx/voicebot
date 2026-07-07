# Trico Calendar Tool — Design

## Goal

Add a local, file-based calendar to Trico's whitelisted tool set — `add_event`,
`list_events`, `remove_event` — so the family can ask Trico to track
appointments and events, without any external account or cloud service. This
is the phase-2 follow-up explicitly deferred by
[2026-07-07-trico-persona-tool-bridge-design.md](2026-07-07-trico-persona-tool-bridge-design.md),
registered against the tool-calling bridge built there (`tools.js` /
`tool-runner.js` / the `[TOOL: ...]` marker convention).

## Scope

- Three new tools registered in `st-bridge/tools.js`'s `TOOLS` whitelist:
  `add_event`, `list_events`, `remove_event`.
- A new module, `st-bridge/calendar.js`, holding all calendar read/write logic
  (kept separate from `tools.js` so that file stays a pure whitelist
  registry, per the existing file-structure convention).
- Events stored as standard iCalendar `VEVENT`s in a single file,
  `assistant-data/calendar.ics`, inside the existing `TOOL_ROOT` scope — no
  new env var or config field needed.
- Two new npm dependencies in `st-bridge/package.json`: `node-ical` (parsing)
  and `ics` (generation).
- Updates to `st-bridge/personas/trico.json` (new tool names + syntax in
  `system_prompt`, an example round-trip in `mes_example`) and
  `docs/SILLYTAVERN_SETUP.md` (whitelist table).
- Tests for all three tools plus a round-trip scenario, in
  `st-bridge/calendar.test.js`.
- Out of scope: recurring events, reminders/notifications, multi-timezone
  support, editing an existing event in place (delete + re-add covers this),
  per-user/per-sender calendars, any UI beyond the `[TOOL: ...]` marker
  convention already established.

## Data model and storage

Each event has:
- `id` — a `crypto.randomUUID()`, stored as the `VEVENT`'s `UID`.
- `date` — `YYYY-MM-DD`.
- `time` — `HH:MM`, 24-hour.
- `title` — free text, stored as `SUMMARY`, capped at 200 characters.

Stored using **local floating time** (no timezone offset or `Z` suffix) —
this is a single-household calendar, not a multi-timezone one, so wall-clock
time as entered is treated as authoritative.

The file lives at `assistant-data/calendar.ics` (i.e.
`path.join(config.root, 'calendar.ics')`, where `config.root` is the same
`TOOL_ROOT` already passed to every tool). It is created on the first
`add_event` call if it doesn't exist yet.

**Read-modify-write-whole-file**: every mutation (`add_event`,
`remove_event`) parses the existing file with `node-ical` into an in-memory
array of events, applies the change, and regenerates the entire file with
`ics`. This is simple and sufficiently fast at household scale (a handful to
a few hundred events) — no incremental/streaming update logic is needed.

## Tool interfaces

All three follow the same whitelist pattern as the existing 10 tools in
`tools.js`: registered in `TOOLS`, receiving `(args, config, timeoutMs)`,
throwing `ToolError` (from `tools.js`) on any validation failure so the
existing tool-runner error-note injection handles it automatically. None of
them shell out (no `execFile` involved) — they're pure `fs` + library calls
via `calendar.js`.

### `add_event <date> <time> <title...>`

Example: `[TOOL: add_event 2026-07-10 14:00 Rendez-vous dentiste]`

Validation (in order, first failure wins):
- `date` matches `^\d{4}-\d{2}-\d{2}$` and is a real calendar date (e.g.
  `2026-02-30` is rejected).
- `time` matches `^\d{2}:\d{2}$` with hours `00`-`23` and minutes `00`-`59`.
- `title` (remaining args, space-joined) is non-empty and ≤ 200 characters.

On success: appends the new event to the parsed list, regenerates the file,
returns `Événement ajouté : <title> (<date> <time>)`.

### `list_events <today|week|all>`

Example: `[TOOL: list_events week]`

- `today` — events whose `date` equals the current date.
- `week` — events whose `date` falls within today through +6 days inclusive.
- `all` — every event.
- Any other argument (or missing argument) → `ToolError`.

Results are sorted chronologically by `date` then `time`. Output is one line
per event: `[<id8>] <date> <time> <title>`, where `<id8>` is the first 8
characters of the event's UUID. If there are no matching events, returns the
French message `Aucun événement trouvé.` rather than an empty string.

### `remove_event <id8>`

Example: `[TOOL: remove_event a1b2c3d4]`

- `<id8>` is matched against the first 8 characters of each stored event's
  UUID. No match → `ToolError` (`Aucun événement avec cet identifiant.`).
- On success: removes that event from the parsed list, regenerates the file,
  returns `Événement supprimé : <title> (<date> <time>)`.

## Integration with existing bridge

No changes needed to `tool-runner.js`, `config.js`, or `index.js` — these
three tools slot into the existing `TOOLS` registry exactly like the phase-1
tools, so they automatically inherit: the `ST_BRIDGE_TOOLS_ENABLED` gate, the
one-tool-per-turn cap, output truncation/error-note injection in
`tool-runner.js`, and the family-friendly blocklist filter on Trico's final
reply.

`st-bridge/personas/trico.json`'s `system_prompt` gains the three tool names
and their argument syntax, following the same style as the existing 10 tools,
plus one example in `mes_example` showing an `add_event` → `[RÉSULTAT]` round
trip. The existing `trico.test.js` (which asserts every `TOOLS` key appears
in `system_prompt`) enforces this stays in sync automatically — if a future
change to `tools.js` isn't reflected in the persona card, that test fails.

`docs/SILLYTAVERN_SETUP.md`'s whitelist table gains three rows.

## Testing

`st-bridge/calendar.test.js`, using real temp directories (matching the
project's existing testing style — no mocked `fs`):

- `add_event` creates `calendar.ics` on first call; a second call appends
  rather than overwriting; rejects malformed date, malformed time, and empty
  title with `ToolError`.
- `list_events` correctly filters `today`, `week`, and `all`, sorted
  chronologically; an empty calendar returns the friendly no-events message;
  an invalid filter argument throws `ToolError`.
- `remove_event` deletes the matching event and leaves others intact; an
  unknown id throws `ToolError`.
- Round-trip test: add two events, list them (`all`), remove one by its
  listed 8-char id, list again and confirm only the other remains.

## Follow-up

None planned beyond this — phase 2 completes the tool whitelist scoped in
the original design spec.
