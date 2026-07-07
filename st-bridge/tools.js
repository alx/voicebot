import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

export class ToolError extends Error {}

const HOSTNAME_RE = /^[a-zA-Z0-9.-]{1,253}$/;
const MAX_OUTPUT_CHARS = 2000;
const MAX_FILE_BYTES = 100_000;

function truncate(text) {
    return text.length > MAX_OUTPUT_CHARS
        ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[...tronqué...]`
        : text;
}

function execFileCapture(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(
            cmd,
            args,
            { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new ToolError(`${cmd} failed: ${stderr || error.message}`));
                    return;
                }
                resolve(stdout);
            }
        );
    });
}

function validateHost(host) {
    if (!host || !HOSTNAME_RE.test(host)) {
        throw new ToolError(`Invalid host: ${host ?? '(missing)'}`);
    }
    return host;
}

export async function resolveScopedPath(root, requestedPath, { mustExist }) {
    const rootReal = await fs.realpath(root);
    const lexical = path.resolve(rootReal, requestedPath || '.');
    if (lexical !== rootReal && !lexical.startsWith(rootReal + path.sep)) {
        throw new ToolError('Path escapes the scoped root');
    }

    const checkTarget = mustExist ? lexical : path.dirname(lexical);
    let real;
    try {
        real = await fs.realpath(checkTarget);
    } catch {
        throw new ToolError(`Path does not exist: ${requestedPath}`);
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new ToolError('Path escapes the scoped root');
    }

    return lexical;
}

export const TOOLS = {
    disk_usage: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('df', ['-h'], timeoutMs)),

    memory: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('free', ['-h'], timeoutMs)),

    uptime: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('uptime', [], timeoutMs)),

    datetime: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('date', [], timeoutMs)),

    local_ip: async (_args, _config, timeoutMs) =>
        truncate(await execFileCapture('ip', ['addr', 'show'], timeoutMs)),

    ping: async (args, _config, timeoutMs) => {
        const host = validateHost(args[0]);
        return truncate(await execFileCapture('ping', ['-c', '3', host], timeoutMs));
    },

    list_dir: async (args, config, timeoutMs) => {
        const target = await resolveScopedPath(config.root, args[0], { mustExist: true });
        return truncate(await execFileCapture('ls', ['-la', target], timeoutMs));
    },

    read_file: async (args, config) => {
        const target = await resolveScopedPath(config.root, args[0], { mustExist: true });
        const content = await fs.readFile(target, 'utf8');
        return truncate(content);
    },

    write_file: async (args, config) => {
        const [requestedPath, ...contentParts] = args;
        if (!requestedPath) {
            throw new ToolError('Missing file path');
        }
        const content = contentParts.join(' ');
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
            throw new ToolError('Content too large');
        }
        const target = await resolveScopedPath(config.root, requestedPath, { mustExist: false });
        await fs.writeFile(target, content, 'utf8');
        return `Fichier écrit : ${requestedPath}`;
    },

    search_files: async (args, config, timeoutMs) => {
        const [pattern, ...rest] = args;
        if (!pattern) {
            throw new ToolError('Missing search pattern');
        }
        const target = await resolveScopedPath(config.root, rest[0], { mustExist: true });
        return truncate(await execFileCapture('grep', ['-rn', pattern, target], timeoutMs));
    },
};

export async function runTool(name, args, config, timeoutMs) {
    const tool = TOOLS[name];
    if (!tool) {
        throw new ToolError(`Unknown tool: ${name}`);
    }
    return tool(args, config, timeoutMs);
}
