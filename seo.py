"""YouTube SEO generation from a Whisper transcript.

Given Klipra's transcript dict (segments with start/end), build a prompt for the
user's chosen LLM and post-process its JSON into clean, copy-paste-ready output:
  - 5 high-CTR title ideas
  - an optimized description (with the chapter list appended)
  - YouTube tags
  - chapters with timestamps SNAPPED to real transcript boundaries (perfect timing)

Pure helpers — no network, no app state — so it's easy to test and safe to import
into app.py.
"""
from __future__ import annotations


def fmt_ts(seconds: float) -> str:
    """YouTube chapter timestamp: m:ss when < 1h, else h:mm:ss."""
    s = max(0, int(round(seconds)))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _timeline(transcript: dict, max_chars: int = 14000) -> str:
    """Compact, time-tagged transcript that still spans the whole video, so the
    model can place chapters across the full timeline without blowing context."""
    segs = transcript.get("segments") or []
    if not segs:
        return (transcript.get("text") or "").strip()[:max_chars]
    # bucket into ~20s windows
    window, buckets, cur, cur_start = 20.0, [], [], None
    for s in segs:
        st = float(s.get("start", 0.0))
        if cur_start is None:
            cur_start = st
        if st - cur_start >= window and cur:
            buckets.append((cur_start, " ".join(cur)))
            cur, cur_start = [], st
        cur.append((s.get("text") or "").strip())
    if cur:
        buckets.append((cur_start or 0.0, " ".join(cur)))
    lines = [f"[{int(st)}s] {txt}" for st, txt in buckets]
    out = "\n".join(lines)
    if len(out) > max_chars:  # keep head + tail so chapters still cover the end
        head = out[: int(max_chars * 0.7)]
        tail = out[-int(max_chars * 0.3):]
        out = head + "\n…\n" + tail
    return out


def _language_instruction(out_lang: str) -> str:
    out = (out_lang or "English").strip()
    low = out.lower().replace("-", " ").replace("_", " ")
    if low in ("english", "en"):
        return ("Write ALL output — every title, the description, every tag, and every "
                "chapter title — in ENGLISH only. The video may be spoken in another "
                "language; translate the meaning into natural, fluent English. Do NOT "
                "output any non-English script (only keep well-known proper nouns/brands).")
    if low in ("roman urdu", "romanurdu", "urdu (roman)", "roman"):
        return ("Write ALL output — every title, the description, every tag, and every "
                "chapter title — in ROMAN URDU: Urdu written with the English/Latin "
                "alphabet (e.g. 'apni crypto privacy aise mehfooz karein'). Do NOT use "
                "the Urdu/Arabic script anywhere. Keep common English tech/brand terms "
                "(NEAR Protocol, blockchain, crypto, privacy) in English.")
    if low in ("auto", "same", "same as video", "match", "source"):
        return "Write all output in the SAME language the video is spoken in."
    return (f"Write ALL output — every title, the description, every tag, and every "
            f"chapter title — in {out}. Do NOT use any other language or script.")


def build_prompt(transcript: dict, duration: float, output_language: str = "English") -> tuple[str, str]:
    lang = transcript.get("language") or "the source language"
    timeline = _timeline(transcript)
    lang_rule = _language_instruction(output_language)
    system = (
        "You are a world-class YouTube SEO strategist and copywriter. You write "
        "titles that maximize click-through rate without clickbait lies, and "
        "descriptions and tags optimized for YouTube search and suggested feed. "
        f"{lang_rule} "
        "You reply with ONLY valid JSON — no markdown, no commentary."
    )
    user = f"""Here is the transcript of a YouTube video. Each line is prefixed with its start time in seconds.

TRANSCRIPT:
{timeline}

VIDEO LENGTH: {int(duration)} seconds. SPOKEN LANGUAGE: {lang}.

OUTPUT LANGUAGE — STRICT: {lang_rule}

Produce YouTube SEO metadata as JSON with EXACTLY these keys:
{{
  "titles": [5 distinct, compelling titles, each <= 70 characters, no surrounding quotes.
             Vary the angles: a how-to, a curiosity/question, a number/listicle, a
             benefit-driven, and a bold/contrarian one. Front-load the main keyword.],
  "description": "3 short paragraphs (~120-180 words total): a strong hook line, what the
                  viewer will learn, and a soft call-to-action. Naturally include the main
                  keywords. Do NOT include the chapter list here.",
  "tags": [12-20 lowercase search tags/keywords, ordered most->least important, no '#'],
  "chapters": [{{"start": <integer seconds>, "title": "<= 45 chars"}}, ...]
}}

Chapter rules: 4-10 chapters, in chronological order, the FIRST chapter MUST start at 0,
every start must be a real topic change drawn from the timestamps above and be within the
video length. Titles should be specific and skimmable."""
    return system, user


def postprocess(seo: dict, transcript: dict, duration: float) -> dict:
    """Validate the LLM JSON and snap chapter timestamps to real segment starts."""
    if not isinstance(seo, dict):
        raise ValueError("LLM did not return a JSON object")

    seg_starts = sorted({float(s.get("start", 0.0)) for s in (transcript.get("segments") or [])})

    def snap(t: float) -> float:
        if not seg_starts:
            return max(0.0, min(t, duration))
        return min(seg_starts, key=lambda x: abs(x - t))

    titles = [str(t).strip().strip('"').strip() for t in (seo.get("titles") or []) if str(t).strip()][:5]
    tags = [str(t).strip().lstrip("#").strip() for t in (seo.get("tags") or []) if str(t).strip()]
    description = (seo.get("description") or "").strip()

    chapters, seen = [], set()
    for ch in (seo.get("chapters") or []):
        try:
            t = float(ch.get("start", 0))
        except (TypeError, ValueError):
            continue
        t = snap(max(0.0, min(t, max(duration - 1, 0))))
        title = str(ch.get("title", "")).strip().strip('"')[:60]
        if not title or int(t) in seen:
            continue
        seen.add(int(t))
        chapters.append({"seconds": int(round(t)), "title": title})
    chapters.sort(key=lambda c: c["seconds"])
    if chapters:
        chapters[0]["seconds"] = 0  # YouTube requires the first chapter at 0:00
    for c in chapters:
        c["time"] = fmt_ts(c["seconds"])

    chapter_block = "\n".join(f"{c['time']} {c['title']}" for c in chapters)
    description_full = description + (("\n\nChapters:\n" + chapter_block) if chapter_block else "")

    return {
        "titles": titles,
        "description": description,
        "description_full": description_full,
        "tags": tags,
        "tags_text": ", ".join(tags),
        "chapters": chapters,
    }
