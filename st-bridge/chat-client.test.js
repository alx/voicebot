import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessageAndAwaitReply } from './chat-client.js';

function makeAdapter({ readyAfterPolls = 1, replyText = 'hello' } = {}) {
    let polls = 0;
    return {
        submitted: [],
        async submitMessage(text) {
            this.submitted.push(text);
        },
        async isReplyReady() {
            polls++;
            return polls > readyAfterPolls;
        },
        async getLatestMessageText() {
            return replyText;
        },
    };
}

test('returns the reply once the adapter reports it is ready', async () => {
    const adapter = makeAdapter({ readyAfterPolls: 2, replyText: 'Bonjour!' });

    const reply = await sendMessageAndAwaitReply(adapter, 'Salut', {
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });

    assert.equal(reply, 'Bonjour!');
    assert.deepEqual(adapter.submitted, ['Salut']);
});

test('throws when the reply never becomes ready before the timeout', async () => {
    const adapter = {
        async submitMessage() {},
        async isReplyReady() {
            return false;
        },
        async getLatestMessageText() {
            return 'unused';
        },
    };

    await assert.rejects(
        sendMessageAndAwaitReply(adapter, 'Salut', { timeoutMs: 50, pollIntervalMs: 10 }),
        /Timed out waiting for SillyTavern reply/
    );
});
