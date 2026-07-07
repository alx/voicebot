import puppeteer from 'puppeteer';
import config from './config.js';
import { selectCharacter, createPageAdapter } from './puppeteer-adapter.js';
import { sendMessageAndAwaitReply } from './chat-client.js';
import { sendMessageWithTools } from './tool-runner.js';
import { loadBlocklist, applyBlocklist } from './blocklist.js';
import { createServer } from './server.js';

async function main() {
    if (!config.ST_CHARACTER_NAME) {
        throw new Error('ST_CHARACTER_NAME must be set in st-bridge/.env');
    }

    console.log(`Launching browser and connecting to SillyTavern at ${config.ST_BASE_URL}...`);
    const browser = await puppeteer.launch({
        headless: true,
        userDataDir: config.USER_DATA_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(config.ST_BASE_URL, { waitUntil: 'networkidle0' });

    console.log(`Selecting character "${config.ST_CHARACTER_NAME}"...`);
    await selectCharacter(page, config.ST_CHARACTER_NAME);

    const adapter = createPageAdapter(page);
    const blocklist = loadBlocklist();
    const replyFn = async (text) => {
        const reply = await sendMessageWithTools(adapter, text, sendMessageAndAwaitReply, {
            timeoutMs: config.REPLY_TIMEOUT_MS,
            toolsEnabled: config.TOOLS_ENABLED,
            toolConfig: { root: config.TOOL_ROOT },
            toolTimeoutMs: config.TOOL_TIMEOUT_MS,
        });
        return applyBlocklist(reply, blocklist);
    };

    const server = createServer(replyFn);
    server.listen(config.PORT, () => {
        console.log(`st-bridge listening on port ${config.PORT}`);
    });

    async function shutdown() {
        console.log('\nShutting down st-bridge...');
        await new Promise((resolve) => {
            server.close(() => resolve());
        });
        await browser.close();
        process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error('st-bridge failed to start:', error);
    process.exit(1);
});
