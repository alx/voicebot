import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWorkerClient } from './pipeline-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fake-worker.js');

function makeTestClient(timeoutMs = 1000) {
    return createWorkerClient({
        command: process.execPath,
        args: [FIXTURE_PATH],
        timeoutMs
    });
}

test('round-trips a normal text request through the worker protocol', async () => {
    const client = makeTestClient();
    try {
        const result = await client.runText('bonjour');
        assert.equal(result.llm_response, 'echo:bonjour');
    } finally {
        client.close();
    }
});

test('rejects the pending request when the worker crashes, then respawns for the next request', async () => {
    const client = makeTestClient();
    try {
        await assert.rejects(client.runText('CRASH'), /Python worker exited/);

        const result = await client.runText('salut');
        assert.equal(result.llm_response, 'echo:salut');
    } finally {
        client.close();
    }
});

test('rejects with a timeout and kills the worker when it hangs, then respawns for the next request', async () => {
    const client = makeTestClient(200);
    try {
        await assert.rejects(client.runText('HANG'), /timed out after 200ms/);

        const result = await client.runText('salut');
        assert.equal(result.llm_response, 'echo:salut');
    } finally {
        client.close();
    }
});
