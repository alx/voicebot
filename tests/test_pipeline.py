from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest
import requests

from src.pipeline import VoicePipeline, VoicePipelineError


def _make_pipeline(**config_overrides):
    """Build a VoicePipeline without running its heavy __init__ (no real STT/TTS/LLM)."""
    pipeline = VoicePipeline.__new__(VoicePipeline)
    defaults = {
        "ST_BRIDGE_URL": "http://localhost:8091",
        "ST_BRIDGE_TIMEOUT": 60,
        "LLM_BACKEND": "direct",
    }
    defaults.update(config_overrides)
    pipeline.config = SimpleNamespace(**defaults)
    return pipeline


def test_query_sillytavern_returns_reply_on_success():
    pipeline = _make_pipeline()
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "Bonjour!"}
    mock_response.raise_for_status.return_value = None

    with patch("src.pipeline.requests.post", return_value=mock_response) as mock_post:
        result = pipeline.query_sillytavern("Salut")

    assert result == "Bonjour!"
    mock_post.assert_called_once_with(
        "http://localhost:8091/reply",
        json={"text": "Salut"},
        timeout=60,
    )


def test_query_sillytavern_raises_on_request_exception():
    pipeline = _make_pipeline()

    with patch(
        "src.pipeline.requests.post",
        side_effect=requests.exceptions.ConnectionError("refused"),
    ):
        with pytest.raises(VoicePipelineError, match="SillyTavern bridge query failed"):
            pipeline.query_sillytavern("Salut")


def test_query_sillytavern_raises_on_empty_reply():
    pipeline = _make_pipeline()
    mock_response = MagicMock()
    mock_response.json.return_value = {"reply": "   "}
    mock_response.raise_for_status.return_value = None

    with patch("src.pipeline.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Empty SillyTavern reply"):
            pipeline.query_sillytavern("Salut")


def test_query_sillytavern_raises_on_malformed_json():
    pipeline = _make_pipeline()
    mock_response = MagicMock()
    mock_response.json.return_value = {"unexpected": "shape"}
    mock_response.raise_for_status.return_value = None

    with patch("src.pipeline.requests.post", return_value=mock_response):
        with pytest.raises(VoicePipelineError, match="Malformed SillyTavern bridge response"):
            pipeline.query_sillytavern("Salut")


def test_run_pipeline_dispatches_to_sillytavern_when_configured(tmp_path):
    input_wav = tmp_path / "input.wav"
    input_wav.write_bytes(b"fake audio")

    pipeline = _make_pipeline(
        LLM_BACKEND="sillytavern",
        AUDIO_OUTPUT_DIR=str(tmp_path / "output"),
    )

    with patch.object(pipeline, "transcribe_audio", return_value=("bonjour", "fr")), \
         patch.object(pipeline, "query_sillytavern", return_value="salut!") as mock_st, \
         patch.object(pipeline, "query_llm") as mock_direct, \
         patch.object(pipeline, "synthesize_speech"):
        result = pipeline.run_pipeline(str(input_wav))

    mock_st.assert_called_once_with("bonjour")
    mock_direct.assert_not_called()
    assert result["llm_response"] == "salut!"


def test_run_pipeline_dispatches_to_direct_llm_by_default(tmp_path):
    input_wav = tmp_path / "input.wav"
    input_wav.write_bytes(b"fake audio")

    pipeline = _make_pipeline(
        LLM_BACKEND="direct",
        AUDIO_OUTPUT_DIR=str(tmp_path / "output"),
    )

    with patch.object(pipeline, "transcribe_audio", return_value=("bonjour", "fr")), \
         patch.object(pipeline, "query_llm", return_value="salut!") as mock_direct, \
         patch.object(pipeline, "query_sillytavern") as mock_st, \
         patch.object(pipeline, "synthesize_speech"):
        result = pipeline.run_pipeline(str(input_wav))

    mock_direct.assert_called_once_with("bonjour", "fr")
    mock_st.assert_not_called()
    assert result["llm_response"] == "salut!"
