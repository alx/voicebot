import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { addEvent, listEvents, removeEvent } from './calendar.js';
import { ToolError } from './tool-error.js';

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

test('listEvents throws ToolError (not a bare Error) when calendar.ics is corrupted', async () => {
    const root = await makeTempRoot();
    const corrupted = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:corrupt-1',
        'DTSTART:20260101T000000Z',
        'RRULE:FREQ=DAILY;UNTIL=badvalue',
        'END:VEVENT',
        'END:VCALENDAR',
    ].join('\n');
    await fs.writeFile(path.join(root, 'calendar.ics'), corrupted, 'utf8');

    await assert.rejects(
        listEvents(['all'], { root }),
        ToolError
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
