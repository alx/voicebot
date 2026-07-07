"""
Configuration for the Python STT->LLM->TTS pipeline.

Config scope: pipeline behavior only — model selection, LLM endpoints,
audio limits. WhatsApp-side settings live in bot/config.js; SillyTavern
bridge settings live in st-bridge/config.js.

Deliberately duplicated with bot/config.js: TEXT_MAX_CHARS (same
TEXT_MAX_CHARS env var on both sides), so Node can reject oversized
messages without spawning Python while Python still enforces the limit
for direct CLI use.
"""
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Project paths
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_OUTPUT_DIR = os.path.join(PROJECT_ROOT, "audio", "output")
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")

# GPU configuration
os.environ["CUDA_VISIBLE_DEVICES"] = "0"

# STT Configuration (faster-whisper)
STT_MODEL_SIZE = "small"  # Options: tiny, base, small, medium, large
STT_LANGUAGE = "fr"       # French language code (or None for auto-detect)
STT_COMPUTE_TYPE = "int8"  # Options: float16, int8, float32
STT_DEVICE = "cpu"        # Using CPU due to cuDNN issues
STT_BEAM_SIZE = 5         # Accuracy vs speed tradeoff (1-10)
STT_DOWNLOAD_ROOT = os.path.join(MODELS_DIR, "faster-whisper")
# Plain local model directory (config.json/model.bin/tokenizer.json/vocabulary.txt),
# used instead of STT_MODEL_SIZE/STT_DOWNLOAD_ROOT when present. Bypasses
# huggingface_hub's online cache-freshness check entirely, which can hang for
# minutes re-verifying an already-complete download over a slow connection.
STT_LOCAL_MODEL_PATH = os.path.join(MODELS_DIR, "faster-whisper-small")

# LLM Configuration (llama-server / any OpenAI-compatible chat completions API)
# Point this at your own LLM server, e.g. llama-server, ollama, vLLM, LM Studio
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://localhost:8081")
LLM_API_URL = f"{LLM_BASE_URL}/v1/chat/completions"
LLM_HEALTH_URL = f"{LLM_BASE_URL}/health"
LLM_MODEL_NAME = os.getenv("LLM_MODEL_NAME", "Qwen3VL-8B-Instruct-Q4_K_M.gguf")
LLM_TEMPERATURE = 0.7
LLM_MAX_TOKENS = 200
LLM_TIMEOUT = 60          # seconds

# SillyTavern persona route (optional alternate backend for the LLM step)
# "direct" calls LLM_API_URL as today; "sillytavern" routes through st-bridge instead
LLM_BACKEND = os.getenv("LLM_BACKEND", "direct")
ST_BRIDGE_URL = os.getenv("ST_BRIDGE_URL", "http://localhost:8091")
ST_BRIDGE_TIMEOUT = 60  # seconds

# TTS Configuration (Piper)
TTS_MODEL_PATH = os.path.join(MODELS_DIR, "piper", "fr_FR-siwis-medium.onnx")

# System prompt for LLM
SYSTEM_PROMPT = """Tu es un assistant vocal bilingue (français/anglais).
Réponds de manière concise (2-3 phrases maximum) dans la langue utilisée par l'utilisateur.
Tes réponses seront converties en audio, donc sois naturel et conversationnel."""

# Audio Processing
AUDIO_MAX_SIZE_MB = 10
AUDIO_MAX_DURATION_SEC = 300  # 5 minutes

# Text message processing
TEXT_MAX_CHARS = int(os.getenv("TEXT_MAX_CHARS", "1000"))

# Logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")  # DEBUG, INFO, WARNING, ERROR
