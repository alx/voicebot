"""
Persistent Python worker: reads JSON-line requests from stdin, dispatches
them to a long-lived VoicePipeline, and writes JSON-line responses to
stdout. Replaces the spawn-per-message src.pipeline_cli invocation so
models load once per bot lifetime instead of once per message.

Protocol: one JSON object per line, UTF-8, newline-terminated. Requests
carry {"id": int, "type": "voice"|"text", ...}; responses echo the id and
carry {"success": bool, ...} plus payload fields flattened at the top
level. All logging goes to stderr; stdout carries only protocol lines.
"""
import sys
import os
import json
import logging

from src.pipeline import VoicePipeline, VoicePipelineError
from src.audio_converter import validate_audio_file, convert_wav_to_ogg_opus
from src import config

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger(__name__)


def handle_request(pipeline: VoicePipeline, request: dict) -> dict:
    """Run one already-parsed request against the pipeline and return its
    payload fields (without id/success — dispatch_line adds those)."""
    if request["type"] == "text":
        text = request.get("text", "")
        if len(text) > pipeline.config.TEXT_MAX_CHARS:
            raise ValueError(
                f"Text message too long: {len(text)} chars "
                f"(max {pipeline.config.TEXT_MAX_CHARS})"
            )
        result = pipeline.run_text_pipeline(text)
        return {"llm_response": result["llm_response"], "timing": result["timing"]}

    audio_path = request.get("audio_path")
    if not audio_path:
        raise ValueError("Missing audio_path for voice request")

    validate_audio_file(
        audio_path,
        max_size_mb=pipeline.config.AUDIO_MAX_SIZE_MB,
        max_duration_sec=pipeline.config.AUDIO_MAX_DURATION_SEC,
    )

    result = pipeline.run_pipeline(audio_path)

    if request.get("output_format") == "ogg":
        wav_path = result["output_audio_path"]
        ogg_path = wav_path.replace(".wav", ".ogg")
        convert_wav_to_ogg_opus(wav_path, ogg_path)
        os.remove(wav_path)
        result["output_audio_path"] = ogg_path

    return {
        "transcription": result["transcription"],
        "language": result["language"],
        "llm_response": result["llm_response"],
        "output_audio_path": result["output_audio_path"],
        "timing": result["timing"],
    }


def dispatch_line(pipeline: VoicePipeline, line: str) -> dict:
    """Parse one request line and return a response dict. Never raises —
    every failure mode is mapped to an error response so a bad request
    can't kill the worker process."""
    try:
        request = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return {
            "id": None,
            "success": False,
            "error": "Malformed JSON request",
            "error_type": "validation_error",
        }

    request_id = request.get("id") if isinstance(request, dict) else None
    request_type = request.get("type") if isinstance(request, dict) else None

    if request_type not in ("voice", "text"):
        return {
            "id": request_id,
            "success": False,
            "error": f"Unknown request type: {request_type!r}",
            "error_type": "validation_error",
        }

    try:
        result = handle_request(pipeline, request)
        return {"id": request_id, "success": True, **result}
    except VoicePipelineError as e:
        return {"id": request_id, "success": False, "error": str(e), "error_type": "pipeline_error"}
    except FileNotFoundError as e:
        return {"id": request_id, "success": False, "error": str(e), "error_type": "file_not_found"}
    except ValueError as e:
        return {"id": request_id, "success": False, "error": str(e), "error_type": "validation_error"}
    except Exception as e:
        logger.error(f"Unexpected error handling request {request_id}: {e}", exc_info=True)
        return {"id": request_id, "success": False, "error": str(e), "error_type": "unexpected_error"}


def main():
    logger.info("Starting persistent pipeline worker")
    pipeline = VoicePipeline(config)
    logger.info("Worker ready, reading requests from stdin")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        response = dispatch_line(pipeline, line)
        print(json.dumps(response), flush=True)

    logger.info("Stdin closed, worker exiting")


if __name__ == "__main__":
    main()
