"""Concrete LLM provider adapters. All in one file for the fork to keep
the port surface small."""
from __future__ import annotations

import json
import os
import time
import httpx

from .base import LLMProvider, LLMError


def _describe_http_error(e: Exception) -> str:
    """Build a human-friendly explanation of an httpx error so logs say
    *which* timeout fired (connect / read / write / pool) instead of the
    bare 'timed out' that httpx gives by default. Helps users tell apart
    'Ollama daemon is down' (ConnectError) from 'model is still loading'
    (ReadTimeout) — they need different remedies.
    """
    name = type(e).__name__
    msg = str(e) or "<no message>"
    hint = ""
    if isinstance(e, httpx.ConnectError):
        hint = "Cannot reach the daemon — is Ollama running?"
    elif isinstance(e, httpx.ConnectTimeout):
        hint = "Daemon didn't accept the connection in time — restart Ollama."
    elif isinstance(e, httpx.ReadTimeout):
        hint = ("Daemon accepted but didn't reply in time — model may be "
                "loading (cold start) or too big for this hardware.")
    elif isinstance(e, httpx.WriteTimeout):
        hint = "Couldn't send the prompt — daemon may be overloaded."
    elif isinstance(e, httpx.PoolTimeout):
        hint = "Connection pool exhausted — too many concurrent requests."
    return f"{name}: {msg}" + (f" ({hint})" if hint else "")


# ---------------------------------------------------------------------------
# OpenAI + OpenAI-compatible (Groq, OpenRouter, MiniMax)
# ---------------------------------------------------------------------------

class OpenAIProvider(LLMProvider):
    name = "openai"
    default_base_url = "https://api.openai.com/v1"

    def _client(self):
        try:
            from openai import OpenAI
        except ImportError as e:
            raise LLMError("openai package not installed") from e
        return OpenAI(
            api_key=self.api_key or "sk-missing",
            base_url=self.base_url or self.default_base_url,
        )

    def complete_text(self, system: str, user: str, *, max_tokens: int = 4096) -> str:
        client = self._client()
        resp = client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens=max_tokens,
            temperature=0.7,
        )
        return resp.choices[0].message.content or ""

    def complete_json(self, system: str, user: str, *, max_tokens: int = 4096, temperature: float = 0.7):
        """Caller can pass temperature=0.0 for deterministic translation.
        We log what came back when JSON-mode succeeds so the upstream
        diagnostic block (`📥 RAW`) shows real provider output instead
        of a silently-swallowed fallback."""
        client = self._client()
        try:
            resp = client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system + "\n\nRespond with valid JSON."},
                    {"role": "user", "content": user},
                ],
                max_tokens=max_tokens,
                temperature=temperature,
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content or ""
            print(f"[{self.name}] complete_json (json_mode): {len(content)} chars")
            return self._parse_json_loose(content)
        except Exception as e:
            print(f"[{self.name}] complete_json json_mode failed → falling back: {type(e).__name__}: {e}")
            # Re-raise into base.complete_json which does plain text + loose parse
            return super().complete_json(system, user, max_tokens=max_tokens)


class GroqProvider(OpenAIProvider):
    name = "groq"
    default_base_url = "https://api.groq.com/openai/v1"


class OpenRouterProvider(OpenAIProvider):
    name = "openrouter"
    default_base_url = "https://openrouter.ai/api/v1"


class MinimaxProvider(OpenAIProvider):
    """api.minimax.io exposes OpenAI-compatible endpoints."""
    name = "minimax"
    default_base_url = "https://api.minimax.io/v1"


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------

class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def complete_text(self, system: str, user: str, *, max_tokens: int = 4096) -> str:
        try:
            from anthropic import Anthropic
        except ImportError as e:
            raise LLMError("anthropic package not installed") from e
        client = Anthropic(api_key=self.api_key)
        resp = client.messages.create(
            model=self.model,
            system=system,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": user}],
        )
        return "".join(getattr(b, "text", "") for b in resp.content)


# ---------------------------------------------------------------------------
# Google Gemini (native SDK; keeps openshorts' original behavior available)
# ---------------------------------------------------------------------------

