#!/bin/bash

# Downloads the AI models the voice pipeline needs (Piper TTS voice +
# faster-whisper STT model) into project-local directories, so first boot
# doesn't need to hit the network again on every run.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [ ! -d ".venv" ]; then
    echo "Error: .venv not found. Create it first, e.g.:"
    echo "  uv venv --python 3.12 .venv"
    echo "  uv pip install -r requirements.txt --python .venv/bin/python"
    exit 1
fi

PYTHON=".venv/bin/python"

echo "=== Piper TTS voice (fr_FR-siwis-medium) ==="
if [ -f "models/piper/fr_FR-siwis-medium.onnx" ]; then
    echo "✓ Already present, skipping"
else
    mkdir -p models/piper
    "$PYTHON" -m piper.download_voices fr_FR-siwis-medium --download-dir models/piper
    echo "✓ Downloaded"
fi

echo
echo "=== faster-whisper STT model (small) ==="
if [ -f "models/faster-whisper-small/model.bin" ]; then
    echo "✓ Already present, skipping"
else
    echo "Downloading directly into a plain local directory (not the shared"
    echo "huggingface_hub cache — that cache's freshness check has been seen"
    echo "to falsely flag a complete download as incomplete and hang for"
    echo "minutes re-verifying it on every pipeline run)."
    echo "model.bin is ~460MB; this can take several minutes on a slow link."
    "$PYTHON" - <<'PYEOF'
from huggingface_hub import snapshot_download

snapshot_download(
    "Systran/faster-whisper-small",
    local_dir="models/faster-whisper-small",
    allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.*"],
)
print("✓ Downloaded")
PYEOF
fi

echo
echo "Models ready."
