"""
LLM backend strategies for VoicePipeline: query an OpenAI-compatible chat
completions endpoint directly, or route the reply through a SillyTavern
persona bridge (st-bridge). Selected once at pipeline construction time via
create_backend(config).
"""
import re
import time
import logging

import requests

logger = logging.getLogger(__name__)


class VoicePipelineError(Exception):
    """Custom exception for pipeline errors"""
    pass


_ACTION_TEXT_PATTERN = re.compile(r'\*[^*]+\*')


def _strip_narration(text: str) -> str:
    """
    Remove *action/narration* asides some roleplay personas still emit despite
    being instructed to reply with spoken dialogue only. Safety net for the
    SillyTavern route on top of the persona-level instruction (chat Author's
    Note / variables) — not a substitute for it, since dialogue that isn't
    asterisk-wrapped passes through untouched.
    """
    cleaned = _ACTION_TEXT_PATTERN.sub('', text)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned or text


class DirectBackend:
    """Queries an OpenAI-compatible chat completions endpoint directly."""

    def __init__(self, config):
        self.config = config
        self._check_health()

    def _check_health(self):
        logger.info(f"Testing LLM: {self.config.LLM_API_URL}")
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

    def get_reply(self, text: str) -> str:
        """
        Query LLM via llama-server OpenAI-compatible API

        Args:
            text: User input text

        Returns:
            LLM response text

        Raises:
            VoicePipelineError: If LLM query fails
        """
        logger.info(f"[LLM] Querying: {self.config.LLM_MODEL_NAME}")
        start = time.time()

        payload = {
            "model": self.config.LLM_MODEL_NAME,
            "messages": [
                {"role": "system", "content": self.config.SYSTEM_PROMPT},
                {"role": "user", "content": text}
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


class SillyTavernBackend:
    """Routes replies through the SillyTavern persona bridge (st-bridge)."""

    def __init__(self, config):
        self.config = config

    def get_reply(self, text: str) -> str:
        """
        Get a persona-driven reply via the SillyTavern bridge

        Args:
            text: User input text

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
                json={"text": text},
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

            reply = _strip_narration(reply)

            elapsed = time.time() - start
            logger.info(f"[LLM] ✓ SillyTavern reply in {elapsed:.2f}s")
            logger.info(f"[LLM] Response: \"{reply}\"")

            return reply

        except requests.exceptions.RequestException as e:
            logger.error(f"[LLM] ✗ SillyTavern bridge query failed: {e}")
            raise VoicePipelineError(f"SillyTavern bridge query failed: {e}")


def create_backend(config):
    """Select a backend instance based on config.LLM_BACKEND (defaults to direct)."""
    if getattr(config, "LLM_BACKEND", "direct") == "sillytavern":
        return SillyTavernBackend(config)
    return DirectBackend(config)
