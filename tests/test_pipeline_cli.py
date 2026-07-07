import json
import subprocess
import sys

import pytest


def run_cli(args):
    return subprocess.run(
        [sys.executable, "-m", "src.pipeline_cli"] + args,
        capture_output=True,
        text=True,
    )


def test_text_and_audio_file_are_mutually_exclusive():
    result = run_cli(["some.wav", "--text", "hello", "--json"])
    assert result.returncode != 0
    assert "not allowed with argument" in result.stderr or "one of the arguments" in result.stderr


def test_requires_either_text_or_audio_file():
    result = run_cli(["--json"])
    assert result.returncode != 0


def test_text_over_max_chars_rejected(monkeypatch):
    monkeypatch.setenv("TEXT_MAX_CHARS", "10")
    result = run_cli(["--text", "this message is way over ten characters", "--json"])
    assert result.returncode == 1
    output = json.loads(result.stdout)
    assert output["success"] is False
    assert output["error_type"] == "validation_error"
