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
