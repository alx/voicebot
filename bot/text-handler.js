import config from './config.js';
import { runTextPipeline } from './pipeline-client.js';
import { notifyError } from './notify-error.js';

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
    const logPrefix = `[${msg.id.id.substring(0, 8)}]`;
    const maxChars = deps.maxChars ?? config.TEXT_MAX_CHARS;
    const runPipeline = deps.runPipeline ?? ((text) => runTextPipeline(text, logPrefix));

    const body = msg.body.trim();

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
        await notifyError(chat, tracker, error, logPrefix);
    }
}
