import { spawn } from 'child_process';

/**
 * Spawn a command, collecting stdout/stderr, and reject if it doesn't
 * finish within timeoutMs (killing the process in that case).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import('child_process').SpawnOptions} options
 * @param {number} timeoutMs
 * @param {{ onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void }} [callbacks]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function runWithTimeout(command, args, options, timeoutMs, callbacks = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, options);

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`Process timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
        }, timeoutMs);

        child.stdout?.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            callbacks.onStdout?.(text);
        });

        child.stderr?.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            callbacks.onStderr?.(text);
        });

        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Failed to spawn process: ${error.message}`));
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`Process exited with code ${code}: ${stderr}`));
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}
