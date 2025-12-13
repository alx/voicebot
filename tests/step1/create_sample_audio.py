#!/usr/bin/env python3
"""
Create sample French audio files for testing the STT pipeline.
Uses espeak-ng for text-to-speech to generate test input.
"""

import subprocess
import os
import sys
from pathlib import Path

SAMPLE_TEXTS = {
    "greeting": "Bonjour, comment allez-vous aujourd'hui?",
    "question": "Quelle est la météo pour demain à Paris?",
    "story": "J'ai visité le musée du Louvre hier. C'était magnifique!",
    "short": "Salut, ça va?"
}

def create_audio_with_espeak(text: str, output_path: str):
    """Generate audio using espeak-ng (must be installed)"""
    try:
        subprocess.run([
            "espeak-ng",
            "-v", "fr",           # French voice
            "-w", output_path,    # Write to wav file
            "-s", "150",          # Speed (150 wpm)
            text
        ], check=True, capture_output=True)
        print(f"✅ Created: {output_path}")
        return True
    except FileNotFoundError:
        print("❌ ERROR: espeak-ng not installed.")
        print("   Install with: sudo apt install espeak-ng")
        return False
    except subprocess.CalledProcessError as e:
        print(f"❌ ERROR: Failed to generate audio: {e}")
        print(f"   stderr: {e.stderr.decode() if e.stderr else 'N/A'}")
        return False

def create_audio_with_ffmpeg(frequency: int, duration: int, output_path: str):
    """Generate simple test tone using ffmpeg"""
    try:
        subprocess.run([
            "ffmpeg", "-y",
            "-f", "lavfi",
            "-i", f"sine=frequency={frequency}:duration={duration}",
            "-ar", "16000",
            "-ac", "1",
            output_path
        ], check=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        print(f"✅ Created test tone: {output_path}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ ERROR: Failed to create test tone: {e}")
        return False

def create_silent_wav(duration: int, output_path: str):
    """Generate silent wav file as fallback"""
    try:
        subprocess.run([
            "ffmpeg", "-y",
            "-f", "lavfi",
            "-i", f"anullsrc=r=16000:cl=mono",
            "-t", str(duration),
            "-ar", "16000",
            "-ac", "1",
            output_path
        ], check=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        print(f"✅ Created silent file: {output_path}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ ERROR: Failed to create silent file: {e}")
        return False

def main():
    # Create input directory
    input_dir = Path(__file__).parent / "audio" / "input"
    input_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("Creating Sample French Audio Files")
    print("=" * 60)
    print(f"Output directory: {input_dir}\n")

    success_count = 0
    total_count = 0

    # Try to generate sample files with espeak-ng
    espeak_available = True
    for name, text in SAMPLE_TEXTS.items():
        total_count += 1
        output_path = str(input_dir / f"sample_{name}.wav")
        if create_audio_with_espeak(text, output_path):
            success_count += 1
        else:
            espeak_available = False
            break

    # If espeak-ng failed, provide alternatives
    if not espeak_available:
        print("\n" + "=" * 60)
        print("⚠️  espeak-ng not available. Creating fallback files...")
        print("=" * 60 + "\n")

        # Create a test tone instead
        tone_path = str(input_dir / "test_tone.wav")
        if create_audio_with_ffmpeg(440, 2, tone_path):
            success_count += 1

        print("\n" + "=" * 60)
        print("Alternative: Record your own audio")
        print("=" * 60)
        print("\nOption 1: Record with ffmpeg")
        print(f"  ffmpeg -f alsa -i default -t 5 -ar 16000 -ac 1 {input_dir}/my_recording.wav\n")
        print("Option 2: Record with arecord")
        print(f"  arecord -d 5 -f S16_LE -r 16000 -c 1 {input_dir}/my_recording.wav\n")
        print("Option 3: Use any existing French wav file")
        print(f"  cp /path/to/your/french_audio.wav {input_dir}/\n")
    else:
        # Also create a test tone
        total_count += 1
        tone_path = str(input_dir / "test_tone.wav")
        if create_audio_with_ffmpeg(440, 2, tone_path):
            success_count += 1

    print("\n" + "=" * 60)
    print(f"Summary: {success_count}/{total_count} files created successfully")
    print("=" * 60)

    # List created files
    if success_count > 0:
        print("\nCreated files:")
        for wav_file in sorted(input_dir.glob("*.wav")):
            size_kb = wav_file.stat().st_size / 1024
            print(f"  - {wav_file.name} ({size_kb:.1f} KB)")

        print(f"\n✅ Ready to test! Run:")
        first_file = next(input_dir.glob("*.wav"), None)
        if first_file:
            print(f"  uv run python test_pipeline.py audio/input/{first_file.name}")
    else:
        print("\n❌ No files created. Please install espeak-ng or record audio manually.")
        sys.exit(1)

if __name__ == "__main__":
    main()
