"""Shared helpers for rewriting Whisper transcripts.

Used by:
  - main.py     — applies a Roman/Latin-script rewrite *before* clip
                  selection so the LLM-picker (and live progress logs)
                  see Latin letters for Urdu/Hindi/Arabic content.
  - app.py      — applies the same rewrite (or full translation) at
                  subtitle-burn time when the user picks a target
                  language or "Roman script" in the subtitle modal.

The function works on the openai-whisper-style dict
({text, language, segments:[{text,start,end,words:[]}]}). It rewrites
each segment's text via the LLM in batches, then redistributes the
synthesized words evenly across the original [start,end] window so
word-level subtitle pacing is preserved.
"""
from __future__ import annotations

import json
from typing import Optional


LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian",
    "zh": "Chinese (Simplified)", "ja": "Japanese", "ko": "Korean",
    "hi": "Hindi", "ur": "Urdu", "ar": "Arabic", "tr": "Turkish",
    "id": "Indonesian", "vi": "Vietnamese", "th": "Thai",
    "fa": "Persian", "pl": "Polish", "nl": "Dutch", "bn": "Bengali",
    "pa": "Punjabi", "ta": "Tamil",
}


def llm_rewrite_transcript(
    transcript: dict,
    *,
    mode: str,                     # 'roman' or 'translate'
    target_language: Optional[str] = None,
    provider_id: str,
    model_name: str,
    api_key: str,
    base_url: Optional[str] = None,
    batch_size: int = 15,
) -> dict:
    """Rewrite each segment's text via the LLM with FULL-clip context.

    `mode='roman'`     → output in Roman/Latin script (Roman Urdu, etc.).
                         The model is also explicitly allowed to FIX
                         Whisper misrecognitions using surrounding
                         context, which is what the user wants — the
                         literal "letter-for-letter" transliteration
                         was producing nonsense when Whisper got the
                         words wrong.
    `mode='translate'` → translate to `target_language` (ISO code).

    Two changes vs. the old version that made the output noticeably
    worse than what a hand-prompted LLM produces:
      • The old prompt forbade fixing words ("KEEP THE ORIGINAL WORDS").
        Whisper outputs are full of mis-hears, so locking the LLM into
        them produces nonsense even from a perfect transliteration.
      • The old batch_size=30 meant the LLM saw a 30-segment window with
        no broader context. Now we pass the full clip's joined transcript
        as a "context" string to every batch, AND raise batch_size to 80
        so each call sees more.

    Returns a deep-copy of the transcript. Falls back silently if
    anything goes wrong.
    """
    from llm import build_provider, LLMError

    if provider_id != "ollama" and not api_key:
        print("⚠️  No LLM key for transcript rewrite — using original")
        return transcript

    segments = transcript.get("segments") or []
    if not segments:
        return transcript

    # Build a full-clip context preview so each batch sees what's around it.
    # Truncate hard at ~2000 chars to keep prompt cost in check.
    full_context = (transcript.get("text") or " ".join(
        (s.get("text") or "").strip() for s in segments
    )).strip()
    if len(full_context) > 2000:
        full_context = full_context[:2000] + "…"

    detected_lang = (transcript.get("language") or "").lower()
    detected_lang_name = LANG_NAMES.get(detected_lang, detected_lang or "the source language")

    # Pull rule blocks from the shared module. Single source of truth for
    # numbers-as-digits, brand canonicalization, content preservation, and
    # context-driven correction — applied identically in main.py's clip
    # picker, thumbnail.py's title generator, etc.
    from prompt_rules import (
        NEVER_DROP,
        USE_CONTEXT_HARD,
        NUMBERS_AS_DIGITS,
        ROMAN_URDU_SPELLING,
        CRYPTO_FINANCE_GLOSSARY,
        SONG_AWARENESS,
    )

    # Bring-Your-Own-Lyrics flag set by /api/clip/.../lyrics-align when
    # the user pasted official lyrics. When True the transcript text is
    # GROUND TRUTH (not Whisper noise), so the prompt can demand
    # accurate translation instead of "fix Whisper errors first".
    is_user_lyrics = bool(transcript.get('_user_lyrics'))

    if mode == "cleanup":
        # Proofread the Whisper transcript IN-PLACE, keeping the same
        # language and script. Used by main.py as the default post-Whisper
        # step for every clip generation, so the LLM that picks viral
        # clips later sees clean input instead of Whisper's raw mishears.
        system = (
            f"You are an expert proofreader of Whisper speech-to-text "
            f"output for spoken {detected_lang_name}. Whisper makes recognition "
            f"errors — similar-sounding words get swapped, proper nouns get "
            f"mangled, English loanwords get butchered, fillers ('um', 'like') "
            f"are inserted or dropped at random.\n\n"
            f"YOUR JOB: fix obvious mistakes using the surrounding context, "
            f"WITHOUT changing the language or writing system, and WITHOUT "
            f"shortening or removing any of the speaker's content.\n\n"
            f"{NEVER_DROP}\n\n"
            f"{USE_CONTEXT_HARD}\n\n"
            f"{NUMBERS_AS_DIGITS}\n\n"
            f"{ROMAN_URDU_SPELLING}\n\n"
            f"You MUST also:\n"
            f"  • Keep the SAME language and SAME script as the input. If the "
            f"input is in Devanagari, output Devanagari. If in Arabic script, "
            f"output Arabic script. If in Latin/English, output Latin/English.\n"
            f"  • Restore brands/people/places to their canonical spelling.\n"
            f"  • Preserve sentence boundaries and natural speech rhythm.\n\n"
            f"You MUST NOT:\n"
            f"  • Translate, transliterate, or change the script in any way.\n"
            f"  • Add commentary, [bracketed] tags, quotes around the output.\n\n"
            f"Full clip context (use this for disambiguation, do NOT rewrite it):\n"
            f"---\n{full_context}\n---"
        )
    elif mode == "roman":
        system = (
            f"You are an expert {detected_lang_name} → Roman/Latin transliterator. "
            f"The input is a Whisper transcript of spoken {detected_lang_name}. "
            f"Whisper makes recognition errors — words that sound similar get swapped, "
            f"proper nouns get mangled, English loanwords come out in the wrong script.\n\n"
            f"YOUR JOB: produce CLEAN, READABLE Roman/Latin output that captures what "
            f"the speaker actually said — preserving every clause and every fact.\n\n"
            f"{NEVER_DROP}\n\n"
            f"{USE_CONTEXT_HARD}\n\n"
            f"{NUMBERS_AS_DIGITS}\n\n"
            f"{ROMAN_URDU_SPELLING}\n\n"
            f"{CRYPTO_FINANCE_GLOSSARY}\n\n"
            f"You MUST also:\n"
            f"  • Use Roman/Latin letters (Roman Urdu / Hinglish / Franco-Arabic style — "
            f"the way a native speaker would casually type on an English keyboard).\n"
            f"  • Keep proper nouns (people, brands, places) spelled the way they are "
            f"normally written in English.\n"
            f"  • Keep English loanwords (\"crypto\", \"community\", \"P2P\") in standard English.\n"
            f"  • Preserve sentence boundaries and natural speech rhythm.\n\n"
            f"You MUST NOT:\n"
            f"  • Translate to a different language. Same words, different writing system.\n"
            f"  • Add commentary, explanations, or [bracketed] tags.\n"
            f"  • Wrap output in quotes.\n\n"
            f"Full clip context (for disambiguation, do NOT rewrite this):\n"
            f"---\n{full_context}\n---"
        )
    elif mode in ("hinglish", "urglish"):
        # CODE-SWITCH PRESERVING TRANSLITERATION
        #
        # Hinglish = Hindi (Devanagari) → Roman, English words kept in English script.
        # Urglish  = Urdu  (Arabic-script) → Roman, English words kept in English script.
        #
        # Difference vs. plain 'roman': we tell the model EXPLICITLY which
        # source language to assume (so it doesn't guess wrong on a
        # short snippet) AND we hammer harder on "English words and
        # phrases must stay in English script verbatim — do not
        # phoneticise them".
        source_label = "Hindi (Devanagari)" if mode == "hinglish" else "Urdu (Arabic / Nastaliq script)"
        target_label = "Hinglish" if mode == "hinglish" else "Urglish (Roman Urdu + English)"
        system = (
            f"You are an expert {target_label} writer. The input is a Whisper "
            f"transcript of {source_label} speech that often code-switches into "
            f"English (technical terms, brand names, common loanwords).\n\n"
            f"YOUR JOB: produce CLEAN, READABLE {target_label} output:\n"
            f"  • Words spoken in {source_label} → Roman/Latin transliteration "
            f"(the way a native speaker types them on an English keyboard — "
            f"e.g. 'क्या' → 'kya', 'ہے' → 'hai').\n"
            f"  • Words and phrases spoken in English → KEEP THEM IN ENGLISH "
            f"VERBATIM. Do NOT phoneticise English. 'layer zero' stays "
            f"'layer zero' (NOT 'leyar ziro'). 'crypto' stays 'crypto' (NOT "
            f"'kripto'). 'Bitcoin' stays 'Bitcoin' (NOT 'bitkoin'). "
            f"'community' stays 'community' (NOT 'komunity').\n"
            f"  • Proper nouns (people, brands, places, projects) → use the "
            f"canonical English spelling.\n"
            f"  • Numbers in digit form (see NUMBERS_AS_DIGITS).\n\n"
            f"WORKED EXAMPLES (these illustrate the boundary you must preserve):\n"
            f'    Input  : "है इस LayerZero protocol का future bright"\n'
            f'    Output : "hai is LayerZero protocol ka future bright"\n'
            f'    Input  : "Bitcoin hold karo, community ke saath grow karo"\n'
            f'    Output : "Bitcoin hold karo, community ke saath grow karo"\n'
            f'    Input  : "yeh airdrop kab claim hoga"\n'
            f'    Output : "yeh airdrop kab claim hoga"\n'
            f'    Input  (Whisper mishears KelpDAO as \"clip down\"):\n'
            f'           : "jo recent hack hua hai clip down ka"\n'
            f'    Output : "jo recent hack hua hai KelpDAO ka"\n'
            f'    Input  (Whisper mishears ChainLink as \"chain link\"):\n'
            f'           : "ab log layer zero se chain link ki taraf shift kar rahe hain"\n'
            f'    Output : "ab log LayerZero se ChainLink ki taraf shift kar rahe hain"\n'
            f'    Input  (token ticker — preserve $ prefix and uppercase):\n'
            f'           : "is ka jo zk token hai BIG question hai"\n'
            f'    Output : "is ka jo $ZK token hai BIG question hai"\n\n'
            f"{NEVER_DROP}\n\n"
            f"{USE_CONTEXT_HARD}\n\n"
            f"{NUMBERS_AS_DIGITS}\n\n"
            f"{ROMAN_URDU_SPELLING}\n\n"
            f"{CRYPTO_FINANCE_GLOSSARY}\n\n"
            f"You MUST NOT:\n"
            f"  • Translate to another language — meaning stays in {source_label}; "
            f"only the script of the {source_label} parts changes.\n"
            f"  • Phoneticise English words (the most common failure mode).\n"
            f"  • Add commentary, [bracketed] tags, quote marks around output.\n\n"
            f"Full clip context (for disambiguation, do NOT rewrite this):\n"
            f"---\n{full_context}\n---"
        )
    else:  # translate
        target_name = LANG_NAMES.get((target_language or "en").lower(), target_language or "English")
        if is_user_lyrics:
            # BYOL path: source is ground-truth user-provided lyrics.
            # PRIMARY MISSION: translate every line to target_name.
            # SPECIAL CASE: lines already in target_name stay verbatim.
            # NEVER an empty output.
            system = (
                f"PRIMARY TASK: Translate the user's song lyrics from their "
                f"original language(s) to {target_name}. The source is OFFICIAL "
                f"LYRICS (not a Whisper transcript), so the words are correct — "
                f"you don't need to guess what was said.\n\n"
                f"FOR EACH input line:\n"
                f"  → if the line is in any language OTHER than {target_name} "
                f"(Roman Urdu, Hindi, Arabic, Spanish, etc.), TRANSLATE it to "
                f"natural, accurate {target_name}. This is your main job.\n"
                f"  → if the line is ALREADY entirely in {target_name} (e.g. an "
                f"English chorus inside a Roman-Urdu song), return that line "
                f"VERBATIM — character for character. Don't 'translate English "
                f"to English'. Don't shorten or rephrase. Just copy it.\n"
                f"  → if the line MIXES scripts within itself (e.g. "
                f"'L1 competitors aaye, sabne dikhaya zor' — English term + "
                f"Roman Urdu), translate the non-{target_name} part to "
                f"{target_name} and keep crypto/finance terms in English. "
                f"E.g. 'L1 competitors arrived, everyone showed their strength'.\n\n"
                f"OUTPUT REQUIREMENTS (failing these breaks the user's video):\n"
                f"  1. Every input i MUST have a non-empty output text. "
                f"Returning '' or null DELETES that subtitle from the burned "
                f"video — never do this.\n"
                f"  2. Match the line count: N input lines → N output items.\n"
                f"  3. Keep emotional / figurative language vivid in {target_name}.\n"
                f"  4. Accuracy over rhyme. Don't sacrifice meaning for poetry.\n\n"
                f"EXAMPLES that show what good translation looks like:\n"
                f'    Input  i=0: "Bitcoin hai naya par Crypto hai puraana,"\n'
                f'    Output i=0: "Bitcoin is new, but Crypto is ancient,"\n'
                f'    Input  i=1: "Boom and bust, we rise from the dust!"   (already English)\n'
                f'    Output i=1: "Boom and bust, we rise from the dust!"   (verbatim copy)\n'
                f'    Input  i=2: "L1 competitors aaye, sabne dikhaya zor,"\n'
                f'    Output i=2: "L1 competitors arrived, everyone showed strength,"\n'
                f'    Input  i=3: "Crypto cycles, in them we trust!"        (already English)\n'
                f'    Output i=3: "Crypto cycles, in them we trust!"        (verbatim copy)\n\n'
                f"{SONG_AWARENESS}\n\n"
                f"{CRYPTO_FINANCE_GLOSSARY}\n\n"
                f"{NEVER_DROP}\n\n"
                f"{NUMBERS_AS_DIGITS}\n\n"
                f"Full lyric context (use this to identify chorus repeats, verse "
                f"boundaries, and the song's topic — do NOT translate this block "
                f"directly, it is reference only):\n"
                f"---\n{full_context}\n---"
            )
        else:
            # Standard speech-translate path. Whisper noise IS expected,
            # so the prompt still asks the model to fix mishears using
            # context BEFORE translating. Adds the crypto glossary and
            # song-awareness blocks so even non-BYOL spoken content
            # gets the "Yield Farming ≠ young farmers" protection.
            system = (
                f"PRIMARY TASK: Translate the Whisper transcript of spoken "
                f"{detected_lang_name} into {target_name}. Use the surrounding "
                f"context to fix obvious recognition mistakes BEFORE translating.\n\n"
                f"FOR EACH segment:\n"
                f"  → if the segment is in {detected_lang_name} or another non-"
                f"{target_name} language, TRANSLATE it to natural, conversational "
                f"{target_name}.\n"
                f"  → if the speaker dropped an already-{target_name} phrase "
                f"into the middle of {detected_lang_name} (code-switching), "
                f"keep that phrase VERBATIM.\n"
                f"  → keep proper nouns (people, brands, places) in their "
                f"canonical English spelling.\n\n"
                f"OUTPUT REQUIREMENTS:\n"
                f"  1. Every input i MUST have a non-empty output text. "
                f"Returning empty for any segment makes that subtitle DISAPPEAR "
                f"from the burned video.\n"
                f"  2. Match line count: N input → N output.\n"
                f"  3. Match tone of the source. Roughly match length "
                f"(a 4-word segment should produce ~4-7 words, not a paragraph).\n\n"
                f"Make the output natural, "
                f"conversational, and concise — these are on-screen subtitles. Match "
                f"the tone of the source. Use the full context below to fix "
                f"recognition errors before translating.\n\n"
                f"{CRYPTO_FINANCE_GLOSSARY}\n\n"
                f"{SONG_AWARENESS}\n\n"
                f"{NEVER_DROP}\n\n"
                f"{USE_CONTEXT_HARD}\n\n"
                f"{NUMBERS_AS_DIGITS}\n\n"
                f"{ROMAN_URDU_SPELLING}\n\n"
                f"Full clip context (for understanding — do NOT translate this directly):\n"
                f"---\n{full_context}\n---"
            )
    system += (
        "\n\nReturn ONLY this JSON shape: "
        '{"items":[{"i":<int>,"text":"<rewritten>"}]}. '
        "Match every input `i` exactly. No commentary, no reasoning trace, "
        "no extra fields."
    )

    try:
        provider = build_provider(provider_id, model_name, api_key, base_url=base_url)
    except LLMError as e:
        print(f"⚠️  Could not build LLM provider for transcript rewrite: {e}")
        return transcript

    # Tell the user EXACTLY what we're about to hit. Critical for
    # debugging Ollama config — if the URL or model name is wrong,
    # the user can see it before the first timeout fires.
    _seg_count = sum(1 for s in segments if (s.get("text") or "").strip())
    _url_hint = (base_url or getattr(provider, "default_base_url", "")) or "(provider default)"
    print(f"   LLM rewrite → provider={provider_id} model={model_name!r} "
          f"endpoint={_url_hint} segments={_seg_count} mode={mode}")

    # Ollama tax: a single large batch on a cold-loaded model often hits
    # the read timeout, which then aborts the whole batch and we lose
    # 15 segments at once. Smaller batches finish faster, give the model
    # more chances to warm up, and degrade gracefully (lose 5 instead
    # of 15 if one fails). Cloud providers can handle the larger batch
    # just fine — no need to penalize them.
    if provider_id == "ollama" and batch_size > 6:
        print(f"   Using batch_size=6 for Ollama (was {batch_size}) — "
              f"smaller batches survive cold-start timeouts.")
        batch_size = 6

    # Helper: detect non-Latin script characters (Arabic/Devanagari/etc.)
    # so we can spot transliteration failures — when the LLM was asked
    # to produce Roman output but the response still contains the source
    # script, we know that particular segment needs a retry.
    import re as _re_local
    _NON_LATIN_RE = _re_local.compile(
        r"[؀-ۿ"   # Arabic
        r"ݐ-ݿ"   # Arabic Supplement
        r"ࢠ-ࣿ"   # Arabic Extended-A
        r"ﭐ-﷿"   # Arabic Presentation Forms-A
        r"ﹰ-﻿"   # Arabic Presentation Forms-B
        r"ऀ-ॿ"   # Devanagari
        r"ঀ-৿"   # Bengali
        r"਀-੿"   # Gurmukhi
        r"஀-௿"   # Tamil
        r"一-鿿"   # CJK
        r"぀-ヿ"   # Hiragana + Katakana
        r"가-힯"   # Hangul
        r"]"
    )
    needs_roman = mode in ("roman", "hinglish", "urglish")

    def _looks_untransliterated(text: str) -> bool:
        """True if `text` still contains source-script characters even
        though the user asked for Roman output. Used to flag segments
        that need a per-segment retry."""
        if not needs_roman:
            return False
        return bool(_NON_LATIN_RE.search(text or ""))

    rewritten_texts: dict = {}
    for batch_start in range(0, len(segments), batch_size):
        batch = list(enumerate(segments[batch_start : batch_start + batch_size]))
        items = [
            {"i": batch_start + local_i, "text": (seg.get("text") or "").strip()}
            for local_i, seg in batch
            if (seg.get("text") or "").strip()
        ]
        if not items:
            continue
        try:
            raw = provider.complete_json(
                system,
                json.dumps({"items": items}, ensure_ascii=False),
                max_tokens=8192,
            )
        except LLMError as e:
            print(f"⚠️  LLM rewrite batch failed (continuing with original): {e}")
            continue
        out_items = (raw.get("items", []) if isinstance(raw, dict) else raw) or []
        for it in out_items:
            if isinstance(it, dict) and isinstance(it.get("i"), int) and isinstance(it.get("text"), str):
                new_text = it["text"].strip()
                # SKIP EMPTY REWRITES. The LLM sometimes returns "" for
                # already-translated lines (interpreting "translate to
                # English" as "no work needed → null"). If we accepted
                # empty strings we'd silently DELETE those segments
                # from the burned subtitle — the user reports it as
                # "English lyrics disappear, only Urdu→English shows".
                # Preserve the original text by leaving rewritten_texts
                # without an entry for this i.
                if new_text:
                    rewritten_texts[it["i"]] = new_text

    # Diagnostic: log how many of the input items came back. If the LLM
    # dropped some, those segments KEEP their original text below
    # (we don't blank them). This makes "missing English chorus lines"
    # impossible — worst case the chorus stays in its original language.
    total_input = sum(1 for s in segments if (s.get("text") or "").strip())
    total_rewritten = len(rewritten_texts)
    if total_rewritten < total_input:
        missing = total_input - total_rewritten
        print(
            f"⚠️  LLM returned {total_rewritten}/{total_input} rewrites — "
            f"{missing} segments will keep their ORIGINAL text. "
            f"(common with very long inputs; reduce batch_size if you want every line attempted)"
        )

    # ROMAN-MODE RETRY PASS.
    # For roman/hinglish/urglish modes, find segments that either
    # (a) the LLM dropped entirely OR (b) came back with the ORIGINAL
    # text unchanged (still in Urdu/Hindi/Arabic script). Retry these
    # ONE-BY-ONE with a tighter prompt — single-segment calls are way
    # more likely to actually transliterate because there's no batch
    # confusion or token-budget exhaustion.
    if needs_roman:
        to_retry: list[int] = []
        for i, seg in enumerate(segments):
            orig = (seg.get("text") or "").strip()
            if not orig:
                continue
            rewritten = rewritten_texts.get(i)
            # Retry if: (1) no rewrite at all, OR (2) rewrite is identical
            # to the original (LLM echoed back without transliterating),
            # OR (3) rewrite still contains source-script characters.
            if (rewritten is None
                or rewritten.strip() == orig.strip()
                or _looks_untransliterated(rewritten)):
                # Also retry if the LLM dropped it AND the original
                # contains non-Latin chars (would otherwise burn as-is).
                if rewritten is None and not _NON_LATIN_RE.search(orig):
                    # Original is already Latin (probably an English-only
                    # segment). Nothing to retry.
                    continue
                to_retry.append(i)

        if to_retry:
            print(f"   Retrying {len(to_retry)} segment(s) that came back with "
                  f"source-script intact — single-segment calls.")
            tighter_system = (
                system
                + "\n\nIMPORTANT — RETRY PASS: the previous attempt left the "
                "source-script characters in the output. Re-transliterate "
                "this ONE segment into pure Roman/Latin letters. NEVER "
                "echo Arabic, Devanagari, or any non-Latin character "
                "into the output. Same words, different writing system."
            )
            retry_ok = 0
            for i in to_retry:
                orig = (segments[i].get("text") or "").strip()
                if not orig:
                    continue
                try:
                    raw = provider.complete_json(
                        tighter_system,
                        json.dumps({"items": [{"i": i, "text": orig}]}, ensure_ascii=False),
                        max_tokens=512,
                    )
                except LLMError as e:
                    print(f"      retry i={i} failed: {e}")
                    continue
                out_items = (raw.get("items", []) if isinstance(raw, dict) else raw) or []
                for it in out_items:
                    if (isinstance(it, dict)
                        and isinstance(it.get("text"), str)
                        and it.get("text").strip()):
                        new_text = it["text"].strip()
                        # Only accept the retry if it actually fixed
                        # the issue — otherwise leave the original
                        # rewritten_texts entry untouched.
                        if not _looks_untransliterated(new_text):
                            rewritten_texts[i] = new_text
                            retry_ok += 1
                        else:
                            print(f"      retry i={i}: model STILL produced source-script — giving up.")
                        break
            print(f"   Retry pass: {retry_ok}/{len(to_retry)} segments successfully transliterated.")

    # Apply rewrites to a deep-copied transcript. SAFETY NET: every
    # segment ends with NON-EMPTY text. If the rewrite was skipped or
    # came back empty (already covered above), the original text is
    # preserved. If the original was somehow already empty, the
    # segment is left empty — burn pipeline drops it cleanly.
    new_transcript = json.loads(json.dumps(transcript))
    for i, seg in enumerate(new_transcript.get("segments", [])):
        original_text = (seg.get("text") or "").strip()
        if i in rewritten_texts:
            new_text = rewritten_texts[i]
        else:
            # No rewrite for this i — keep the original text. This is
            # the line the user might have wanted translated but the
            # LLM dropped. They at least see SOMETHING (the source
            # language) instead of nothing.
            new_text = original_text
        # Final safety: if somehow we ended with empty text but had
        # original content, restore the original. Subtitles must
        # never silently disappear.
        if not new_text and original_text:
            new_text = original_text
        seg["text"] = new_text
        # Redistribute words evenly across original [start, end] so the
        # SRT generator's word-level timing still works.
        s, e = float(seg.get("start", 0)), float(seg.get("end", 0))
        tokens = new_text.split()
        if not tokens or e <= s:
            seg["words"] = []
            continue
        per = (e - s) / len(tokens)
        seg["words"] = [
            {"word": tok, "start": s + idx * per, "end": s + (idx + 1) * per}
            for idx, tok in enumerate(tokens)
        ]
    new_transcript["text"] = " ".join(
        seg.get("text", "") for seg in new_transcript.get("segments", [])
    )
    return new_transcript


