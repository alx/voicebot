import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { runWithTimeout } from './subprocess-timeout.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Build the argv for invoking the Python pipeline CLI in --text mode.
 *
 * The text value is packed into a single `--text=<value>` token rather than
 * passed as two separate argv entries (`--text`, value). This is required
 * because Node's `spawn` (no shell) hands the array straight through as
 * argv, so a value that itself starts with a dash (e.g. the emoticon `-_-`)
 * would otherwise be misparsed by Python's argparse as a new option flag
 * instead of the value of `--text`.
 * @param {string} text - The message body to reply to
 * @returns {string[]} argv array (excluding the interpreter/command itself)
 */
export function buildTextPipelineArgs(text) {
    return ['-m', 'src.pipeline_cli', `--text=${text}`, '--json'];
}

/**
 * Build the argv for invoking the Python pipeline CLI on a voice message.
 * @param {string} audioPath - Path to the downloaded voice note
 * @returns {string[]} argv array (excluding the interpreter/command itself)
 */
export function buildVoicePipelineArgs(audioPath) {
    return ['-m', 'src.pipeline_cli', audioPath, '--json', '--output-format', 'ogg'];
}

/**
 * Parse the pipeline subprocess stdout: must be a JSON object, and an
 * embedded `error` field (the CLI's failure envelope) is surfaced as a throw.
 * @param {string} stdout
 * @returns {object} parsed pipeline result
 */
export function parsePipelineOutput(stdout) {
    let result;
    try {
        result = JSON.parse(stdout);
    } catch (parseError) {
        throw new Error(`Failed to parse pipeline output: ${parseError.message}\nOutput: ${stdout}`);
    }
    if (result.error) {
        throw new Error(result.error);
    }
    return result;
}

async function runPipeline(args, logPrefix) {
    const { stdout } = await runWithTimeout(
        config.PYTHON_CMD,
        args,
        { cwd: REPO_ROOT },
        config.PIPELINE_TIMEOUT_MS,
        {
            onStderr: (chunk) => console.error(`${logPrefix} [Python stderr]:`, chunk.trim())
        }
    );
    return parsePipelineOutput(stdout);
}

/**
 * Run the full STT->LLM->TTS pipeline on a voice note.
 * @param {string} audioPath - Path to the downloaded voice note
 * @param {string} [logPrefix] - Log prefix for correlating output
 * @returns {Promise<{transcription: string, language: string, llm_response: string, output_audio_path: string, timing: object}>}
 */
export function runVoicePipeline(audioPath, logPrefix = '') {
    return runPipeline(buildVoicePipelineArgs(audioPath), logPrefix);
}

/**
 * Run the text-only reply pipeline (LLM step, no STT/TTS).
 * @param {string} text - The message body to reply to
 * @param {string} [logPrefix] - Log prefix for correlating output
 * @returns {Promise<{llm_response: string, timing: object}>}
 */
export function runTextPipeline(text, logPrefix = '') {
    return runPipeline(buildTextPipelineArgs(text), logPrefix);
}