class GeminiProvider(LLMProvider):
    name = "gemini"

    def _new_client(self):
        """Build a fresh client per request. The google-genai SDK uses
        an internal httpx session; under some conditions (subprocess
        startup, recreated event loops) a stale Client raises 'Cannot
        send a request, as the client has been closed'. We avoid this
        by always creating a new Client and binding it to a local var
        so it stays alive through the request."""
        try:
            from google import genai
        except ImportError as e:
            raise LLMError("google-genai not installed") from e
        return genai.Client(api_key=self.api_key)

    def complete_text(self, system: str, user: str, *, max_tokens: int = 4096) -> str:
        from google.genai import types
        client = self._new_client()
        try:
            resp = client.models.generate_content(
                model=self.model,
                contents=user,
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    max_output_tokens=max_tokens,
                    temperature=0.7,
                ),
            )
            return resp.text or ""
        finally:
            # Some genai versions expose a close(); call it if present so
            # we don't leak the underlying httpx session.
            close = getattr(client, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass

    def complete_json(self, system: str, user: str, *, max_tokens: int = 4096):
        from google.genai import types
        client = self._new_client()
        try:
            resp = client.models.generate_content(
                model=self.model,
                contents=user,
                config=types.GenerateContentConfig(
                    system_instruction=system + "\n\nReturn valid JSON.",
                    max_output_tokens=max_tokens,
                    temperature=0.7,
                    response_mime_type="application/json",
                ),
            )
            return self._parse_json_loose(resp.text or "")
        except Exception:
            # Fall back to the base parser via a fresh text completion
            return super().complete_json(system, user, max_tokens=max_tokens)
        finally:
            close = getattr(client, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass


# ---------------------------------------------------------------------------
# Ollama (local, no API key)
# ---------------------------------------------------------------------------

class OllamaProvider(LLMProvider):
    name = "ollama"
    # Inside Docker, `localhost` is the container itself — not the Mac
    # running Ollama. Docker Desktop exposes the host at the special DNS
    # name `host.docker.internal`. Default to that so Klipra → Ollama
    # works out of the box. Override with X-LLM-Base-URL if running
    # outside Docker (e.g. `http://localhost:11434`).
    default_base_url = "http://host.docker.internal:11434"

    def complete_text(self, system: str, user: str, *, max_tokens: int = 4096) -> str:
        url = (self.base_url or self.default_base_url).rstrip("/") + "/api/chat"
        payload = {
            "model": self.model,
            "stream": False,
            # keep_alive belongs at the TOP level of the request, not
            # nested in `options` — Ollama warns "invalid option" when
            # it's misplaced and silently ignores the keep-warm hint,
            # forcing cold reloads on every call. Put it at the right
            # level so the model stays in memory between batches.
            "keep_alive": "30m",
            "options": {
                "num_predict": max_tokens,
                "temperature": 0.7,
            },
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        # Same retry-with-backoff pattern as complete_json. Cold-loaded
        # models often need one extra cycle to warm up before they
        # respond.
        base_timeout = float(os.getenv("KLIPRA_OLLAMA_TIMEOUT", "300"))
        timeouts = [base_timeout, base_timeout * 1.5, base_timeout * 2.0]
        last_err: Exception | None = None
        for attempt, t in enumerate(timeouts, start=1):
            try:
                resp = httpx.post(url, json=payload, timeout=t)
                resp.raise_for_status()
                return (resp.json().get("message") or {}).get("content", "")
            except (httpx.ConnectError, httpx.ConnectTimeout,
                    httpx.ReadTimeout, httpx.WriteTimeout,
                    httpx.PoolTimeout) as e:
                last_err = e
                if attempt < len(timeouts):
                    backoff = 2.0 * attempt
                    print(f"⚠️  Ollama attempt {attempt} ({type(e).__name__}). "
                          f"Retrying in {backoff:.0f}s…")
                    time.sleep(backoff)
                    continue
                raise LLMError(
                    f"Ollama request failed after {attempt} attempts "
                    f"({_describe_http_error(e)}). "
                    f"URL={url} model={self.model!r}."
                ) from e
            except httpx.HTTPStatusError as e:
                raise LLMError(
                    f"Ollama HTTP {e.response.status_code} from {url}: "
                    f"{e.response.text[:200]}. Model={self.model!r}."
                ) from e
        raise LLMError(f"Ollama request exhausted retries: {last_err}")

    def complete_json(self, system: str, user: str, *, max_tokens: int = 4096, temperature: float = 0.2):
        """Use Ollama's built-in JSON mode (`format: "json"`) instead
        of relying on the base class's "ask nicely + regex-extract"
        fallback. The base path was failing for Qwen-style local
        models that produce reasoning text before / around the JSON,
        which made every transcript-rewrite batch fail and silently
        kept the original (un-translated) text. With format=json
        Ollama constrains the model's output to a valid JSON value,
        so json.loads on the response just works.

        Caller can pass temperature=0.0 for translation (deterministic),
        leave default 0.2 for general JSON tasks.

        Two robustness improvements over the original:

          1. Retry-with-backoff. A cold-loaded Ollama model can take
             30-90s to warm up — the first request after `ollama serve`
             starts often hits a read timeout while the model loads. We
             now retry up to 3 times with increasing total timeout so
             the user doesn't have to manually re-trigger every batch.
          2. Specific error messages. The bare 'timed out' string is
             useless for debugging — we now say *which* timeout fired
             and what the user should check (daemon down vs model
             loading vs hardware too small).
        """
        url = (self.base_url or self.default_base_url).rstrip("/") + "/api/chat"
        # Some Ollama JSON-mode setups won't honour the constraint
        # unless the prompt itself mentions JSON, so we keep the
        # explicit "Return ONLY valid JSON" reminder. Belt + braces.
        system_json = (
            system
            + "\n\nReturn ONLY valid JSON. No prose, no markdown, no code fences, "
            "no commentary, no reasoning trace."
        )
        payload = {
            "model": self.model,
            "stream": False,
            # The key bit — forces structured JSON output.
            # Supported by Ollama since v0.1.30+.
            "format": "json",
            # keep_alive belongs at the TOP level, not under `options`.
            # When nested incorrectly, Ollama logs "invalid option" and
            # silently ignores the warm-up hint, forcing a cold reload
            # on every call. Keep it here so the model stays resident
            # for 30 min between batches.
            "keep_alive": "30m",
            "options": {
                "num_predict": max_tokens,
                # Lower temp for translation/alignment — they
                # want deterministic output. 0.7 was fine for
                # creative gen but gave us inconsistent JSON.
                "temperature": 0.2,
            },
            "messages": [
                {"role": "system", "content": system_json},
                {"role": "user", "content": user},
            ],
        }
        # User-tunable timeout. Default 600s already covers most cases
        # but huge models (qwen2.5:72b on a Mac) can need more.
        base_timeout = float(os.getenv("KLIPRA_OLLAMA_TIMEOUT", "600"))
        # Three attempts: first at base_timeout (most batches finish
        # well within), then a longer one to absorb cold start, then a
        # last hail-mary at 2x in case the model is genuinely huge.
        timeouts = [base_timeout, base_timeout * 1.5, base_timeout * 2.0]
        last_err: Exception | None = None
        for attempt, t in enumerate(timeouts, start=1):
            try:
                resp = httpx.post(url, json=payload, timeout=t)
                resp.raise_for_status()
                raw = (resp.json().get("message") or {}).get("content", "")
                if not raw:
                    raise LLMError("Empty response from Ollama JSON mode")
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    # Fall back to the loose parser — even with
                    # format=json, some older Ollama versions
                    # occasionally include trailing whitespace or wrap
                    # output in code fences. The base-class loose parser
                    # handles those cases.
                    return self._parse_json_loose(raw)
            except (httpx.ConnectError, httpx.ConnectTimeout,
                    httpx.ReadTimeout, httpx.WriteTimeout,
                    httpx.PoolTimeout) as e:
                last_err = e
                # On the first transient error, give the model a moment
                # to finish loading before we hammer it again.
                if attempt < len(timeouts):
                    backoff = 2.0 * attempt
                    print(f"⚠️  Ollama attempt {attempt} ({type(e).__name__}). "
                          f"Retrying in {backoff:.0f}s with longer timeout "
                          f"({timeouts[attempt]:.0f}s)…")
                    time.sleep(backoff)
                    continue
                # Final attempt failed — bubble up with a useful message.
                raise LLMError(
                    f"Ollama JSON request failed after {attempt} attempts "
                    f"({_describe_http_error(e)}). "
                    f"URL={url} model={self.model!r}."
                ) from e
            except httpx.HTTPStatusError as e:
                # Non-2xx (model not pulled, etc.) — don't retry, the
                # error is permanent for this call.
                raise LLMError(
                    f"Ollama HTTP {e.response.status_code} from {url}: "
                    f"{e.response.text[:200]}. Model={self.model!r}."
                ) from e
        # Defensive — loop should always either return or raise.
        raise LLMError(f"Ollama JSON request exhausted retries: {last_err}")
