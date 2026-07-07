import { runTool, ToolError } from './tools.js';

const TOOL_MARKER_RE = /^\[TOOL:\s*([a-zA-Z_]+)\s*([^\]]*)\]$/;

export function parseToolMarker(text) {
    const trimmed = text.trim();
    const match = TOOL_MARKER_RE.exec(trimmed);
    if (!match) {
        return null;
    }
    const name = match[1];
    const rawArgs = match[2].trim();
    const args = rawArgs.length > 0 ? rawArgs.split(/\s+/) : [];
    return { name, args };
}

export async function sendMessageWithTools(adapter, text, sendFn, options) {
    const firstReply = await sendFn(adapter, text, { timeoutMs: options.timeoutMs });

    if (!options.toolsEnabled) {
        return firstReply;
    }

    const marker = parseToolMarker(firstReply);
    if (!marker) {
        return firstReply;
    }

    let resultText;
    try {
        resultText = await runTool(marker.name, marker.args, options.toolConfig, options.toolTimeoutMs);
    } catch (error) {
        resultText = error instanceof ToolError
            ? `Erreur : ${error.message}`
            : 'Erreur : outil indisponible.';
    }

    const injected = `[RÉSULTAT] ${resultText}`;
    return sendFn(adapter, injected, { timeoutMs: options.timeoutMs });
}
