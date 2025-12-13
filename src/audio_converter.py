"""
Audio Format Converter - Handle conversions between WhatsApp and pipeline formats
"""
import os
import logging
from pydub import AudioSegment
from typing import Optional

logger = logging.getLogger(__name__)


def convert_whatsapp_audio_to_wav(input_path: str, output_path: str) -> str:
    """
    Convert WhatsApp audio (typically OGG/OPUS) to WAV for STT processing

    Args:
        input_path: Path to WhatsApp audio file (OGG/OPUS)
        output_path: Output WAV path

    Returns:
        Path to converted WAV file

    Raises:
        FileNotFoundError: If input file not found
        Exception: If conversion fails
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input audio file not found: {input_path}")

    try:
        logger.debug(f"Converting {input_path} to WAV")

        # Load audio file (pydub auto-detects format)
        audio = AudioSegment.from_file(input_path)

        # Convert to WAV with STT-friendly settings:
        # - 16kHz sample rate
        # - Mono (1 channel)
        # - PCM encoding
        audio = audio.set_frame_rate(16000).set_channels(1)

        # Ensure output directory exists
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        # Export as WAV
        audio.export(output_path, format="wav")

        file_size = os.path.getsize(output_path) / 1024  # KB
        logger.info(f"Converted to WAV: {output_path} ({file_size:.1f} KB)")

        return output_path

    except Exception as e:
        logger.error(f"Failed to convert audio to WAV: {e}")
        raise


def convert_wav_to_ogg_opus(wav_path: str, output_path: str) -> str:
    """
    Convert WAV to OGG/OPUS for WhatsApp (fallback if WAHA auto-convert fails)

    Args:
        wav_path: Input WAV file path
        output_path: Output OGG path

    Returns:
        Path to converted OGG file

    Raises:
        FileNotFoundError: If input file not found
        Exception: If conversion fails
    """
    if not os.path.exists(wav_path):
        raise FileNotFoundError(f"Input WAV file not found: {wav_path}")

    try:
        logger.debug(f"Converting {wav_path} to OGG/OPUS")

        # Load WAV file
        audio = AudioSegment.from_wav(wav_path)

        # Ensure output directory exists
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        # Export as OGG with OPUS codec
        # WhatsApp prefers specific settings:
        # - 16kHz sample rate
        # - Mono
        # - 24kbps bitrate (good quality for voice)
        audio.export(
            output_path,
            format="ogg",
            codec="libopus",
            parameters=[
                "-ar", "16000",      # 16kHz sample rate
                "-ac", "1",          # Mono
                "-b:a", "24k"        # 24kbps bitrate
            ]
        )

        file_size = os.path.getsize(output_path) / 1024  # KB
        logger.info(f"Converted to OGG/OPUS: {output_path} ({file_size:.1f} KB)")

        return output_path

    except Exception as e:
        logger.error(f"Failed to convert WAV to OGG/OPUS: {e}")
        raise


def validate_audio_file(file_path: str, max_size_mb: int = 10) -> bool:
    """
    Validate audio file (size, format, duration)

    Args:
        file_path: Path to audio file
        max_size_mb: Maximum file size in MB

    Returns:
        True if valid, False otherwise

    Raises:
        ValueError: If file is invalid with reason
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    # Check file size
    file_size_mb = os.path.getsize(file_path) / (1024 * 1024)
    if file_size_mb > max_size_mb:
        raise ValueError(f"File too large: {file_size_mb:.2f}MB (max {max_size_mb}MB)")

    try:
        # Load and validate with pydub
        audio = AudioSegment.from_file(file_path)
        duration_sec = len(audio) / 1000.0

        # Limit duration to 5 minutes (300 seconds)
        if duration_sec > 300:
            raise ValueError(f"Audio too long: {duration_sec:.1f}s (max 300s)")

        # Check if audio has content (not silent/empty)
        if duration_sec < 0.1:
            raise ValueError("Audio too short (< 0.1s)")

        logger.debug(f"Audio validated: {file_path} ({duration_sec:.1f}s, {file_size_mb:.2f}MB)")
        return True

    except Exception as e:
        logger.error(f"Audio validation failed: {e}")
        raise ValueError(f"Invalid audio file: {e}")


def get_audio_info(file_path: str) -> dict:
    """
    Get audio file information

    Args:
        file_path: Path to audio file

    Returns:
        Dict with audio properties (duration, channels, sample_rate, file_size)
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    audio = AudioSegment.from_file(file_path)

    return {
        "duration_sec": len(audio) / 1000.0,
        "channels": audio.channels,
        "sample_rate": audio.frame_rate,
        "file_size_mb": os.path.getsize(file_path) / (1024 * 1024)
    }
