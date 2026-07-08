import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTextPipelineArgs,
    buildVoicePipelineArgs,
    parsePipelineOutput
} from './pipeline-client.js';

test('packs dash-prefixed text into a single --text=<value> argv token', () => {
    // Regression test: node's spawn (no shell) passes each array element as
    // its own argv token. If the text value were a separate token from
    // `--text`, Python's argparse would misparse a dash-leading body like
    // `-_-` as a new option flag instead of the value of --text, causing the
    // subprocess to exit with code 2 for perfectly benign input.
    const args = buildTextPipelineArgs('-_-');

    assert.ok(
        args.includes('--text=-_-'),
        `expected args to contain the single token "--text=-_-", got ${JSON.stringify(args)}`
    );
    assert.equal(args.includes('--text'), false);
    assert.equal(args.includes('-_-'), false);
});

test('packs ordinary text into a single --text=<value> argv token', () => {
    const args = buildTextPipelineArgs('Quel temps fait-il ?');
    assert.ok(args.includes('--text=Quel temps fait-il ?'));
});

test('voice args request JSON output in OGG format for WhatsApp', () => {
    const args = buildVoicePipelineArgs('/tmp/x.ogg');
    assert.deepEqual(args, ['-m', 'src.pipeline_cli', '/tmp/x.ogg', '--json', '--output-format', 'ogg']);
});

test('parsePipelineOutput returns the parsed result object', () => {
    const result = parsePipelineOutput('{"success": true, "llm_response": "salut"}');
    assert.equal(result.llm_response, 'salut');
});

test('parsePipelineOutput throws a descriptive error on non-JSON output', () => {
    assert.throws(
        () => parsePipelineOutput('Traceback (most recent call last):'),
        /Failed to parse pipeline output/
    );
});

test('parsePipelineOutput throws the embedded pipeline error', () => {
    assert.throws(
        () => parsePipelineOutput('{"success": false, "error": "STT failed: boom"}'),
        /STT failed: boom/
    );
});
