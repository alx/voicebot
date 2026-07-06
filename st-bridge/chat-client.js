function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {Object} ChatAdapter
 * @property {(text: string) => Promise<void>} submitMessage
 * @property {() => Promise<boolean>} isReplyReady
 * @property {() => Promise<string>} getLatestMessageText
 */

/**
 * Submit a message through the given chat adapter and wait for its reply.
 *
 * @param {ChatAdapter} adapter
 * @param {string} text
 * @param {{ timeoutMs: number, pollIntervalMs?: number }} options
 * @returns {Promise<string>} the reply text
 */
export async function sendMessageAndAwaitReply(adapter, text, options) {
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const timeoutMs = options.timeoutMs;

    await adapter.submitMessage(text);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await adapter.isReplyReady()) {
            return adapter.getLatestMessageText();
        }
        await delay(pollIntervalMs);
    }

    throw new Error(`Timed out waiting for SillyTavern reply after ${timeoutMs}ms`);
}
