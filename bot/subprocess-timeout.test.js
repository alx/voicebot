import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithTimeout } from './subprocess-timeout.js';

test('resolves with stdout when the process exits quickly', async () => {
    const result = await runWithTimeout(process.execPath, ['-e', 'console.log("hello")'], {}, 5000);
    assert.equal(result.stdout.trim(), 'hello');
});

test('rejects when the process exceeds the timeout, and kills it', async () => {
    await assert.rejects(
        runWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], {}, 200),
        /timed out/
    );
});

test('rejects when the process exits non-zero', async () => {
    await assert.rejects(
        runWithTimeout(process.execPath, ['-e', 'process.exit(1)'], {}, 5000),
        /exited with code 1/
    );
});

test('streams stderr via the onStderr callback', async () => {
    const chunks = [];
    await runWithTimeout(
        process.execPath,
        ['-e', 'process.stderr.write("warn text")'],
        {},
        5000,
        { onStderr: (text) => chunks.push(text) }
    );
    assert.ok(chunks.join('').includes('warn text'));
});
