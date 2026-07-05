import wave

import pytest

from src.audio_converter import validate_audio_file


def _write_silent_wav(path, duration_sec, frame_rate=16000):
    n_frames = int(duration_sec * frame_rate)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(frame_rate)
        wav_file.writeframes(b"\x00\x00" * n_frames)


def test_validate_audio_file_rejects_oversized_file(tmp_path):
    big_file = tmp_path / "big.wav"
    big_file.write_bytes(b"\x00" * (2 * 1024 * 1024))  # 2MB of zero bytes

    with pytest.raises(ValueError, match="too large"):
        validate_audio_file(str(big_file), max_size_mb=1)


def test_validate_audio_file_accepts_normal_file(tmp_path):
    normal_file = tmp_path / "normal.wav"
    _write_silent_wav(normal_file, duration_sec=2)

    assert validate_audio_file(str(normal_file), max_size_mb=10, max_duration_sec=300) is True


def test_validate_audio_file_rejects_too_long_duration(tmp_path):
    long_file = tmp_path / "long.wav"
    _write_silent_wav(long_file, duration_sec=5)

    with pytest.raises(ValueError, match="Invalid audio file"):
        validate_audio_file(str(long_file), max_size_mb=10, max_duration_sec=1)
