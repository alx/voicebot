#!/usr/bin/env python3
"""
Test STT and TTS components independently (no LLM required)
Usage: python test_stt_tts.py <input_wav_file>
"""

import sys
import os

# Force CPU for TTS to avoid cuDNN issues
os.environ["COQUI_TOS_AGREED"] = "1"

import time
from pathlib import Path
from datetime import datetime
from faster_whisper import WhisperModel
from TTS.api import TTS
import config

def test_stt(audio_path: str):
    """Test Speech-to-Text"""
    print("=" * 60)
    print("[STT TEST] Initializing faster-whisper")
    print("=" * 60)

    os.environ["CUDA_VISIBLE_DEVICES"] = "0"

    start = time.time()
    model = WhisperModel(
        model_size_or_path=config.STT_MODEL_SIZE,
        device=config.STT_DEVICE,
        compute_type=config.STT_COMPUTE_TYPE,
        download_root=config.STT_DOWNLOAD_ROOT
    )
    print(f"✓ Model loaded in {time.time() - start:.2f}s\n")

    print(f"[STT TEST] Transcribing: {Path(audio_path).name}")
    start = time.time()

    segments, info = model.transcribe(
        audio=audio_path,
        language=config.STT_LANGUAGE,
        beam_size=config.STT_BEAM_SIZE,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500)
    )

    transcription = " ".join([segment.text.strip() for segment in segments])
    detected_lang = info.language if config.STT_LANGUAGE is None else config.STT_LANGUAGE

    elapsed = time.time() - start
    print(f"✓ Transcription completed in {elapsed:.2f}s")
    print(f"  Language: {detected_lang}")
    print(f"  Text: \"{transcription}\"\n")

    return transcription, detected_lang

def test_tts(text: str, language: str, output_path: str):
    """Test Text-to-Speech"""
    print("=" * 60)
    print("[TTS TEST] Initializing XTTS v2")
    print("=" * 60)

    start = time.time()
    tts_model = TTS(
        model_name=config.TTS_MODEL_NAME,
        progress_bar=False
    ).to(config.TTS_DEVICE)
    print(f"✓ Model loaded in {time.time() - start:.2f}s\n")

    print(f"[TTS TEST] Synthesizing speech ({language})")
    print(f"  Input text: \"{text}\"")
    start = time.time()

    tts_model.tts_to_file(
        text=text,
        file_path=output_path,
        speaker_wav=config.TTS_SPEAKER_WAV,
        language=language
    )

    elapsed = time.time() - start
    file_size = os.path.getsize(output_path) / 1024  # KB
    print(f"✓ Synthesis completed in {elapsed:.2f}s")
    print(f"  Output: {output_path} ({file_size:.1f} KB)\n")

    return output_path

def main():
    if len(sys.argv) < 2:
        print("Usage: python test_stt_tts.py <input_wav_file>")
        print("\nExample:")
        print("  python test_stt_tts.py audio/input/sample_greeting.wav")
        sys.exit(1)

    input_file = sys.argv[1]

    if not os.path.exists(input_file):
        print(f"❌ Error: Input file not found: {input_file}")
        sys.exit(1)

    os.makedirs(config.AUDIO_OUTPUT_DIR, exist_ok=True)

    try:
        print("\n" + "=" * 60)
        print("TESTING STT -> TTS PIPELINE (NO LLM)")
        print("=" * 60 + "\n")

        # Test STT
        transcription, detected_lang = test_stt(input_file)

        if not transcription.strip():
            print("❌ No transcription generated (empty audio?)")
            sys.exit(1)

        # Prepare mock LLM response (echo the transcription)
        mock_response = f"Vous avez dit: {transcription}"
        print("=" * 60)
        print("[MOCK LLM] Using mock response (LLM not connected)")
        print("=" * 60)
        print(f"  Input: \"{transcription}\"")
        print(f"  Output: \"{mock_response}\"\n")

        # Test TTS
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        input_name = Path(input_file).stem
        output_filename = f"{input_name}_tts_test_{timestamp}.wav"
        output_path = os.path.join(config.AUDIO_OUTPUT_DIR, output_filename)

        test_tts(mock_response, detected_lang, output_path)

        print("=" * 60)
        print("✅ TEST COMPLETE!")
        print("=" * 60)
        print(f"\nPlay output with:")
        print(f"  ffplay {output_path}")
        print(f"  # or")
        print(f"  aplay {output_path}\n")

    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
