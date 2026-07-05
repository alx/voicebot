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
