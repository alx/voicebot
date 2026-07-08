from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest
import requests

from src.llm_backends import (
    DirectBackend,
    SillyTavernBackend,
    VoicePipelineError,
    create_backend,
    _strip_narration,
)


def _st_config(**overrides):
    defaults = {"ST_BRIDGE_URL": "http://localhost:8091", "ST_BRIDGE_TIMEOUT": 60}
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _direct_config(**overrides):
    defaults = {
        "LLM_API_URL": "http://localhost:8081/v1/chat/completions",
        "LLM_HEALTH_URL": "http://localhost:8081/health",
        "LLM_MODEL_NAME": "test-model",
        "SYSTEM_PROMPT": "Tu es un assistant.",
        "LLM_TEMPERATURE": 0.7,
        "LLM_MAX_TOKENS": 200,
        "LLM_TIMEOUT": 60,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_direct_backend(**overrides):
    with patch("src.llm_backends.requests.get", side_effect=requests.exceptions.ConnectionError("refused")):
        return DirectBackend(_direct_config(**overrides))


def test_create_backend_returns_direct_by_default():
    backend = create_backend(_direct_config(LLM_BACKEND="direct"))
    assert isinstance(backend, DirectBackend)


def test_create_backend_returns_direct_when_llm_backend_missing():
    config = _direct_config()  # no LLM_BACKEND attribute at all
    backend = create_backend(config)
    assert isinstance(backend, DirectBackend)


def test_create_backend_returns_sillytavern_when_configured():
    backend = create_backend(_st_config(LLM_BACKEND="sillytavern"))
    assert isinstance(backend, SillyTavernBackend)


def test_direct_backend_checks_health_on_construction():
    with patch("src.llm_backends.requests.get") as mock_get:
        mock_get.return_value = MagicMock(status_code=200)
        DirectBackend(_direct_config())
    mock_get.assert_called_once_with("http://localhost:8081/health", timeout=5)


def test_direct_backend_construction_tolerates_failed_health_check():
    backend = _make_direct_backend()
    assert isinstance(backend, DirectBackend)


def test_direct_backend_get_reply_returns_llm_content():
    backend = _make_direct_backend()
    mock_response = MagicMock()
    mock_response.json.return_value = {"choices": [{"message": {"content": "Bonjour!"}}]}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response) as mock_post:
        result = backend.get_reply("Salut")

    assert result == "Bonjour!"
    mock_post.assert_called_once_with(
        "http://localhost:8081/v1/chat/completions",
        json={
            "model": "test-model",
            "messages": [
                {"role": "system", "content": "Tu es un assistant."},
                {"role": "user", "content": "Salut"},
            ],
            "temperature": 0.7,
            "max_tokens": 200,
        },
        timeout=60,
    )


def test_direct_backend_get_reply_raises_on_request_exception():
    backend = _make_direct_backend()

    with patch(
        "src.llm_backends.requests.post",
        side_effect=requests.exceptions.ConnectionError("refused"),
    ):
        with pytest.raises(VoicePipelineError, match="LLM query failed"):
            backend.get_reply("Salut")


def test_direct_backend_get_reply_raises_on_empty_response():
    backend = _make_direct_backend()
    mock_response = MagicMock()
    mock_response.json.return_value = {"choices": [{"message": {"content": "   "}}]}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Empty LLM response"):
            backend.get_reply("Salut")


def test_sillytavern_backend_returns_reply_on_success():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "Bonjour!"}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response) as mock_post:
        result = backend.get_reply("Salut")

    assert result == "Bonjour!"
    mock_post.assert_called_once_with(
        "http://localhost:8091/reply",
        json={"text": "Salut"},
        timeout=60,
    )


def test_sillytavern_backend_raises_on_request_exception():
    backend = SillyTavernBackend(_st_config())

    with patch(
        "src.llm_backends.requests.post",
        side_effect=requests.exceptions.ConnectionError("refused"),
    ):
        with pytest.raises(VoicePipelineError, match="SillyTavern bridge query failed"):
            backend.get_reply("Salut")


def test_sillytavern_backend_raises_on_empty_reply():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "   "}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Empty SillyTavern reply"):
            backend.get_reply("Salut")


def test_sillytavern_backend_raises_on_malformed_json():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"unexpected": "shape"}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Malformed SillyTavern bridge response"):
            backend.get_reply("Salut")


def test_sillytavern_backend_raises_on_non_string_reply():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": None}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Malformed SillyTavern bridge response"):
            backend.get_reply("Salut")


def test_sillytavern_backend_strips_narration_from_reply():
    backend = SillyTavernBackend(_st_config())
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "*sourit* Bonjour !"}
    mock_response.raise_for_status.return_value = None

    with patch("src.llm_backends.requests.post", return_value=mock_response):
        result = backend.get_reply("Salut")

    assert result == "Bonjour !"


def test_strip_narration_removes_asterisk_wrapped_asides():
    assert _strip_narration("*sourit* Bonjour !") == "Bonjour !"


def test_strip_narration_returns_original_text_when_entirely_narration():
    assert _strip_narration("*hausse les épaules*") == "*hausse les épaules*"
