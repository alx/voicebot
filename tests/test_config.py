import importlib
import os

import pytest


def _reload_config():
    from src import config
    importlib.reload(config)
    return config


def test_llm_base_url_defaults_to_localhost(monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    config = _reload_config()
    assert config.LLM_API_URL == "http://localhost:8081/v1/chat/completions"
    assert config.LLM_HEALTH_URL == "http://localhost:8081/health"


def test_llm_base_url_override(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "http://example.internal:9000")
    config = _reload_config()
    assert config.LLM_API_URL == "http://example.internal:9000/v1/chat/completions"
    assert config.LLM_HEALTH_URL == "http://example.internal:9000/health"


def test_dead_waha_and_tts_config_removed():
    config = _reload_config()
    for attr in (
        "WAHA_URL",
        "WAHA_SESSION",
        "WAHA_WEBHOOK_PORT",
        "VOICEBOT_CHAT_ID",
        "TTS_MODEL_NAME",
        "TTS_SPEAKER_WAV",
    ):
        assert not hasattr(config, attr), f"{attr} should have been removed"


def test_llm_backend_defaults_to_direct(monkeypatch):
    monkeypatch.delenv("LLM_BACKEND", raising=False)
    config = _reload_config()
    assert config.LLM_BACKEND == "direct"


def test_llm_backend_override(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "sillytavern")
    config = _reload_config()
    assert config.LLM_BACKEND == "sillytavern"


def test_st_bridge_url_defaults_to_localhost(monkeypatch):
    monkeypatch.delenv("ST_BRIDGE_URL", raising=False)
    config = _reload_config()
    assert config.ST_BRIDGE_URL == "http://localhost:8091"


def test_st_bridge_url_override(monkeypatch):
    monkeypatch.setenv("ST_BRIDGE_URL", "http://example.internal:9100")
    config = _reload_config()
    assert config.ST_BRIDGE_URL == "http://example.internal:9100"


def test_st_bridge_timeout_is_an_int():
    config = _reload_config()
    assert config.ST_BRIDGE_TIMEOUT == 60


def test_text_max_chars_defaults_to_1000(monkeypatch):
    monkeypatch.delenv("TEXT_MAX_CHARS", raising=False)
    config = _reload_config()
    assert config.TEXT_MAX_CHARS == 1000


def test_text_max_chars_override(monkeypatch):
    monkeypatch.setenv("TEXT_MAX_CHARS", "500")
    config = _reload_config()
    assert config.TEXT_MAX_CHARS == 500


def test_dead_pipeline_config_removed_slice1():
    config = _reload_config()
    for attr in (
        "STATUS_MESSAGES",
        "MAX_RETRIES",
        "RETRY_DELAY",
        "AUDIO_DOWNLOAD_TIMEOUT",
        "LOGS_DIR",
        "ENABLE_ERROR_NOTIFICATIONS",
        "TTS_LANGUAGE",
        "TTS_DEVICE",
        "AUDIO_INPUT_DIR",
        "TEMP_AUDIO_DIR",
        "CUDA_DEVICE",
    ):
        assert not hasattr(config, attr), f"{attr} should have been removed"


def test_tts_model_path_points_at_bundled_piper_voice():
    config = _reload_config()
    assert config.TTS_MODEL_PATH == os.path.join(
        config.MODELS_DIR, "piper", "fr_FR-siwis-medium.onnx"
    )
