import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createServer } from './server.js';

function postJson(port, path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(
            {
                port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
            }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function getJson(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ port, path }, (res) => {
            let raw = '';
            res.on('data', (chunk) => {
                raw += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }).on('error', reject);
    });
}

function withServer(replyFn, fn) {
    return new Promise((resolve, reject) => {
        const server = createServer(replyFn);
        server.listen(0, async () => {
            try {
                await fn(server.address().port);
                resolve();
            } catch (error) {
                reject(error);
            } finally {
                server.close();
            }
        });
    });
}

test('POST /reply returns the reply from replyFn', async () => {
    await withServer(
        async (text) => `echo: ${text}`,
        async (port) => {
            const { status, body } = await postJson(port, '/reply', { text: 'hi' });
            assert.equal(status, 200);
            assert.deepEqual(body, { reply: 'echo: hi' });
        }
    );
});

test('POST /reply with missing text returns 400', async () => {
    await withServer(
        async () => 'unused',
        async (port) => {
            const { status, body } = await postJson(port, '/reply', {});
            assert.equal(status, 400);
            assert.equal(body.error, 'Missing "text" field');
        }
    );
});

test('POST /reply while busy returns 409', async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });

    await withServer(
        async (text) => {
            await gate;
            return `echo: ${text}`;
        },
        async (port) => {
            // Fire both requests back-to-back with no delay between them, so their
            // bodies are still streaming/arriving concurrently. The busy guard must
            // still serialize them correctly regardless of body-transmission timing
            // or which of the two connections happens to be accepted first.
            const first = postJson(port, '/reply', { text: 'one' });
            const second = postJson(port, '/reply', { text: 'two' });

            // Whichever request is rejected as busy resolves immediately (it never
            // touches replyFn/the gate); the accepted one stays pending until we
            // release the gate below. Race them to find the immediate 409 without
            // assuming which one arrived "first".
            const quick = await Promise.race([first, second]);
            assert.equal(quick.status, 409);

            release();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            const statuses = [firstResult.status, secondResult.status].sort();
            assert.deepEqual(statuses, [200, 409]);
        }
    );
});

test('GET /health returns ok', async () => {
    await withServer(
        async () => 'unused',
        async (port) => {
            const result = await getJson(port, '/health');
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, { status: 'ok' });
        }
    );
});
