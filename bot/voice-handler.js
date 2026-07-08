import fs from 'fs/promises';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import config from './config.js';
import { runVoicePipeline } from './pipeline-client.js';
import { notifyError } from './notify-error.js';

/**
 * Handle incoming voice message: download the audio, run it through the
 * STT->LLM->TTS pipeline, and send the staged status replies plus the voice
 * response.
 * @param {Message} msg - WhatsApp message object
 * @param {Chat} chat - WhatsApp chat object
 * @param {Client} client - WhatsApp client (unused; kept for signature parity)
 * @param {{ sendTracked: Function }} tracker - Tracks bot-sent messages to ignore on echo
 * @param {{ runPipeline?: Function, tempDir?: string, mediaFromFile?: Function }} [deps] - Injectable overrides for testing
 */
export async function handleVoiceMessage(msg, chat, client, tracker, deps = {}) {
    const messageId = msg.id.id.substring(0, 8);
    const logPrefix = `[${messageId}]`;
    const runPipeline = deps.runPipeline ?? ((audioPath) => runVoicePipeline(audioPath, logPrefix));
    const tempDir = deps.tempDir ?? config.TEMP_DIR;
    const mediaFromFile = deps.mediaFromFile ?? ((filePath) => MessageMedia.fromFilePath(filePath));

    console.log(`${logPrefix} Processing voice message from ${chat.name || chat.id._serialized}`);

    let tempAudioPath = null;

    try {
        // Stage 1: Acknowledge receipt
        await tracker.sendTracked(chat, config.STATUS_MESSAGES.received);

        // Stage 2: Download audio
        const media = await msg.downloadMedia();
        if (!media) {
            throw new Error('Failed to download media');
        }

        tempAudioPath = path.join(tempDir, `whatsapp_${Date.now()}_${messageId}.ogg`);
        await fs.writeFile(tempAudioPath, media.data, 'base64');
        console.log(`${logPrefix} Audio saved to ${tempAudioPath}`);

        // Stage 3: Run the Python pipeline
        const result = await runPipeline(tempAudioPath);

        // Stage 4: Send transcription
        await tracker.sendTracked(
            chat,
            config.STATUS_MESSAGES.transcription.replace('{}', result.transcription)
        );

        // Stage 5: Send LLM response
        await tracker.sendTracked(
            chat,
            config.STATUS_MESSAGES.llm_response.replace('{}', result.llm_response)
        );

        // Stage 6: Send voice audio
        const audioMedia = mediaFromFile(result.output_audio_path);
        await tracker.sendTracked(chat, audioMedia, { sendAudioAsVoice: true });

        console.log(`${logPrefix} ✓ Complete (${result.timing?.total ?? 'unknown'}s)`);
        console.log(`${logPrefix} Timing - STT: ${result.timing?.stt}s, LLM: ${result.timing?.llm}s, TTS: ${result.timing?.tts}s`);

    } catch (error) {
        await notifyError(chat, tracker, error, logPrefix);
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
