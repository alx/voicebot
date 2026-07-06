"""
Voice Pipeline - STT->LLM->TTS with structured output
Refactored from test_pipeline.py for production use
"""
import os
import time
import subprocess
import logging
import requests
from datetime import datetime
from pathlib import Path
from faster_whisper import WhisperModel
from typing import Dict, Any, Tuple

logger = logging.getLogger(__name__)


class VoicePipelineError(Exception):
    """Custom exception for pipeline errors"""
    pass


class VoicePipeline:
    """Voice processing pipeline: STT → LLM → TTS"""

    def __init__(self, config_module):
        """
        Initialize all pipeline components

        Args:
            config_module: Configuration module with all settings
        """
        self.config = config_module
        logger.info("=" * 60)
        logger.info("Voice Pipeline Initializing...")
        logger.info("=" * 60)

        # Ensure CUDA device is set
        os.environ["CUDA_VISIBLE_DEVICES"] = "0"

        # Initialize STT
        logger.info(f"\n[1/3] Loading STT: faster-whisper ({self.config.STT_MODEL_SIZE})")
        start = time.time()
        try:
            self.stt_model = WhisperModel(
                model_size_or_path=self.config.STT_MODEL_SIZE,
                device=self.config.STT_DEVICE,
                compute_type=self.config.STT_COMPUTE_TYPE,
                download_root=self.config.STT_DOWNLOAD_ROOT
            )
            logger.info(f"   ✓ Loaded in {time.time() - start:.2f}s")
        except Exception as e:
            logger.error(f"   ✗ Failed to load STT model: {e}")
            raise VoicePipelineError(f"STT initialization failed: {e}")

        # Test LLM connection
        logger.info(f"\n[2/3] Testing LLM: {self.config.LLM_API_URL}")
        start = time.time()
        try:
            response = requests.get(self.config.LLM_HEALTH_URL, timeout=5)
            if response.status_code == 200:
                logger.info(f"   ✓ Connected in {time.time() - start:.2f}s")
            else:
                raise Exception(f"Health check failed: {response.status_code}")
        except Exception as e:
            logger.warning(f"   ⚠ LLM health check failed: {e}")
            logger.warning(f"   Pipeline will continue, but LLM queries may fail")

        # Initialize TTS (Piper)
        logger.info(f"\n[3/3] Loading TTS: Piper (CPU-based)")
        start = time.time()

        # Check if Piper model exists
        piper_model = os.path.join(self.config.PROJECT_ROOT, "models", "piper", "fr_FR-siwis-medium.onnx")
        if not os.path.exists(piper_model):
            logger.error(f"   ✗ ERROR: Piper model not found at {piper_model}")
            raise VoicePipelineError(f"Piper model not found: {piper_model}")

        self.piper_model = piper_model
        logger.info(f"   ✓ Piper ready in {time.time() - start:.2f}s")

        logger.info("\n" + "=" * 60)
        logger.info("Pipeline Ready!")
        logger.info("=" * 60 + "\n")

    def transcribe_audio(self, audio_path: str) -> Tuple[str, str]:
        """
        Step 1: Transcribe audio to text using faster-whisper

        Args:
            audio_path: Path to audio file

        Returns:
            Tuple of (transcribed_text, detected_language)

        Raises:
            VoicePipelineError: If transcription fails
        """
        logger.info(f"[STT] Transcribing: {Path(audio_path).name}")
        start = time.time()

        try:
            segments, info = self.stt_model.transcribe(
                audio=audio_path,
                language=self.config.STT_LANGUAGE,
                beam_size=self.config.STT_BEAM_SIZE,
                vad_filter=True,  # Voice activity detection
                vad_parameters=dict(min_silence_duration_ms=500)
            )

            # Collect all segments
            transcription = " ".join([segment.text.strip() for segment in segments])
            detected_lang = info.language if self.config.STT_LANGUAGE is None else self.config.STT_LANGUAGE

            elapsed = time.time() - start
            logger.info(f"[STT] ✓ Completed in {elapsed:.2f}s")
            logger.info(f"[STT] Language: {detected_lang}")
            logger.info(f"[STT] Text: \"{transcription}\"")

            if not transcription.strip():
                raise VoicePipelineError("Empty transcription (no speech detected)")

            return transcription, detected_lang

        except Exception as e:
            logger.error(f"[STT] ✗ Transcription failed: {e}")
            raise VoicePipelineError(f"STT failed: {e}")

    def query_llm(self, user_text: str, language: str) -> str:
        """
        Step 2: Query LLM via llama-server OpenAI-compatible API

        Args:
            user_text: User input text
            language: Detected language

        Returns:
            LLM response text

        Raises:
            VoicePipelineError: If LLM query fails
        """
        logger.info(f"[LLM] Querying: {self.config.LLM_MODEL_NAME}")
        start = time.time()

        # Build OpenAI-compatible chat request
        payload = {
            "model": self.config.LLM_MODEL_NAME,
            "messages": [
                {"role": "system", "content": self.config.SYSTEM_PROMPT},
                {"role": "user", "content": user_text}
            ],
            "temperature": self.config.LLM_TEMPERATURE,
            "max_tokens": self.config.LLM_MAX_TOKENS
        }

        try:
            response = requests.post(
                self.config.LLM_API_URL,
                json=payload,
                timeout=self.config.LLM_TIMEOUT
            )
            response.raise_for_status()

            # Extract response from OpenAI format
            data = response.json()
            llm_response = data["choices"][0]["message"]["content"].strip()

            elapsed = time.time() - start
            logger.info(f"[LLM] ✓ Completed in {elapsed:.2f}s")
            logger.info(f"[LLM] Response: \"{llm_response}\"")

            if not llm_response.strip():
                raise VoicePipelineError("Empty LLM response")

            return llm_response

        except requests.exceptions.RequestException as e:
            logger.error(f"[LLM] ✗ LLM query failed: {e}")
            raise VoicePipelineError(f"LLM query failed: {e}")

    def query_sillytavern(self, user_text: str) -> str:
        """
        Alternate Step 2: Get a persona-driven reply via the SillyTavern bridge

        Args:
            user_text: User input text

        Returns:
            SillyTavern reply text

        Raises:
            VoicePipelineError: If the bridge call fails
        """
        logger.info(f"[LLM] Querying SillyTavern bridge: {self.config.ST_BRIDGE_URL}")
        start = time.time()

        try:
            response = requests.post(
                f"{self.config.ST_BRIDGE_URL}/reply",
                json={"text": user_text},
                timeout=self.config.ST_BRIDGE_TIMEOUT
            )
            response.raise_for_status()

            data = response.json()
            try:
                reply = data["reply"].strip()
            except (KeyError, TypeError, AttributeError) as e:
                raise VoicePipelineError(f"Malformed SillyTavern bridge response: {e}")

            if not reply:
                raise VoicePipelineError("Empty SillyTavern reply")

            elapsed = time.time() - start
            logger.info(f"[LLM] ✓ SillyTavern reply in {elapsed:.2f}s")
            logger.info(f"[LLM] Response: \"{reply}\"")

            return reply

        except requests.exceptions.RequestException as e:
            logger.error(f"[LLM] ✗ SillyTavern bridge query failed: {e}")
            raise VoicePipelineError(f"SillyTavern bridge query failed: {e}")

    def synthesize_speech(self, text: str, language: str, output_path: str):
        """
        Step 3: Synthesize speech using Piper TTS

        Args:
            text: Text to synthesize
            language: Language code
            output_path: Output audio file path

        Raises:
            VoicePipelineError: If synthesis fails
        """
        logger.info(f"[TTS] Synthesizing speech ({language}) with Piper")
        start = time.time()

        try:
            # Ensure output directory exists
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # Use Piper via command line
            result = subprocess.run(
                ["piper", "--model", self.piper_model, "--output_file", output_path],
                input=text.encode('utf-8'),
                capture_output=True,
                check=True
            )

            elapsed = time.time() - start
            file_size = os.path.getsize(output_path) / 1024  # KB
            logger.info(f"[TTS] ✓ Completed in {elapsed:.2f}s")
            logger.info(f"[TTS] Saved: {output_path} ({file_size:.1f} KB)")

        except subprocess.CalledProcessError as e:
            logger.error(f"[TTS] ✗ TTS failed: {e}")
            logger.error(f"[TTS] stderr: {e.stderr.decode() if e.stderr else 'N/A'}")
            raise VoicePipelineError(f"TTS failed: {e}")
        except Exception as e:
            logger.error(f"[TTS] ✗ TTS error: {e}")
            raise VoicePipelineError(f"TTS error: {e}")

    def run_pipeline(self, input_wav: str, output_path: str = None) -> Dict[str, Any]:
        """
        Execute complete STT->LLM->TTS pipeline

        Args:
            input_wav: Path to input audio file
            output_path: Optional output path (auto-generated if not provided)

        Returns:
            Dict with:
                - transcription: str
                - language: str
                - llm_response: str
                - output_audio_path: str
                - timing: dict with stt, llm, tts, total times

        Raises:
            VoicePipelineError: If any step fails
        """
        # Validate input
        if not os.path.exists(input_wav):
            raise FileNotFoundError(f"Input file not found: {input_wav}")

        # Generate output filename with timestamp if not provided
        if output_path is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            input_name = Path(input_wav).stem
            output_filename = f"{input_name}_response_{timestamp}.wav"
            output_path = os.path.join(self.config.AUDIO_OUTPUT_DIR, output_filename)

        # Ensure output directory exists
        os.makedirs(self.config.AUDIO_OUTPUT_DIR, exist_ok=True)

        logger.info("\n" + "=" * 60)
        logger.info(f"PIPELINE EXECUTION START")
        logger.info(f"Input: {input_wav}")
        logger.info("=" * 60 + "\n")

        pipeline_start = time.time()
        timing = {}

        try:
            # Step 1: STT
            stt_start = time.time()
            transcription, detected_lang = self.transcribe_audio(input_wav)
            timing['stt'] = time.time() - stt_start

            # Step 2: LLM
            llm_start = time.time()
            if self.config.LLM_BACKEND == "sillytavern":
                llm_response = self.query_sillytavern(transcription)
            else:
                llm_response = self.query_llm(transcription, detected_lang)
            timing['llm'] = time.time() - llm_start

            # Step 3: TTS
            tts_start = time.time()
            self.synthesize_speech(llm_response, detected_lang, output_path)
            timing['tts'] = time.time() - tts_start

            timing['total'] = time.time() - pipeline_start

            logger.info("=" * 60)
            logger.info(f"PIPELINE EXECUTION COMPLETE")
            logger.info(f"Total Time: {timing['total']:.2f}s")
            logger.info(f"Output: {output_path}")
            logger.info("=" * 60 + "\n")

            return {
                "transcription": transcription,
                "language": detected_lang,
                "llm_response": llm_response,
                "output_audio_path": output_path,
                "timing": timing
            }

        except Exception as e:
            logger.error("\n" + "=" * 60)
            logger.error(f"PIPELINE FAILED: {e}")
            logger.error("=" * 60 + "\n")
            raise
