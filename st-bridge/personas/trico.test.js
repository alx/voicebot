import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TOOLS } from '../tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cardPath = path.join(__dirname, 'trico.json');

test('trico.json is a valid SillyTavern v2 character card', () => {
    const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.data.name, 'Trico');
    assert.ok(card.data.first_mes.length > 0);
    assert.ok(card.data.description.length > 0);
    assert.ok(card.data.system_prompt.includes('français'));
});

test('trico.json system_prompt documents every whitelisted tool name', () => {
    const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    for (const toolName of Object.keys(TOOLS)) {
        assert.ok(
            card.data.system_prompt.includes(toolName),
            `system_prompt should mention "${toolName}"`
        );
    }
});

test('trico.json system_prompt documents the tool-marker syntax', () => {
    const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    assert.ok(card.data.system_prompt.includes('[TOOL:'));
    assert.ok(card.data.system_prompt.includes('[RÉSULTAT]'));
});
