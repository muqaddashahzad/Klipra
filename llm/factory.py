"""Build a provider instance from (provider_id, model, api_key, base_url)
and expose the catalog for the frontend Settings page."""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .base import LLMProvider, LLMError
from .providers import (
    OpenAIProvider, GroqProvider, OpenRouterProvider, MinimaxProvider,
    AnthropicProvider, GeminiProvider, OllamaProvider,
)


@dataclass
class ProviderInfo:
    id: str
    name: str
    requires_key: bool
    models: List[str]
    notes: str = ""


PROVIDER_INFO: list[ProviderInfo] = [
    ProviderInfo(
        id="gemini",
        name="Google Gemini",
        requires_key=True,
        # Google deprecated gemini-1.5-flash and gemini-1.5-pro for new
        # API keys (existing keys may still work but new keys 404). We
        # default to gemini-2.5-flash which is the current free-tier
        # multimodal model. -lite variants are even faster but slightly
        # lower quality. 2.5-pro stays as the paid premium option.
        # First item in the list becomes the default in the dropdown.
        models=[
            "gemini-2.5-flash",        # FREE — current Google default (recommended)
            "gemini-2.5-flash-lite",   # FREE — fastest, smaller / cheaper
            "gemini-2.0-flash",        # FREE — older but stable, still supported
            "gemini-2.0-flash-lite",   # FREE — fastest 2.0 variant
            "gemini-2.5-pro",          # PAID — top of the stack
        ],
        notes="1M+ context, native multimodal. Free tier covers ~5 ten-minute videos/day.",
    ),
    ProviderInfo(
        id="openai",
        name="OpenAI",
        requires_key=True,
        models=["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"],
    ),
    ProviderInfo(
        id="anthropic",
        name="Anthropic (Claude)",
        requires_key=True,
        models=[
            "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5",
            "claude-3-5-sonnet-latest",
        ],
        notes="Best hook/script writing quality.",
    ),
    ProviderInfo(
        id="openrouter",
        name="OpenRouter",
        requires_key=True,
        models=[
            "openrouter/free",
            "minimax/minimax-m2.5:free", "minimax/minimax-m2:free",
            "google/gemma-3-27b-it:free", "meta-llama/llama-3.3-70b-instruct:free",
            "deepseek/deepseek-r1:free",
            "minimax/minimax-m2.7", "anthropic/claude-sonnet-4.6",
            "openai/gpt-5", "google/gemini-2.5-pro",
        ],
        notes="100+ models with one key. ':free' variants work without billing.",
    ),
    ProviderInfo(
        id="groq",
        name="Groq",
        requires_key=True,
        models=["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
        notes="Fastest inference.",
    ),
    ProviderInfo(
        id="minimax",
        name="MiniMax",
        requires_key=True,
        models=[
            "MiniMax-M2.7", "MiniMax-M2.7-highspeed",
            "MiniMax-M2.5", "MiniMax-M2.5-highspeed",
            "MiniMax-M2.1", "MiniMax-M2", "MiniMax-M2-Stable",
        ],
        notes="Key from platform.minimax.io — not your consumer subscription.",
    ),
    ProviderInfo(
        id="ollama",
        name="Ollama (local)",
        requires_key=False,
        models=["llama3.3", "llama3.1", "qwen2.5", "mistral", "gemma2"],
        notes="Local inference. Zero cost, zero data leaves your server.",
    ),
]


def build_provider(
    provider_id: str,
    model: str,
    api_key: str = "",
    base_url: str | None = None,
) -> LLMProvider:
    """Instantiate a concrete provider. Raises LLMError for unknown ids."""
    pid = (provider_id or "").lower().strip()
    kwargs = dict(api_key=api_key, model=model, base_url=base_url)
    table = {
        "openai": OpenAIProvider,
        "anthropic": AnthropicProvider,
        "gemini": GeminiProvider,
        "openrouter": OpenRouterProvider,
        "groq": GroqProvider,
        "minimax": MinimaxProvider,
        "ollama": OllamaProvider,
    }
    cls = table.get(pid)
    if not cls:
        raise LLMError(f"Unknown provider: {provider_id}")
    return cls(**kwargs)
