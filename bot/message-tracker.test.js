import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageTracker } from './message-tracker.js';

function makeFakeChat(sentId) {
    return {
        sendMessage: async (content, options) => ({
            id: { id: sentId },
            content,
            options
        })
    };
}

test('sendTracked records the sent message id', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat('msg-1');

    const sent = await tracker.sendTracked(chat, 'hello');

    assert.equal(sent.id.id, 'msg-1');
    assert.equal(tracker.wasSent('msg-1'), true);
});

test('wasSent returns false for unknown ids', () => {
    const tracker = createMessageTracker();
    assert.equal(tracker.wasSent('never-sent'), false);
});

test('release removes the id so it is only consumed once', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat('msg-2');

    await tracker.sendTracked(chat, 'hello');
    assert.equal(tracker.wasSent('msg-2'), true);

    tracker.release('msg-2');
    assert.equal(tracker.wasSent('msg-2'), false);
});

test('sendTracked forwards options to chat.sendMessage', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat('msg-3');

    const sent = await tracker.sendTracked(chat, 'audio-content', { sendAudioAsVoice: true });

    assert.deepEqual(sent.options, { sendAudioAsVoice: true });
});
