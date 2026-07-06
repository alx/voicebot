import http from 'http';

/**
 * @param {(text: string) => Promise<string>} replyFn
 * @returns {import('http').Server}
 */
export function createServer(replyFn) {
    let busy = false;

    return http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }

        if (req.method !== 'POST' || req.url !== '/reply') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        if (busy) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Busy processing another request' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', async () => {
            busy = true;
            try {
                const parsed = JSON.parse(body || '{}');
                if (!parsed.text || typeof parsed.text !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing "text" field' }));
                    return;
                }

                const reply = await replyFn(parsed.text);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reply }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            } finally {
                busy = false;
            }
        });
    });
}
