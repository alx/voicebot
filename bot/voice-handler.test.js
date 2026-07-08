import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { handleVoiceMessage } from './voice-handler.js';
import { createMessageTracker } from './message-tracker.js';

function makeFakeChat() {
    const sent = [];
    let counter = 0;
    return {
        sent,
        name: 'Test Group',
        sendMessage: async (content) => {
            counter += 1;
            sent.push(content);
            return { id: { id: `sent-${counter}` } };
        }
    };
}

function makeVoiceMsg(id = 'incoming-1') {
    return {
        id: { id },
        downloadMedia: async () => ({
            data: Buffer.from('fake-ogg-bytes').toString('base64')
        })
    };
}

async function withTempDir(fn) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-handler-test-'));
    try {
        await fn(tempDir);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

test('happy path sends ack, transcription, llm response, then voice audio', async () => {
    await withTempDir(async (tempDir) => {
        const tracker = createMessageTracker();
        const chat = makeFakeChat();
        const sentinel = { fake: 'media' };
        let pipelineAudioPath = null;
        let audioExistedDuringPipeline = false;

        await handleVoiceMessage(makeVoiceMsg(), chat, null, tracker, {
            tempDir,
            runPipeline: async (audioPath) => {
                pipelineAudioPath = audioPath;
                audioExistedDuringPipeline = await fs.access(audioPath).then(() => true, () => false);
                return {
                    transcription: 'bonjour tout le monde',
                    language: 'fr',
                    llm_response: 'Salut!',
                    output_audio_path: '/nonexistent/reply.ogg',
                    timing: { stt: 1, llm: 2, tts: 3, total: 6 }
                };
            },
            mediaFromFile: (filePath) => {
                assert.equal(filePath, '/nonexistent/reply.ogg');
                return sentinel;
            }
        });

        assert.equal(chat.sent.length, 4);
        assert.match(chat.sent[0], /vocal reçu/);
        assert.match(chat.sent[1], /bonjour tout le monde/);
        assert.match(chat.sent[2], /Salut!/);
        assert.equal(chat.sent[3], sentinel);

        assert.ok(pipelineAudioPath.startsWith(tempDir), 'audio saved under the injected temp dir');
        assert.equal(audioExistedDuringPipeline, true);
    });
});

test('cleans up the temp audio file after success', async () => {
    await withTempDir(async (tempDir) => {
        const tracker = createMessageTracker();
        const chat = makeFakeChat();

        await handleVoiceMessage(makeVoiceMsg('incoming-2'), chat, null, tracker, {
            tempDir,
            runPipeline: async () => ({
                transcription: 't', language: 'fr', llm_response: 'r',
                output_audio_path: '/nonexistent/reply.ogg', timing: {}
            }),
            mediaFromFile: () => ({})
        });

        assert.deepEqual(await fs.readdir(tempDir), []);
    });
});

test('pipeline failure sends an error notification and still cleans up', async () => {
    await withTempDir(async (tempDir) => {
        const tracker = createMessageTracker();
        const chat = makeFakeChat();

        await handleVoiceMessage(makeVoiceMsg('incoming-3'), chat, null, tracker, {
            tempDir,
            runPipeline: async () => {
                throw new Error('pipeline exploded');
            }
        });

        assert.equal(chat.sent.length, 2); // ack + error notification
        assert.match(chat.sent[1], /pipeline exploded/);
        assert.deepEqual(await fs.readdir(tempDir), []);
    });
});

test('failed media download sends an error notification', async () => {
    await withTempDir(async (tempDir) => {
        const tracker = createMessageTracker();
        const chat = makeFakeChat();
        const msg = { id: { id: 'incoming-4' }, downloadMedia: async () => null };

        await handleVoiceMessage(msg, chat, null, tracker, {
            tempDir,
            runPipeline: async () => {
                throw new Error('should not be reached');
            }
        });

        assert.equal(chat.sent.length, 2); // ack + error notification
        assert.match(chat.sent[1], /Failed to download media/);
    });
});

test('registers every sent message with the tracker to avoid echo loops', async () => {
    await withTempDir(async (tempDir) => {
        const tracker = createMessageTracker();
        const chat = makeFakeChat();

        await handleVoiceMessage(makeVoiceMsg('incoming-5'), chat, null, tracker, {
            tempDir,
            runPipeline: async () => ({
                transcription: 't', language: 'fr', llm_response: 'r',
                output_audio_path: '/nonexistent/reply.ogg', timing: {}
            }),
            mediaFromFile: () => ({})
        });

        for (const id of ['sent-1', 'sent-2', 'sent-3', 'sent-4']) {
            assert.equal(tracker.wasSent(id), true, `${id} should be tracked`);
        }
    });
});
