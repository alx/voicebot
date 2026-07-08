from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from src.pipeline import VoicePipelineError
from src.worker import dispatch_line, handle_request


def _make_pipeline(**overrides):
    config = SimpleNamespace(
        TEXT_MAX_CHARS=1000,
        AUDIO_MAX_SIZE_MB=10,
        AUDIO_MAX_DURATION_SEC=300,
    )
    pipeline = MagicMock()
    pipeline.config = config
    for key, value in overrides.items():
        setattr(pipeline, key, value)
    return pipeline


def test_dispatch_line_text_request_success():
    pipeline = _make_pipeline()
    pipeline.run_text_pipeline.return_value = {"llm_response": "salut", "timing": {"llm": 1, "total": 1}}

    response = dispatch_line(pipeline, '{"id": 1, "type": "text", "text": "bonjour"}')

    assert response == {"id": 1, "success": True, "llm_response": "salut", "timing": {"llm": 1, "total": 1}}
    pipeline.run_text_pipeline.assert_called_once_with("bonjour")


def test_dispatch_line_text_over_max_chars_returns_validation_error():
    pipeline = _make_pipeline()

    response = dispatch_line(pipeline, '{"id": 2, "type": "text", "text": "' + "x" * 1001 + '"}')

    assert response["id"] == 2
    assert response["success"] is False
    assert response["error_type"] == "validation_error"
    assert "too long" in response["error"]
    pipeline.run_text_pipeline.assert_not_called()


def test_dispatch_line_voice_request_success_wav_no_conversion(tmp_path):
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"fake audio")
    pipeline = _make_pipeline()
    pipeline.run_pipeline.return_value = {
        "transcription": "bonjour",
        "language": "fr",
        "llm_response": "salut",
        "output_audio_path": str(tmp_path / "out.wav"),
        "timing": {"stt": 1, "llm": 1, "tts": 1, "total": 3},
    }

    with patch("src.worker.validate_audio_file") as mock_validate:
        response = dispatch_line(
            pipeline,
            f'{{"id": 3, "type": "voice", "audio_path": "{audio_path}"}}',
        )

    mock_validate.assert_called_once_with(str(audio_path), max_size_mb=10, max_duration_sec=300)
    assert response["success"] is True
    assert response["output_audio_path"].endswith("out.wav")


def test_dispatch_line_voice_request_converts_to_ogg(tmp_path):
    audio_path = tmp_path / "input.ogg"
    audio_path.write_bytes(b"fake audio")
    wav_output = tmp_path / "out.wav"
    pipeline = _make_pipeline()
    pipeline.run_pipeline.return_value = {
        "transcription": "bonjour",
        "language": "fr",
        "llm_response": "salut",
        "output_audio_path": str(wav_output),
        "timing": {"stt": 1, "llm": 1, "tts": 1, "total": 3},
    }

    with patch("src.worker.validate_audio_file"), \
         patch("src.worker.convert_wav_to_ogg_opus") as mock_convert, \
         patch("src.worker.os.remove") as mock_remove:
        response = dispatch_line(
            pipeline,
            f'{{"id": 4, "type": "voice", "audio_path": "{audio_path}", "output_format": "ogg"}}',
        )

    expected_ogg = str(wav_output).replace(".wav", ".ogg")
    mock_convert.assert_called_once_with(str(wav_output), expected_ogg)
    mock_remove.assert_called_once_with(str(wav_output))
    assert response["output_audio_path"] == expected_ogg


def test_dispatch_line_missing_audio_path_returns_validation_error():
    pipeline = _make_pipeline()

    response = dispatch_line(pipeline, '{"id": 5, "type": "voice"}')

    assert response == {
        "id": 5,
        "success": False,
        "error": "Missing audio_path for voice request",
        "error_type": "validation_error",
    }


def test_dispatch_line_unparseable_json_returns_validation_error():
    pipeline = _make_pipeline()

    response = dispatch_line(pipeline, "not json")

    assert response["id"] is None
    assert response["success"] is False
    assert response["error_type"] == "validation_error"


def test_dispatch_line_unknown_type_echoes_id_and_returns_validation_error():
    pipeline = _make_pipeline()

    response = dispatch_line(pipeline, '{"id": 6, "type": "bogus"}')

    assert response["id"] == 6
    assert response["success"] is False
    assert response["error_type"] == "validation_error"


def test_dispatch_line_maps_voice_pipeline_error_to_pipeline_error_type(tmp_path):
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"fake audio")
    pipeline = _make_pipeline()
    pipeline.run_pipeline.side_effect = VoicePipelineError("STT failed: boom")

    with patch("src.worker.validate_audio_file"):
        response = dispatch_line(pipeline, f'{{"id": 7, "type": "voice", "audio_path": "{audio_path}"}}')

    assert response == {"id": 7, "success": False, "error": "STT failed: boom", "error_type": "pipeline_error"}


def test_dispatch_line_maps_file_not_found_to_file_not_found_type():
    pipeline = _make_pipeline()

    with patch("src.worker.validate_audio_file", side_effect=FileNotFoundError("Audio file not found: /nope.wav")):
        response = dispatch_line(pipeline, '{"id": 8, "type": "voice", "audio_path": "/nope.wav"}')

    assert response == {
        "id": 8,
        "success": False,
        "error": "Audio file not found: /nope.wav",
        "error_type": "file_not_found",
    }


def test_dispatch_line_maps_unexpected_exception_to_unexpected_error_type():
    pipeline = _make_pipeline()
    pipeline.run_text_pipeline.side_effect = RuntimeError("boom")

    response = dispatch_line(pipeline, '{"id": 9, "type": "text", "text": "bonjour"}')

    assert response == {"id": 9, "success": False, "error": "boom", "error_type": "unexpected_error"}


def test_handle_request_text_returns_only_payload_fields():
    pipeline = _make_pipeline()
    pipeline.run_text_pipeline.return_value = {"llm_response": "salut", "timing": {"llm": 1, "total": 1}}

    result = handle_request(pipeline, {"type": "text", "text": "bonjour"})

    assert result == {"llm_response": "salut", "timing": {"llm": 1, "total": 1}}
