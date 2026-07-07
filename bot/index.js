import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import { handleVoiceMessage } from './voice-handler.js';
import { createQueue } from './queue.js';
import config from './config.js';

console.log('='.repeat(60));
console.log('WhatsApp Voice Bot (whatsapp-web.js)');
console.log('='.repeat(60));

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        headless: true
    }
});

const voiceQueue = createQueue();

// IDs of voice replies the bot itself sent, so message_create (which fires for
// fromMe messages too) doesn't re-queue the bot's own audio reply as a new
// incoming voice message.
const sentReplyIds = new Set();

// QR code event - scan with WhatsApp to authenticate
client.on('qr', (qr) => {
    console.log('\n' + '='.repeat(60));
    console.log('Scan this QR code with WhatsApp:');
    console.log('='.repeat(60) + '\n');
    qrcode.generate(qr, { small: true });
    console.log('\n' + '='.repeat(60));
    console.log('Waiting for authentication...');
    console.log('='.repeat(60) + '\n');
});

// Authentication successful
client.on('authenticated', () => {
    console.log('✓ Authenticated successfully!');
});

// Authentication failure
client.on('auth_failure', (msg) => {
    console.error('✗ Authentication failed:', msg);
    console.error('Delete .wwebjs_auth/ folder and try again');
});

// Client ready event
client.on('ready', () => {
    console.log('\n' + '='.repeat(60));
    console.log('✓ WhatsApp bot ready!');
    console.log('='.repeat(60));

    if (config.TARGET_GROUP_ID) {
        console.log(`Processing messages from: ${config.TARGET_GROUP_ID}`);
    } else {
        console.warn('⚠️  Warning: VOICEBOT_GROUP_ID not set in .env');
        console.warn('   Bot will log all incoming chat IDs for you to identify the target group');
    }

    console.log('\nListening for voice messages...');
    console.log('Send a voice message to the target group to test!');
    console.log('='.repeat(60) + '\n');
});

// Disconnected event
client.on('disconnected', (reason) => {
    console.log('✗ Client disconnected:', reason);
    console.log('Attempting to reconnect...');
});

// Loading screen event
client.on('loading_screen', (percent, message) => {
    console.log(`Loading: ${percent}% - ${message}`);
});

// Message event - main handler
// Uses message_create (not message) because whatsapp-web.js never emits
// 'message' for messages sent by the linked account itself (fromMe), which
// is the case whenever the bot owner tests it from their own phone.
client.on('message_create', async (msg) => {
    try {
        // Get chat information
        const chat = await msg.getChat();
        const chatId = chat.id._serialized;

        // Skip the bot's own voice reply echoed back via message_create
        if (sentReplyIds.has(msg.id.id)) {
            sentReplyIds.delete(msg.id.id);
            return;
        }

        // Log all incoming messages for debugging (helps find group ID)
        if (!config.TARGET_GROUP_ID) {
            console.log(`\nIncoming message from chat: ${chatId} (${chat.name || 'Unknown'})`);
            console.log(`Message type: ${msg.type}, hasMedia: ${msg.hasMedia}`);
        }

        // Filter: only process if TARGET_GROUP_ID is set
        if (config.TARGET_GROUP_ID && chatId !== config.TARGET_GROUP_ID) {
            return; // Ignore messages from other chats
        }

        // Filter: only process voice messages (ptt = push-to-talk)
        if (msg.hasMedia && msg.type === 'ptt') {
            console.log(`\nVoice message received! Queued for processing...`);
            voiceQueue.enqueue(() => handleVoiceMessage(msg, chat, client, sentReplyIds)).catch((error) => {
                console.error(`Unexpected error in queued voice message handler:`, error);
            });
        } else if (msg.hasMedia && msg.type === 'audio') {
            // Also handle regular audio messages
            console.log(`\nAudio message received! Queued for processing...`);
            voiceQueue.enqueue(() => handleVoiceMessage(msg, chat, client, sentReplyIds)).catch((error) => {
                console.error(`Unexpected error in queued voice message handler:`, error);
            });
        }

    } catch (error) {
        console.error('Error in message handler:', error);
    }
});

// Error event
client.on('error', (error) => {
    console.error('Client error:', error);
});

// Initialize the client
console.log('Initializing WhatsApp client...');
console.log('This may take a moment...\n');

client.initialize().catch((error) => {
    console.error('Failed to initialize client:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\nShutting down gracefully...');
    await client.destroy();
    console.log('✓ Client destroyed. Goodbye!');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\nReceived SIGTERM, shutting down...');
    await client.destroy();
    process.exit(0);
});
