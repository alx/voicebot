#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "=== WhatsApp Voice Bot (whatsapp-web.js) ==="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found"
    echo ""
    echo "Create .env file from template:"
    echo "  cp .env.example .env"
    echo ""
    echo "Then edit .env and set VOICEBOT_GROUP_ID (optional on first run)"
    echo "Run the bot once without GROUP_ID to find your group ID in the logs"
    echo ""
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js not installed"
    echo "Install Node.js from: https://nodejs.org/"
    exit 1
fi

echo "✓ Node.js version: $(node --version)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm not installed"
    exit 1
fi

# Install Node dependencies if needed
if [ ! -d "bot/node_modules" ]; then
    echo ""
    echo "Installing Node.js dependencies..."
    cd bot && npm install && cd ..
    echo "✓ Dependencies installed"
fi

# Check Python virtual environment
if [ ! -d ".venv" ]; then
    echo ""
    echo "❌ Error: Python virtual environment not found at .venv"
    echo "Create it with: python3 -m venv .venv"
    exit 1
fi

# Activate Python virtual environment
source .venv/bin/activate
echo "✓ Python virtual environment activated"

# Create temp directory
mkdir -p audio/temp
echo "✓ Created temp audio directory"

# Load LLM_BASE_URL from .env if set (falls back to the same default as src/config.py)
set -a
source .env
set +a
LLM_BASE_URL="${LLM_BASE_URL:-http://localhost:8081}"

# Check LLM connectivity (optional warning)
echo ""
echo "Checking LLM connectivity..."
if curl -s "${LLM_BASE_URL}/health" > /dev/null 2>&1; then
    echo "✓ LLM accessible"
else
    echo "⚠️  Warning: LLM not accessible at ${LLM_BASE_URL}"
    echo "   Voice processing may fail without LLM"
fi

# Check if chromium/puppeteer dependencies are available
echo ""
echo "Checking system dependencies..."
if command -v chromium &> /dev/null || command -v chromium-browser &> /dev/null || command -v google-chrome &> /dev/null; then
    echo "✓ Chromium/Chrome found"
else
    echo "⚠️  Warning: Chromium not found"
    echo "   Install with: sudo apt install chromium-browser (Ubuntu/Debian)"
fi

# Start bot
echo ""
echo "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "="
echo "Starting WhatsApp Voice Bot..."
echo ""
echo "On first run:"
echo "  1. A QR code will appear in terminal"
echo "  2. Open WhatsApp on your phone"
echo "  3. Go to Settings → Linked Devices"
echo "  4. Tap 'Link a Device'"
echo "  5. Scan the QR code"
echo ""
echo "After authentication:"
echo "  - Session will be saved in .wwebjs_auth/"
echo "  - No QR code needed on subsequent runs"
echo "  - Send voice message to find/set group ID"
echo ""
echo "Press Ctrl+C to stop"
echo "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "=" "="
echo ""

export CUDA_VISIBLE_DEVICES=0

# Run the bot
cd bot && node index.js