def llm_translate_full_lyrics(
    lyric_lines: list,
    *,
    target_language: str,
    provider_id: str,
    model_name: str,
    api_key: str,
    base_url=None,
) -> list:
    """One-shot translation of an ENTIRE list of song lyric lines.

    Returns a list of translated strings — guaranteed same length as
    input. Lines already in target_language are returned verbatim;
    other lines get translated.

    Why this exists (vs. llm_rewrite_transcript):
      The batched rewrite path inside llm_rewrite_transcript was
      designed for Whisper transcripts where each segment is a
      different chunk of speech. For SONG lyrics with a repeating
      chorus, that path is unreliable — the LLM sees identical
      `text` values at non-consecutive `i` indices, and JSON output
      tends to collapse / skip duplicates. ALSO splitting the lyrics
      across multiple batches loses cross-batch context (the chorus
      pattern visible only when the LLM sees the whole song).

      One-shot translation of the FULL lyrics list fixes both:
        • All chorus repeats appear in the same prompt — the LLM sees
          they're identical and translates them identically.
        • No batching, no item-dropping, no missing lines.
        • Verbatim preservation for already-target-language lines is
          easier when the LLM can see the song's overall language mix.

    Use this for the BYOL path (user pasted official lyrics).
    For pure-Whisper transcripts, keep using llm_rewrite_transcript.
    """
    if not lyric_lines:
        return []

    from llm import build_provider, LLMError
    # These names are referenced in the prompt below. They live in
    # prompt_rules.py and were previously imported only inside
    # llm_rewrite_transcript — which meant calling llm_translate_full_lyrics
    # raised NameError, silently caught by the try/except in the
    # endpoint and reported as "translation failed; using original".
    # That single missing import was the root cause of every translation
    # failure across all providers (Ollama, MiniMax, Gemini — all of them).
    from prompt_rules import SONG_AWARENESS, CRYPTO_FINANCE_GLOSSARY

    target_name = LANG_NAMES.get((target_language or "en").lower(), target_language or "English")

    try:
        provider = build_provider(provider_id, model_name, api_key, base_url=base_url)
    except LLMError as e:
        print(f"⚠️  llm_translate_full_lyrics: provider build failed ({e}); returning input unchanged.")
        return list(lyric_lines)

    system = (
        f"PRIMARY TASK: Translate the following OFFICIAL SONG LYRICS to "
        f"{target_name}. Return EXACTLY the same number of lines as input, "
        f"in the same order, with the same `i` indices.\n\n"
        f"HARD RULES (never break):\n"
        f"  1. If a line is ALREADY entirely in {target_name} (e.g. an "
        f"English chorus inside a Roman-Urdu song), return that line "
        f"VERBATIM — character-for-character. Do not rephrase, do not "
        f"paraphrase, do not 'simplify'. Just copy.\n"
        f"  2. If a line is in any other language, TRANSLATE it to "
        f"natural, accurate {target_name}.\n"
        f"  3. If a line mixes scripts within itself "
        f"(e.g. 'L1 competitors aaye, sabne dikhaya zor'), translate the "
        f"non-{target_name} part to {target_name} and keep proper nouns / "
        f"crypto-finance terms / brand names in their canonical English form.\n"
        f"  4. Repeating lyric lines (chorus, hook) MUST translate to the "
        f"EXACT SAME output every time they appear. The chorus at i=5 and "
        f"the chorus at i=20 produce identical output text.\n"
        f"  5. Never add, remove, or reorder lines. N input lines → N "
        f"output items. Every i in 0..N-1 must appear exactly once.\n"
        f"  6. Never return empty / null text for any line. Every output "
        f"item must have non-empty `text`.\n\n"
        f"EXAMPLES (each input line stays on its own output line):\n"
        f'  Input  i=0: "Bitcoin hai naya par Crypto hai puraana,"\n'
        f'  Output i=0: "Bitcoin is new, but Crypto is ancient,"\n'
        f'  Input  i=1: "Boom and bust, we rise from the dust!"   (already English)\n'
        f'  Output i=1: "Boom and bust, we rise from the dust!"   (verbatim copy)\n'
        f'  Input  i=2: "L1 competitors aaye, sabne dikhaya zor,"\n'
        f'  Output i=2: "L1 competitors arrived, everyone showed strength,"\n\n'
        f"{SONG_AWARENESS}\n\n"
        f"{CRYPTO_FINANCE_GLOSSARY}\n\n"
        f'OUTPUT FORMAT — return ONLY this JSON:\n'
        f'  {{"items":[{{"i":0,"text":"<translated line 0>"}},'
        f'{{"i":1,"text":"<translated line 1>"}}, ...]}}'
    )

    # Consistent payload key with the rest of the codebase ("items"
    # matches llm_rewrite_transcript and llm_align_lyrics_to_whisper).
    # Earlier versions used "lines" which confused some models about
    # whether to mirror the input shape — they'd output {"lines":...}
    # instead of {"items":...} and the parser missed everything.
    payload = {"items": [{"i": i, "text": line} for i, line in enumerate(lyric_lines)]}
    user = json.dumps(payload, ensure_ascii=False)

    print(f"🔥 llm_translate_full_lyrics: sending {len(lyric_lines)} lines for {target_name} translation "
          f"(provider={provider_id}, model={model_name})")

    # Use complete_text + manual parse so we can LOG the raw response
    # (essential for debugging "the LLM didn't actually translate").
    # Pass temperature=0.0 via the JSON-mode call when we can — cloud
    # providers ignore unknown kwargs, Ollama provider takes it.
    try:
        # Try complete_json first — most providers support a JSON mode.
        # If complete_json doesn't accept temperature kwarg (older
        # providers), this falls through harmlessly to the default.
        try:
            raw_obj = provider.complete_json(
                system, user, max_tokens=15000, temperature=0.0,
            )
            raw_text = json.dumps(raw_obj, ensure_ascii=False) if not isinstance(raw_obj, str) else raw_obj
        except TypeError:
            # Old complete_json signatures without temperature kwarg.
            raw_obj = provider.complete_json(system, user, max_tokens=15000)
            raw_text = json.dumps(raw_obj, ensure_ascii=False) if not isinstance(raw_obj, str) else raw_obj
        # Diagnostic print — first 1500 chars of what came back.
        # If translation is silently failing, this is the FIRST place
        # to look: did the LLM return JSON? Did it return original?
        # Did it return reasoning text and forget the JSON? You see
        # exactly what happened.
        print(f"📥 llm_translate_full_lyrics RAW (first 1500 chars):\n{raw_text[:1500]}\n— end raw —")
    except LLMError as e:
        print(f"⚠️  llm_translate_full_lyrics: LLM call failed ({e}); returning input unchanged.")
        return list(lyric_lines)
    except Exception as e:
        print(f"⚠️  llm_translate_full_lyrics: unexpected error ({type(e).__name__}: {e}); returning input unchanged.")
        return list(lyric_lines)

    raw = raw_obj
    items = (raw.get("items", []) if isinstance(raw, dict) else raw) or []
    print(f"📊 llm_translate_full_lyrics: parsed {len(items)} items from response")
    out_by_index: dict = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        i = it.get("i")
        text = it.get("text")
        if not isinstance(i, int) or not isinstance(text, str):
            continue
        if not (0 <= i < len(lyric_lines)):
            continue
        new_text = text.strip()
        if new_text:
            out_by_index[i] = new_text

    # Build the result list — same length as input. Missing entries
    # fall back to the ORIGINAL lyric line (never empty, never the
    # wrong index). Worst case the user sees an untranslated line
    # rather than a missing one.
    result: list = []
    missing = 0
    for i, original in enumerate(lyric_lines):
        translated = out_by_index.get(i)
        if translated:
            result.append(translated)
        else:
            result.append(original)
            missing += 1
    if missing:
        print(
            f"⚠️  llm_translate_full_lyrics: {missing}/{len(lyric_lines)} lines "
            f"weren't returned by the LLM — those keep their ORIGINAL text."
        )
    else:
        print(f"✅ llm_translate_full_lyrics: translated all {len(lyric_lines)} lines into {target_name}.")
    return result


