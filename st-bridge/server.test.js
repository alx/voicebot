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
            const first = postJson(port, '/reply', { text: 'one' });
            await new Promise((resolve) => setTimeout(resolve, 20));
            const second = await postJson(port, '/reply', { text: 'two' });
            assert.equal(second.status, 409);
            release();
            const firstResult = await first;
            assert.equal(firstResult.status, 200);
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
