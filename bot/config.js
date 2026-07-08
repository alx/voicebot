// Config scope: WhatsApp-side behavior only — group targeting, user-facing
// status messages, and Python subprocess invocation limits.
//
// Deliberately duplicated with src/config.py: TEXT_MAX_CHARS (same
// TEXT_MAX_CHARS env var on both sides), so Node can reject oversized
// messages without spawning Python while Python still enforces the limit
// for direct CLI use.

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from parent directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

export default {
    // WhatsApp group ID to process messages from
    // Format: 120363123456789@g.us
    TARGET_GROUP_ID: process.env.VOICEBOT_GROUP_ID,

    // Temp directory for audio files (shared with Python)
    TEMP_DIR: path.join(__dirname, '..', 'audio', 'temp'),

    // Status messages sent to users (French)
    STATUS_MESSAGES: {
        received: "🎤 Message vocal reçu, traitement en cours...",
        transcription: "📝 Transcription: {}",
        llm_response: "🤖 Réponse: {}",
        error: "❌ Erreur: {}"
    },

    // Enable/disable error notifications in chat
    ENABLE_ERROR_NOTIFICATIONS: true,

    // Python command (can be overridden via env var)
    PYTHON_CMD: process.env.PYTHON_CMD || 'python',

    // Max time to wait for the Python pipeline before killing it (ms)
    PIPELINE_TIMEOUT_MS: parseInt(process.env.PIPELINE_TIMEOUT_MS || '90000', 10),

    // Max characters allowed in a text message before Trico rejects it without calling Python
    TEXT_MAX_CHARS: parseInt(process.env.TEXT_MAX_CHARS || '1000', 10)
};
