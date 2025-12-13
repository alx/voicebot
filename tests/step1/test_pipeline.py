#!/usr/bin/env python3
"""
Simplified STT->LLM->TTS pipeline tester.
Usage: python test_pipeline.py <input_wav_file>
"""

import sys
import os
import time
import subprocess
import tempfile
from pathlib import Path
from datetime import datetime
import requests
from faster_whisper import WhisperModel
import config

class VoicePipeline:
    def __init__(self):
        """Initialize all pipeline components"""
        print("=" * 60)
        print("Voice Pipeline Initializing...")
        print("=" * 60)

        # Ensure CUDA device is set
        os.environ["CUDA_VISIBLE_DEVICES"] = "0"

        # Initialize STT
        print(f"\n[1/3] Loading STT: faster-whisper ({config.STT_MODEL_SIZE})")
        start = time.time()
        self.stt_model = WhisperModel(
            model_size_or_path=config.STT_MODEL_SIZE,
            device=config.STT_DEVICE,
            compute_type=config.STT_COMPUTE_TYPE,
            download_root=config.STT_DOWNLOAD_ROOT
        )
        print(f"   ✓ Loaded in {time.time() - start:.2f}s")

        # Test LLM connection
        print(f"\n[2/3] Testing LLM: {config.LLM_API_URL}")
        start = time.time()
        try:
            response = requests.get(config.LLM_HEALTH_URL, timeout=5)
            if response.status_code == 200:
                print(f"   ✓ Connected in {time.time() - start:.2f}s")
            else:
                raise Exception(f"Health check failed: {response.status_code}")
        except Exception as e:
            print(f"   ✗ ERROR: {e}")
            print(f"   Make sure llama-server is running at {config.LLM_API_URL}")
            sys.exit(1)

        # Initialize TTS (Piper)
        print(f"\n[3/3] Loading TTS: Piper (CPU-based)")
        start = time.time()

        # Check if Piper model exists
        piper_model = os.path.join(config.PROJECT_ROOT, "models", "piper", "fr_FR-siwis-medium.onnx")
        if not os.path.exists(piper_model):
            print(f"   ✗ ERROR: Piper model not found at {piper_model}")
            print("   Run: cd models/piper && wget https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx")
            sys.exit(1)

        self.piper_model = piper_model
        print(f"   ✓ Piper ready in {time.time() - start:.2f}s")

        print("\n" + "=" * 60)
        print("Pipeline Ready!")
        print("=" * 60 + "\n")

    def transcribe_audio(self, audio_path: str) -> tuple[str, str]:
        """
        Step 1: Transcribe audio to text using faster-whisper
        Returns: (transcribed_text, detected_language)
        """
        print(f"[STT] Transcribing: {Path(audio_path).name}")
        start = time.time()

        segments, info = self.stt_model.transcribe(
            audio=audio_path,
            language=config.STT_LANGUAGE,
            beam_size=config.STT_BEAM_SIZE,
            vad_filter=True,  # Voice activity detection
            vad_parameters=dict(min_silence_duration_ms=500)
        )

        # Collect all segments
        transcription = " ".join([segment.text.strip() for segment in segments])
        detected_lang = info.language if config.STT_LANGUAGE is None else config.STT_LANGUAGE

        elapsed = time.time() - start
        print(f"[STT] ✓ Completed in {elapsed:.2f}s")
        print(f"[STT] Language: {detected_lang}")
        print(f"[STT] Text: \"{transcription}\"")
        print()

        return transcription, detected_lang

    def query_llm(self, user_text: str, language: str) -> str:
        """
        Step 2: Query LLM via llama-server OpenAI-compatible API
        Returns: LLM response text
        """
        print(f"[LLM] Querying: {config.LLM_MODEL_NAME}")
        start = time.time()

        # Build OpenAI-compatible chat request
        payload = {
            "model": config.LLM_MODEL_NAME,
            "messages": [
                {"role": "system", "content": config.SYSTEM_PROMPT},
                {"role": "user", "content": user_text}
            ],
            "temperature": config.LLM_TEMPERATURE,
            "max_tokens": config.LLM_MAX_TOKENS
        }

        try:
            response = requests.post(
                config.LLM_API_URL,
                json=payload,
                timeout=config.LLM_TIMEOUT
            )
            response.raise_for_status()

            # Extract response from OpenAI format
            data = response.json()
            llm_response = data["choices"][0]["message"]["content"].strip()

            elapsed = time.time() - start
            print(f"[LLM] ✓ Completed in {elapsed:.2f}s")
            print(f"[LLM] Response: \"{llm_response}\"")
            print()

            return llm_response

        except requests.exceptions.RequestException as e:
            print(f"[LLM] ✗ ERROR: {e}")
            raise

    def synthesize_speech(self, text: str, language: str, output_path: str):
        """
        Step 3: Synthesize speech using Piper TTS
        Saves output to output_path
        """
        print(f"[TTS] Synthesizing speech ({language}) with Piper")
        start = time.time()

        try:
            # Use Piper via command line
            result = subprocess.run(
                ["piper", "--model", self.piper_model, "--output_file", output_path],
                input=text.encode('utf-8'),
                capture_output=True,
                check=True
            )

            elapsed = time.time() - start
            file_size = os.path.getsize(output_path) / 1024  # KB
            print(f"[TTS] ✓ Completed in {elapsed:.2f}s")
            print(f"[TTS] Saved: {output_path} ({file_size:.1f} KB)")
            print()

        except subprocess.CalledProcessError as e:
            print(f"[TTS] ✗ ERROR: {e}")
            print(f"[TTS] stderr: {e.stderr.decode() if e.stderr else 'N/A'}")
            raise
        except Exception as e:
            print(f"[TTS] ✗ ERROR: {e}")
            raise

    def run_pipeline(self, input_wav: str) -> str:
        """
        Execute complete STT->LLM->TTS pipeline
        Returns: path to output audio file
        """
        # Validate input
        if not os.path.exists(input_wav):
            raise FileNotFoundError(f"Input file not found: {input_wav}")

        # Generate output filename with timestamp
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        input_name = Path(input_wav).stem
        output_filename = f"{input_name}_response_{timestamp}.wav"
        output_path = os.path.join(config.AUDIO_OUTPUT_DIR, output_filename)

        # Ensure output directory exists
        os.makedirs(config.AUDIO_OUTPUT_DIR, exist_ok=True)

        print("\n" + "=" * 60)
        print(f"PIPELINE EXECUTION START")
        print(f"Input: {input_wav}")
        print("=" * 60 + "\n")

        pipeline_start = time.time()

        try:
            # Step 1: STT
            transcription, detected_lang = self.transcribe_audio(input_wav)

            if not transcription.strip():
                raise ValueError("No transcription generated (empty audio?)")

            # Step 2: LLM
            llm_response = self.query_llm(transcription, detected_lang)

            if not llm_response.strip():
                raise ValueError("Empty LLM response")

            # Step 3: TTS
            self.synthesize_speech(llm_response, detected_lang, output_path)

            total_time = time.time() - pipeline_start

            print("=" * 60)
            print(f"PIPELINE EXECUTION COMPLETE")
            print(f"Total Time: {total_time:.2f}s")
            print(f"Output: {output_path}")
            print("=" * 60 + "\n")

            return output_path

        except Exception as e:
            print("\n" + "=" * 60)
            print(f"PIPELINE FAILED: {e}")
            print("=" * 60 + "\n")
            raise

def main():
    if len(sys.argv) < 2:
        print("Usage: python test_pipeline.py <input_wav_file>")
        print("\nExample:")
        print("  python test_pipeline.py audio/input/sample_greeting.wav")
        sys.exit(1)

    input_file = sys.argv[1]

    try:
        # Initialize pipeline (loads all models)
        pipeline = VoicePipeline()

        # Run full pipeline
        output_file = pipeline.run_pipeline(input_file)

        print(f"✅ Success! Play output with:")
        print(f"  ffplay {output_file}")
        print(f"  # or")
        print(f"  aplay {output_file}")

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
