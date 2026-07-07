import path from 'path';
import config from './config.js';
import { runWithTimeout } from './subprocess-timeout.js';

/**
 * Call the Python pipeline in --text mode as a subprocess.
 * @param {string} text - The message body to reply to
 * @param {string} logPrefix - Log prefix for debugging
 * @returns {Promise<{llm_response: string, timing: object}>}
 */
async function callTextPipeline(text, logPrefix = '') {
    const { stdout } = await runWithTimeout(
        config.PYTHON_CMD,
        ['-m', 'src.pipeline_cli', '--text', text, '--json'],
        { cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..') },
        config.PIPELINE_TIMEOUT_MS,
        {
            onStderr: (chunk) => console.error(`${logPrefix} [Python stderr]:`, chunk.trim())
        }
    );

    let result;
    try {
        result = JSON.parse(stdout);
    } catch (parseError) {
        throw new Error(`Failed to parse pipeline output: ${parseError.message}\nOutput: ${stdout}`);
    }

    if (result.error) {
        throw new Error(result.error);
    }

    return result;
}

/**
 * Handle an incoming text message: reject if too long, otherwise run it
 * through the Python reply pipeline and send the text-only response.
 * @param {Message} msg - WhatsApp message object
 * @param {Chat} chat - WhatsApp chat object
 * @param {Client} client - WhatsApp client (unused; kept for signature parity with handleVoiceMessage)
 * @param {{ sendTracked: Function }} tracker - Tracks bot-sent messages to ignore on echo
 * @param {{ maxChars?: number, runPipeline?: Function }} [deps] - Injectable overrides for testing
 */
export async function handleTextMessage(msg, chat, client, tracker, deps = {}) {
    const maxChars = deps.maxChars ?? config.TEXT_MAX_CHARS;
    const runPipeline = deps.runPipeline ?? ((text) => callTextPipeline(text, `[${msg.id.id.substring(0, 8)}]`));

    const body = msg.body.trim();
    const logPrefix = `[${msg.id.id.substring(0, 8)}]`;

    if (body.length > maxChars) {
        console.log(`${logPrefix} Text message rejected: ${body.length} chars (max ${maxChars})`);
        await tracker.sendTracked(chat, `❌ Message trop long (max ${maxChars} caractères).`);
        return;
    }

    console.log(`${logPrefix} Processing text message from ${chat.name || chat.id?._serialized}`);

    try {
        const result = await runPipeline(body);
        await tracker.sendTracked(chat, result.llm_response);
        console.log(`${logPrefix} ✓ Complete`);
    } catch (error) {
        console.error(`${logPrefix} ✗ Error:`, error.message);

        if (config.ENABLE_ERROR_NOTIFICATIONS) {
            const errorMsg = config.STATUS_MESSAGES.error.replace('{}', error.message);
            try {
                await tracker.sendTracked(chat, errorMsg);
            } catch (sendError) {
                console.error(`${logPrefix} Failed to send error notification:`, sendError.message);
            }
        }
    }
}