def llm_align_lyrics_to_whisper(
    whisper_segments: list,
    lyric_lines: list,
    *,
    provider_id: str,
    model_name: str,
    api_key: str,
    base_url=None,
    structure_outline: str = "",
) -> list:
    """Use an LLM to map Whisper transcription segments onto user-
    provided lyric lines. The LLM reads BOTH the heard text and the
    official lyrics and returns, for each Whisper segment, either:
      • the index of the user lyric line that semantically matches it
      • None — meaning skip (ad-lib, instrumental noise, no match)

    Critical for songs where:
      • Choruses repeat verbatim (the same lyric line maps to MULTIPLE
        Whisper segments at different timestamps).
      • Whisper mishears mixed-script vocals (Roman Urdu / Hinglish /
        Arabic) — text doesn't match but phonetics do.
      • Whisper detects ad-libs, drum hits, and exclamations as if
        they were lyric lines — those should be skipped.

    Returns a list of length len(whisper_segments). Each entry is an
    int (lyric index) or None. Falls back to None for segments the
    LLM couldn't classify or returned malformed data for.
    """
    from llm import build_provider, LLMError

    if not whisper_segments or not lyric_lines:
        return [None] * len(whisper_segments)

    try:
        provider = build_provider(provider_id, model_name, api_key, base_url=base_url)
    except LLMError as e:
        print(f"⚠️  LLM align: provider build failed ({e}); skipping semantic match.")
        return [None] * len(whisper_segments)

    payload = {
        "whisper_segments": [
            {
                "i": i,
                "t": round(float(s.get("start", 0)), 2),
                "heard": ((s.get("text") or "").strip()[:200]),
            }
            for i, s in enumerate(whisper_segments)
        ],
        "lyric_lines": [
            {"j": j, "text": (line or "").strip()[:200]}
            for j, line in enumerate(lyric_lines)
        ],
    }
    # Optional: include the song's STRUCTURE OUTLINE (with [Verse]/
    # [Chorus]/[Bridge] markers preserved) so the LLM can see where
    # repetition is expected. Without this, choruses get matched once
    # and subsequent occurrences silently dropped.
    if structure_outline:
        payload["song_structure_for_context"] = structure_outline[:4000]

    # NEW prompt — tighter, with worked examples that show the model
    # what 'chorus repeats at different times re-use the same j indices'
    # actually looks like. Some MiniMax / DeepSeek class models default
    # to chain-of-thought; the 'OUTPUT FORMAT (READ THIS FIRST)' anchor
    # at the very top stops that.
    system = (
        "OUTPUT FORMAT (READ THIS FIRST — THIS IS MANDATORY):\n"
        'Return ONLY a single JSON object: {"matches":[{"i":<int>,"j":<int|null>}, ...]}\n'
        "No prose, no reasoning, no code fences, no extra text. Response must start with `{` and end with `}`.\n\n"
        "TASK: Map Whisper segments (time-ordered audio chunks) to official lyric lines.\n\n"
        "INPUT:\n"
        "- whisper_segments: array in TIME ORDER (i = index, t = start seconds, heard = what Whisper heard)\n"
        "- lyric_lines: array in SONG ORDER (j = line index, text = official lyric)\n"
        "- song_structure_for_context: full lyrics with [Verse]/[Chorus]/[Bridge] tags — use this to see repetition!\n\n"
        "CRITICAL RULES (never break these):\n"
        "1. CHORUS REPEATS ARE SACRED. If the structure outline shows [Chorus] (or any block) appearing N times, "
        "its lyric indices (e.g. j=5,6,7,8) MUST appear in your matches EXACTLY N times at different time ranges.\n"
        "2. Walk the song in TIME ORDER: first chorus block early, second in middle, third near end. "
        "A chorus repeat at t=180 uses the SAME j indices as the first chorus at t=30.\n"
        "3. Never skip a chorus repeat. If you see a large Whisper gap after a verse, it is almost certainly the next chorus.\n"
        "4. Match by PHONETICS, not exact text. Whisper often mishears Roman Urdu / Hinglish — use 'heard' only as a sound hint.\n"
        "5. Return null ONLY for true noise/ad-libs ('yeah', 'oh', 'boom', instrumental blips). "
        "Every real lyric line j must appear at least once.\n"
        "6. Output must contain exactly one entry per whisper_segment i (0 to last).\n"
        "7. SPECIAL: a segment whose 'heard' is exactly '[music]' means Whisper couldn't "
        "transcribe that region (likely a chorus, instrumental break, or music-heavy section). "
        "For these, IGNORE 'heard' entirely and use TIME POSITION + structure outline to decide. "
        "If the structure outline shows a [Chorus] block expected at this time range, map the "
        "consecutive [music] segments to the chorus's j indices in order (e.g. j=5,6,7,8 for "
        "a 4-line chorus split across 4 [music] segments). These are PRIME chorus territory.\n\n"
        "EXAMPLES OF CORRECT BEHAVIOUR (for a song with chorus at j=5-8):\n"
        '  Input whisper i=12 at t=32s (heard: "boom and bust we rise") → j=5\n'
        '  Input whisper i=45 at t=145s (heard: "boom dust") → j=5 again (second chorus)\n'
        '  Input whisper i=78 at t=260s (heard: "crypto cycles trust") → j=6 (second chorus line 2)\n\n'
        "Now process the input and return the matches JSON."
    )

    # temperature=0.0 → deterministic alignment (no creative drift).
    # OpenAIProvider/MinimaxProvider/Ollama all now accept this kwarg;
    # if a provider is on an older signature, fall back to the default
    # call without temperature.
    # max_tokens=12000 — for a 56-segment Whisper × 48-line song the
    # JSON matches array can be ~1500 tokens; 12k gives plenty of head
    # room for longer pieces. 8192 was occasionally truncating responses.
    try:
        try:
            raw = provider.complete_json(
                system,
                json.dumps(payload, ensure_ascii=False),
                max_tokens=12000,
                temperature=0.0,
            )
        except TypeError:
            raw = provider.complete_json(
                system,
                json.dumps(payload, ensure_ascii=False),
                max_tokens=12000,
            )
    except LLMError as e:
        print(f"⚠️  LLM align call failed ({e}); skipping semantic match.")
        return [None] * len(whisper_segments)

    items = (raw.get("matches", []) if isinstance(raw, dict) else []) or []
    out: list = [None] * len(whisper_segments)
    for m in items:
        if not isinstance(m, dict):
            continue
        i = m.get("i")
        j = m.get("j")
        if not isinstance(i, int) or not (0 <= i < len(whisper_segments)):
            continue
        if isinstance(j, int) and 0 <= j < len(lyric_lines):
            out[i] = j
        else:
            out[i] = None
    matched_count = sum(1 for x in out if x is not None)
    print(
        f"🧠 LLM semantic align: {matched_count} / {len(whisper_segments)} "
        f"Whisper segments mapped to {len(lyric_lines)} lyric lines."
    )
    return out


