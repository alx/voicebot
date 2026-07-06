# WhatsApp Voice Bot - whatsapp-web.js

A WhatsApp voice bot that processes voice messages through an STT→LLM→TTS pipeline using whatsapp-web.js.

> **Note on whatsapp-web.js:** this bot connects via [whatsapp-web.js](https://wwebjs.dev/), an unofficial client that automates WhatsApp Web. It is not sanctioned by WhatsApp/Meta and using it technically violates WhatsApp's Terms of Service — accounts *can* be banned for automated use, though this is commonly used for personal/small-group bots. Use at your own risk, ideally with a number you don't mind losing.

## Architecture

**Hybrid Node.js + Python:**
- **Node.js**: Handles WhatsApp connection (whatsapp-web.js library)
- **Python**: Handles voice processing (STT→LLM→TTS pipeline)

```
WhatsApp → whatsapp-web.js → Node.js bot → Python subprocess → Response
                (receives)     (processes)    (STT/LLM/TTS)     (sends back)
```

## Features

- 🎤 Receives voice messages from WhatsApp groups
- 📝 Transcribes speech using faster-whisper (French by default)
- 🤖 Generates responses using any OpenAI-compatible LLM server
- 🔊 Synthesizes speech using Piper TTS
- ✅ Sends 4 status updates: acknowledgment, transcription, LLM response, audio
- 🔐 QR code authentication (once), session persisted
- ❌ Graceful error handling with user notifications
- 🚦 Oversized/overlong voice notes rejected before they hit the pipeline; only one message processed at a time; a hung pipeline subprocess is killed after a timeout

## Prerequisites

1. **Node.js** (v18+)
   ```bash
   node --version  # Check if installed
   ```

2. **Python 3.8-3.12** (3.13 currently lacks a prebuilt wheel for a transitive dependency of `faster-whisper`; use `python3.11` or `python3.12` explicitly if your system default is newer)
   ```bash
   python3 --version
   ```

3. **Chromium/Chrome** (for whatsapp-web.js)
   ```bash
   sudo apt install chromium-browser  # Ubuntu/Debian
   ```

4. **ffmpeg** (for audio processing)
   ```bash
   sudo apt install ffmpeg
   ```

5. **An OpenAI-compatible LLM server** (e.g. [llama-server](https://github.com/ggerganov/llama.cpp), [ollama](https://ollama.com/), vLLM, LM Studio) reachable over HTTP. Defaults to `http://localhost:8081`; override with `LLM_BASE_URL` in `.env` if it runs elsewhere.

6. **Piper TTS voice model** — see step 2 below.

## Quick Start

### 1. Install Dependencies

**Node.js:**
```bash
cd bot
npm install
```

**Python:**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Download a Piper voice model

`piper-tts` (installed above) provides the `piper` CLI, but voices are downloaded separately. This project defaults to the French `fr_FR-siwis-medium` voice:

```bash
mkdir -p models/piper
source .venv/bin/activate
python -m piper.download_voices fr_FR-siwis-medium --download-dir models/piper
```

This creates `models/piper/fr_FR-siwis-medium.onnx` and its `.onnx.json` config, which `src/pipeline.py` expects. Browse other voices at the [Piper voices catalog](https://github.com/rhasspy/piper/blob/master/VOICES.md) — see "Customization" below for using a different language/voice.

### 3. Configure Environment

```bash
# Create .env from template
cp .env.example .env

# Edit .env (VOICEBOT_GROUP_ID is optional on first run; LLM_BASE_URL only needed
# if your LLM server isn't at http://localhost:8081)
nano .env
```

### 4. Start the Bot

```bash
./start_bot.sh
```

**On first run:**
1. A QR code will appear in the terminal
2. Open WhatsApp on your phone → Settings → Linked Devices
3. Tap "Link a Device" and scan the QR code
4. Wait for "WhatsApp bot ready!"

**After authentication:**
- Session saved in `.wwebjs_auth/` (no QR code needed again)
- Send a test message to any group to see chat IDs in logs
- Update `.env` with your target group ID
- Restart bot

### 5. Find Your Group ID

**Option A: Use the Group ID Finder Script (Recommended)**

Run the provided script to list all your groups:
```bash
./scripts/get_group_id.sh
```

This will display all your WhatsApp groups with their IDs. Copy the ID you want to use.

See [docs/GET_GROUP_ID.md](docs/GET_GROUP_ID.md) for detailed instructions.

**Option B: Manual Method**

Send a message to your target WhatsApp group. The bot will log:
```
Incoming message from chat: 120363123456789@g.us (Group Name)
```

Copy this ID to `.env`:
```bash
VOICEBOT_GROUP_ID=120363123456789@g.us
```

Restart the bot.

### 6. Test with Voice Message

1. Send a voice message to the configured group
2. Bot will respond with 4 messages:
   - 🎤 "Message vocal reçu..."
   - 📝 "Transcription: {your speech}"
   - 🤖 "Réponse: {LLM answer}"
   - 🔊 Voice audio file

## Project Structure

```
voicebot/
├── bot/                          # Node.js WhatsApp bot
│   ├── index.js                  # Main bot entry point
│   ├── voice-handler.js          # Voice message processing
│   ├── subprocess-timeout.js     # Timeout/kill wrapper for the Python subprocess
│   ├── queue.js                  # Serializes voice message processing
│   ├── *.test.js                 # Node test suite (run: npm test)
│   ├── config.js                 # Bot configuration
│   ├── package.json              # Node dependencies
│   └── .wwebjs_auth/             # Session data (auto-created)
│
├── src/                          # Python pipeline
│   ├── pipeline.py                # VoicePipeline class
│   ├── pipeline_cli.py            # CLI wrapper for Node integration
│   ├── audio_converter.py         # Format conversion + validation
│   └── config.py                  # Python config
│
├── st-bridge/                    # Optional: SillyTavern persona bridge (see docs/SILLYTAVERN_SETUP.md)
│   ├── index.js                   # Entry point: launches browser + HTTP server
│   ├── chat-client.js             # Chat orchestration (submit + poll for reply)
│   ├── puppeteer-adapter.js       # Real SillyTavern DOM glue
│   ├── server.js                  # HTTP API (/reply, /health)
│   └── config.js                  # st-bridge configuration
│
├── tests/                        # Python test suite (run: pytest)
├── tests/step1/                  # Manual example scripts (STT/TTS tried individually)
├── docs/                         # Setup guides
├── audio/                        # Runtime audio files (gitignored)
├── models/                       # AI models (gitignored)
├── LICENSE
├── .env                          # Your local configuration (gitignored)
└── start_bot.sh                  # Startup script
```

## Configuration

### Environment Variables (.env)

```bash
# WhatsApp group ID (format: 120363123456789@g.us)
VOICEBOT_GROUP_ID=

# Optional: LLM server, if not http://localhost:8081
# LLM_BASE_URL=http://localhost:8081
# LLM_MODEL_NAME=your-model-name.gguf

# Optional: max time (ms) to wait for the Python pipeline before killing it
# PIPELINE_TIMEOUT_MS=90000

# Optional: Python command override
# PYTHON_CMD=python3

# Optional: Override default logging level
# LOG_LEVEL=INFO
```

### Status Messages

Edit `bot/config.js` to customize messages sent to users:

```javascript
STATUS_MESSAGES: {
    received: "🎤 Message vocal reçu, traitement en cours...",
    transcription: "📝 Transcription: {}",
    llm_response: "🤖 Réponse: {}",
    error: "❌ Erreur: {}"
}
```

## Customization

This bot defaults to French. To use another language, change these three places:

1. `src/config.py`: `STT_LANGUAGE` (or `None` for auto-detect) and `SYSTEM_PROMPT`
2. `src/pipeline.py`: `synthesize_speech()`'s hardcoded Piper model path (`models/piper/fr_FR-siwis-medium.onnx`)
3. Download the corresponding Piper voice for your target language (see step 2 in Quick Start)

## Optional: SillyTavern Persona Route

Instead of the default direct LLM call, the pipeline can route replies
through a real chat persona defined in [SillyTavern](https://github.com/SillyTavern/SillyTavern),
with multi-turn conversation memory. See
[docs/SILLYTAVERN_SETUP.md](docs/SILLYTAVERN_SETUP.md) for setup instructions.

## Testing

### Automated tests

```bash
# Python (pytest)
source .venv/bin/activate
pytest

# Node (built-in test runner)
cd bot
npm test
```

### Test Python Pipeline Directly

```bash
source .venv/bin/activate
python -m src.pipeline_cli path/to/audio.wav --json
# Expected output: JSON with transcription, llm_response, output_audio_path
```

### Manual component scripts

`tests/step1/` has small standalone scripts for trying STT/TTS individually (not part of the automated suite):
```bash
cd tests/step1
python create_sample_audio.py       # generates sample French WAV files
python test_stt_only.py ../../audio/input/sample_greeting.wav
```

## Troubleshooting

### QR Code Not Showing

```bash
# Check if Node.js and dependencies installed
cd bot && npm install

# Try running directly
cd bot && node index.js
```

### "Chromium not found" Error

```bash
# Install Chromium
sudo apt install chromium-browser  # Ubuntu/Debian
sudo yum install chromium          # CentOS/RHEL
```

### Session Expired / QR Code Again

```bash
# Delete session data and re-authenticate
rm -rf bot/.wwebjs_auth/
./start_bot.sh
```

### Python Pipeline Fails

```bash
# Test Python pipeline manually
source .venv/bin/activate
python -m src.pipeline_cli path/to/audio.wav --json

# Check LLM connectivity (uses LLM_BASE_URL from .env, default localhost:8081)
curl "${LLM_BASE_URL:-http://localhost:8081}/health"
```

### Bot Not Responding to Voice Messages

1. Check bot is running and authenticated
2. Verify `VOICEBOT_GROUP_ID` is correct in `.env`
3. Send voice message to configured group (not individual chat)
4. Check bot logs for errors

## Performance

Approximate latency per voice message (French, small Whisper model, CPU STT/TTS):
- Download: ~0.5s
- STT: ~1.5-2s
- LLM: ~2-3s (depends on your LLM server/hardware)
- TTS: ~1s
- Upload + status: ~0.5s
- **Total: ~6-7 seconds per voice message**

## Known Limitations

- **No persistent model**: each voice message spawns a new Python subprocess that reloads the Whisper model from disk. This adds latency vs. a long-running worker process — a reasonable target for a future improvement, not implemented here to keep the architecture simple.
- **Single-instance, no horizontal scaling**: one bot process, one WhatsApp session. Not designed for multiple concurrent group deployments from one codebase instance.
- **No per-user rate limiting**: anyone in the configured group can trigger the pipeline; there's no cooldown or quota per sender, only the global one-at-a-time queue.
- **Unofficial WhatsApp client**: see the note at the top of this README.

## Development

### Run with Auto-Reload

```bash
cd bot
npm run dev  # Watches for file changes
```

### Debug Mode

```bash
# Enable verbose logging
LOG_LEVEL=DEBUG ./start_bot.sh
```

## Support

For issues:
1. Check logs in terminal
2. Test Python pipeline: `python -m src.pipeline_cli path/to/audio.wav --json`
3. Verify Node.js and Python both working
4. Check `.env` configuration

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- **whatsapp-web.js**: WhatsApp Web client library (https://wwebjs.dev/)
- **faster-whisper**: Fast STT (https://github.com/guillaumekln/faster-whisper)
- **Piper TTS**: Fast TTS (https://github.com/rhasspy/piper)
