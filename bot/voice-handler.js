import fs from 'fs/promises';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import config from './config.js';
import { runWithTimeout } from './subprocess-timeout.js';

/**
 * Handle incoming voice message
 * @param {Message} msg - WhatsApp message object
 * @param {Chat} chat - WhatsApp chat object
 * @param {Client} client - WhatsApp client
 * @param {Set<string>} sentReplyIds - IDs of bot-sent voice replies to ignore on echo
 */
export async function handleVoiceMessage(msg, chat, client, sentReplyIds) {
    const messageId = msg.id.id.substring(0, 8);
    const logPrefix = `[${messageId}]`;

    console.log(`${logPrefix} Processing voice message from ${chat.name || chat.id._serialized}`);

    let tempAudioPath = null;

    try {
        // Stage 1: Acknowledge receipt
        console.log(`${logPrefix} Sending acknowledgment...`);
        await chat.sendMessage(config.STATUS_MESSAGES.received);

        // Stage 2: Download audio
        console.log(`${logPrefix} Downloading voice message...`);
        const media = await msg.downloadMedia();

        if (!media) {
            throw new Error('Failed to download media');
        }

        // Save to temp file
        tempAudioPath = path.join(
            config.TEMP_DIR,
            `whatsapp_${Date.now()}_${messageId}.ogg`
        );

        await fs.writeFile(tempAudioPath, media.data, 'base64');
        console.log(`${logPrefix} Audio saved to ${tempAudioPath}`);

        // Stage 3: Call Python pipeline
        console.log(`${logPrefix} Calling Python pipeline...`);
        const result = await callPythonPipeline(tempAudioPath, logPrefix);

        // Check if result has error
        if (result.error) {
            throw new Error(result.error);
        }

        // Stage 4: Send transcription
        console.log(`${logPrefix} Sending transcription...`);
        const transcriptionMsg = config.STATUS_MESSAGES.transcription.replace(
            '{}',
            result.transcription
        );
        await chat.sendMessage(transcriptionMsg);

        // Stage 5: Send LLM response
        console.log(`${logPrefix} Sending LLM response...`);
        const llmMsg = config.STATUS_MESSAGES.llm_response.replace(
            '{}',
            result.llm_response
        );
        await chat.sendMessage(llmMsg);

        // Stage 6: Send voice audio
        console.log(`${logPrefix} Sending voice response...`);
        const audioMedia = MessageMedia.fromFilePath(result.output_audio_path);
        const sentReply = await chat.sendMessage(audioMedia, {
            sendAudioAsVoice: true
        });
        if (sentReplyIds && sentReply?.id?.id) {
            sentReplyIds.add(sentReply.id.id);
        }

        const totalTime = result.timing?.total || 'unknown';
        console.log(`${logPrefix} ✓ Complete (${totalTime}s)`);
        console.log(`${logPrefix} Timing - STT: ${result.timing?.stt}s, LLM: ${result.timing?.llm}s, TTS: ${result.timing?.tts}s`);

    } catch (error) {
        console.error(`${logPrefix} ✗ Error:`, error.message);
        console.error(error.stack);

        // Send error message to user
        if (config.ENABLE_ERROR_NOTIFICATIONS) {
            const errorMsg = config.STATUS_MESSAGES.error.replace(
                '{}',
                error.message
            );

            try {
                await chat.sendMessage(errorMsg);
            } catch (sendError) {
                console.error(`${logPrefix} Failed to send error notification:`, sendError.message);
            }
        }
    } finally {
        // Cleanup temporary audio file
        if (tempAudioPath) {
            try {
                await fs.unlink(tempAudioPath);
                console.log(`${logPrefix} Cleaned up ${tempAudioPath}`);
            } catch (cleanupError) {
                console.warn(`${logPrefix} Failed to cleanup ${tempAudioPath}:`, cleanupError.message);
            }
        }
    }
}

/**
 * Call Python pipeline as subprocess, killing it if it exceeds the configured timeout
 * @param {string} audioPath - Path to audio file
 * @param {string} logPrefix - Log prefix for debugging
 * @returns {Promise<Object>} Pipeline result with transcription, llm_response, output_audio_path
 */
async function callPythonPipeline(audioPath, logPrefix = '') {
    const { stdout } = await runWithTimeout(
        config.PYTHON_CMD,
        ['-m', 'src.pipeline_cli', audioPath, '--json', '--output-format', 'ogg'],
        { cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..') },
        config.PIPELINE_TIMEOUT_MS,
        {
            onStderr: (text) => console.error(`${logPrefix} [Python stderr]:`, text.trim())
        }
    );

    try {
        return JSON.parse(stdout);
    } catch (parseError) {
        throw new Error(`Failed to parse pipeline output: ${parseError.message}\nOutput: ${stdout}`);
    }
}
