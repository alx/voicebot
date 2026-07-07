import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { TOOLS, runTool, resolveScopedPath, ToolError } from './tools.js';

async function makeTempRoot() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'trico-tools-'));
}

test('runTool rejects an unknown tool name', async () => {
    await assert.rejects(
        runTool('does_not_exist', [], { root: '/tmp' }, 1000),
        ToolError
    );
});

test('disk_usage returns non-empty output', async () => {
    const output = await runTool('disk_usage', [], { root: '/tmp' }, 5000);
    assert.ok(output.length > 0);
});

test('ping rejects a host containing shell metacharacters', async () => {
    await assert.rejects(
        runTool('ping', ['; rm -rf /'], { root: '/tmp' }, 1000),
        ToolError
    );
});

test('ping rejects a missing host argument', async () => {
    await assert.rejects(
        runTool('ping', [], { root: '/tmp' }, 1000),
        ToolError
    );
});

test('ping rejects a host argument starting with a hyphen (flag injection)', async () => {
    await assert.rejects(
        runTool('ping', ['-f'], { root: '/tmp' }, 1000),
        ToolError
    );
});

test('resolveScopedPath allows a path inside the root', async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello');
    const resolved = await resolveScopedPath(root, 'notes.txt', { mustExist: true });
    assert.equal(resolved, path.join(root, 'notes.txt'));
});

test('resolveScopedPath rejects ../ traversal', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        resolveScopedPath(root, '../outside.txt', { mustExist: false }),
        ToolError
    );
});

test('resolveScopedPath rejects an absolute path outside the root', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        resolveScopedPath(root, '/etc/passwd', { mustExist: true }),
        ToolError
    );
});

test('resolveScopedPath rejects a symlink that escapes the root', async () => {
    const root = await makeTempRoot();
    const outsideDir = await makeTempRoot();
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'nope');
    await fs.symlink(outsideDir, path.join(root, 'escape'));
    await assert.rejects(
        resolveScopedPath(root, 'escape/secret.txt', { mustExist: true }),
        ToolError
    );
});

test('write_file then read_file round-trips content inside the root', async () => {
    const root = await makeTempRoot();
    await TOOLS.write_file(['note.txt', 'bonjour', 'le', 'monde'], { root });
    const content = await TOOLS.read_file(['note.txt'], { root });
    assert.equal(content, 'bonjour le monde');
});

test('resolveScopedPath rejects a pre-existing symlink leaf that escapes the root, even when mustExist is false', async () => {
    const root = await makeTempRoot();
    const outsideDir = await makeTempRoot();
    const outsideFile = path.join(outsideDir, 'target.txt');
    await fs.writeFile(outsideFile, 'outside content');
    await fs.symlink(outsideFile, path.join(root, 'escape-target'));

    await assert.rejects(
        resolveScopedPath(root, 'escape-target', { mustExist: false }),
        ToolError
    );
});

test('write_file rejects writing through a pre-existing symlink that escapes the root', async () => {
    const root = await makeTempRoot();
    const outsideDir = await makeTempRoot();
    const outsideFile = path.join(outsideDir, 'target.txt');
    await fs.writeFile(outsideFile, 'outside content');
    await fs.symlink(outsideFile, path.join(root, 'escape-target'));

    await assert.rejects(
        TOOLS.write_file(['escape-target', 'pwned'], { root }),
        ToolError
    );

    const contentAfter = await fs.readFile(outsideFile, 'utf8');
    assert.equal(contentAfter, 'outside content');
});

test('write_file rejects content larger than the size cap', async () => {
    const root = await makeTempRoot();
    const tooBig = 'a'.repeat(100_001);
    await assert.rejects(
        TOOLS.write_file(['big.txt', tooBig], { root }),
        ToolError
    );
});

test('search_files finds a matching line inside the root', async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, 'haystack.txt'), 'bonjour le monde\nautre ligne');
    const output = await TOOLS.search_files(['bonjour', '.'], { root }, 5000);
    assert.ok(output.includes('bonjour'));
});

test('list_dir rejects a path escaping the root', async () => {
    const root = await makeTempRoot();
    await assert.rejects(
        TOOLS.list_dir(['../'], { root }, 5000),
        ToolError
    );
});
