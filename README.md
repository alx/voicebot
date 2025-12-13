# WhatsApp Voice Bot - whatsapp-web.js

A WhatsApp voice bot that processes voice messages through an STT→LLM→TTS pipeline using whatsapp-web.js.

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
- 📝 Transcribes speech using faster-whisper (French/English)
- 🤖 Generates responses using remote LLM (Qwen3VL-8B)
- 🔊 Synthesizes speech using Piper TTS
- ✅ Sends 4 status updates: acknowledgment, transcription, LLM response, audio
- 🔐 QR code authentication (once), session persisted
- ❌ Graceful error handling with user notifications

## Prerequisites

1. **Node.js** (v18+)
   ```bash
   node --version  # Check if installed
   ```

2. **Python 3.8+** with virtual environment
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

5. **LLM server** accessible at `http://100.86.147.125:8081` (or update config)

## Quick Start

### 1. Install Dependencies

**Node.js:**
```bash
cd bot
npm install
```

**Python:** (already installed if you ran WAHA version)
```bash
source .venv/bin/activate
# Dependencies already installed from previous implementation
```

### 2. Configure Environment

```bash
# Create .env from template
cp .env.example .env

# Edit .env (VOICEBOT_GROUP_ID is optional on first run)
nano .env
```

### 3. Start the Bot

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

### 4. Find Your Group ID

**Option A: Use the Group ID Finder Script (Recommended)**

Run the provided script to list all your groups:
```bash
./get_group_id.sh
```

This will display all your WhatsApp groups with their IDs. Copy the ID you want to use.

See [GET_GROUP_ID.md](GET_GROUP_ID.md) for detailed instructions.

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

### 5. Test with Voice Message

1. Send a voice message to the configured group
2. Bot will respond with 4 messages:
   - 🎤 "Message vocal reçu..."
   - 📝 "Transcription: {your speech}"
   - 🤖 "Réponse: {LLM answer}"
   - 🔊 Voice audio file

## Project Structure

```
voice_bot/
├── bot/                      # Node.js WhatsApp bot
│   ├── index.js              # Main bot entry point
│   ├── voice-handler.js      # Voice message processing
│   ├── config.js             # Bot configuration
│   ├── package.json          # Node dependencies
│   └── .wwebjs_auth/         # Session data (auto-created)
│
├── src/                      # Python pipeline
│   ├── pipeline.py           # VoicePipeline class
│   ├── pipeline_cli.py       # CLI wrapper (NEW)
│   ├── audio_converter.py    # Format conversions
│   └── config.py             # Python config
│
├── tests/step1/              # Original test files
├── audio/                    # Audio files
├── models/                   # AI models
├── .env                      # Configuration
└── start_bot.sh              # Startup script
```

## Configuration

### Environment Variables (.env)

```bash
# WhatsApp group ID (format: 120363123456789@g.us)
VOICEBOT_GROUP_ID=

# Optional: Python command override
# PYTHON_CMD=python3

# Optional: Logging level
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

## Testing

### Test Python Pipeline Directly

```bash
source .venv/bin/activate

# Test with sample audio
python -m src.pipeline_cli audio/input/sample_greeting.wav --json

# Expected output: JSON with transcription, llm_response, output_audio_path
```

### Test Individual Components

```bash
# Original standalone test (still works)
cd tests/step1
python test_pipeline.py ../../audio/input/sample_greeting.wav
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
python -m src.pipeline_cli audio/input/sample_greeting.wav --json

# Check LLM connectivity
curl http://100.86.147.125:8081/health
```

### Bot Not Responding to Voice Messages

1. Check bot is running and authenticated
2. Verify `VOICEBOT_GROUP_ID` is correct in `.env`
3. Send voice message to configured group (not individual chat)
4. Check bot logs for errors

## Performance

Same as WAHA implementation:
- Download: ~0.5s
- STT: ~1.9s
- LLM: ~2.4s
- TTS: ~1.1s
- Upload + status: ~0.5s
- **Total: ~6-7 seconds per voice message**

## Advantages Over WAHA

1. ✅ No Docker container needed
2. ✅ Direct WhatsApp Web connection
3. ✅ Event-driven (more reliable than webhooks)
4. ✅ Session persistence (QR code only once)
5. ✅ Simpler deployment (single process)
6. ✅ No external service dependency

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

### Manual Testing

```bash
# Test Node.js can call Python
cd bot
node -e "
const { spawn } = require('child_process');
const py = spawn('python', ['-m', 'src.pipeline_cli', '--help'], {cwd: '..'});
py.stdout.on('data', d => console.log(d.toString()));
"
```

## Files Changed from WAHA Version

**New Files:**
- `bot/index.js` - WhatsApp bot entry point
- `bot/voice-handler.js` - Message processing
- `bot/config.js` - Bot configuration
- `bot/package.json` - Node dependencies
- `src/pipeline_cli.py` - CLI wrapper for pipeline

**Removed Files:**
- `src/waha_client.py` - WAHA-specific client
- `src/webhook_server.py` - FastAPI webhook server

**Modified Files:**
- `.env.example` - Updated for whatsapp-web.js
- `.gitignore` - Added Node.js and .wwebjs_auth/
- `start_bot.sh` - New startup script

**Unchanged Files:**
- `src/pipeline.py` - Pipeline logic (reused)
- `src/audio_converter.py` - Audio conversions
- `src/config.py` - Python config
- `tests/step1/*` - All test files

## Support

For issues:
1. Check logs in terminal
2. Test Python pipeline: `python -m src.pipeline_cli audio/input/sample_greeting.wav --json`
3. Verify Node.js and Python both working
4. Check `.env` configuration

## License

MIT

## Acknowledgments

- **whatsapp-web.js**: WhatsApp Web client library (https://wwebjs.dev/)
- **faster-whisper**: Fast STT (https://github.com/guillaumekln/faster-whisper)
- **Piper TTS**: Fast TTS (https://github.com/rhasspy/piper)