# ---------------------------------------------------------------------------
# BYOL alignment helpers — recovery, verification, structure parsing
# These are used by the merge step in app.py to recover chorus repeats
# the LLM aligner missed.
# ---------------------------------------------------------------------------

def split_lyric_into_word_chunks(
    text: str,
    max_words: int = 5,
) -> list[str]:
    """Split a lyric line into chunks of at most `max_words` words each.

    Used for BYOL subtitle output — the user wants short on-screen chunks
    (4-5 words) so the audience reads each phrase quickly rather than
    seeing a wall of text. Punctuation-aware where possible: prefer
    breaking after commas / dashes / em-dashes when they fall in a
    reasonable range, so phrases stay coherent. Otherwise just slice
    every `max_words`.

    Examples (max_words=5):
      "Boom and bust, we rise from the dust!"
        → ["Boom and bust,", "we rise from the dust!"]
      "Bitcoin is new but Crypto is ancient,"
        → ["Bitcoin is new but Crypto", "is ancient,"]
    """
    line = (text or "").strip()
    if not line:
        return []
    words = line.split()
    if len(words) <= max_words:
        return [line]

    # Phrase-aware split: when a comma / dash / em-dash falls in a
    # reasonable range (>= 2 words from start, <= max_words from start),
    # break there to keep phrases coherent.
    chunks: list[str] = []
    i = 0
    n = len(words)
    while i < n:
        # Look for a comma / em-dash / semi-colon between i+1 and
        # i+max_words; prefer the LAST one in range (so we don't break
        # too early). Tokens ending in ,/—/–/;/: are good break points.
        break_at = -1
        end_search = min(i + max_words, n)
        for k in range(i + 2, end_search):
            if words[k - 1].rstrip().endswith((",", "—", "–", ";", ":")):
                break_at = k  # break AFTER this token
        if break_at <= 0:
            break_at = end_search
        chunks.append(" ".join(words[i:break_at]).strip())
        i = break_at
    return [c for c in chunks if c]


