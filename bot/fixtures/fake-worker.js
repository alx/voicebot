// Fake worker used by pipeline-client.test.js to exercise the persistent
// worker protocol (spawn, correlation, timeout, crash) without depending on
// a real Python environment. Reads JSON-line requests from stdin; behavior
// is driven by the request's `text` field so tests can trigger each case:
//   - text === "CRASH": exits immediately without responding
//   - text === "HANG": never responds
//   - anything else: echoes back `echo:<text>` as llm_response
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
    if (!line.trim()) return;
    const request = JSON.parse(line);

    if (request.text === 'CRASH') {
        process.exit(1);
    }
    if (request.text === 'HANG') {
        return;
    }

    const response = { id: request.id, success: true, llm_response: `echo:${request.text}`, timing: {} };
    process.stdout.write(JSON.stringify(response) + '\n');
});
