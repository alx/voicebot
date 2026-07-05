import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from './queue.js';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('runs tasks sequentially, not concurrently', async () => {
    const queue = createQueue();
    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    function makeTask(id, ms) {
        return async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await delay(ms);
            order.push(id);
            concurrent--;
        };
    }

    await Promise.all([
        queue.enqueue(makeTask('a', 30)),
        queue.enqueue(makeTask('b', 10)),
        queue.enqueue(makeTask('c', 20)),
    ]);

    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(maxConcurrent, 1);
});

test('a failing task does not block later tasks', async () => {
    const queue = createQueue();
    const results = [];

    const first = queue.enqueue(async () => {
        throw new Error('boom');
    });
    const second = queue.enqueue(async () => {
        results.push('ran');
        return 'ok';
    });

    await assert.rejects(first, /boom/);
    assert.equal(await second, 'ok');
    assert.deepEqual(results, ['ran']);
});