def chunk_segments_by_word_count(
    segments: list,
    max_words: int = 5,
) -> list:
    """Apply split_lyric_into_word_chunks to each segment, redistributing
    timings proportionally across the chunks. Each input segment becomes
    one or more output segments, each with no more than `max_words` words.

    Word-level timings inside `words` are partitioned in order: the first
    chunk gets the first N word-timings, the second gets the next M, etc.
    If `words` is missing or shorter than the split text, fall back to
    even time distribution across chunks.
    """
    out: list = []
    for seg in (segments or []):
        text = (seg.get("text") or "").strip()
        chunks = split_lyric_into_word_chunks(text, max_words=max_words)
        if len(chunks) <= 1:
            out.append(seg)
            continue
        s_start = float(seg.get("start", 0))
        s_end = float(seg.get("end", 0))
        seg_words = seg.get("words") or []
        # Build per-chunk word lists.
        per_chunk_words = [c.split() for c in chunks]
        per_chunk_count = [len(w) for w in per_chunk_words]
        idx = 0
        # Fall back to even time slicing if word-level timings are
        # missing or insufficient.
        use_word_timings = len(seg_words) >= sum(per_chunk_count)
        if not use_word_timings:
            total_words = max(1, sum(per_chunk_count))
            per_word = (s_end - s_start) / total_words
            cur = s_start
            for ci, count in enumerate(per_chunk_count):
                chunk_start = cur
                chunk_end = cur + per_word * count
                cur = chunk_end
                out.append({
                    "text": chunks[ci],
                    "start": chunk_start,
                    "end": min(chunk_end, s_end),
                    "words": [
                        {"word": w, "start": chunk_start + j * per_word, "end": chunk_start + (j + 1) * per_word}
                        for j, w in enumerate(per_chunk_words[ci])
                    ],
                })
        else:
            for ci, count in enumerate(per_chunk_count):
                slice_words = seg_words[idx:idx + count]
                idx += count
                if not slice_words:
                    continue
                chunk_start = float(slice_words[0].get("start", s_start))
                chunk_end = float(slice_words[-1].get("end", s_end))
                out.append({
                    "text": chunks[ci],
                    "start": chunk_start,
                    "end": chunk_end,
                    "words": slice_words,
                })
    return out


