from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest
import requests

from src.pipeline import VoicePipeline, VoicePipelineError


def _make_pipeline(**config_overrides):
    """Build a VoicePipeline without running its heavy __init__ (no real STT/TTS/LLM)."""
    pipeline = VoicePipeline.__new__(VoicePipeline)
    pipeline.config = SimpleNamespace(**config_overrides)
    return pipeline


def test_run_pipeline_calls_backend_get_reply(tmp_path):
    input_wav = tmp_path / "input.wav"
    input_wav.write_bytes(b"fake audio")

    pipeline = _make_pipeline(AUDIO_OUTPUT_DIR=str(tmp_path / "output"))
    pipeline.backend = MagicMock()
    pipeline.backend.get_reply.return_value = "salut!"

    with patch.object(pipeline, "transcribe_audio", return_value=("bonjour", "fr")), \
         patch.object(pipeline, "synthesize_speech"):
        result = pipeline.run_pipeline(str(input_wav))

    pipeline.backend.get_reply.assert_called_once_with("bonjour")
    assert result["llm_response"] == "salut!"


def test_init_does_not_load_stt_model():
    """Constructing VoicePipeline must not touch WhisperModel until transcribe_audio() is called."""
    config = SimpleNamespace(
        STT_LOCAL_MODEL_PATH="/nonexistent/path",
        STT_MODEL_SIZE="small",
        STT_DEVICE="cpu",
        STT_COMPUTE_TYPE="int8",
        STT_DOWNLOAD_ROOT="/nonexistent/download-root",
        LLM_API_URL="http://localhost:8081/v1/chat/completions",
        LLM_HEALTH_URL="http://localhost:8081/health",
        LLM_BACKEND="direct",
        PROJECT_ROOT="/nonexistent/project-root",
    )
    with patch("src.llm_backends.requests.get", side_effect=requests.exceptions.ConnectionError("refused")), \
         patch("src.pipeline.WhisperModel") as mock_whisper:
        pipeline = VoicePipeline(config)

    mock_whisper.assert_not_called()
    assert not hasattr(pipeline, "stt_model")


def test_transcribe_audio_loads_stt_model_on_first_call(tmp_path):
    """transcribe_audio() must load the model lazily via _ensure_stt()."""
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"fake audio")

    config = SimpleNamespace(
        STT_LOCAL_MODEL_PATH="/nonexistent/path",
        STT_MODEL_SIZE="small",
        STT_DEVICE="cpu",
        STT_COMPUTE_TYPE="int8",
        STT_DOWNLOAD_ROOT="/nonexistent/download-root",
        STT_LANGUAGE="fr",
        STT_BEAM_SIZE=5,
    )
    pipeline = VoicePipeline.__new__(VoicePipeline)
    pipeline.config = config

    mock_segment = SimpleNamespace(text=" bonjour ")
    mock_model = MagicMock()
    mock_model.transcribe.return_value = ([mock_segment], SimpleNamespace(language="fr"))

    with patch("src.pipeline.WhisperModel", return_value=mock_model) as mock_whisper_cls:
        text, lang = pipeline.transcribe_audio(str(audio_path))
        # Second call must not reload the model
        pipeline.transcribe_audio(str(audio_path))

    mock_whisper_cls.assert_called_once()
    assert text == "bonjour"
    assert lang == "fr"


def test_synthesize_speech_checks_piper_model_on_first_call(tmp_path):
    """synthesize_speech() must validate/set self.piper_model lazily via _ensure_tts()."""
    config = SimpleNamespace(TTS_MODEL_PATH=str(tmp_path / "fr_FR-siwis-medium.onnx"))
    pipeline = VoicePipeline.__new__(VoicePipeline)
    pipeline.config = config

    with pytest.raises(VoicePipelineError, match="Piper model not found"):
        pipeline.synthesize_speech("bonjour", "fr", str(tmp_path / "out.wav"))


def test_run_text_pipeline_calls_backend_get_reply():
    pipeline = _make_pipeline()
    pipeline.backend = MagicMock()
    pipeline.backend.get_reply.return_value = "salut!"

    result = pipeline.run_text_pipeline("bonjour")

    pipeline.backend.get_reply.assert_called_once_with("bonjour")
    assert result["llm_response"] == "salut!"
    assert "llm" in result["timing"]
    assert "total" in result["timing"]


def test_run_text_pipeline_raises_on_empty_text():
    pipeline = _make_pipeline()
    pipeline.backend = MagicMock()

    with pytest.raises(VoicePipelineError, match="Empty text input"):
        pipeline.run_text_pipeline("   ")
