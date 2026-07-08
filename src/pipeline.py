"""
Voice Pipeline - STT->LLM->TTS with structured output
Refactored from test_pipeline.py for production use
"""
import os
import time
import subprocess
import logging
from datetime import datetime
from pathlib import Path
from faster_whisper import WhisperModel
from typing import Dict, Any, Tuple

from src.llm_backends import VoicePipelineError, create_backend

logger = logging.getLogger(__name__)


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

        self.backend = create_backend(config_module)

        logger.info("Pipeline ready (STT/TTS load lazily on first use)")

        logger.info("\n" + "=" * 60)
        logger.info("Pipeline Ready!")
        logger.info("=" * 60 + "\n")

    def _ensure_stt(self):
        """Lazily load the faster-whisper model on first use."""
        if getattr(self, "stt_model", None) is not None:
            return

        local_model_path = getattr(self.config, "STT_LOCAL_MODEL_PATH", None)
        use_local_path = local_model_path and os.path.isdir(local_model_path)
        logger.info(
            f"Loading STT: faster-whisper "
            f"({local_model_path if use_local_path else self.config.STT_MODEL_SIZE})"
        )
        start = time.time()
        try:
            if use_local_path:
                self.stt_model = WhisperModel(
                    model_size_or_path=local_model_path,
                    device=self.config.STT_DEVICE,
                    compute_type=self.config.STT_COMPUTE_TYPE,
                )
            else:
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
        self._ensure_stt()
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

    def _ensure_tts(self):
        """Lazily validate the Piper model path on first use."""
        if getattr(self, "piper_model", None) is not None:
            return

        piper_model = self.config.TTS_MODEL_PATH
        if not os.path.exists(piper_model):
            logger.error(f"   ✗ ERROR: Piper model not found at {piper_model}")
            raise VoicePipelineError(f"Piper model not found: {piper_model}")
        self.piper_model = piper_model

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
        self._ensure_tts()
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
            llm_response = self.backend.get_reply(transcription)
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

    def run_text_pipeline(self, text: str) -> Dict[str, Any]:
        """
        Execute the reply-only pipeline for typed input: LLM step only, no STT/TTS.

        Args:
            text: User input text

        Returns:
            Dict with:
                - llm_response: str
                - timing: dict with llm, total times

        Raises:
            VoicePipelineError: If the input is empty or the backend call fails
        """
        if not text.strip():
            raise VoicePipelineError("Empty text input")

        logger.info("\n" + "=" * 60)
        logger.info(f"TEXT PIPELINE EXECUTION START")
        logger.info("=" * 60 + "\n")

        pipeline_start = time.time()
        timing = {}

        try:
            llm_start = time.time()
            llm_response = self.backend.get_reply(text)
            timing['llm'] = time.time() - llm_start
            timing['total'] = time.time() - pipeline_start

            logger.info("=" * 60)
            logger.info(f"TEXT PIPELINE EXECUTION COMPLETE")
            logger.info(f"Total Time: {timing['total']:.2f}s")
            logger.info("=" * 60 + "\n")

            return {
                "llm_response": llm_response,
                "timing": timing
            }

        except Exception as e:
            logger.error("\n" + "=" * 60)
            logger.error(f"TEXT PIPELINE FAILED: {e}")
            logger.error("=" * 60 + "\n")
            raise
