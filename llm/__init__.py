"""LLM provider abstraction — bring-your-own-model.

Drop-in replacement for the `google.genai` hardcoded call in main.py. Any
code that needs an LLM should do:

    from llm import build_provider
    provider = build_provider(provider_id, model, api_key)
    data = provider.complete_json(system_prompt, user_prompt)

and receive a parsed JSON object back. The surface is intentionally tiny
so adapters stay ~50 lines each.
"""
from .factory import build_provider, PROVIDER_INFO
from .base import LLMProvider, LLMError

__all__ = ["build_provider", "PROVIDER_INFO", "LLMProvider", "LLMError"]
