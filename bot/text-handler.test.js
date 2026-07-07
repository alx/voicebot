import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTextMessage } from './text-handler.js';
import { createMessageTracker } from './message-tracker.js';

function makeFakeChat() {
    const sent = [];
    let counter = 0;
    return {
        sent,
        sendMessage: async (content) => {
            counter += 1;
            const id = { id: `sent-${counter}` };
            sent.push(content);
            return { id };
        }
    };
}

test('rejects over-length messages without calling the pipeline', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const msg = { body: 'x'.repeat(2000), id: { id: 'incoming-1' } };
    let pipelineCalled = false;

    await handleTextMessage(msg, chat, null, tracker, {
        maxChars: 1000,
        runPipeline: async () => {
            pipelineCalled = true;
            return { llm_response: 'should not be reached' };
        }
    });

    assert.equal(pipelineCalled, false);
    assert.equal(chat.sent.length, 1);
    assert.match(chat.sent[0], /trop long|too long/i);
});

test('sends the pipeline llm_response as a single text reply', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const msg = { body: 'Quel temps fait-il ?', id: { id: 'incoming-2' } };

    await handleTextMessage(msg, chat, null, tracker, {
        maxChars: 1000,
        runPipeline: async (text) => {
            assert.equal(text, 'Quel temps fait-il ?');
            return { llm_response: 'Il fait beau!', timing: { llm: 1.2, total: 1.3 } };
        }
    });

    assert.deepEqual(chat.sent, ['Il fait beau!']);
});

test('sends the configured error message when the pipeline fails', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const msg = { body: 'hello', id: { id: 'incoming-3' } };

    await handleTextMessage(msg, chat, null, tracker, {
        maxChars: 1000,
        runPipeline: async () => {
            throw new Error('pipeline exploded');
        }
    });

    assert.equal(chat.sent.length, 1);
    assert.match(chat.sent[0], /pipeline exploded/);
});

test('registers the sent reply with the tracker to avoid echo loops', async () => {
    const tracker = createMessageTracker();
    const chat = makeFakeChat();
    const msg = { body: 'hi', id: { id: 'incoming-4' } };

    await handleTextMessage(msg, chat, null, tracker, {
        maxChars: 1000,
        runPipeline: async () => ({ llm_response: 'yo', timing: {} })
    });

    assert.equal(tracker.wasSent('sent-1'), true);
});
