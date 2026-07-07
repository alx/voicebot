import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyError } from './notify-error.js';
import { createMessageTracker } from './message-tracker.js';

function makeFakeChat() {
    const sent = [];
    let counter = 0;
    return {
        sent,
        sendMessage: async (content) => {
            counter += 1;
            sent.push(content);
            return { id: { id: `sent-${counter}` } };
        }
    };
}

test('sends the configured error message with the error text substituted', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();

    await notifyError(chat, tracker, new Error('pipeline exploded'), '[t1]');

    assert.equal(chat.sent.length, 1);
    assert.match(chat.sent[0], /Erreur/);
    assert.match(chat.sent[0], /pipeline exploded/);
});

test('registers the error message with the tracker to avoid echo loops', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();

    await notifyError(chat, tracker, new Error('boom'), '[t2]');

    assert.equal(tracker.wasSent('sent-1'), true);
});

test('resolves without throwing when sending the notification itself fails', async () => {
    const tracker = createMessageTracker();
    const chat = {
        sendMessage: async () => {
            throw new Error('connection lost');
        }
    };

    await assert.doesNotReject(notifyError(chat, tracker, new Error('boom'), '[t3]'));
});
