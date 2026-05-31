"""Per-clip hook regeneration.

Why this exists: both the Fast (single-call multimodal) and Pro (staged
pipeline) pickers occasionally return identical or generic hooks for
every selected clip — the user complained that all 6 clips on screen
had the literal same title ("Run hundreds of AI agents in one unified
token hub") and the same caption rationale. That's a useless UX:
viewers can't distinguish clips by their card.

The robust fix is to NOT trust the picker's hook. Instead, after we
know each clip's [start, end] range, we go back to the transcript,
extract the actual lines spoken inside that range, and ask an LLM to
write ONE punchy hook + reason PER clip from those lines. This gives
us:
  • Genuinely unique hooks (because each clip's transcript content is
    different — the picker can't "leak" one moment's text into another
    clip's hook).
  • Hooks that match what's actually said in the clip (the picker's
    hook can drift if downstream snapping changed the boundaries).
  • Fail-soft: if the LLM call fails, we keep the picker's original
    hook so the user still sees something.

Public surface: `ensure_unique_hooks(clips, transcript_segments, ...)`.
Mutates the supplied list of clip dicts in place AND returns it for
chaining. Each clip dict needs `start` + `end` keys; the regenerated
fields are `hook` and `why_viral`.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


def _extract_clip_text(
    start: float,
    end: float,
    segments: List[Dict[str, Any]],
) -> str:
    """Pull the spoken transcript inside [start, end] as a flat string.
    Includes any segment that overlaps the range so the hook reflects
    everything heard in the clip."""
    lines: List[str] = []
    for s in segments or []:
        try:
            ss = float(s.get("start", 0))
            se = float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        if se <= start or ss >= end:
            continue
        text = (s.get("text") or "").strip()
        if text:
            lines.append(text)
    return " ".join(lines)


def _hooks_need_regen(clips: List[Dict[str, Any]]) -> bool:
    """True if any clip looks like it has a generic / duplicated hook
    that warrants a regen pass.

    Heuristics:
      • An empty / missing hook → regen.
      • Two or more clips share the EXACT hook string → regen all.
      • A hook is suspiciously short (< 4 words) → regen all (often a
        single keyword like "AI" or a placeholder).
    """
    if not clips:
        return False
    hooks = [(c.get("hook") or "").strip() for c in clips]
    if any(not h for h in hooks):
        return True
    seen: Dict[str, int] = {}
    for h in hooks:
        seen[h] = seen.get(h, 0) + 1
    if any(count >= 2 for count in seen.values()):
        return True
    if any(len(h.split()) < 4 for h in hooks):
        return True
    return False


def ensure_unique_hooks(
    clips: List[Dict[str, Any]],
    transcript_segments: List[Dict[str, Any]],
    *,
    provider_id: str,
    model_name: str,
    api_key: str,
    base_url: Optional[str] = None,
    force: bool = False,
    on_log=None,
) -> List[Dict[str, Any]]:
    """Replace each clip's hook + why_viral with a fresh per-clip pair
    derived from the transcript text inside its [start, end] range.

    `force=False` (default): only regenerate when `_hooks_need_regen`
    decides the existing hooks look bad. Saves an LLM call when the
    picker did its job.

    `force=True`: always regenerate. Useful when the caller knows the
    picker's hooks are unreliable (e.g. Pro pipeline running on a
    poor local VLM).
    """
    log = on_log or (lambda s: print(s))
    if not clips:
        return clips
    if not force and not _hooks_need_regen(clips):
        log("✓ Per-clip hooks look unique — skipping regen.")
        return clips

    log(f"📝 Regenerating per-clip hooks for {len(clips)} clip(s)…")

    # Collect each clip's transcript text. If a clip's range has no
    # transcript (very rare — silent clip), keep its existing hook.
    payload: List[Dict[str, Any]] = []
    for i, c in enumerate(clips):
        try:
            start = float(c.get("start", 0))
            end = float(c.get("end", 0))
        except (TypeError, ValueError):
            continue
        text = _extract_clip_text(start, end, transcript_segments)
        if not text:
            continue
        payload.append({
            "n": i + 1,
            "start": round(start, 1),
            "end": round(end, 1),
            "text": text[:1500],  # cap so the prompt stays bounded
        })
    if not payload:
        log("⚠️  No transcript content in any clip — skipping regen.")
        return clips

    # One LLM call generates hooks for ALL clips at once. Numbering
    # keeps the response 1:1 mappable.
    items = "\n\n".join(
        f"--- CLIP {p['n']} ({p['start']:.0f}s → {p['end']:.0f}s) ---\n{p['text']}"
        for p in payload
    )
    system = (
        "You are a viral short-form video editor writing the hook "
        "headline + caption rationale for clips that have ALREADY "
        "been picked. You will be shown the transcript of EACH clip. "
        "For each clip, return EXACTLY ONE hook and EXACTLY ONE "
        "rationale. Hooks MUST be unique across clips — never reuse "
        "the same wording for two different clips. Hooks should be "
        "8-12 words, in the speaker's apparent language (English if "
        "the transcript is English; English-equivalent otherwise), "
        "phrased as a curiosity gap or a specific punchy claim. "
        "Rationales should be one sentence on what specifically makes "
        "THAT clip land — refer to a unique detail from its transcript."
    )
    user = (
        f"Write a unique hook + rationale for each of these {len(payload)} clips:\n\n"
        f"{items}\n\n"
        'Return ONLY this JSON shape — no markdown, no prose: '
        '{"clips": [{"n": 1, "hook": "...", "why_viral": "..."}, ...]}'
    )

    try:
        from llm import build_provider, LLMError
        provider = build_provider(
            provider_id=provider_id,
            model=model_name,
            api_key=api_key,
            base_url=base_url,
        )
        resp = provider.complete_json(system=system, user=user, max_tokens=2400)
    except (LLMError, Exception) as e:
        log(f"⚠️  Hook regen failed — keeping picker's hooks: {e}")
        return clips

    if not isinstance(resp, dict):
        log("⚠️  Hook regen returned non-dict — keeping picker's hooks.")
        return clips

    # Be tolerant about which key the model used — clips, items, hooks.
    new_hooks: List[Dict[str, Any]] = []
    for k in ("clips", "items", "hooks", "results"):
        v = resp.get(k)
        if isinstance(v, list) and v:
            new_hooks = v
            break
    if not new_hooks:
        # Last-ditch: walk dict values for any list of dicts that have
        # an `n` field.
        for v in resp.values():
            if isinstance(v, list) and v and isinstance(v[0], dict) and "n" in v[0]:
                new_hooks = v
                break
    if not new_hooks:
        log(f"⚠️  Hook regen produced no parseable list. keys={list(resp.keys())}")
        return clips

    # Map back to clips. Track uniqueness as a final guard.
    written = 0
    seen_hooks: set = set()
    for h in new_hooks:
        if not isinstance(h, dict):
            continue
        try:
            idx = int(h.get("n", -1)) - 1
        except (TypeError, ValueError):
            continue
        if not (0 <= idx < len(clips)):
            continue
        hook = str(h.get("hook") or "").strip()[:160]
        why = str(h.get("why_viral") or h.get("why") or "").strip()[:280]
        if not hook:
            continue
        # Final dedupe layer — if the LLM still produced a duplicate,
        # tag the clip number so the cards don't display identical
        # titles. Better an awkward-but-distinct hook than a misleading
        # one.
        if hook in seen_hooks:
            hook = f"{hook} ({idx + 1})"
        seen_hooks.add(hook)
        clips[idx]["hook"] = hook
        if why:
            clips[idx]["why_viral"] = why
        written += 1

    log(f"✓ Hook regen wrote {written} unique hook(s) of {len(clips)} clip(s).")
    return clips
