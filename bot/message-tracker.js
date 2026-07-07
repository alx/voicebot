/**
 * Tracks message IDs the bot itself has sent, so the bot's own outgoing
 * messages (text replies, status updates, voice replies) don't get
 * re-processed when whatsapp-web.js echoes them back via message_create.
 * @returns {{
 *   sendTracked: (chat: Chat, content: any, options?: object) => Promise<Message>,
 *   wasSent: (messageId: string) => boolean,
 *   release: (messageId: string) => void
 * }}
 */
export function createMessageTracker() {
    const sentIds = new Set();

    async function sendTracked(chat, content, options) {
        const sent = await chat.sendMessage(content, options);
        if (sent?.id?.id) {
            sentIds.add(sent.id.id);
        }
        return sent;
    }

    function wasSent(messageId) {
        return sentIds.has(messageId);
    }

    function release(messageId) {
        sentIds.delete(messageId);
    }

    return { sendTracked, wasSent, release };
}