def split_whisper_mega_segments(
    whisper_segments: list,
    *,
    max_dur: float = 10.0,
    sub_dur: float = 5.0,
) -> list:
    """Split Whisper segments that are suspiciously long.

    Whisper Turbo (and even larger models on songs with heavy background
    music + female chorus over male verse instrumentation) sometimes
    compresses 15-25 seconds of audio into a single short-text segment.
    A real verse / chorus / sung lyric line is 2-5 seconds; anything
    longer is almost always the model lumping a chorus + neighbouring
    verse into one block and slapping the closest phrase as the label.

    This pre-splits any segment > max_dur into ~sub_dur chunks. The
    FIRST sub-segment keeps Whisper's original text (so the aligner can
    still match the actual transcribed phrase to its lyric); subsequent
    sub-segments get the sentinel "[music]" so the LLM aligner knows
    'this is uncertain — likely a chorus or instrumental break, check
    the structure outline'.

    Why "[music]" not empty: an LLM tends to skip empty inputs without
    matching them to anything. A meaningful sentinel forces the LLM to
    consider what should be there based on time + structure context.
    """
    out: list = []
    for s in (whisper_segments or []):
        try:
            start = float(s.get("start", 0))
            end = float(s.get("end", 0))
        except Exception:
            out.append(s)
            continue
        dur = end - start
        if dur <= max_dur:
            out.append(s)
            continue
        n = max(2, int(round(dur / max(1.0, sub_dur))))
        per = dur / n
        original_text = (s.get("text") or "").strip()
        for k in range(n):
            sub_start = start + k * per
            sub_end = start + (k + 1) * per
            sub = dict(s)
            sub["start"] = sub_start
            sub["end"] = sub_end
            sub["text"] = original_text if k == 0 else "[music]"
            out.append(sub)
    return out


