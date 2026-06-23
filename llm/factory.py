"""Build a provider instance from (provider_id, model, api_key, base_url)
and expose the catalog for the frontend Settings page."""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import List

from .base import LLMProvider, LLMError
from .providers import (
    OpenAIProvider, GroqProvider, OpenRouterProvider, MinimaxProvider,
    AnthropicProvider, GeminiProvider, GeminiSubscriptionProvider,
    OllamaProvider,
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
        id="gemini-subscription",
        name="Gemini · Subscription",
        requires_key=False,
        # Tier-based model names match the actual gemini.google.com UI:
        #   *-plus      → AI Pro subscription ($20/mo) — most users
        #   *-advanced  → AI Ultra subscription ($200/mo)
        #   plain       → free tier (no subscription required)
        # First item becomes the default — uses your AI Pro quota.
        models=[
            "gemini-3-flash-plus",            # AI Pro fast (default)
            "gemini-3-pro-plus",              # AI Pro quality
            "gemini-3-flash-thinking-plus",   # AI Pro reasoning
            "gemini-3-flash",                 # Free fast
            "gemini-3-pro",                   # Free quality
            "gemini-3-flash-thinking",        # Free reasoning
            "gemini-3-flash-advanced",        # AI Ultra fast
            "gemini-3-pro-advanced",          # AI Ultra quality
        ],
        notes=(
            "Uses your Google AI Pro / Ultra consumer subscription via "
            "gemini.google.com cookies. NO API key, NO per-request quota — "
            "only your subscription's 5-hour-window quota. Run "
            "Setup-Gemini-Subscription.command once to extract cookies "
            "from Chrome. -plus models use AI Pro, -advanced use AI Ultra, "
            "plain ones use free tier. Personal/local use only."
        ),
    ),
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


class FallbackProvider(LLMProvider):
    """Wraps a primary provider with a local-Ollama fallback.

    If the primary's complete_text raises ANY exception (expired cookies,
    gemini.google.com outage, rate limit, network blip), the same prompt is
    transparently retried against local Ollama. complete_json inherits the
    fallback automatically because the base class routes it through
    complete_text.
    """

    # Ollama model used for fallback, in preference order. First one that
    # is actually installed wins; if the list-check itself fails we just
    # try the first name and let Ollama error meaningfully.
    FALLBACK_MODELS = ["qwen2.5:14b", "qwen3:32b", "llama3.1", "llama3.3"]

    def __init__(self, primary: LLMProvider):
        super().__init__(api_key="", model=primary.model, base_url=None)
        self.primary = primary
        self.name = f"{primary.name}+ollama-fallback"

    def _pick_ollama_model(self) -> str:
        try:
            import urllib.request as _ur
            url = OllamaProvider.default_base_url.rstrip("/") + "/api/tags"
            with _ur.urlopen(url, timeout=5) as r:
                installed = {m["name"] for m in json.loads(r.read().decode()).get("models", [])}
            for cand in self.FALLBACK_MODELS:
                if cand in installed:
                    return cand
            if installed:
                return sorted(installed)[0]
        except Exception:
            pass
        return self.FALLBACK_MODELS[0]

    def complete_text(self, system: str, user: str, *, max_tokens: int = 4096) -> str:
        try:
            return self.primary.complete_text(system, user, max_tokens=max_tokens)
        except Exception as primary_err:
            fb_model = self._pick_ollama_model()
            print(
                f"⚠️  {self.primary.name} failed ({str(primary_err)[:160]}) — "
                f"falling back to Ollama ({fb_model})",
                flush=True,
            )
            try:
                fb = OllamaProvider(model=fb_model)
                return fb.complete_text(system, user, max_tokens=max_tokens)
            except Exception as fb_err:
                raise LLMError(
                    f"Primary ({self.primary.name}) failed: {str(primary_err)[:200]} — "
                    f"AND Ollama fallback ({fb_model}) failed: {str(fb_err)[:200]}"
                ) from fb_err


def build_provider(
    provider_id: str,
    model: str,
    api_key: str = "",
    base_url: str | None = None,
) -> LLMProvider:
    """Instantiate a concrete provider. Raises LLMError for unknown ids.

    gemini-subscription gets wrapped in FallbackProvider so a cookie expiry
    or gemini.google.com outage degrades gracefully to local Ollama instead
    of failing the user's pipeline run.
    """
    pid = (provider_id or "").lower().strip()
    kwargs = dict(api_key=api_key, model=model, base_url=base_url)
    table = {
        "openai": OpenAIProvider,
        "anthropic": AnthropicProvider,
        "gemini": GeminiProvider,
        "gemini-subscription": GeminiSubscriptionProvider,
        "openrouter": OpenRouterProvider,
        "groq": GroqProvider,
        "minimax": MinimaxProvider,
        "ollama": OllamaProvider,
    }
    cls = table.get(pid)
    if not cls:
        raise LLMError(f"Unknown provider: {provider_id}")
    prov = cls(**kwargs)
    if pid == "gemini-subscription":
        return FallbackProvider(prov)
    return prov
