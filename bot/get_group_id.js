#!/usr/bin/env node

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';

console.log('='.repeat(60));
console.log('WhatsApp Group ID Finder');
console.log('='.repeat(60));
console.log('\nThis script will list all your WhatsApp groups with their IDs.');
console.log('You can then copy the ID to your .env file.\n');

// Initialize WhatsApp client with same auth as main bot
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
    process.exit(1);
});

// Client ready event
client.on('ready', async () => {
    console.log('\n' + '='.repeat(60));
    console.log('✓ WhatsApp connected!');
    console.log('='.repeat(60));
    console.log('\nFetching all chats...\n');

    try {
        // Get all chats
        const chats = await client.getChats();

        // Filter only groups
        const groups = chats.filter(chat => chat.isGroup);

        if (groups.length === 0) {
            console.log('No groups found. Make sure you\'re a member of at least one WhatsApp group.');
        } else {
            console.log(`Found ${groups.length} group(s):\n`);
            console.log('='.repeat(60));

            groups.forEach((group, index) => {
                console.log(`\n${index + 1}. ${group.name}`);
                console.log(`   ID: ${group.id._serialized}`);
                console.log(`   Participants: ${group.participants ? group.participants.length : 'Unknown'}`);
            });

            console.log('\n' + '='.repeat(60));
            console.log('\nTo use a group, copy its ID to your .env file:');
            console.log('VOICEBOT_GROUP_ID=<paste_id_here>');
            console.log('\nExample:');
            console.log('VOICEBOT_GROUP_ID=120363123456789@g.us');
            console.log('='.repeat(60) + '\n');
        }

    } catch (error) {
        console.error('Error fetching chats:', error);
    } finally {
        // Disconnect and exit
        console.log('Disconnecting...');
        await client.destroy();
        console.log('✓ Done! You can now close this script.');
        process.exit(0);
    }
});

// Error event
client.on('error', (error) => {
    console.error('Client error:', error);
});

// Initialize the client
console.log('Connecting to WhatsApp...');
console.log('This may take a moment...\n');

client.initialize().catch((error) => {
    console.error('Failed to initialize client:', error);
    process.exit(1);
});

// Graceful shutdown on Ctrl+C
process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    await client.destroy();
    console.log('✓ Goodbye!');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\nReceived SIGTERM, shutting down...');
    await client.destroy();
    process.exit(0);
});
