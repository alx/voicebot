#!/usr/bin/env python3
"""
Test STT component only
Usage: python test_stt_only.py <input_wav_file>
"""

import sys
import os
import time
from pathlib import Path
from faster_whisper import WhisperModel
import config

def main():
    if len(sys.argv) < 2:
        print("Usage: python test_stt_only.py <input_wav_file>")
        print("\nExample:")
        print("  python test_stt_only.py audio/input/sample_greeting.wav")
        sys.exit(1)

    input_file = sys.argv[1]

    if not os.path.exists(input_file):
        print(f"❌ Error: Input file not found: {input_file}")
        sys.exit(1)

    try:
        print("\n" + "=" * 60)
        print("STT TEST - faster-whisper")
        print("=" * 60)

        os.environ["CUDA_VISIBLE_DEVICES"] = "0"

        print(f"\n[1/2] Loading faster-whisper ({config.STT_MODEL_SIZE})")
        start = time.time()
        model = WhisperModel(
            model_size_or_path=config.STT_MODEL_SIZE,
            device=config.STT_DEVICE,
            compute_type=config.STT_COMPUTE_TYPE,
            download_root=config.STT_DOWNLOAD_ROOT
        )
        print(f"✓ Model loaded in {time.time() - start:.2f}s")

        print(f"\n[2/2] Transcribing: {Path(input_file).name}")
        start = time.time()

        segments, info = model.transcribe(
            audio=input_file,
            language=config.STT_LANGUAGE,
            beam_size=config.STT_BEAM_SIZE,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )

        transcription = " ".join([segment.text.strip() for segment in segments])
        detected_lang = info.language if config.STT_LANGUAGE is None else config.STT_LANGUAGE

        elapsed = time.time() - start
        print(f"✓ Transcription completed in {elapsed:.2f}s")
        print(f"\nResults:")
        print(f"  Language: {detected_lang}")
        print(f"  Text: \"{transcription}\"")

        print("\n" + "=" * 60)
        print("✅ STT TEST COMPLETE!")
        print("=" * 60 + "\n")

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
