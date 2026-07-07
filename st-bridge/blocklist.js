import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BLOCKLIST_PATH = path.join(__dirname, 'blocklist.json');

export const REFUSAL_MESSAGE =
    "Je ne peux pas répondre à ça, mais je suis là pour t'aider autrement !";

export function loadBlocklist(filePath = DEFAULT_BLOCKLIST_PATH) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const words = JSON.parse(raw);
    if (!Array.isArray(words) || !words.every((word) => typeof word === 'string')) {
        throw new Error('blocklist file must be a JSON array of strings');
    }
    return words;
}

export function applyBlocklist(text, blocklist) {
    const lower = text.toLowerCase();
    const matched = blocklist.some((word) => lower.includes(word.toLowerCase()));
    if (matched) {
        console.log(`[blocklist] reply blocked at ${new Date().toISOString()}`);
        return REFUSAL_MESSAGE;
    }
    return text;
}