def parse_structure_blocks(structure_outline: str, lyric_lines: list[str]) -> list[dict]:
    """Parse the user's lyrics-with-structure-tags into ordered BLOCKS.

    Returns a list of blocks in song order, each block:
        {
          "tag": "Chorus" | "Verse 1" | "Bridge" | "Outro" | ...
          "j_indices": [5, 6, 7, 8],   # which dedup'd lyric_lines this block contains
        }

    A block is delimited by `[Tag]` lines in the outline. Within each
    block, we map each non-tag line back to the index it occupies in the
    deduplicated `lyric_lines` array — that way the chorus block returns
    [5, 6, 7, 8] every time it appears, even though `lyric_lines` only
    contains those four lines once.

    Used by:
      - the verification helper, to count how many [Chorus] blocks exist
      - the recovery pass, to know which BLOCK of indices to inject when
        a chorus repeat was missed (we insert all 4 chorus lines, not 1).
    """
    import re

    # Build a quick lookup: stripped lyric text → index in lyric_lines.
    # This handles the dedup: chorus repeats in the outline all map to
    # the SAME indices in lyric_lines (which is unique-only).
    line_to_idx: dict[str, int] = {}
    for j, line in enumerate(lyric_lines or []):
        key = (line or "").strip().lower()
        if key and key not in line_to_idx:
            line_to_idx[key] = j

    blocks: list[dict] = []
    current_tag = None
    current_indices: list[int] = []
    tag_re = re.compile(r"^\s*\[([^\]]+)\]\s*$")

    # Only STRUCTURAL tags open new blocks. Annotation tags like
    # [Female Vocals] / [Male Vocals] / [Spoken Word] / [Melodic Flow] /
    # [Instrumental] / [Dance Break] / [Melodic Interlude] are
    # auxiliary metadata about the section, NOT new sections — they
    # appear NESTED inside [Chorus] etc and must not reset the tag.
    # If we treat them as section openers, [Chorus] gets immediately
    # overwritten by [Female Vocals] and chorus_blocks ends up empty,
    # which silently breaks chorus coverage detection.
    STRUCTURAL_KEYWORDS = (
        "verse", "chorus", "bridge", "intro", "outro",
        "pre-chorus", "prechorus", "hook", "refrain",
    )

    def _is_structural(tag: str) -> bool:
        low = (tag or "").lower().strip()
        return any(kw in low for kw in STRUCTURAL_KEYWORDS)

    def _close():
        if current_indices:
            blocks.append({"tag": current_tag or "Section", "j_indices": current_indices.copy()})

    for raw in (structure_outline or "").splitlines():
        m = tag_re.match(raw)
        if m:
            tag_text = m.group(1).strip()
            if _is_structural(tag_text):
                # Real section header — close previous block, start new.
                _close()
                current_tag = tag_text
                current_indices = []
            # Annotation tags ([Female Vocals], etc.) are silently
            # ignored — they don't reset current_tag or current_indices.
            continue
        line_key = raw.strip().lower()
        if not line_key:
            continue
        j = line_to_idx.get(line_key)
        if j is not None:
            current_indices.append(j)
    _close()

    # If the outline had NO tags at all, we still want a single block
    # covering everything so the recovery pass has something to work with.
    if not blocks and lyric_lines:
        blocks.append({"tag": "Song", "j_indices": list(range(len(lyric_lines)))})
    return blocks


