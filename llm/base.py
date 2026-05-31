"""Abstract LLM provider interface."""
from __future__ import annotations

import abc
import json
import re
from typing import Any


class LLMError(RuntimeError):
    """Raised when a provider fails or returns unusable output."""


class LLMProvider(abc.ABC):
    name: str = "abstract"

    def __init__(self, api_key: str = "", model: str = "", base_url: str | None = None):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url

    @abc.abstractmethod
    def complete_text(self, system: str, user: str, *, max_tokens: int = 4096) -> str:
        ...

    def complete_json(self, system: str, user: str, *, max_tokens: int = 4096) -> Any:
        system_json = (
            system
            + "\n\nReturn ONLY valid JSON. No prose, no markdown, no code fences."
        )
        raw = self.complete_text(system_json, user, max_tokens=max_tokens)
        return self._parse_json_loose(raw)

    @staticmethod
    def _parse_json_loose(raw: str) -> Any:
        if not raw:
            raise LLMError("Empty response from model")
        text = raw.strip()
        fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
        if fence:
            text = fence.group(1).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        for opener, closer in (("{", "}"), ("[", "]")):
            first = text.find(opener)
            last = text.rfind(closer)
            if first >= 0 and last > first:
                try:
                    return json.loads(text[first : last + 1])
                except json.JSONDecodeError:
                    continue
        raise LLMError(f"No JSON found in model output:\n{raw[:500]}")
