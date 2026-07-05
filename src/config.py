"""
Configuration file for Voice Bot STT->LLM->TTS Pipeline
"""
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Project paths
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_INPUT_DIR = os.path.join(PROJECT_ROOT, "audio", "input")
AUDIO_OUTPUT_DIR = os.path.join(PROJECT_ROOT, "audio", "output")
TEMP_AUDIO_DIR = os.path.join(PROJECT_ROOT, "audio", "temp")
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
LOGS_DIR = os.path.join(PROJECT_ROOT, "logs")

# GPU configuration
CUDA_DEVICE = "cuda:0"  # Use GPU 0 only
os.environ["CUDA_VISIBLE_DEVICES"] = "0"

# STT Configuration (faster-whisper)
STT_MODEL_SIZE = "small"  # Options: tiny, base, small, medium, large
STT_LANGUAGE = "fr"       # French language code (or None for auto-detect)
STT_COMPUTE_TYPE = "int8"  # Options: float16, int8, float32
STT_DEVICE = "cpu"        # Using CPU due to cuDNN issues
STT_BEAM_SIZE = 5         # Accuracy vs speed tradeoff (1-10)
STT_DOWNLOAD_ROOT = os.path.join(MODELS_DIR, "faster-whisper")

# LLM Configuration (llama-server / any OpenAI-compatible chat completions API)
# Point this at your own LLM server, e.g. llama-server, ollama, vLLM, LM Studio
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://localhost:8081")
LLM_API_URL = f"{LLM_BASE_URL}/v1/chat/completions"
LLM_HEALTH_URL = f"{LLM_BASE_URL}/health"
LLM_MODEL_NAME = os.getenv("LLM_MODEL_NAME", "Qwen3VL-8B-Instruct-Q4_K_M.gguf")
LLM_TEMPERATURE = 0.7
LLM_MAX_TOKENS = 200
LLM_TIMEOUT = 60          # seconds

# TTS Configuration (Piper)
TTS_LANGUAGE = "fr"       # Default output language (fr or en)
TTS_DEVICE = "cpu"        # Using CPU to avoid GPU memory conflicts

# System prompt for LLM
SYSTEM_PROMPT = """Tu es un assistant vocal bilingue (français/anglais).
Réponds de manière concise (2-3 phrases maximum) dans la langue utilisée par l'utilisateur.
Tes réponses seront converties en audio, donc sois naturel et conversationnel."""

# Audio Processing
AUDIO_DOWNLOAD_TIMEOUT = 30  # seconds
AUDIO_MAX_SIZE_MB = 10

# Status Messages (French)
STATUS_MESSAGES = {
    "received": "🎤 Message vocal reçu, traitement en cours...",
    "transcription": "📝 Transcription: {}",
    "llm_response": "🤖 Réponse: {}",
    "error": "❌ Erreur: {}",
    "processing": "⚙️ Traitement...",
}

# Error Handling
ENABLE_ERROR_NOTIFICATIONS = True
MAX_RETRIES = 3
RETRY_DELAY = 2  # seconds

# Logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")  # DEBUG, INFO, WARNING, ERROR