def verify_chorus_coverage(
    llm_matches: list,
    lyric_lines: list[str],
    structure_outline: str,
) -> dict:
    """Diagnostic — prints how many [Chorus] blocks exist in the outline
    vs how many distinct chorus occurrences appear in the LLM matches.
    Returns a dict with the counts so callers can log or react.

    Detection strategy (more reliable than searching for the word
    'chorus' inside lyric text — most chorus lyrics don't contain that
    word):
      • Parse structure outline → blocks tagged [Chorus]/[Chorus 1]/...
      • Walk LLM matches in order, count distinct CHORUS-BLOCK runs.
        A 'chorus run' = an unbroken stretch of matched j's that all
        belong to a chorus block's j_indices. Two runs separated by
        non-chorus matches count as two occurrences.
    """
    blocks = parse_structure_blocks(structure_outline, lyric_lines)
    chorus_blocks = [b for b in blocks if "chorus" in b["tag"].lower()]
    if not chorus_blocks:
        return {"expected_chorus_blocks": 0, "matched_chorus_blocks": 0, "blocks": blocks}

    # Union of all j indices that belong to any chorus block.
    chorus_j_set = set()
    for b in chorus_blocks:
        chorus_j_set.update(b["j_indices"])

    expected = len(chorus_blocks)
    matched_runs = 0
    in_chorus = False
    for j in (llm_matches or []):
        if j is not None and j in chorus_j_set:
            if not in_chorus:
                matched_runs += 1
                in_chorus = True
        else:
            in_chorus = False

    print(
        f"🔍 Chorus coverage: outline expects {expected} chorus block(s), "
        f"LLM matched {matched_runs} chorus run(s)."
    )
    if matched_runs < expected:
        print(
            f"   ⚠️  Missing {expected - matched_runs} chorus repeat(s). "
            f"Recovery pass will try to inject them into the largest unmatched gaps."
        )
    return {
        "expected_chorus_blocks": expected,
        "matched_chorus_blocks": matched_runs,
        "chorus_j_set": chorus_j_set,
        "blocks": blocks,
    }


def recover_missing_blocks(
    merged: list[tuple],
    lyric_lines: list[str],
    structure_outline: str,
    *,
    whisper_segments: list[dict],
    coverage: dict | None = None,
    min_gap: float = 4.0,
) -> list[tuple]:
    """Given the merged (l_idx, start, end) groups produced by the LLM
    aligner + merge step, find chorus / structure blocks that the LLM
    UNDER-MATCHED and inject them into the largest unmatched time gaps.

    Returns the same `merged` list, augmented with recovered groups,
    re-sorted by start time. Each recovered group is one (j, start, end)
    tuple per missing lyric line — so a chorus block of [5,6,7,8] that
    needs to be injected becomes 4 contiguous tuples sharing the gap's
    duration proportionally.

    This fixes the original bug from the ticket: when MiniMax M2.7 maps
    the chorus's Whisper segments to a neighbouring verse line (j=9 LTC),
    the chorus indices (j=5..8) end up missing entirely. We detect that
    case here and force-fill the gap with the full chorus block, in
    proper line order.

    Strategy (deliberately conservative — better to leave a gap than
    invent timings):
      1. Build set of j indices ever used in `merged`.
      2. From structure outline, build ordered chorus blocks.
      3. For each chorus block, count how many times its j_indices
         appear in `merged`. If fewer than the block appears in the
         outline, the block is under-matched.
      4. Find unmatched gaps in the merged timeline > min_gap seconds.
      5. Pair under-matched blocks with the largest gaps (in song-time
         order — we don't reshuffle, we fill in place).
      6. Distribute each block's j_indices across its assigned gap with
         equal time per line.
    """
    if not merged or not lyric_lines or not structure_outline:
        return merged

    coverage = coverage or verify_chorus_coverage(
        [j for j, _, _ in [(g[0], g[1], g[2]) for g in merged]],
        lyric_lines,
        structure_outline,
    )
    blocks = coverage.get("blocks") or parse_structure_blocks(structure_outline, lyric_lines)
    chorus_blocks = [b for b in blocks if "chorus" in b["tag"].lower()]
    if not chorus_blocks:
        return merged

    # Count how many distinct CHORUS-BLOCK runs are already in `merged`
    # (a run = consecutive merged groups whose j is in the chorus set).
    chorus_j_set = set()
    for b in chorus_blocks:
        chorus_j_set.update(b["j_indices"])
    matched_runs = 0
    in_run = False
    for (j, _, _) in merged:
        if j in chorus_j_set:
            if not in_run:
                matched_runs += 1
                in_run = True
        else:
            in_run = False

    expected = len(chorus_blocks)
    missing = expected - matched_runs
    if missing <= 0:
        return merged

    # Find unmatched gaps in the merged timeline.
    sorted_m = sorted(merged, key=lambda g: g[1])
    gaps: list[tuple[float, float]] = []
    prev_end = 0.0
    for (_, s_start, s_end) in sorted_m:
        if s_start - prev_end > min_gap:
            gaps.append((prev_end, s_start))
        prev_end = max(prev_end, s_end)
    # Trailing gap.
    song_end = max((s.get("end", 0.0) for s in (whisper_segments or [])), default=prev_end)
    if song_end - prev_end > min_gap:
        gaps.append((prev_end, song_end))

    if not gaps:
        return merged

    # Take the `missing` largest gaps — they're the most likely to hold
    # the missed chorus repeats. Sort descending by duration, take top
    # `missing`, then sort BACK by time so we fill in song order.
    largest = sorted(gaps, key=lambda g: g[1] - g[0], reverse=True)[:missing]
    largest.sort(key=lambda g: g[0])

    # Pair each missing chorus block with one gap. Use the FIRST chorus
    # block's j_indices for every recovered block — choruses repeat
    # verbatim by definition.
    template_indices = chorus_blocks[0]["j_indices"]
    if not template_indices:
        return merged

    recovered: list[tuple] = list(merged)
    for (gap_start, gap_end) in largest:
        gap_dur = gap_end - gap_start
        # Don't fabricate huge timings; cap at 6s per line.
        per_line = min(6.0, max(1.5, gap_dur / max(1, len(template_indices))))
        # If the gap is shorter than (per_line × N), squeeze evenly.
        if per_line * len(template_indices) > gap_dur:
            per_line = gap_dur / len(template_indices)
        cur = gap_start
        for j in template_indices:
            recovered.append((j, cur, min(cur + per_line, gap_end)))
            cur += per_line
        print(
            f"   → Recovery: injected chorus block {template_indices} into "
            f"gap {gap_start:.1f}-{gap_end:.1f}s ({per_line:.2f}s/line)"
        )

    recovered.sort(key=lambda g: g[1])
    return recovered
