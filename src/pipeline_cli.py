#!/usr/bin/env python3
"""
CLI wrapper for VoicePipeline - outputs JSON for Node.js integration
Usage: python -m src.pipeline_cli <audio_file> [--json]
"""
import sys
import json
import argparse
import logging
from pathlib import Path

# Import pipeline components
from src.pipeline import VoicePipeline, VoicePipelineError
from src.audio_converter import validate_audio_file
from src import config

# Configure logging to stderr (stdout is reserved for JSON output)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)

logger = logging.getLogger(__name__)


def main():
    """Main CLI entry point"""
    parser = argparse.ArgumentParser(
        description='Voice Pipeline CLI - STT->LLM->TTS processing'
    )
    parser.add_argument(
        'audio_file',
        help='Input audio file path (OGG, WAV, MP3, etc.)'
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='Output JSON format (for Node.js integration)'
    )
    parser.add_argument(
        '--quiet',
        action='store_true',
        help='Suppress pipeline logs (only output result)'
    )
    parser.add_argument(
        '--output-format',
        choices=['wav', 'ogg'],
        default='wav',
        help='Output audio format (default: wav, use ogg for WhatsApp compatibility)'
    )

    args = parser.parse_args()

    # Suppress pipeline logs if --quiet
    if args.quiet:
        logging.getLogger('src.pipeline').setLevel(logging.WARNING)
        logging.getLogger().setLevel(logging.WARNING)

    try:
        # Validate input file exists
        audio_path = Path(args.audio_file)
        if not audio_path.exists():
            raise FileNotFoundError(f"Audio file not found: {args.audio_file}")

        logger.info(f"Processing audio file: {args.audio_file}")

        # Validate before loading any models — reject bad input cheaply
        validate_audio_file(
            str(audio_path),
            max_size_mb=config.AUDIO_MAX_SIZE_MB,
            max_duration_sec=config.AUDIO_MAX_DURATION_SEC
        )

        # Initialize pipeline (logs to stderr)
        pipeline = VoicePipeline(config)

        # Run pipeline
        result = pipeline.run_pipeline(str(audio_path.absolute()))

        # Convert WAV to OGG/Opus if requested (for WhatsApp compatibility)
        if args.output_format == 'ogg':
            import os
            from src.audio_converter import convert_wav_to_ogg_opus

            wav_path = result['output_audio_path']
            ogg_path = wav_path.replace('.wav', '.ogg')

            logger.info(f"Converting WAV to OGG/Opus for WhatsApp: {ogg_path}")
            convert_wav_to_ogg_opus(wav_path, ogg_path)

            # Clean up intermediate WAV file
            os.remove(wav_path)

            # Update result to point to OGG file
            result['output_audio_path'] = ogg_path

        if args.json:
            # Output JSON to stdout for Node.js
            json_output = {
                "success": True,
                "transcription": result["transcription"],
                "language": result["language"],
                "llm_response": result["llm_response"],
                "output_audio_path": result["output_audio_path"],
                "timing": result["timing"]
            }
            print(json.dumps(json_output))
        else:
            # Human-readable output
            print("\n" + "=" * 60)
            print("Pipeline Result:")
            print("=" * 60)
            print(f"Transcription: {result['transcription']}")
            print(f"Language: {result['language']}")
            print(f"LLM Response: {result['llm_response']}")
            print(f"Output Audio: {result['output_audio_path']}")
            print(f"\nTiming:")
            print(f"  STT: {result['timing']['stt']:.2f}s")
            print(f"  LLM: {result['timing']['llm']:.2f}s")
            print(f"  TTS: {result['timing']['tts']:.2f}s")
            print(f"  Total: {result['timing']['total']:.2f}s")
            print("=" * 60 + "\n")

        sys.exit(0)

    except VoicePipelineError as e:
        logger.error(f"Pipeline error: {e}")

        if args.json:
            error_output = {
                "success": False,
                "error": str(e),
                "error_type": "pipeline_error"
            }
            print(json.dumps(error_output))
        else:
            print(f"\n❌ Pipeline Error: {e}\n", file=sys.stderr)

        sys.exit(1)

    except FileNotFoundError as e:
        logger.error(f"File error: {e}")

        if args.json:
            error_output = {
                "success": False,
                "error": str(e),
                "error_type": "file_not_found"
            }
            print(json.dumps(error_output))
        else:
            print(f"\n❌ File Error: {e}\n", file=sys.stderr)

        sys.exit(1)

    except ValueError as e:
        logger.error(f"Validation error: {e}")

        if args.json:
            error_output = {
                "success": False,
                "error": str(e),
                "error_type": "validation_error"
            }
            print(json.dumps(error_output))
        else:
            print(f"\n❌ Validation Error: {e}\n", file=sys.stderr)

        sys.exit(1)

    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)

        if args.json:
            error_output = {
                "success": False,
                "error": str(e),
                "error_type": "unexpected_error"
            }
            print(json.dumps(error_output))
        else:
            print(f"\n❌ Unexpected Error: {e}\n", file=sys.stderr)
            import traceback
            traceback.print_exc()

        sys.exit(1)


if __name__ == '__main__':
    main()
