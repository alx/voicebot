import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import config from './config.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KILL_GRACE_MS = 500;

function killWorker(state) {
    try {
        state.process.kill('SIGTERM');
    } catch {
        return;
    }
    const forceKillTimer = setTimeout(() => {
        try {
            state.process.kill('SIGKILL');
        } catch {
            // already exited
        }
    }, KILL_GRACE_MS);
    state.process.once('exit', () => clearTimeout(forceKillTimer));
}

function rejectAllPending(state, error) {
    for (const pending of state.pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    state.pendingRequests.clear();
}

function handleWorkerLine(state, line) {
    let response;
    try {
        response = JSON.parse(line);
    } catch (parseError) {
        console.error('[worker] Failed to parse response line:', line);
        return;
    }

    const pending = state.pendingRequests.get(response.id);
    if (!pending) {
        console.error('[worker] Received response for unknown request id:', response.id);
        return;
    }

    state.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);

    if (response.success === false) {
        pending.reject(new Error(response.error));
        return;
    }

    const { id, success, error, error_type, ...result } = response;
    pending.resolve(result);
}

/**
 * Create an isolated client for the persistent Python worker protocol. The
 * production client (below) is one instance of this; tests create their own
 * instances pointed at a fake worker script so they don't share process
 * state with each other or with production code.
 * @param {{ command?: string, args?: string[], cwd?: string, timeoutMs?: number }} [options]
 */
export function createWorkerClient(options = {}) {
    const command = options.command ?? config.PYTHON_CMD;
    const args = options.args ?? ['-m', 'src.worker'];
    const cwd = options.cwd ?? REPO_ROOT;
    const timeoutMs = options.timeoutMs ?? config.PIPELINE_TIMEOUT_MS;

    let worker = null;

    function getWorker() {
        if (worker) return worker;

        const child = spawn(command, args, { cwd });
        const state = {
            process: child,
            pendingRequests: new Map(),
            nextId: 1,
            buffer: ''
        };

        child.stdin.on('error', (err) => {
            console.error('[worker] stdin error:', err.message);
        });

        child.stdout.on('data', (chunk) => {
            state.buffer += chunk.toString();
            let newlineIndex;
            while ((newlineIndex = state.buffer.indexOf('\n')) !== -1) {
                const line = state.buffer.slice(0, newlineIndex);
                state.buffer = state.buffer.slice(newlineIndex + 1);
                if (line.trim().length > 0) {
                    handleWorkerLine(state, line);
                }
            }
        });

        child.stderr.on('data', (chunk) => {
            console.error('[worker stderr]:', chunk.toString().trim());
        });

        child.on('exit', (code, signal) => {
            rejectAllPending(state, new Error(`Python worker exited (code=${code}, signal=${signal})`));
            if (worker === state) {
                worker = null;
            }
        });

        child.on('error', (spawnError) => {
            rejectAllPending(state, new Error(`Failed to spawn Python worker: ${spawnError.message}`));
            if (worker === state) {
                worker = null;
            }
        });

        worker = state;
        return state;
    }

    function sendRequest(request, logPrefix) {
        const state = getWorker();
        const id = state.nextId++;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                state.pendingRequests.delete(id);
                console.error(`${logPrefix} Pipeline worker timed out after ${timeoutMs}ms`);
                killWorker(state);
                if (worker === state) {
                    worker = null;
                }
                reject(new Error(`Pipeline worker timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            state.pendingRequests.set(id, { resolve, reject, timer });

            const line = JSON.stringify({ ...request, id }) + '\n';
            try {
                state.process.stdin.write(line, (writeError) => {
                    if (writeError) {
                        state.pendingRequests.delete(id);
                        clearTimeout(timer);
                        reject(new Error(`Failed to write to Python worker: ${writeError.message}`));
                    }
                });
            } catch (writeError) {
                state.pendingRequests.delete(id);
                clearTimeout(timer);
                reject(new Error(`Failed to write to Python worker: ${writeError.message}`));
            }
        });
    }

    return {
        runVoice(audioPath, logPrefix = '') {
            return sendRequest({ type: 'voice', audio_path: audioPath, output_format: 'ogg' }, logPrefix);
        },
        runText(text, logPrefix = '') {
            return sendRequest({ type: 'text', text }, logPrefix);
        },
        /**
         * Terminate the underlying worker process, if any. Not used by
         * production code (the bot process runs indefinitely and the worker
         * is meant to outlive individual requests) — this exists so tests
         * can tear down the child processes they spawn instead of leaving
         * them running and keeping the event loop alive.
         */
        close() {
            if (worker) {
                killWorker(worker);
                worker = null;
            }
        }
    };
}

const defaultClient = createWorkerClient();

/**
 * Run the full STT->LLM->TTS pipeline on a voice note via the persistent
 * Python worker.
 * @param {string} audioPath - Path to the downloaded voice note
 * @param {string} [logPrefix] - Log prefix for correlating output
 * @returns {Promise<{transcription: string, language: string, llm_response: string, output_audio_path: string, timing: object}>}
 */
export function runVoicePipeline(audioPath, logPrefix = '') {
    return defaultClient.runVoice(audioPath, logPrefix);
}

/**
 * Run the text-only reply pipeline (LLM step, no STT/TTS) via the
 * persistent Python worker.
 * @param {string} text - The message body to reply to
 * @param {string} [logPrefix] - Log prefix for correlating output
 * @returns {Promise<{llm_response: string, timing: object}>}
 */
export function runTextPipeline(text, logPrefix = '') {
    return defaultClient.runText(text, logPrefix);
}
