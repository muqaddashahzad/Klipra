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


# ---------------------------------------------------------------------------
# Google Gemini SUBSCRIPTION (via web cookies, no API quota)
# ---------------------------------------------------------------------------

class GeminiSubscriptionProvider(LLMProvider):
    """Uses the user's Google AI Pro consumer subscription via the
    `gemini-webapi` library (which talks to gemini.google.com directly
    with the user's session cookies, NOT the developer API).

    Difference from `GeminiProvider`:
        GeminiProvider          → developer API at generativelanguage.googleapis.com
                                  Pay-per-token, hits free-tier rate limits.
        GeminiSubscriptionProvider → consumer chat at gemini.google.com
                                  Uses your $20/mo AI Pro subscription's
                                  5-hour-window quota. No API quota.

    Cookies live in /app/data/gemini_cookies.json (host-mounted volume).
    The user populates that file by running Setup-Gemini-Subscription.command.

    Caveats users should know:
      - Personal use only. Google's ToS doesn't formally permit
        programmatic access via consumer cookies.
      - Web UI changes can break this provider. The gemini-webapi
        maintainers usually catch up in days.
      - If the user signs out of gemini.google.com in Chrome, the
        cookies become invalid and the script must be re-run.
    """

    name = "gemini-subscription"
    COOKIE_PATH = "/app/data/gemini_cookies.json"

    # Map our model identifiers to gemini-webapi's Model enum.
    # Defaults to G_2_0_FLASH if the requested model isn't known.
    _MODEL_MAP_LAZY = None

    @classmethod
    def _model_map(cls):
        """Map our public model identifiers to gemini-webapi's Model enum.

        gemini-webapi 2.x uses tier-based naming (matches the actual UI):
          BASIC_*    → free tier (gemini.google.com without subscription)
          PLUS_*     → Google AI Pro subscription ($20/mo) — what most users have
          ADVANCED_* → Google AI Ultra subscription ($200/mo)

        Our public ids prefix with the tier so user gets to pick.
        """
        if cls._MODEL_MAP_LAZY is not None:
            return cls._MODEL_MAP_LAZY
        try:
            from gemini_webapi.constants import Model
        except ImportError as e:
            raise LLMError(
                "gemini-webapi package not installed. Rebuild backend "
                "after adding gemini-webapi>=1.5.0 to requirements.txt."
            ) from e
        out = {}
        # Try both the new tier-based names (2.x) AND legacy names just in case
        # the library version varies between environments.
        candidates = [
            # ── AI Pro tier (PLUS_*) — most users ──
            ("gemini-3-flash-plus",       "PLUS_FLASH"),
            ("gemini-3-pro-plus",         "PLUS_PRO"),
            ("gemini-3-flash-thinking-plus", "PLUS_THINKING"),
            # ── AI Ultra tier (ADVANCED_*) ──
            ("gemini-3-flash-advanced",   "ADVANCED_FLASH"),
            ("gemini-3-pro-advanced",     "ADVANCED_PRO"),
            ("gemini-3-flash-thinking-advanced", "ADVANCED_THINKING"),
            # ── Free tier (BASIC_*) — works without subscription ──
            ("gemini-3-flash",            "BASIC_FLASH"),
            ("gemini-3-pro",              "BASIC_PRO"),
            ("gemini-3-flash-thinking",   "BASIC_THINKING"),
            # ── Legacy 1.x library names — kept for fallback compatibility ──
            ("gemini-2.5-flash",          "G_2_5_FLASH"),
            ("gemini-2.5-pro",            "G_2_5_PRO"),
            ("gemini-2.0-flash",          "G_2_0_FLASH"),
            ("gemini-2.0-flash-thinking", "G_2_0_FLASH_THINKING"),
            ("gemini-1.5-pro",            "G_1_5_PRO"),
            ("gemini-1.5-flash",          "G_1_5_FLASH"),
        ]
        for our_id, attr in candidates:
            v = getattr(Model, attr, None)
            if v is not None:
                out[our_id] = v
        cls._MODEL_MAP_LAZY = out
        return out

    _warned_model_fallback = False

    def _resolved_model(self):
        """Pick the right Model enum for the requested id, with sensible
        fallback to the user's likely subscription tier."""
        m = (self.model or "").strip().lower()
        mapping = self._model_map()
        if m in mapping:
            return mapping[m]
        # Sensible defaults — prefer PLUS (AI Pro) since that's what most
        # users on this provider will have. Fall back to BASIC (free) if
        # the AI Pro tier constants aren't exposed.
        for candidate in (
            "gemini-3-flash-plus",        # AI Pro fast
            "gemini-3-flash",             # Free fast
            "gemini-2.5-flash",           # Legacy fast
            "gemini-3-pro-plus",          # AI Pro quality
            "gemini-3-pro",               # Free quality
        ):
            if candidate in mapping:
                chosen = mapping[candidate]
                # Surface the silent downgrade ONCE so a model-name/library
                # mismatch (e.g. the requested tier isn't exposed by the
                # pinned gemini-webapi) is visible instead of mysteriously
                # giving lower-quality output.
                if not type(self)._warned_model_fallback:
                    type(self)._warned_model_fallback = True
                    print(f"⚠️  gemini-subscription: requested model {self.model!r} not "
                          f"available in this gemini-webapi — using {getattr(chosen, 'name', chosen)} instead.",
                          flush=True)
                return chosen
        if mapping:
            return next(iter(mapping.values()))
        raise LLMError("No usable Gemini model constants exposed by gemini-webapi")

    def _load_cookies(self) -> dict:
        from pathlib import Path
        p = Path(self.COOKIE_PATH)
        if not p.exists():
            raise LLMError(
                f"Gemini subscription cookies not found at {self.COOKIE_PATH}. "
                "Run Setup-Gemini-Subscription.command at the Klipra root to "
                "extract them from your Chrome browser, then restart this "
                "backend container."
            )
        try:
            data = json.loads(p.read_text())
        except Exception as e:
            raise LLMError(f"Could not parse {self.COOKIE_PATH}: {e}") from e
        needed = {"__Secure-1PSID", "__Secure-1PSIDTS"}
        missing = needed - set(data.keys())
        if missing:
            raise LLMError(
                f"Missing required Gemini cookies: {sorted(missing)}. "
                "Re-run Setup-Gemini-Subscription.command — make sure you're "
                "logged into gemini.google.com in Chrome first."
            )
        return data

    # ── Persistent session (class-level) ────────────────────────────────
    # ONE event loop on a daemon thread + ONE cached GeminiClient, reused
    # across every call. The previous design created a fresh GeminiClient and
    # called client.init() on EVERY complete_text — for a 356-segment
    # transliteration that's 356 × (7s init + a fresh cookie auth roundtrip),
    # which hammered gemini.google.com, tripped the "UNAUTHENTICATED" de-auth,
    # and ultimately crashed the clip-gen subprocess (exit code 1). Reusing
    # one authenticated client makes calls fast and stops the auth storm.
    _loop = None
    _loop_thread = None
    _client = None
    _client_cookie_fp = None
    _session_lock = None  # threading.Lock, lazily created

    @classmethod
    def _ensure_loop(cls):
        import asyncio
        import threading
        if cls._session_lock is None:
            cls._session_lock = threading.Lock()
        with cls._session_lock:
            if (cls._loop is not None and cls._loop_thread is not None
                    and cls._loop_thread.is_alive()):
                return
            cls._loop = asyncio.new_event_loop()

            def _run():
                asyncio.set_event_loop(cls._loop)
                cls._loop.run_forever()

            cls._loop_thread = threading.Thread(
                target=_run, daemon=True, name="gemini-sub-loop")
            cls._loop_thread.start()

    @classmethod
    def _submit(cls, coro, timeout=120):
        """Marshal a coroutine onto the persistent loop and wait for it."""
        import asyncio
        cls._ensure_loop()
        fut = asyncio.run_coroutine_threadsafe(coro, cls._loop)
        try:
            return fut.result(timeout=timeout)
        except Exception:
            try:
                fut.cancel()
            except Exception:
                pass
            raise

    @classmethod
    def _reset_client(cls):
        """Drop the cached client so the next call re-inits (used after any
        failure — covers expired cookies / a session that went bad)."""
        cls._client = None
        cls._client_cookie_fp = None

    async def _get_client(self, cookies):
        cls = type(self)
        fp = (cookies.get("__Secure-1PSID", "")[-12:] + "|"
              + (cookies.get("__Secure-1PSIDTS", "") or "")[-12:])
        if cls._client is not None and cls._client_cookie_fp == fp:
            return cls._client
        from gemini_webapi import GeminiClient
        client = GeminiClient(
            secure_1psid=cookies["__Secure-1PSID"],
            secure_1psidts=cookies.get("__Secure-1PSIDTS"),
            proxy=None,
        )
        await client.init(timeout=30)
        cls._client = client
        cls._client_cookie_fp = fp
        return client

    # ── Circuit breaker ─────────────────────────────────────────────────
    # When the cookies aren't authenticating, gemini-webapi retries the
    # session init ~6× with backoff → ~100s PER call, then returns content
    # via an unauthenticated/free path. Over a 356-segment clip-gen run that
    # is an hour of grinding. Instead: a healthy call answers in <40s, so we
    # cap each attempt at 40s; the FIRST timeout/failure trips this breaker,
    # and every subsequent call for the next 10 min raises immediately →
    # FallbackProvider goes straight to local Ollama (fast + reliable).
    _CALL_TIMEOUT_S = 40
    _BREAKER_COOLDOWN_S = 600
    _unhealthy_until = 0.0

    def complete_text(self, system: str, user: str, *, max_tokens: int = 4096) -> str:
        import time as _t
        cls = type(self)

        # Circuit open? Fail fast so FallbackProvider hits Ollama instantly.
        if _t.monotonic() < cls._unhealthy_until:
            raise LLMError(
                "Gemini subscription session is unauthenticated (cookies likely "
                "expired/rotated) — backing off; using fallback. Re-run "
                "Setup-Gemini-Subscription.command to restore it."
            )

        try:
            from gemini_webapi import GeminiClient  # noqa: F401 — presence check
        except ImportError as e:
            raise LLMError(
                "gemini-webapi package not installed. Rebuild backend "
                "after adding gemini-webapi>=1.5.0 to requirements.txt."
            ) from e

        cookies = self._load_cookies()
        model_const = self._resolved_model()

        # gemini.google.com expects a single combined prompt; there's no
        # separate system slot like the developer API. Front-load the
        # system instruction.
        combined = f"{system.strip()}\n\n---\n\n{user.strip()}".strip()

        async def _call():
            client = await self._get_client(cookies)
            resp = await client.generate_content(combined, model=model_const)
            return getattr(resp, "text", "") or ""

        def _trip_breaker():
            cls._unhealthy_until = _t.monotonic() + cls._BREAKER_COOLDOWN_S
            cls._reset_client()

        try:
            text = self._submit(_call(), timeout=cls._CALL_TIMEOUT_S)
        except Exception as e:
            # Timeout or hard failure: trip the breaker so the rest of the
            # run uses Ollama instead of paying the timeout every call.
            _trip_breaker()
            raise LLMError(
                "Gemini subscription call failed/timed out (cookies may be "
                "expired or rotated — re-run Setup-Gemini-Subscription.command "
                f"after logging into gemini.google.com in Chrome): {e}"
            )
        if not text.strip():
            _trip_breaker()
            raise LLMError(
                "Gemini subscription returned an empty response — cookies "
                "likely expired. Re-run Setup-Gemini-Subscription.command, "
                "or switch the AI provider to Ollama."
            )
        return text
