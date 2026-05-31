import os
import json
import re
import subprocess
import time

try:
    from google import genai
    from google.genai import types
    _HAS_GEMINI_SDK = True
except ImportError:
    genai = None
    types = None
    _HAS_GEMINI_SDK = False

class VideoEditor:
    """Auto-edit pipeline with multi-provider support.

    - Gemini path: uploads the rendered clip and asks for a context-aware
      FFmpeg filter using visual + transcript analysis (original behavior).
    - Any other provider: skips upload (other LLMs don't accept video)
      and asks for a filter based on transcript + dimensions only. The
      feature still works on OpenAI / Anthropic / MiniMax / OpenRouter /
      Ollama without a Gemini key.
    """

    def __init__(self, api_key, provider_id="gemini", model_name=None, base_url=None):
        self.provider_id = (provider_id or "gemini").lower()
        self.api_key = api_key
        self.base_url = base_url
        if self.provider_id == "gemini":
            if not _HAS_GEMINI_SDK:
                raise RuntimeError("google-genai SDK not installed")
            self.client = genai.Client(api_key=api_key)
            self.model_name = model_name or "gemini-3-flash-preview"
        else:
            from llm import build_provider
            self.model_name = model_name or "gpt-5-mini"
            self._provider = build_provider(
                self.provider_id, self.model_name, api_key, base_url=base_url,
            )
            self.client = None

    def upload_video(self, video_path):
        """Uploads video to Gemini File API. Returns None for non-Gemini
        providers (which run text-only auto-edit without visual analysis)."""
        if self.provider_id != "gemini":
            print(f"ℹ️  Provider '{self.provider_id}' doesn't accept video uploads — "
                  f"running text-only auto-edit from transcript.")
            return None

        print(f"📤 Uploading {video_path} to Gemini...")
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video file not found: {video_path}")
        try:
            file_upload = self.client.files.upload(file=video_path)
        except Exception as e:
            print(f"❌ Gemini Upload Error: {e}")
            raise e

        print("⏳ Waiting for video processing by Gemini...")
        while True:
            file_info = self.client.files.get(name=file_upload.name)
            if file_info.state == "ACTIVE":
                print("✅ Video processed and ready.")
                return file_upload
            elif file_info.state == "FAILED":
                raise Exception("Video processing failed by Gemini.")
            time.sleep(2)

    def get_ffmpeg_filter(self, video_file_obj, duration, fps=30, width=None, height=None, transcript=None):
        """Asks the LLM for an FFmpeg filter string that makes the clip
        feel viral. The prompt now MANDATES effects (no opt-out for
        'serious' clips) — talking-head footage looked unchanged before
        because the old prompt told the model 'better no effect than
        random effect', and the model dutifully returned no-ops.
        """
        if width is None or height is None:
            width, height = 1080, 1920

        transcript_text = json.dumps(transcript) if transcript else "Not available."
        total_frames = max(1, int(round(duration * fps)))
        # Punch-in cadence: roughly one zoom level change every 3 seconds.
        zoom_zones = max(4, int(duration / 3))

        prompt = f"""
        You are a viral short-form video editor. Generate an FFmpeg filter string that makes this clip feel ENERGETIC, POLISHED, and SHAREABLE — like Submagic, Opus, or Klap output. Talking-head footage WILL look bland without your edits, so the edits are MANDATORY, not optional.

        Video Duration: {duration} seconds.
        Video FPS: {fps}
        Total frames: {total_frames} (use the `on` variable from 0 to {total_frames} in zoompan)
        Video Resolution (MUST KEEP EXACT): {width}x{height}

        TRANSCRIPT (use timestamps to find emphasis moments):
        {transcript_text}

        ========== ALWAYS DO ALL THREE ==========
        Your output filter MUST contain ALL of these. Skipping any of them is a failure:

        1) ZOOM / PUNCH-IN MOTION — at least {zoom_zones} distinct zoom levels across the clip (NOT all the same value):
           - Open with subtle zoom (1.05x) for the first few seconds.
           - Punch IN to ~1.18-1.25x at sentence-emphasis moments (use the transcript to find these).
           - Pull back to ~1.08x in lulls.
           - Always end on a slight zoom-in (1.10-1.15x) for momentum.
           - Use one `zoompan` with a piecewise expression like:
             `zoompan=z='1.05*between(on,0,30)+1.20*between(on,31,75)+1.08*between(on,76,150)+1.22*between(on,151,225)+1.12*gte(on,226)':d=1:s={width}x{height}:fps={fps}`
           - Every zone must have a DISTINCT multiplier. Five identical 1.0 zones is a no-op and FORBIDDEN.

        2) COLOR GRADE — applied to the WHOLE clip (no `enable=` on the base grade):
           - `eq=contrast=1.10:saturation=1.18:gamma=0.97`
           - Then ONE additional `eq=contrast=1.25:saturation=1.35:enable='between(t,X,Y)'` band lasting ~1-2 s on the single biggest emphasis moment.

        3) SHARPEN — once for the whole clip:
           - `unsharp=lx=5:ly=5:la=0.6:cx=5:cy=5:ca=0.0`

        Optional flair (use AT MOST ONE of these — don't pile on):
           - `hue=s=0:enable='between(t,A,B)'` for a brief 0.3 s desaturated punctuation moment.

        ========== HARD SYNTAX RULES ==========
        - DO NOT use `<`, `>`, `<=`, `>=`. Use `lt(x,y)`, `gt(x,y)`, `lte(x,y)`, `gte(x,y)`, `between(x,a,b)`.
        - Wrap dynamic values in single quotes: `z='...'`, `enable='...'`.
        - For `zoompan`:
          - Use `on` (output frame index, 0 to {total_frames}).
          - Convert seconds → frames: `frame = seconds * {fps}`.
          - Always set `s={width}x{height}`, `fps={fps}`, `d=1`.
          - DO NOT use `scale`, `crop`, or `pad` (would change aspect).
        - For `eq`/`hue`/`unsharp`:
          - DO NOT use dynamic expressions for parameter values (no `contrast='1+0.5*t'`).
          - Use `enable='between(t,start,end)'` for time-bounded bands.
          - You may chain multiple instances of the same filter for multiple bands.

        ========== ABSOLUTE NO-NOS ==========
        - Empty filter string. Even on quiet talking-head footage, you MUST apply zoom + color + sharpen.
        - All-equal zoom values (e.g. all `1.0` or all `1.1`). Visible motion is the goal.
        - Aspect ratio change. Output stays {width}x{height}.

        OUTPUT JSON ONLY (no markdown fences, no commentary):
        {{
            "filter_string": "..."
        }}
        """

        print(f"🤖 Asking {self.provider_id}/{self.model_name} for FFmpeg filter...")
        if self.provider_id == "gemini" and video_file_obj is not None:
            response = self.client.models.generate_content(
                model=self.model_name,
                contents=[video_file_obj, prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json"
                )
            )
            response_text_for_log = response.text
        else:
            # Text-only path (works for any provider). The visual analysis
            # is sacrificed; the prompt's transcript + dimensions are
            # enough for sensible filters in 90% of cases.
            data = self._provider.complete_json(
                "You are an expert FFmpeg video editor.",
                prompt,
                max_tokens=4096,
            )
            class _R: pass
            response = _R()
            response.text = json.dumps(data) if not isinstance(data, str) else data
            response_text_for_log = response.text

        print(f"🔍 DEBUG: LLM Raw Response:\n{response_text_for_log}")

        try:
            # Clean response text (remove potential markdown blocks)
            text = response.text
            if text.startswith("```json"):
                text = text[7:]
            elif text.startswith("```"):
                text = text[3:]
            
            if text.endswith("```"):
                text = text[:-3]
                
            text = text.strip()
            
            # Additional cleanup for potential trailing characters outside JSON
            # Find the first '{' and last '}'
            start_idx = text.find('{')
            end_idx = text.rfind('}')
            
            if start_idx != -1 and end_idx != -1:
                text = text[start_idx:end_idx+1]
            
            print(f"🔍 DEBUG: Cleaned JSON Text:\n{text}")
                
            return json.loads(text)
        except json.JSONDecodeError:
            print(f"❌ Failed to parse JSON: {response.text}")
            return None

    def get_effects_config(self, video_file_obj, duration, fps=30, width=None, height=None, transcript=None):
        """Asks Gemini for a structured EffectsConfig JSON for Remotion rendering."""
        if width is None or height is None:
            width, height = 1080, 1920

        transcript_text = json.dumps(transcript) if transcript else "Not available."

        prompt = f"""
        You are an expert video editor analyzing a video and its transcript to generate dynamic visual effects for a Remotion-based renderer.

        Video Duration: {duration} seconds.
        Video FPS: {fps}
        Video Resolution: {width}x{height}

        TRANSCRIPT (Context of what is being said):
        {transcript_text}

        Your task is to produce a structured JSON describing time-based effect segments that cover the FULL video duration.

        Each segment has these fields:
        - "startSec" (number): Start time in seconds.
        - "endSec" (number): End time in seconds.
        - "zoom" (number): Zoom level. 1.0 = no zoom, max 1.5. Use subtle values like 1.05-1.2 for most cases.
        - "zoomCenterX" (number): Horizontal focus point for zoom, 0.0 (left) to 1.0 (right). 0.5 = center.
        - "zoomCenterY" (number): Vertical focus point for zoom, 0.0 (top) to 1.0 (bottom). 0.5 = center.
        - "brightness" (number): Brightness multiplier. 1.0 = normal. Range 0.8-1.2.
        - "contrast" (number): Contrast multiplier. 1.0 = normal. Range 0.8-1.3.
        - "saturate" (number): Saturation multiplier. 1.0 = normal. Range 0.8-1.3.

        Instructions:
        1. ANALYZE the video content and transcript to understand mood, pacing, and key moments.
        2. Apply CONTEXTUAL effects aligned with speech and action:
           - Use slow, subtle zooms toward the speaker's face during speaking moments.
           - Emphasize key moments, punchlines, or dramatic beats with slightly stronger zoom or contrast.
           - Keep transitions smooth — avoid jarring jumps between segments.
           - If nothing significant is happening, keep values at defaults (zoom 1.0, all multipliers 1.0).
        3. Segments MUST cover the entire video duration from 0 to {duration} seconds with no gaps.
        4. Prefer fewer, longer segments with gradual changes over many rapid short segments.
        5. Output ONLY valid JSON, no explanations.

        Output format:
        {{
            "segments": [
                {{
                    "startSec": 0,
                    "endSec": 3.5,
                    "zoom": 1.0,
                    "zoomCenterX": 0.5,
                    "zoomCenterY": 0.5,
                    "brightness": 1.0,
                    "contrast": 1.0,
                    "saturate": 1.0
                }}
            ]
        }}
        """

        print(f"🤖 Asking {self.provider_id}/{self.model_name} for Remotion effects config...")
        if self.provider_id == "gemini" and video_file_obj is not None:
            response = self.client.models.generate_content(
                model=self.model_name,
                contents=[video_file_obj, prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json"
                )
            )
        else:
            data = self._provider.complete_json(
                "You are an expert video editor producing JSON effect configs.",
                prompt,
                max_tokens=4096,
            )
            class _R: pass
            response = _R()
            response.text = json.dumps(data) if not isinstance(data, str) else data

        print(f"🔍 DEBUG: LLM Raw Response:\n{response.text}")

        try:
            # Clean response text (remove potential markdown blocks)
            text = response.text
            if text.startswith("```json"):
                text = text[7:]
            elif text.startswith("```"):
                text = text[3:]

            if text.endswith("```"):
                text = text[:-3]

            text = text.strip()

            # Find the first '{' and last '}'
            start_idx = text.find('{')
            end_idx = text.rfind('}')

            if start_idx != -1 and end_idx != -1:
                text = text[start_idx:end_idx+1]

            print(f"🔍 DEBUG: Cleaned JSON Text:\n{text}")

            return json.loads(text)
        except json.JSONDecodeError:
            print(f"❌ Failed to parse effects config JSON: {response.text}")
            return None

    @staticmethod
    def _split_filter_chain(filter_string: str) -> list[str]:
        """Split a -vf filter chain on commas — respecting BOTH single-quoted
        substrings AND parenthesised expressions.

        The previous version only tracked quotes, so `crop=iw:ih/(1+sin(t)
        *between(t,0,2))` — which has commas INSIDE parens — got split
        into pieces. That broke the strip-crop logic and confused the
        zoompan-size enforcer too.
        """
        parts: list[str] = []
        start = 0
        in_quote = False
        paren_depth = 0
        for i, ch in enumerate(filter_string):
            if ch == "'":
                in_quote = not in_quote
            elif not in_quote:
                if ch == "(":
                    paren_depth += 1
                elif ch == ")":
                    paren_depth = max(0, paren_depth - 1)
                elif ch == "," and paren_depth == 0:
                    parts.append(filter_string[start:i])
                    start = i + 1
        parts.append(filter_string[start:])
        return parts

    @classmethod
    def _enforce_zoompan_output_size(cls, filter_string: str, width: int, height: int) -> str:
        """Force any zoompan filter to output the same geometry as the input clip."""
        parts = cls._split_filter_chain(filter_string)
        out_parts: list[str] = []
        for part in parts:
            if "zoompan=" in part:
                # Force s=WxH inside zoompan options (digitsxdigits only).
                if re.search(r":s=\d+x\d+", part):
                    part = re.sub(r":s=\d+x\d+", f":s={width}x{height}", part)
                else:
                    part = f"{part}:s={width}x{height}"
            out_parts.append(part)
        return ",".join(out_parts)

    # ------------------------------------------------------------------
    # SOUND-EFFECT LIBRARY
    # ------------------------------------------------------------------
    # Each entry returns a self-contained FFmpeg audio source expression
    # — built from `aevalsrc`/`anoisesrc` so we don't need binary sound
    # files on disk. The expressions render mono 44.1 kHz audio at the
    # given duration with an envelope that decays naturally. amplitude
    # already includes a -6 dB headroom so multiple SFX mixed with
    # original audio don't clip.
    #
    # Schema: name -> { duration_s, source_expr, default_gain }
    # source_expr is a Python format string with {dur} placeholder so
    # the duration can be tweaked per-cue if needed.
    # ------------------------------------------------------------------
    SFX_LIBRARY = {
        # Quick 1 kHz click — for subtle zone changes
        "pop": {
            "duration_s": 0.10,
            "source_expr": "aevalsrc=exp(-t*40)*sin(2*PI*1000*t)*0.5:s=44100:d={dur}",
            "default_gain": 0.6,
        },
        # Filtered noise burst — for fast zoom-in punches
        "whoosh": {
            "duration_s": 0.30,
            "source_expr": (
                "anoisesrc=color=brown:duration={dur}:amplitude=0.4:sample_rate=44100,"
                "lowpass=f=2500"
            ),
            "default_gain": 0.7,
        },
        # Low boom with snappy decay — for big punches / heavy emphasis
        "impact": {
            "duration_s": 0.40,
            "source_expr": "aevalsrc=exp(-t*8)*sin(2*PI*65*t)*0.7:s=44100:d={dur}",
            "default_gain": 0.8,
        },
        # Bell-like sine with long tail — for graceful pull-back / reveal
        "ding": {
            "duration_s": 0.60,
            "source_expr": "aevalsrc=exp(-t*4)*sin(2*PI*880*t)*0.4:s=44100:d={dur}",
            "default_gain": 0.5,
        },
        # Ascending tone over 1.5s — for build-ups / risers before a punch
        "riser": {
            "duration_s": 1.50,
            "source_expr": (
                "aevalsrc=(t/{dur})*sin(2*PI*(200+800*t/{dur})*t)*0.4:s=44100:d={dur}"
            ),
            "default_gain": 0.6,
        },
        # Reverse-whoosh — for zoom-OUT moments. Same as whoosh but
        # high-pass and with a slow attack instead of fast decay.
        "reverse_whoosh": {
            "duration_s": 0.30,
            "source_expr": (
                "anoisesrc=color=brown:duration={dur}:amplitude=0.4:sample_rate=44100,"
                "highpass=f=300"
            ),
            "default_gain": 0.65,
        },
    }

    @classmethod
    def _detect_sfx_cues_from_filter(
        cls, filter_string: str, fps: int = 30, max_cues: int = 5,
    ) -> list[tuple[float, str]]:
        """Parse the AI's zoompan z= expression to find zone boundaries
        and pick a sound cue for each transition. Returns a list of
        (timestamp_seconds, cue_type) tuples, capped at `max_cues` so
        we don't spam the audio with constant whooshes on long clips.

        Heuristic per-transition:
          - new zoom > prev zoom + 0.10  -> 'impact'   (big punch in)
          - new zoom > prev zoom         -> 'pop'      (subtle punch)
          - new zoom < prev zoom - 0.10  -> 'whoosh'   (fast pull back)
          - new zoom < prev zoom         -> 'reverse_whoosh' (gentle pull)
          - equal                        -> skip
        """
        if not filter_string or "zoompan" not in filter_string:
            return []

        # Find the z='...' contents inside the zoompan filter.
        m = re.search(r"zoompan=[^,]*?z='([^']+)'", filter_string)
        if not m:
            return []
        z_expr = m.group(1)

        # Extract multiplier × between(on, start, end) terms. Also
        # handle the trailing gte(on, X) zone the prompt examples use.
        zones: list[tuple[float, int, int]] = []  # (zoom, start_frame, end_frame)
        for mm in re.finditer(
            r"(\d+(?:\.\d+)?)\s*\*\s*between\(on\s*,\s*(\d+)\s*,\s*(\d+)\)",
            z_expr,
        ):
            zoom = float(mm.group(1))
            f0 = int(mm.group(2))
            f1 = int(mm.group(3))
            zones.append((zoom, f0, f1))
        gte_m = re.search(r"(\d+(?:\.\d+)?)\s*\*\s*gte\(on\s*,\s*(\d+)\)", z_expr)
        if gte_m:
            zones.append((float(gte_m.group(1)), int(gte_m.group(2)), int(gte_m.group(2)) + 9999))
        # Sort by start frame just in case the expression isn't ordered.
        zones.sort(key=lambda z: z[1])
        if len(zones) < 2:
            return []

        cues: list[tuple[float, str]] = []
        fps = max(1, int(fps))
        prev_zoom = zones[0][0]
        for zoom, f0, _f1 in zones[1:]:
            delta = zoom - prev_zoom
            t_s = f0 / fps
            if abs(delta) < 0.001:
                prev_zoom = zoom
                continue
            if delta > 0.10:
                cues.append((t_s, "impact"))
            elif delta > 0:
                cues.append((t_s, "pop"))
            elif delta < -0.10:
                cues.append((t_s, "whoosh"))
            else:  # gentle decrease
                cues.append((t_s, "reverse_whoosh"))
            prev_zoom = zoom
        return cues[:max_cues]

    @classmethod
    def _build_sfx_source(cls, cue_type: str, label: str, master_gain: float = 1.0) -> tuple[str, float]:
        """Return a filter_complex chunk that materialises one SFX as the
        named output `[label]`. Returns (chunk, effective_duration).
        Unknown cue_type defaults to 'pop'.
        """
        spec = cls.SFX_LIBRARY.get(cue_type) or cls.SFX_LIBRARY["pop"]
        dur = float(spec["duration_s"])
        expr = spec["source_expr"].format(dur=dur)
        gain = max(0.0, min(2.0, float(spec["default_gain"]) * float(master_gain)))
        # `volume=` lets us apply the master-gain scaling per-cue.
        return f"{expr},volume={gain:.3f}[{label}]", dur

    @classmethod
    def _strip_aspect_changing_filters(cls, filter_string: str) -> str:
        """Drop any `crop=`, `scale=`, or `pad=` segments from the chain.

        Why this exists: the prompt to Gemini explicitly says NOT to
        emit crop/scale/pad — they change the output aspect, and on
        top of that crop expressions like
            ih/(1+0.25*sin(PI*t/2)*sin(PI*t/2)*between(t,0,2))
        are evaluated by FFmpeg at filter-init time (eval=init by
        default) which doesn't support all the runtime functions, so
        the whole render fails with "Failed to configure input pad on
        Parsed_crop_0".

        The AI sometimes ignores the rule. Rather than dead-end the
        user's preview, strip the offending segments and let the rest
        of the filter chain (zoompan + eq + unsharp) run.
        """
        if not filter_string:
            return filter_string
        parts = cls._split_filter_chain(filter_string)
        kept: list[str] = []
        dropped: list[str] = []
        for part in parts:
            stripped = part.strip()
            # Match the FILTER NAME prefix only — don't false-positive
            # on substring matches inside expressions ('between',
            # 'scale_factor', etc.).
            if (stripped.startswith("crop=")
                or stripped.startswith("scale=")
                or stripped.startswith("pad=")):
                dropped.append(stripped[:80])
                continue
            kept.append(part)
        if dropped:
            print(
                f"🧹 Stripped {len(dropped)} aspect-changing filter(s) "
                f"the AI generated against instructions: {dropped}"
            )
        return ",".join(kept)

    @staticmethod
    def _sanitize_filter_string(filter_string: str) -> str:
        """
        Best-effort sanitizer for Gemini-generated FFmpeg expressions.
        Converts comparison operators (t<3, on>=75, etc.) into FFmpeg expr functions (lt(), gte(), ...),
        which are far more reliably parsed across FFmpeg builds.
        """
        s = filter_string

        # Order matters: handle >= / <= before > / <
        patterns: list[tuple[re.Pattern[str], str]] = [
            (re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*>=\s*(-?\d+(?:\.\d+)?)"), r"gte(\1,\2)"),
            (re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*<=\s*(-?\d+(?:\.\d+)?)"), r"lte(\1,\2)"),
            (re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*>\s*(-?\d+(?:\.\d+)?)"), r"gt(\1,\2)"),
            (re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*<\s*(-?\d+(?:\.\d+)?)"), r"lt(\1,\2)"),
        ]
        for pat, repl in patterns:
            s = pat.sub(repl, s)

        return s

    def apply_edits(self, input_path, output_path, filter_data, *,
                    enable_sfx: bool = False, sfx_volume: float = 0.6):
        """Executes FFmpeg with the generated filter.

        When `enable_sfx` is True, also auto-detects zoom transitions in
        the filter string and mixes synthetic sound effects (whoosh /
        impact / pop / etc.) into the audio at those moments. The
        `sfx_volume` (0.0-1.0) is a master gain applied to all cues.
        """
        
        # Probe dimensions early so the fallback can use them.
        try:
            probe_cmd = ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                         '-show_entries', 'stream=width,height,r_frame_rate,duration',
                         '-of', 'csv=p=0', input_path]
            probe_out = subprocess.check_output(
                probe_cmd, env={**os.environ, "LANG": "C.UTF-8"}
            ).decode().strip().split(',')
            probe_w, probe_h = int(probe_out[0]), int(probe_out[1])
            probe_fps_str = probe_out[2] if len(probe_out) > 2 else "30/1"
            num, den = probe_fps_str.split('/')
            probe_fps = max(1, int(round(int(num) / max(1, int(den)))))
            probe_dur = float(probe_out[3]) if len(probe_out) > 3 and probe_out[3] else 30.0
        except Exception as e:
            print(f"⚠️ Could not probe input: {e}")
            probe_w, probe_h, probe_fps, probe_dur = 1080, 1920, 30, 30.0

        def _baseline_filter(w, h, fps, dur):
            """Hand-rolled fallback filter — GUARANTEED visible zoom +
            color grade + sharpen across the clip's full duration. Bigger
            zoom range than before (1.0 → 1.30) so the change is
            obviously visible, not subtle.
            """
            tf = max(1, int(round(dur * fps)))
            # 5 zoom zones with distinct, deliberately punchy levels.
            z1 = int(tf * 0.20); z2 = int(tf * 0.40)
            z3 = int(tf * 0.60); z4 = int(tf * 0.80)
            zoom_expr = (
                f"1.00*between(on,0,{z1})+"
                f"1.25*between(on,{z1+1},{z2})+"
                f"1.10*between(on,{z2+1},{z3})+"
                f"1.30*between(on,{z3+1},{z4})+"
                f"1.15*gte(on,{z4+1})"
            )
            # Two pop-color bands so SOMETHING obvious happens twice.
            pop1_s, pop1_e = max(0.3, dur * 0.20), max(0.8, dur * 0.30)
            pop2_s, pop2_e = max(0.5, dur * 0.65), max(1.0, dur * 0.78)
            return (
                f"zoompan=z='{zoom_expr}':d=1:s={w}x{h}:fps={fps},"
                # Strong base color grade — saturation +25%, contrast +15%.
                f"eq=contrast=1.15:saturation=1.25:gamma=0.95,"
                # Two punchy pop bands.
                f"eq=contrast=1.30:saturation=1.45:enable='between(t,{pop1_s:.2f},{pop1_e:.2f})',"
                f"eq=contrast=1.30:saturation=1.45:enable='between(t,{pop2_s:.2f},{pop2_e:.2f})',"
                f"unsharp=lx=5:ly=5:la=0.8:cx=5:cy=5:ca=0.0,"
                f"setsar=1"
            )

        # Decide what filter to apply. STRICT no-op detection — every
        # path that doesn't have BOTH zoom motion AND a color grade
        # falls back to the guaranteed baseline. That's how we make
        # sure Auto Edit always produces visible change.
        filter_string = (filter_data or {}).get("filter_string", "").strip() if filter_data else ""

        def _filter_is_substantive(s):
            """Return True if the LLM filter genuinely contains effects
            that will be visible on screen. Catches more no-op patterns
            than the previous heuristic — empty, too-short, missing
            zoompan or missing eq, all-1.0 zoom values, identity eq."""
            import re as _re
            if not s or len(s) < 60:
                return False
            if "zoompan" not in s:
                return False
            if "eq=" not in s and "hue=" not in s and "curves" not in s:
                return False
            # All-1.0 zoom (e.g. z='1.0' or z='1*…') — produces no motion.
            zooms = _re.findall(r"z\s*=\s*'([^']+)'", s)
            for zexpr in zooms:
                # Extract numeric multipliers — anything other than 1.0 means real motion.
                multipliers = _re.findall(r"(\d+\.?\d*)\s*\*\s*(?:between|gte|lte|lt|gt|if)", zexpr)
                non_unity = [m for m in multipliers if abs(float(m) - 1.0) > 0.01]
                if not non_unity:
                    return False
            # Identity eq (contrast=1, saturation=1, gamma=1) is a no-op.
            eq_blocks = _re.findall(r"eq=([^,]+)", s)
            saw_real_eq = False
            for eq in eq_blocks:
                if any(_re.search(rf"{k}\s*=\s*([0-9.]+)", eq) and
                       abs(float(_re.search(rf"{k}\s*=\s*([0-9.]+)", eq).group(1)) - 1.0) > 0.01
                       for k in ("contrast", "saturation", "gamma", "brightness")):
                    saw_real_eq = True
                    break
            if not saw_real_eq:
                return False
            return True

        if not _filter_is_substantive(filter_string):
            old_len = len(filter_string)
            filter_string = _baseline_filter(probe_w, probe_h, probe_fps, probe_dur)
            print(
                f"🛟 LLM filter was a no-op (len={old_len}) — using guaranteed baseline edits.\n"
                f"   Baseline filter: {filter_string[:200]}…"
            )

        # Reuse probed dimensions for downstream geometry enforcement.
        w, h = probe_w, probe_h

        # Strip crop / scale / pad — the AI sometimes adds them despite
        # the prompt's "DO NOT use crop/scale/pad" rule, and crop's
        # eval=init doesn't handle the time-dependent expressions the
        # AI tends to put in them, so the whole render dies with
        # "Error when evaluating the expression". Drop those filters
        # and keep the rest of the chain (zoompan + eq + unsharp etc.).
        no_aspect = self._strip_aspect_changing_filters(filter_string)
        if no_aspect != filter_string:
            filter_string = no_aspect

        # Sanitize common expression pitfalls (e.g., t<3 / on>=75) before executing FFmpeg.
        sanitized = self._sanitize_filter_string(filter_string)
        if sanitized != filter_string:
            print("🧼 Sanitized AI Filter (converted comparisons to lt/lte/gt/gte functions)")
            print(f"🧼 Before: {filter_string}")
            print(f"🧼 After:  {sanitized}")
            filter_string = sanitized

        # Enforce zoompan output size to preserve aspect ratio / resolution.
        if w and h:
            enforced = self._enforce_zoompan_output_size(filter_string, w, h)
            if enforced != filter_string:
                print(f"📐 Enforced zoompan output size to {w}x{h}")
                filter_string = enforced

            # Ensure square pixels (avoid weird display stretching in some players).
            if "setsar=" not in filter_string:
                filter_string = f"{filter_string},setsar=1"

        print(f"🎬 Executing AI Filter: {filter_string}")

        # SFX MIX PATH — when enabled and the filter has detectable
        # zoom transitions, switch from -vf + audio-copy to
        # -filter_complex with the SFX mixed in. Falls back to the
        # plain video filter when nothing's to add.
        sfx_cues: list[tuple[float, str]] = []
        if enable_sfx:
            try:
                sfx_cues = self._detect_sfx_cues_from_filter(
                    filter_string, fps=probe_fps,
                )
                print(f"🔊 SFX cues detected: {len(sfx_cues)} -> {sfx_cues}")
            except Exception as _sfx_err:
                print(f"⚠️ SFX cue detection failed: {_sfx_err}")
                sfx_cues = []

        if sfx_cues:
            # Build a filter_complex with [0:v] -> our video chain and
            # [0:a] mixed with N delayed SFX sources.
            video_chain = f"[0:v]{filter_string}[v]"
            sfx_chunks: list[str] = []
            sfx_inputs: list[str] = []
            master_gain = max(0.0, min(1.5, float(sfx_volume or 0.6)))
            for i, (t_s, cue_type) in enumerate(sfx_cues):
                src_label = f"sfxsrc{i}"
                src_chunk, _dur = self._build_sfx_source(
                    cue_type, src_label, master_gain=master_gain,
                )
                # adelay wants milliseconds; :all=1 routes the same
                # delay to all channels of the stereo source we'll mix
                # into. We promote mono -> stereo via aformat first so
                # the amix output is consistent with the original
                # audio's channel count.
                delay_ms = max(0, int(round(t_s * 1000)))
                delayed_label = f"sfx{i}d"
                sfx_chunks.append(src_chunk)
                sfx_chunks.append(
                    f"[{src_label}]aformat=channel_layouts=stereo,"
                    f"adelay={delay_ms}|{delay_ms}[{delayed_label}]"
                )
                sfx_inputs.append(f"[{delayed_label}]")
            mix_inputs = "[0:a]" + "".join(sfx_inputs)
            mix_chunk = (
                f"{mix_inputs}amix=inputs={1 + len(sfx_inputs)}:"
                f"duration=first:dropout_transition=0:normalize=0[a]"
            )
            filter_complex = ";".join([video_chain, *sfx_chunks, mix_chunk])
            print(f"🔊 SFX filter_complex ({len(sfx_cues)} cues, gain={master_gain:.2f}):")
            print(f"   {filter_complex[:300]}{'…' if len(filter_complex) > 300 else ''}")
            cmd = [
                'ffmpeg', '-y',
                '-i', input_path,
                '-filter_complex', filter_complex,
                '-map', '[v]', '-map', '[a]',
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
                '-c:a', 'aac', '-b:a', '192k',
                output_path
            ]
        else:
            cmd = [
                'ffmpeg', '-y',
                '-i', input_path,
                '-vf', filter_string,
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
                '-c:a', 'copy',
                output_path
            ]
        
        # Use explicit environment with UTF-8 to avoid ascii errors in subprocess
        env = os.environ.copy()
        # On some minimal docker images, we need to ensure we use a UTF-8 locale
        # Try C.UTF-8 first, fallback to en_US.UTF-8 if available, but C.UTF-8 is usually safer for minimal
        env["LANG"] = "C.UTF-8"
        env["LC_ALL"] = "C.UTF-8"
        
        try:
            # We must encode arguments if filesystem is ascii but we have unicode chars
            # But subprocess in Python 3 handles unicode args by encoding them with os.fsencode().
            # If sys.getfilesystemencoding() is ascii, this fails.
            # We can't change fs encoding at runtime easily.
            # Workaround: pass bytes directly? subprocess allows bytes in args.
            
            # Convert command elements to bytes assuming utf-8 if they are strings
            cmd_bytes = []
            for arg in cmd:
                if isinstance(arg, str):
                    cmd_bytes.append(arg.encode('utf-8'))
                else:
                    cmd_bytes.append(arg)
            
            subprocess.run(cmd_bytes, check=True, env=env)
        except subprocess.CalledProcessError as e:
            print(f"❌ FFmpeg failed: {e}")
            raise e

if __name__ == "__main__":
    pass