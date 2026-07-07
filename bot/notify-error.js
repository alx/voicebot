import config from './config.js';

/**
 * Log a handler error and (if enabled) notify the chat with the configured
 * error status message. Never throws: a failure to send the notification is
 * logged and swallowed, since there is nothing further to do about it.
 * @param {Chat} chat - WhatsApp chat object
 * @param {{ sendTracked: Function }} tracker - Tracks bot-sent messages to ignore on echo
 * @param {Error} error - The error to report
 * @param {string} [logPrefix] - Log prefix for correlating output
 */
export async function notifyError(chat, tracker, error, logPrefix = '') {
    console.error(`${logPrefix} ✗ Error:`, error.message);

    if (!config.ENABLE_ERROR_NOTIFICATIONS) {
        return;
    }

    const errorMsg = config.STATUS_MESSAGES.error.replace('{}', error.message);
    try {
        await tracker.sendTracked(chat, errorMsg);
    } catch (sendError) {
        console.error(`${logPrefix} Failed to send error notification:`, sendError.message);
    }
}
