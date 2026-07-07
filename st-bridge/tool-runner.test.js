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
