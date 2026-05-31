import time
import cv2
import scenedetect
import subprocess
import argparse
import re
import sys
from scenedetect import SceneManager
from scenedetect.detectors import ContentDetector
# PySceneDetect API moved between major versions:
#   • 0.5.x: VideoManager + SceneManager.detect_scenes(frame_source=vm)
#   • 0.6.x: open_video() + SceneManager.detect_scenes(video=vs)
# We import both symbols defensively and pick the right path at call
# time. Without this guard the whole transcription pipeline 500s on
# any host that has 0.6+ installed (Linux containers, fresh installs).
try:
    from scenedetect import open_video as _scenedetect_open_video  # 0.6+
    _SCENEDETECT_VARIANT = "v06"
except ImportError:
    _scenedetect_open_video = None
    try:
        from scenedetect import VideoManager as _LegacyVideoManager  # 0.5.x
        _SCENEDETECT_VARIANT = "v05"
    except ImportError:
        _LegacyVideoManager = None
        _SCENEDETECT_VARIANT = "missing"
from ultralytics import YOLO
import torch
import os
import numpy as np
from tqdm import tqdm
import yt_dlp
import mediapipe as mp
# import whisper (replaced by faster_whisper inside function)
from google import genai
from dotenv import load_dotenv
import json

import warnings
warnings.filterwarnings("ignore", category=UserWarning, module='google.protobuf')

# Load environment variables
load_dotenv()

# --- Constants ---
ASPECT_RATIO = 9 / 16

try:
    from prompt_rules import USER_TEXT_RULES
except ImportError:
    USER_TEXT_RULES = ""  # graceful fallback if module is missing

GEMINI_PROMPT_TEMPLATE = """
You are a senior short-form video editor. Read the ENTIRE transcript and word-level timestamps to choose AT LEAST {min_clips} and AT MOST {max_clips} of the MOST VIRAL moments for TikTok/IG Reels/YouTube Shorts. Each clip must be between {min_duration} and {max_duration} seconds long. Hitting the {min_clips}-clip floor is REQUIRED — return your best picks even if some score modestly.

⚠️ FFMPEG TIME CONTRACT — STRICT REQUIREMENTS:
- Return timestamps in ABSOLUTE SECONDS from the start of the video (usable in: ffmpeg -ss <start> -to <end> -i <input> ...).
- Only NUMBERS with decimal point, up to 3 decimals (examples: 0, 1.250, 17.350).
- Ensure 0 ≤ start < end ≤ VIDEO_DURATION_SECONDS.
- 🔒 DURATION IS A HARD CONSTRAINT: every clip MUST be between {min_duration} and {max_duration} seconds long. Clips outside this range will be REJECTED by the post-processor.
  - If a great hook is only ~10 s but min is {min_duration} s → expand it: include enough setup BEFORE the hook and payoff/elaboration AFTER to fill the time.
  - Never return a clip shorter than {min_duration} seconds even if you think the punchline is shorter.
- 🎯 USE THE FULL DURATION RANGE — do NOT pick the same length for every clip. The range is {min_duration}–{max_duration} s wide for a reason. Vary clip lengths according to how much context each moment genuinely needs:
  - Short, punchy one-liner moment → near {min_duration} s.
  - Story or argument with setup + payoff → mid-range (e.g. {min_duration} + 30 s).
  - Long-form explanation, demo, or list → toward {max_duration} s.
  Returning 5 clips at the same length is a sign you're anchoring to the floor — DON'T.
- Prefer starting 0.2–0.4 s BEFORE the hook and ending 0.2–0.4 s AFTER the payoff.
- Use silence moments for natural cuts; never cut in the middle of a word or phrase.
- STRICTLY FORBIDDEN to use time formats other than absolute seconds.

VIDEO_DURATION_SECONDS: {video_duration}

TRANSCRIPT_TEXT (raw):
{transcript_text}

WORDS_JSON (array of {{w, s, e}} where s/e are seconds):
{words_json}

STRICT EXCLUSIONS:
- No generic intros/outros or purely sponsorship segments unless they contain the hook.
- No clips < {min_duration} s or > {max_duration} s.

OUTPUT — RETURN ONLY VALID JSON (no markdown, no comments). Order clips by predicted performance (best to worst). In the descriptions, ALWAYS include a CTA like "Follow me and comment X and I'll send you the workflow" (especially if discussing an n8n workflow):
{{
  "shorts": [
    {{
      "start": <number in seconds, e.g., 12.340>,
      "end": <number in seconds, e.g., 37.900>,
      "video_description_for_tiktok": "<description for TikTok oriented to get views>",
      "video_description_for_instagram": "<description for Instagram oriented to get views>",
      "video_title_for_youtube_short": "<title for YouTube Short oriented to get views 100 chars max>",
      "viral_hook_text": "<SHORT punchy text overlay (max 10 words). MUST BE IN THE SAME LANGUAGE AS THE VIDEO TRANSCRIPT. Examples: 'POV: You realized...', 'Did you know?', '$15 + $100 FREE!'>"
    }}
  ]
}}

""" + USER_TEXT_RULES + """
"""

# Load the YOLO model once (Keep for backup or scene analysis if needed)
model = YOLO('yolov8n.pt')

# --- MediaPipe Setup ---
# Use standard Face Detection (BlazeFace) for speed
mp_face_detection = mp.solutions.face_detection
face_detection = mp_face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5)

class SmoothedCameraman:
    """
    Handles smooth camera movement.
    Simplified Logic: "Heavy Tripod"
    Only moves if the subject leaves the center safe zone.
    Moves slowly and linearly.
    """
    def __init__(self, output_width, output_height, video_width, video_height):
        self.output_width = output_width
        self.output_height = output_height
        self.video_width = video_width
        self.video_height = video_height
        
        # Initial State
        self.current_center_x = video_width / 2
        self.target_center_x = video_width / 2
        
        # Calculate crop dimensions once
        self.crop_height = video_height
        self.crop_width = int(self.crop_height * ASPECT_RATIO)
        if self.crop_width > video_width:
             self.crop_width = video_width
             self.crop_height = int(self.crop_width / ASPECT_RATIO)
             
        # Safe Zone: 20% of the video width
        # As long as the target is within this zone relative to current center, DO NOT MOVE.
        self.safe_zone_radius = self.crop_width * 0.25

    def update_target(self, face_box):
        """
        Updates the target center based on detected face/person.
        """
        if face_box:
            x, y, w, h = face_box
            self.target_center_x = x + w / 2
    
    def get_crop_box(self, force_snap=False):
        """
        Returns the (x1, y1, x2, y2) for the current frame.
        """
        if force_snap:
            self.current_center_x = self.target_center_x
        else:
            diff = self.target_center_x - self.current_center_x
            
            # SIMPLIFIED LOGIC:
            # 1. Is the target outside the safe zone?
            if abs(diff) > self.safe_zone_radius:
                # 2. If yes, move towards it slowly (Linear Speed)
                # Determine direction
                direction = 1 if diff > 0 else -1
                
                # Speed: 2 pixels per frame (Slow pan)
                # If the distance is HUGE (scene change or fast movement), speed up slightly
                if abs(diff) > self.crop_width * 0.5:
                    speed = 15.0 # Fast re-frame
                else:
                    speed = 3.0  # Slow, steady pan
                
                self.current_center_x += direction * speed
                
                # Check if we overshot (prevent oscillation)
                new_diff = self.target_center_x - self.current_center_x
                if (direction == 1 and new_diff < 0) or (direction == -1 and new_diff > 0):
                    self.current_center_x = self.target_center_x
            
            # If inside safe zone, DO NOTHING (Stationary Camera)
                
        # Clamp center
        half_crop = self.crop_width / 2
        
        if self.current_center_x - half_crop < 0:
            self.current_center_x = half_crop
        if self.current_center_x + half_crop > self.video_width:
            self.current_center_x = self.video_width - half_crop
            
        x1 = int(self.current_center_x - half_crop)
        x2 = int(self.current_center_x + half_crop)
        
        x1 = max(0, x1)
        x2 = min(self.video_width, x2)
        
        y1 = 0
        y2 = self.video_height
        
        return x1, y1, x2, y2

class SpeakerTracker:
    """
    Tracks speakers over time to prevent rapid switching and handle temporary obstructions.
    """
    def __init__(self, stabilization_frames=15, cooldown_frames=30):
        self.active_speaker_id = None
        self.speaker_scores = {}  # {id: score}
        self.last_seen = {}       # {id: frame_number}
        self.locked_counter = 0   # How long we've been locked on current speaker
        
        # Hyperparameters
        self.stabilization_threshold = stabilization_frames # Frames needed to confirm a new speaker
        self.switch_cooldown = cooldown_frames              # Minimum frames before switching again
        self.last_switch_frame = -1000
        
        # ID tracking
        self.next_id = 0
        self.known_faces = [] # [{'id': 0, 'center': x, 'last_frame': 123}]

    def get_target(self, face_candidates, frame_number, width):
        """
        Decides which face to focus on.
        face_candidates: list of {'box': [x,y,w,h], 'score': float}
        """
        current_candidates = []
        
        # 1. Match faces to known IDs (simple distance tracking)
        for face in face_candidates:
            x, y, w, h = face['box']
            center_x = x + w / 2
            
            best_match_id = -1
            min_dist = width * 0.15 # Reduced matching radius to avoid jumping in groups
            
            # Try to match with known faces seen recently
            for kf in self.known_faces:
                if frame_number - kf['last_frame'] > 30: # Forgot faces older than 1s (was 2s)
                    continue
                    
                dist = abs(center_x - kf['center'])
                if dist < min_dist:
                    min_dist = dist
                    best_match_id = kf['id']
            
            # If no match, assign new ID
            if best_match_id == -1:
                best_match_id = self.next_id
                self.next_id += 1
            
            # Update known face
            self.known_faces = [kf for kf in self.known_faces if kf['id'] != best_match_id]
            self.known_faces.append({'id': best_match_id, 'center': center_x, 'last_frame': frame_number})
            
            current_candidates.append({
                'id': best_match_id,
                'box': face['box'],
                'score': face['score']
            })

        # 2. Update Scores with decay
        for pid in list(self.speaker_scores.keys()):
             self.speaker_scores[pid] *= 0.85 # Faster decay (was 0.9)
             if self.speaker_scores[pid] < 0.1:
                 del self.speaker_scores[pid]

        # Add new scores
        for cand in current_candidates:
            pid = cand['id']
            # Score is purely based on size (proximity) now that we don't have mouth
            raw_score = cand['score'] / (width * width * 0.05)
            self.speaker_scores[pid] = self.speaker_scores.get(pid, 0) + raw_score

        # 3. Determine Best Speaker
        if not current_candidates:
            # If no one found, maintain last active speaker if cooldown allows
            # to avoid black screen or jump to 0,0
            return None 
            
        best_candidate = None
        max_score = -1
        
        for cand in current_candidates:
            pid = cand['id']
            total_score = self.speaker_scores.get(pid, 0)
            
            # Hysteresis: HUGE Bonus for current active speaker
            if pid == self.active_speaker_id:
                total_score *= 3.0 # Sticky factor
                
            if total_score > max_score:
                max_score = total_score
                best_candidate = cand

        # 4. Decide Switch
        if best_candidate:
            target_id = best_candidate['id']
            
            if target_id == self.active_speaker_id:
                self.locked_counter += 1
                return best_candidate['box']
            
            # New person
            if frame_number - self.last_switch_frame < self.switch_cooldown:
                old_cand = next((c for c in current_candidates if c['id'] == self.active_speaker_id), None)
                if old_cand:
                    return old_cand['box']
            
            self.active_speaker_id = target_id
            self.last_switch_frame = frame_number
            self.locked_counter = 0
            return best_candidate['box']
            
        return None

def detect_face_candidates(frame):
    """
    Returns list of all detected faces using lightweight FaceDetection.
    """
    height, width, _ = frame.shape
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = face_detection.process(rgb_frame)
    
    candidates = []
    
    if not results.detections:
        return []
        
    for detection in results.detections:
        bboxC = detection.location_data.relative_bounding_box
        x = int(bboxC.xmin * width)
        y = int(bboxC.ymin * height)
        w = int(bboxC.width * width)
        h = int(bboxC.height * height)
        
        candidates.append({
            'box': [x, y, w, h],
            'score': w * h # Area as score
        })
            
    return candidates

def detect_person_yolo(frame):
    """
    Fallback: Detect largest person using YOLO when face detection fails.
    Returns [x, y, w, h] of the person's 'upper body' approximation.
    """
    # Use the globally loaded model
    results = model(frame, verbose=False, classes=[0]) # class 0 is person
    
    if not results:
        return None
        
    best_box = None
    max_area = 0
    
    for result in results:
        boxes = result.boxes
        for box in boxes:
            x1, y1, x2, y2 = [int(i) for i in box.xyxy[0]]
            w = x2 - x1
            h = y2 - y1
            area = w * h
            
            if area > max_area:
                max_area = area
                # Focus on the top 40% of the person (head/chest) for framing
                # This approximates where the face is if we can't detect it directly
                face_h = int(h * 0.4)
                best_box = [x1, y1, w, face_h]
                
    return best_box

def create_general_frame(frame, output_width, output_height):
    """
    Creates a 'General Shot' frame: 
    - Background: Blurred zoom of original
    - Foreground: Original video scaled to fit width, centered vertically.
    """
    orig_h, orig_w = frame.shape[:2]
    
    # 1. Background (Fill Height)
    # Crop center to aspect ratio
    bg_scale = output_height / orig_h
    bg_w = int(orig_w * bg_scale)
    bg_resized = cv2.resize(frame, (bg_w, output_height))
    
    # Crop center of background
    start_x = (bg_w - output_width) // 2
    if start_x < 0: start_x = 0
    background = bg_resized[:, start_x:start_x+output_width]
    if background.shape[1] != output_width:
        background = cv2.resize(background, (output_width, output_height))
        
    # Blur background
    background = cv2.GaussianBlur(background, (51, 51), 0)
    
    # 2. Foreground (Fit Width)
    scale = output_width / orig_w
    fg_h = int(orig_h * scale)
    foreground = cv2.resize(frame, (output_width, fg_h))
    
    # 3. Overlay
    y_offset = (output_height - fg_h) // 2
    
    # Clone background to avoid modifying it
    final_frame = background.copy()
    final_frame[y_offset:y_offset+fg_h, :] = foreground
    
    return final_frame

def analyze_scenes_strategy(video_path, scenes):
    """
    Analyzes each scene to determine if it should be TRACK (Single person) or GENERAL (Group/Wide).
    Returns list of strategies corresponding to scenes.

    GENERAL is a fallback that letterboxes the horizontal frame inside a
    9:16 canvas with a blurred background — it's correct for genuine
    landscape B-roll or wide group shots, but WRONG for single-speaker
    content where the speaker just briefly looked away from camera.

    Bug we're fixing: the old thresholds (avg_faces < 0.5 OR > 1.2 on a
    3-frame sample) flipped many single-speaker scenes into GENERAL
    because:
      • A single missed face on 1 of 3 frames dropped avg to 0.67, which
        was fine — but 2 missed = 0.33 < 0.5 = GENERAL even though the
        speaker was clearly there for 1/3 of frames.
      • Background photos, mirrors, posters, or a briefly-visible second
        person pushed avg > 1.2 = GENERAL even when the foreground
        speaker was the obvious focus.

    Fixes:
      1. Sample 5 frames instead of 3 — averaging across more samples
         is dramatically more stable.
      2. Lower the no-face threshold from 0.5 to 0.2 — only flip to
         GENERAL when essentially no frames showed a face (B-roll).
      3. Raise the multi-face threshold from 1.2 to 2.0 — only flip to
         GENERAL when at least 2 people were CONSISTENTLY visible.
      4. Honour `OPENSHORTS_FORCE_TRACK=1` — environment override that
         skips GENERAL entirely and forces face-tracking on every clip.
         Recommended for podcast / talking-head / rap content where the
         only acceptable output is a face-centered vertical crop.
    """
    cap = cv2.VideoCapture(video_path)
    strategies = []

    # Env-driven hard override. Useful for users who never want the
    # letterboxed-blur-bg fallback (single-speaker content always).
    force_track = (os.getenv("OPENSHORTS_FORCE_TRACK", "").strip().lower()
                   in ("1", "true", "yes", "on"))
    if force_track:
        print(f"   OPENSHORTS_FORCE_TRACK=on → all {len(scenes)} scenes will use TRACK strategy.")
        cap.release()
        return ['TRACK'] * len(scenes)

    if not cap.isOpened():
        return ['TRACK'] * len(scenes)

    # Stats so the user can see (in the worker log) why a given scene
    # went GENERAL — makes it easy to tune or report bugs.
    general_count = 0

    for scene_idx, (start, end) in enumerate(tqdm(scenes, desc="   Analyzing Scenes")):
        start_f = start.get_frames()
        end_f = end.get_frames()
        # Sample 5 frames evenly across the scene — more samples
        # smooth out detector flicker (motion blur, head turns, etc.).
        if end_f - start_f < 10:
            # Very short scene — sample just the middle frame.
            frames_to_check = [int((start_f + end_f) / 2)]
        else:
            frames_to_check = [
                start_f + max(5, (end_f - start_f) // 10),
                start_f + (end_f - start_f) // 4,
                int((start_f + end_f) / 2),
                start_f + 3 * (end_f - start_f) // 4,
                end_f - max(5, (end_f - start_f) // 10),
            ]

        face_counts = []
        for f_idx in frames_to_check:
            cap.set(cv2.CAP_PROP_POS_FRAMES, f_idx)
            ret, frame = cap.read()
            if not ret:
                continue
            candidates = detect_face_candidates(frame)
            face_counts.append(len(candidates))

        if not face_counts:
            avg_faces = 0
            max_faces = 0
        else:
            avg_faces = sum(face_counts) / len(face_counts)
            max_faces = max(face_counts)

        # Strategy (NEW thresholds):
        #   • avg < 0.2  → GENERAL (essentially never saw a face — B-roll)
        #   • avg >= 2.0 AND max >= 2 → GENERAL (group consistently 2+ ppl)
        #   • otherwise  → TRACK
        if avg_faces < 0.2:
            strategy = 'GENERAL'
            reason = f"avg_faces={avg_faces:.2f} (no face detected)"
        elif avg_faces >= 2.0 and max_faces >= 2:
            strategy = 'GENERAL'
            reason = f"avg_faces={avg_faces:.2f}, max={max_faces} (group)"
        else:
            strategy = 'TRACK'
            reason = f"avg_faces={avg_faces:.2f}"

        if strategy == 'GENERAL':
            general_count += 1
            print(f"   Scene {scene_idx + 1}/{len(scenes)} → GENERAL "
                  f"({reason}) — will be letterboxed with blurred background.")

        strategies.append(strategy)

    cap.release()
    if general_count > 0:
        print(f"   Strategy summary: {len(scenes) - general_count} TRACK, "
              f"{general_count} GENERAL. Set OPENSHORTS_FORCE_TRACK=1 to "
              f"force face-tracking on every scene.")
    return strategies

def detect_scenes(video_path):
    """Run PySceneDetect against `video_path`. Works with both
    pre-0.6 (VideoManager) and 0.6+ (open_video) APIs — the 0.6 release
    removed VideoManager and broke every codebase that imported it.
    Returns (scene_list, fps) on either path."""
    scene_manager = SceneManager()
    scene_manager.add_detector(ContentDetector())
    if _SCENEDETECT_VARIANT == "v06" and _scenedetect_open_video is not None:
        # New API. open_video returns a VideoStream-like object whose
        # .frame_rate gives fps; SceneManager.detect_scenes takes the
        # stream directly via the `video` kwarg.
        video = _scenedetect_open_video(video_path)
        scene_manager.detect_scenes(video=video)
        scene_list = scene_manager.get_scene_list()
        fps = float(getattr(video, "frame_rate", 0)) or 30.0
        return scene_list, fps
    if _SCENEDETECT_VARIANT == "v05" and _LegacyVideoManager is not None:
        # Legacy API.
        video_manager = _LegacyVideoManager([video_path])
        video_manager.set_downscale_factor()
        video_manager.start()
        scene_manager.detect_scenes(frame_source=video_manager)
        scene_list = scene_manager.get_scene_list()
        fps = video_manager.get_framerate()
        video_manager.release()
        return scene_list, fps
    raise RuntimeError(
        "PySceneDetect is missing or its API is unrecognised. "
        f"variant={_SCENEDETECT_VARIANT}. Install scenedetect>=0.6."
    )

def get_video_resolution(video_path):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise IOError(f"Could not open video file {video_path}")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    return width, height


def sanitize_filename(filename):
    """Remove invalid characters from filename."""
    filename = re.sub(r'[<>:"/\\|?*]', '', filename)
    filename = filename.replace(' ', '_')
    return filename[:100]


def download_youtube_video(url, output_dir="."):
    """
    Downloads a YouTube video using yt-dlp.
    Returns the path to the downloaded video and the video title.
    """
    print(f"🔍 Debug: yt-dlp version: {yt_dlp.version.__version__}")
    print("📥 Downloading video from YouTube...")
    step_start_time = time.time()

    cookies_path = '/app/cookies.txt'
    cookies_env = os.environ.get("YOUTUBE_COOKIES")
    if cookies_env:
        print("🍪 Found YOUTUBE_COOKIES env var, creating cookies file inside container...")
        try:
            with open(cookies_path, 'w') as f:
                f.write(cookies_env)
            if os.path.exists(cookies_path):
                 print(f"   Debug: Cookies file created. Size: {os.path.getsize(cookies_path)} bytes")
                 with open(cookies_path, 'r') as f:
                     content = f.read(100)
                     print(f"   Debug: First 100 chars of cookie file: {content}")
        except Exception as e:
            print(f"⚠️ Failed to write cookies file: {e}")
            cookies_path = None
    else:
        cookies_path = None
        print("⚠️ YOUTUBE_COOKIES env var not found.")
    
    # Common yt-dlp options to work around YouTube bot detection.
    # extractor_args tries multiple player clients in order; tv_embed / android
    # avoid the OAuth/PO-token checks that block server IPs.
    _COMMON_YDL_OPTS = {
        'quiet': False,
        'verbose': True,
        'no_warnings': False,
        'cookiefile': cookies_path if cookies_path else None,
        'socket_timeout': 30,
        'retries': 10,
        'fragment_retries': 10,
        'nocheckcertificate': True,
        'cachedir': False,
        'extractor_args': {
            'youtube': {
                'player_client': ['tv_embed', 'android', 'mweb', 'web'],
                'player_skip': ['webpage', 'configs'],
            }
        },
        'http_headers': {
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/120.0.0.0 Safari/537.36'
            ),
        },
    }

    with yt_dlp.YoutubeDL(_COMMON_YDL_OPTS) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
            video_title = info.get('title', 'youtube_video')
            sanitized_title = sanitize_filename(video_title)
        except Exception as e:
            # Force print to stderr/stdout immediately so it's captured before crash
            import sys
            import traceback
            
            # Print minimal error first to ensure something gets out
            print("🚨 YOUTUBE DOWNLOAD ERROR 🚨", file=sys.stderr)
            
            error_msg = f"""
            
❌ ================================================================= ❌
❌ FATAL ERROR: YOUTUBE DOWNLOAD FAILED
❌ ================================================================= ❌
            
REASON: YouTube has blocked the download request (Error 429/Unavailable).
        This is likely a temporary IP ban on this server.

👇 SOLUTION FOR USER 👇
---------------------------------------------------------------------
1. Download the video manually to your computer.
2. Use the 'Upload Video' tab in this app to process it.
---------------------------------------------------------------------

Technical Details: {str(e)}
            """
            # Print to both streams to ensure capture
            print(error_msg, file=sys.stdout)
            print(error_msg, file=sys.stderr)
            
            # Force flush
            sys.stdout.flush()
            sys.stderr.flush()
            
            # Wait a split second to allow buffer to drain before raising
            time.sleep(0.5)
            
            raise e
    
    output_template = os.path.join(output_dir, f'{sanitized_title}.%(ext)s')
    expected_file = os.path.join(output_dir, f'{sanitized_title}.mp4')
    if os.path.exists(expected_file):
        os.remove(expected_file)
        print(f"🗑️  Removed existing file to re-download with H.264 codec")
    
    ydl_opts = {
        **_COMMON_YDL_OPTS,
        # Accept VP9 / AV1 streams (often higher quality than YouTube's
        # AVC1 at the same resolution). yt-dlp will mux to mp4 either way.
        # Cap at 1080p — 4K downloads waste time and disk for 9:16 output.
        'format': (
            'bestvideo[height<=1080][vcodec^=av01]+bestaudio[ext=m4a]/'
            'bestvideo[height<=1080][vcodec^=vp9]+bestaudio[ext=m4a]/'
            'bestvideo[height<=1080][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/'
            'bestvideo[height<=1080]+bestaudio/'
            'best[height<=1080]/'
            'best'
        ),
        'outtmpl': output_template,
        'merge_output_format': 'mp4',
        'overwrites': True,
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    
    downloaded_file = os.path.join(output_dir, f'{sanitized_title}.mp4')
    
    if not os.path.exists(downloaded_file):
        for f in os.listdir(output_dir):
            if f.startswith(sanitized_title) and f.endswith('.mp4'):
                downloaded_file = os.path.join(output_dir, f)
                break
    
    step_end_time = time.time()
    print(f"✅ Video downloaded in {step_end_time - step_start_time:.2f}s: {downloaded_file}")

    return downloaded_file, sanitized_title


def download_url_video(url: str, output_dir: str) -> tuple:
    """Generic, platform-agnostic video download using yt-dlp.

    yt-dlp natively supports YouTube, TikTok, Twitter/X, Instagram,
    Facebook, Reddit, Vimeo, Twitch, and ~1800 other sites. We just
    hand it the URL and let it auto-detect the extractor.

    Returns (downloaded_path, sanitized_title).

    Used by the standalone Subtitle and Dub features so users can
    paste a link from any social platform instead of uploading a file.
    For the clip-generation flow we still use download_youtube_video()
    because it has YouTube-specific bot-detection workarounds that
    would only get in the way for other platforms.
    """
    print(f"📥 Downloading video from URL ({url[:80]}…)")
    step_start_time = time.time()

    # Pre-extract title so we can name the output file deterministically.
    probe_opts = {
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 30,
        'retries': 3,
        'nocheckcertificate': True,
    }
    try:
        with yt_dlp.YoutubeDL(probe_opts) as ydl:
            info = ydl.extract_info(url, download=False)
        video_title = (info or {}).get('title') or 'video'
    except Exception as e:
        # Some platforms 403 on the metadata-only call but allow the
        # actual download. Fall back to a generic name in that case.
        print(f"⚠️ Could not pre-extract title ({e}); using generic name.")
        video_title = 'video'
    sanitized_title = sanitize_filename(video_title)

    output_template = os.path.join(output_dir, f'{sanitized_title}.%(ext)s')
    expected_file = os.path.join(output_dir, f'{sanitized_title}.mp4')
    if os.path.exists(expected_file):
        os.remove(expected_file)

    ydl_opts = {
        'quiet': False,
        'no_warnings': False,
        'socket_timeout': 30,
        'retries': 5,
        'fragment_retries': 5,
        'nocheckcertificate': True,
        'cachedir': False,
        # Cap at 1080p — bigger isn't needed for subtitle/dub workflows
        # and saves bandwidth + disk.
        'format': (
            'bestvideo[height<=1080]+bestaudio/'
            'best[height<=1080]/'
            'best'
        ),
        'outtmpl': output_template,
        'merge_output_format': 'mp4',
        'overwrites': True,
        'http_headers': {
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/120.0.0.0 Safari/537.36'
            ),
        },
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except Exception as e:
        # Surface the platform name in the error for clearer UX.
        host = ''
        try:
            from urllib.parse import urlparse
            host = (urlparse(url).hostname or '').replace('www.', '')
        except Exception:
            pass
        raise RuntimeError(
            f"Could not download from {host or 'this URL'}: {e}. "
            "Some platforms (Instagram private posts, region-locked "
            "content, etc.) require login cookies or a different "
            "approach. Try downloading the file manually and uploading "
            "it instead."
        ) from e

    downloaded_file = os.path.join(output_dir, f'{sanitized_title}.mp4')
    if not os.path.exists(downloaded_file):
        # yt-dlp may have remuxed under a slightly different extension.
        for f in os.listdir(output_dir):
            if f.startswith(sanitized_title) and f.endswith(('.mp4', '.mkv', '.webm', '.mov')):
                downloaded_file = os.path.join(output_dir, f)
                break
    if not os.path.exists(downloaded_file):
        raise RuntimeError(
            "Download completed but the output file is missing — yt-dlp may "
            "have failed silently."
        )

    print(f"✅ URL video downloaded in {time.time() - step_start_time:.1f}s: {downloaded_file}")
    return downloaded_file, sanitized_title


def process_video_to_vertical(input_video, final_output_video):
    """
    Core logic to convert horizontal video to vertical using scene detection and Active Speaker Tracking (MediaPipe).
    """
    script_start_time = time.time()
    
    # Define temporary file paths based on the output name
    base_name = os.path.splitext(final_output_video)[0]
    temp_video_output = f"{base_name}_temp_video.mp4"
    temp_audio_output = f"{base_name}_temp_audio.aac"
    
    # Clean up previous temp files if they exist
    if os.path.exists(temp_video_output): os.remove(temp_video_output)
    if os.path.exists(temp_audio_output): os.remove(temp_audio_output)
    if os.path.exists(final_output_video): os.remove(final_output_video)

    print(f"🎬 Processing clip: {input_video}")
    print("   Step 1: Detecting scenes...")
    scenes, fps = detect_scenes(input_video)
    
    if not scenes:
        print("   ❌ No scenes were detected. Using full video as one scene.")
        # If scene detection fails or finds nothing, treat whole video as one scene
        cap = cv2.VideoCapture(input_video)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        from scenedetect import FrameTimecode
        scenes = [(FrameTimecode(0, fps), FrameTimecode(total_frames, fps))]

    print(f"   ✅ Found {len(scenes)} scenes.")

    print("\n   🧠 Step 2: Preparing Active Tracking...")
    original_width, original_height = get_video_resolution(input_video)
    
    OUTPUT_HEIGHT = original_height
    OUTPUT_WIDTH = int(OUTPUT_HEIGHT * ASPECT_RATIO)
    if OUTPUT_WIDTH % 2 != 0:
        OUTPUT_WIDTH += 1

    # Initialize Cameraman
    cameraman = SmoothedCameraman(OUTPUT_WIDTH, OUTPUT_HEIGHT, original_width, original_height)
    
    # --- New Strategy: Per-Scene Analysis ---
    print("\n   🤖 Step 3: Analyzing Scenes for Strategy (Single vs Group)...")
    scene_strategies = analyze_scenes_strategy(input_video, scenes)
    # scene_strategies is a list of 'TRACK' or 'General' corresponding to scenes
    
    print("\n   ✂️ Step 4: Processing video frames...")
    
    command = [
        'ffmpeg', '-y', '-f', 'rawvideo', '-vcodec', 'rawvideo',
        '-s', f'{OUTPUT_WIDTH}x{OUTPUT_HEIGHT}', '-pix_fmt', 'bgr24',
        '-r', str(fps), '-i', '-', '-c:v', 'libx264',
        # Quality bump:
        #   - CRF 18 (was 23) — visually transparent vs source at this rate.
        #   - preset 'medium' (was 'fast') — 1.5x slower encode, ~10% smaller
        #     file, sharper at the same CRF.
        #   - high profile + level 4.1 — broadest playback compat at 1080p.
        #   - tune film — preserves grain/texture better than the default.
        '-preset', 'medium', '-crf', '18',
        '-profile:v', 'high', '-level', '4.1',
        '-tune', 'film',
        '-pix_fmt', 'yuv420p',
        '-an', temp_video_output
    ]

    ffmpeg_process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    cap = cv2.VideoCapture(input_video)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    frame_number = 0
    current_scene_index = 0
    
    # Pre-calculate scene boundaries
    scene_boundaries = []
    for s_start, s_end in scenes:
        scene_boundaries.append((s_start.get_frames(), s_end.get_frames()))

    # Global tracker for single-person shots
    speaker_tracker = SpeakerTracker(cooldown_frames=30)

    with tqdm(total=total_frames, desc="   Processing", file=sys.stdout) as pbar:
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            # Update Scene Index
            if current_scene_index < len(scene_boundaries):
                start_f, end_f = scene_boundaries[current_scene_index]
                if frame_number >= end_f and current_scene_index < len(scene_boundaries) - 1:
                    current_scene_index += 1
            
            # Determine Strategy for current frame based on scene
            current_strategy = scene_strategies[current_scene_index] if current_scene_index < len(scene_strategies) else 'TRACK'
            
            # Apply Strategy
            if current_strategy == 'GENERAL':
                # "Plano General" -> Blur Background + Fit Width
                output_frame = create_general_frame(frame, OUTPUT_WIDTH, OUTPUT_HEIGHT)
                
                # Reset cameraman/tracker so they don't drift while inactive
                cameraman.current_center_x = original_width / 2
                cameraman.target_center_x = original_width / 2
                
            else:
                # "Single Speaker" -> Track & Crop
                
                # Detect every 2nd frame for performance
                if frame_number % 2 == 0:
                    candidates = detect_face_candidates(frame)
                    target_box = speaker_tracker.get_target(candidates, frame_number, original_width)
                    if target_box:
                        cameraman.update_target(target_box)
                    else:
                        person_box = detect_person_yolo(frame)
                        if person_box:
                            cameraman.update_target(person_box)

                # Snap camera on scene change to avoid panning from previous scene position
                is_scene_start = (frame_number == scene_boundaries[current_scene_index][0])
                
                x1, y1, x2, y2 = cameraman.get_crop_box(force_snap=is_scene_start)
                
                # Crop
                if y2 > y1 and x2 > x1:
                    cropped = frame[y1:y2, x1:x2]
                    output_frame = cv2.resize(cropped, (OUTPUT_WIDTH, OUTPUT_HEIGHT))
                else:
                    output_frame = cv2.resize(frame, (OUTPUT_WIDTH, OUTPUT_HEIGHT))

            ffmpeg_process.stdin.write(output_frame.tobytes())
            frame_number += 1
            pbar.update(1)
    
    ffmpeg_process.stdin.close()
    stderr_output = ffmpeg_process.stderr.read().decode()
    ffmpeg_process.wait()
    cap.release()

    if ffmpeg_process.returncode != 0:
        print("\n   ❌ FFmpeg frame processing failed.")
        print("   Stderr:", stderr_output)
        return False

    print("\n   🔊 Step 5: Extracting audio...")
    audio_extract_command = [
        'ffmpeg', '-y', '-i', input_video, '-vn', '-acodec', 'copy', temp_audio_output
    ]
    try:
        subprocess.run(audio_extract_command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError:
        print("\n   ❌ Audio extraction failed (maybe no audio?). Proceeding without audio.")
        pass

    print("\n   ✨ Step 6: Merging...")
    if os.path.exists(temp_audio_output):
        merge_command = [
            'ffmpeg', '-y', '-i', temp_video_output, '-i', temp_audio_output,
            '-c:v', 'copy', '-c:a', 'copy', final_output_video
        ]
    else:
         merge_command = [
            'ffmpeg', '-y', '-i', temp_video_output,
            '-c:v', 'copy', final_output_video
        ]
        
    try:
        subprocess.run(merge_command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        print(f"   ✅ Clip saved to {final_output_video}")
    except subprocess.CalledProcessError as e:
        print("\n   ❌ Final merge failed.")
        print("   Stderr:", e.stderr.decode())
        return False

    # Clean up temp files
    if os.path.exists(temp_video_output): os.remove(temp_video_output)
    if os.path.exists(temp_audio_output): os.remove(temp_audio_output)
    
    return True

def _transcript_cache_key(video_path: str, transcribe_provider: str, forced_lang: str | None, model_size: str) -> str | None:
    """Hash a video file fast enough that repeated jobs on the SAME
    source don't pay the 10-15 minute Whisper cost twice. We sample
    the first and last 1 MB of the file plus its size — content-stable
    against renames, and 1000× faster than hashing the whole file for
    a 1 GB video (which would itself take 15 seconds).

    The cache key also folds in the transcription PROVIDER, the
    requested LANGUAGE hint, and the WHISPER MODEL SIZE — different
    settings produce different transcripts so they shouldn't collide.
    Returns None if the file can't be read (caller treats as a miss).
    """
    import hashlib
    try:
        size = os.path.getsize(video_path)
    except OSError:
        return None
    h = hashlib.sha256()
    SAMPLE = 1024 * 1024  # 1 MB head + 1 MB tail = enough entropy
    try:
        with open(video_path, "rb") as f:
            head = f.read(SAMPLE)
            h.update(head)
            if size > SAMPLE * 2:
                f.seek(-SAMPLE, 2)
                tail = f.read(SAMPLE)
                h.update(tail)
        h.update(str(size).encode())
        h.update((transcribe_provider or "").encode())
        h.update((forced_lang or "").encode())
        h.update((model_size or "").encode())
        return h.hexdigest()[:24]
    except Exception:
        return None


def _transcript_cache_path(key: str) -> str:
    """Cache files live alongside the rest of the output, namespaced
    so they're easy to wipe if you ever want a clean cache."""
    cache_dir = os.path.join(os.environ.get("OPENSHORTS_OUTPUT_DIR", "output"), ".transcript_cache")
    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, f"{key}.json")


def _try_whisper_sidecar(audio_path, *, language=None, initial_prompt=""):
    """Attempt transcription via the native macOS Whisper sidecar.

    The sidecar (whisper_sidecar/sidecar.py) runs OUTSIDE Docker on
    the macOS host and uses Apple Metal via mlx-whisper, which is
    roughly 10-15× faster than the CPU path inside the container.

    Returns:
        dict shaped like faster-whisper's result, or None on any
        kind of failure (caller falls back to local CPU Whisper).

    The function NEVER raises — every failure is logged and returns
    None so the pipeline keeps working when the sidecar is offline.
    """
    url = (os.getenv("KLIPRA_WHISPER_SIDECAR_URL") or "").strip().rstrip("/")
    if not url:
        return None
    try:
        import requests
    except ImportError:
        # `requests` is a dep of yt-dlp + a few other things in the
        # Klipra image, so this branch is mostly defensive.
        print("⚠️  Sidecar configured but `requests` not installed — "
              "skipping native path, using CPU.")
        return None

    health_url = f"{url}/health"
    transcribe_url = f"{url}/transcribe"

    # Cheap probe — if the sidecar isn't running we want to fail
    # within ~1.5 s, not block a clip-gen job.
    try:
        h = requests.get(health_url, timeout=1.5)
        if h.status_code != 200:
            return None
        info = h.json()
    except Exception:
        # Connection refused / DNS failure / timeout / non-JSON. All
        # mean "no sidecar today" — fall through to CPU silently.
        return None

    print(f"⚡ Whisper sidecar online: {info}")
    print(f"🚀 Sending audio to native Whisper sidecar ({url}) — Metal-accelerated.")

    # Long timeout — long videos legitimately take a while even on
    # Metal. 1 hour is a generous ceiling. Loopback connections
    # don't have any TCP keepalive issues at this length.
    try:
        with open(audio_path, "rb") as f:
            files = {"audio": (os.path.basename(audio_path), f, "application/octet-stream")}
            data = {}
            if language:
                data["language"] = language
            if initial_prompt:
                data["initial_prompt"] = initial_prompt
            r = requests.post(
                transcribe_url,
                files=files,
                data=data,
                timeout=(30, 3600),  # (connect, read)
            )
        r.raise_for_status()
        result = r.json()
    except Exception as e:
        print(f"⚠️  Sidecar transcription failed: {e} — falling back to CPU faster-whisper.")
        return None

    if not isinstance(result, dict) or not result.get("segments"):
        print("⚠️  Sidecar returned an empty result — falling back to CPU faster-whisper.")
        return None

    print(
        f"✓ Sidecar returned {len(result.get('segments', []))} segments, "
        f"language={result.get('language', '')!r}"
    )
    # Print a sample of the first segment so the live log feels alive
    # the same way the CPU path does.
    first = result["segments"][0]
    print(f"   [{float(first.get('start', 0)):.2f}s -> "
          f"{float(first.get('end', 0)):.2f}s] {first.get('text', '').strip()[:120]}")
    return result


def transcribe_video(video_path):
    """Stage 1 of Klipra's pipeline.

    Defaults to Whisper Turbo (free, local). Switches to ElevenLabs
    Scribe when the user has set OPENSHORTS_TRANSCRIBE_PROVIDER=elevenlabs
    AND provided an OPENSHORTS_ELEVENLABS_KEY. If Scribe fails (bad key,
    quota hit, network issue), we fall back to local Whisper so a job
    never dies on a transient cloud problem.

    Transcripts are CACHED by content hash so re-running on the same
    video file (which is the common case during testing or when a job
    crashes mid-pipeline and the user retries) returns instantly
    instead of re-transcribing for another 10-15 minutes. The cache
    survives across jobs, features, and backend restarts.
    """
    transcribe_provider = (
        os.getenv("OPENSHORTS_TRANSCRIBE_PROVIDER") or "whisper"
    ).lower()
    forced_language = (os.getenv("OPENSHORTS_TRANSCRIPT_LANG") or "").strip().lower() or None
    # Mixed-script codes from the frontend (Hinglish, Roman Urdu, etc.):
    # Whisper doesn't accept "hi-en" — let it auto-detect instead. The
    # LLM cleanup later sees the original language signal via the
    # transcript metadata and treats it as code-switched.
    if forced_language in ("hi-en", "ur-en", "ar-en"):
        print(f"🌐 Mixed-script source ({forced_language}) — letting Whisper auto-detect.")
        forced_language = None
    cache_model = (
        os.getenv("OPENSHORTS_WHISPER_MODEL")
        or os.getenv("WHISPER_MODEL")
        or "large-v3-turbo"
    )
    cache_key = _transcript_cache_key(video_path, transcribe_provider, forced_language, cache_model)
    if cache_key:
        cache_path = _transcript_cache_path(cache_key)
        if os.path.isfile(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                if cached and cached.get("segments"):
                    print(f"⚡ Transcript cache hit ({cache_key}) — skipping Whisper.")
                    return cached
            except Exception as e:
                print(f"⚠️  Cache file unreadable ({cache_key}), re-transcribing: {e}")
    if transcribe_provider == "elevenlabs":
        eleven_key = os.getenv("OPENSHORTS_ELEVENLABS_KEY") or os.getenv("ELEVENLABS_API_KEY")
        if eleven_key:
            try:
                from transcribe_elevenlabs import transcribe_with_elevenlabs
                forced_lang = (os.getenv("OPENSHORTS_TRANSCRIPT_LANG") or "").strip().lower() or None
                eleven_result = transcribe_with_elevenlabs(
                    video_path,
                    api_key=eleven_key,
                    language_code=forced_lang,
                )
                if cache_key and eleven_result and eleven_result.get("segments"):
                    try:
                        with open(_transcript_cache_path(cache_key), "w", encoding="utf-8") as f:
                            json.dump(eleven_result, f)
                    except Exception as e:
                        print(f"⚠️  Could not save transcript cache: {e}")
                return eleven_result
            except Exception as e:
                print(f"⚠️  ElevenLabs Scribe failed ({e}). Falling back to local Whisper.")
        else:
            print("⚠️  ElevenLabs requested but no key found. Falling back to local Whisper.")

    # ====================================================================
    # NATIVE-MAC SIDECAR (Apple Metal / MLX) — FAST PATH
    # ====================================================================
    # When KLIPRA_WHISPER_SIDECAR_URL is configured AND the sidecar's
    # /health probe answers within 1.5 s, we offload the whole transcript
    # to it. mlx-whisper on the user's M-series GPU is ~10-15× CPU speed.
    # If anything goes wrong (sidecar offline, crash, timeout), we silently
    # drop down to the local faster-whisper path below — same behaviour
    # users had before the sidecar existed.
    #
    # We resolve the forced_language here too so the sidecar request and
    # the CPU fallback use exactly the same language argument.
    forced_language_pre = (os.getenv("OPENSHORTS_TRANSCRIPT_LANG") or "").strip().lower() or None
    if forced_language_pre in ("hi-en", "ur-en", "ar-en"):
        # Mixed-script source — Whisper only accepts single-ISO codes.
        forced_language_pre = None

    sidecar_result = _try_whisper_sidecar(
        video_path,
        language=forced_language_pre,
    )
    if sidecar_result and sidecar_result.get("segments"):
        # Cache exactly the same as the CPU path so a re-run hits the
        # cache regardless of which path produced the original.
        if cache_key:
            try:
                with open(_transcript_cache_path(cache_key), "w", encoding="utf-8") as f:
                    json.dump(sidecar_result, f)
                print(f"💾 Sidecar transcript cached as {cache_key}.json.")
            except Exception as e:
                print(f"⚠️  Could not save sidecar transcript cache: {e}")
        return sidecar_result

    # ---- CPU FALLBACK (faster-whisper inside the container) ------------
    from faster_whisper import WhisperModel

    # Whisper model size — bigger = noticeably more accurate, especially
    # for non-English / accented audio, but proportionally slower.
    # Override via OPENSHORTS_WHISPER_MODEL (preferred — set by the API
    # layer from the dashboard's speed picker) or the legacy WHISPER_MODEL
    # env var if compute-bound:
    #   tiny   → fastest, very rough transcripts
    #   base   → fast, noticeable hallucinations on accented English
    #   small  → balanced — much better than base, ~2x faster than medium
    #   medium → most accurate of the practical sizes
    #   large-v3 → best quality, ~3x slower than medium
    # Single Whisper tier: large-v3-turbo. Same accuracy as Large-v3 but
    # ~8× faster. We dropped the Fast/Balanced/Best picker because turbo
    # is just better than all three on every axis that matters. Override
    # via OPENSHORTS_WHISPER_MODEL env var if you really want a different
    # tier (e.g. tiny for testing).
    model_size = (
        os.getenv("OPENSHORTS_WHISPER_MODEL")
        or os.getenv("WHISPER_MODEL")
        or "large-v3-turbo"
    )
    # Beam size — large/turbo benefit from a wider beam (better
    # disambiguation), tiny models don't.
    beam_size = 5 if model_size in ("medium", "small", "large-v3", "large-v3-turbo") else 1
    # Friendly model name for the log line. "large-v3-turbo" is the
    # technical id; "Whisper Turbo" is what users actually selected
    # in the dashboard, so spell that out so the two never look like
    # different things.
    friendly = {
        "large-v3-turbo": "Whisper Turbo (large-v3-turbo)",
        "large-v3": "Whisper Large-v3",
        "large-v2": "Whisper Large-v2",
        "medium": "Whisper Medium",
        "small": "Whisper Small",
        "base": "Whisper Base",
        "tiny": "Whisper Tiny",
    }.get(model_size, f"Whisper {model_size}")

    # ---- DEVICE / PERFORMANCE TUNING -----------------------------------
    # Docker on macOS runs in a Linux VM with NO Metal/MPS access, so
    # GPU acceleration is impossible from inside the container. Best we
    # can do is squeeze the CPU path. On Linux/Windows hosts with NVIDIA
    # GPUs, set OPENSHORTS_WHISPER_DEVICE=cuda + the matching compute
    # type (e.g. float16) and faster-whisper will pick up the GPU
    # automatically.
    device = (os.getenv("OPENSHORTS_WHISPER_DEVICE") or "cpu").strip().lower()
    # compute_type: int8 is fastest on CPU (no native fp16 ops on most
    # x86_64 / arm64 CPUs); float16 is best on CUDA GPUs.
    if device == "cuda":
        default_compute = "float16"
    else:
        default_compute = "int8"
    compute_type = (os.getenv("OPENSHORTS_WHISPER_COMPUTE_TYPE") or default_compute).strip()
    # cpu_threads = 0 lets faster-whisper / CTranslate2 pick a default
    # (usually half the cores). Override with OPENSHORTS_WHISPER_CPU_THREADS
    # to use all of them. On a 12-core M3 Max, set to 12 (or 10 if you
    # want to leave 2 cores for the rest of the OS).
    try:
        cpu_threads = int(os.getenv("OPENSHORTS_WHISPER_CPU_THREADS", "0") or 0)
    except ValueError:
        cpu_threads = 0
    if cpu_threads <= 0:
        # Auto-pick: use all logical CPUs the container can see.
        try:
            import multiprocessing as _mp
            cpu_threads = max(1, _mp.cpu_count())
        except Exception:
            cpu_threads = 4  # safe fallback
    # num_workers: how many concurrent transcription workers run
    # against the same model instance. >1 lets audio decode + Whisper
    # inference overlap, which is a meaningful win on a single long
    # video. Costs RAM (each worker ≈ 1× the model size). On 64 GB
    # boxes 2 is a great default; bump higher if you process several
    # videos in parallel.
    try:
        num_workers = int(os.getenv("OPENSHORTS_WHISPER_NUM_WORKERS", "2") or 2)
    except ValueError:
        num_workers = 2
    num_workers = max(1, num_workers)

    print(
        f"🎙️  Transcribing with {friendly} — running on the "
        f"Faster-Whisper library "
        f"(device={device}, compute_type={compute_type}, "
        f"cpu_threads={cpu_threads}, num_workers={num_workers}, beam={beam_size})."
    )
    if device == "cpu":
        # Friendly hint for Mac users: Docker can't see Metal, so the
        # 24-core GPU is unreachable from here. Tell them how to push
        # the CPU side as far as it goes.
        print(
            "   ℹ️  Tip: on macOS, Docker has no GPU access. To make "
            "the CPU path as fast as possible, raise Docker Desktop → "
            "Settings → Resources → CPUs to your physical core count "
            "(e.g. 12 on an M3 Max), and set "
            "OPENSHORTS_WHISPER_CPU_THREADS to the same value."
        )

    model = WhisperModel(
        model_size,
        device=device,
        compute_type=compute_type,
        cpu_threads=cpu_threads,
        num_workers=num_workers,
    )

    # Optional language hint. Without this, Whisper auto-detects, and for
    # Urdu speakers it commonly mis-fires as 'hi' (Hindi) and emits
    # Devanagari script. The dashboard exposes this as a "Source language"
    # picker on the submit form.
    forced_language = (os.getenv("OPENSHORTS_TRANSCRIPT_LANG") or "").strip().lower() or None
    # Same mixed-script normalization as line ~990 — the early one only
    # runs on the cache-key / ElevenLabs paths, but the actual
    # faster-whisper call below needs the SAME treatment or it errors
    # with "'ur-en' is not a valid language code". Whisper's accepted
    # codes are single ISO-639-1 only; mixed-script codes (Hinglish /
    # Roman Urdu / Roman Arabic) must collapse to None so Whisper
    # auto-detects.
    if forced_language in ("hi-en", "ur-en", "ar-en"):
        print(f"🌐 Mixed-script source ({forced_language}) at transcribe step — letting Whisper auto-detect.")
        forced_language = None
    if forced_language:
        print(f"   Forcing language: {forced_language}")

    # beam_size 5 + vad_filter dramatically reduce repetition loops
    # (the "$100 with a $100" pattern is a known Whisper failure mode
    # on low-quality audio that beam search + VAD largely fixes).
    segments, info = model.transcribe(
        video_path,
        word_timestamps=True,
        beam_size=beam_size,
        vad_filter=True,
        condition_on_previous_text=False,
        language=forced_language,
    )
    
    print(f"   Detected language '{info.language}' with probability {info.language_probability:.2f}")
    
    # Convert to openai-whisper compatible format
    transcript_segments = []
    full_text = ""
    
    for segment in segments:
        # Print progress to keep user informed (and prevent timeouts feeling)
        print(f"   [{segment.start:.2f}s -> {segment.end:.2f}s] {segment.text}")
        
        seg_dict = {
            'text': segment.text,
            'start': segment.start,
            'end': segment.end,
            'words': []
        }
        
        if segment.words:
            for word in segment.words:
                seg_dict['words'].append({
                    'word': word.word,
                    'start': word.start,
                    'end': word.end,
                    'probability': word.probability
                })
        
        transcript_segments.append(seg_dict)
        full_text += segment.text + " "
        
    result = {
        'text': full_text.strip(),
        'segments': transcript_segments,
        'language': info.language
    }
    # Persist to cache so a subsequent run on the same input file
    # (same content hash + same provider/lang/model) returns instantly
    # without re-doing the 10-15-minute Whisper pass. The cache also
    # crosses feature boundaries — e.g. if the user runs subtitle then
    # dub on the same source, dub gets a free transcribe.
    if cache_key:
        try:
            with open(_transcript_cache_path(cache_key), "w", encoding="utf-8") as f:
                json.dump(result, f)
            print(f"💾 Transcript cached as {cache_key}.json — same video won't re-transcribe.")
        except Exception as e:
            print(f"⚠️  Could not save transcript cache: {e}")
    return result

def _enforce_clip_duration(
    shorts: list,
    *,
    min_duration: float,
    max_duration: float,
    video_duration: float,
) -> list:
    """Adjust LLM-returned clips so every one is between min_duration
    and max_duration seconds.

    Strategy per clip:
      - Already in range → leave alone.
      - Shorter than min → expand to a *randomized* target (between min
        and min+25% of the [min,max] range). Without randomization, every
        too-short clip would snap to exactly `min_duration` and the user
        would see a row of identically-sized clips.
      - Longer than max → trim from both ends symmetrically.

    Runs AFTER the LLM picks moments. The prompt also asks for variety
    + range, but LLMs routinely return uniform-length clips — this gate
    is what actually delivers the variety the user wanted.
    """
    import random
    out: list = []
    for clip in shorts:
        try:
            start = float(clip.get("start", 0))
            end = float(clip.get("end", 0))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        duration = end - start

        if duration < min_duration:
            # Randomize the extension target between min_duration and
            # min_duration + 25% of the configured range. Keeps clips
            # varied even when most of them needed extension.
            jitter_band = max(2.0, (max_duration - min_duration) * 0.25)
            target = min_duration + random.uniform(0, jitter_band)
            target = min(target, max_duration)
            need = target - duration
            half = need / 2.0
            new_start = max(0.0, start - half)
            new_end = min(video_duration, end + half)
            # If we hit one end, push the other side further to compensate.
            shortfall_end = (end + half) - new_end
            if shortfall_end > 0:
                new_start = max(0.0, new_start - shortfall_end)
            shortfall_start = half - (start - new_start)
            if shortfall_start > 0:
                new_end = min(video_duration, new_end + shortfall_start)
            if (new_end - new_start) < min_duration - 0.5:
                # Can't stretch enough — source is too short or the
                # clip is at the very edge of the source. Drop it.
                print(
                    f"   ⚠️  Dropping clip [{start:.2f}, {end:.2f}] "
                    f"({duration:.1f}s): can't expand to {min_duration}s "
                    f"without overrunning source ({video_duration:.1f}s)."
                )
                continue
            print(
                f"   ⏱️  Extended [{start:.2f}, {end:.2f}] ({duration:.1f}s) → "
                f"[{new_start:.2f}, {new_end:.2f}] ({new_end - new_start:.1f}s)"
            )
            clip = {**clip, "start": round(new_start, 3), "end": round(new_end, 3)}

        elif duration > max_duration:
            excess = duration - max_duration
            half = excess / 2.0
            clip = {
                **clip,
                "start": round(start + half, 3),
                "end": round(end - half, 3),
            }
            print(
                f"   ✂️  Trimmed long clip ({duration:.1f}s → {max_duration}s)"
            )

        out.append(clip)
    return out


def get_viral_clips(
    transcript_result,
    video_duration,
    *,
    provider_id: str | None = None,
    model_name: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
):
    """Detect viral clips with any supported LLM provider.

    Backward-compatible: when called with no kwargs, reads GEMINI_API_KEY
    from env and uses gemini-2.5-flash — the original openshorts behavior.

    New: accepts an explicit provider/model/key triple so the HTTP layer
    can pass whatever the user picked in the UI.
    """
    from llm import build_provider, LLMError

    # Fill in the legacy defaults so existing callers (CLI, other scripts)
    # keep working without changes.
    provider_id = (provider_id or "gemini").lower()
    if provider_id == "gemini":
        model_name = model_name or "gemini-2.5-flash"
        api_key = api_key or os.getenv("GEMINI_API_KEY", "")
    if provider_id != "ollama" and not api_key:
        print(f"❌ Error: no API key provided for provider '{provider_id}'.")
        return None

    print(f"🤖  Analyzing with {provider_id} · {model_name} ...")

    # Build the words array the prompt expects
    words = []
    for segment in transcript_result['segments']:
        for word in segment.get('words', []):
            words.append({
                'w': word['word'],
                's': word['start'],
                'e': word['end']
            })

    # Read clip-selection bounds from env (set by app.py from request headers).
    # Sensible defaults match openshorts' original behavior so the CLI path
    # keeps working unchanged.
    def _env_int(name, default):
        try:
            return max(1, int(os.getenv(name) or default))
        except ValueError:
            return default
    min_clips = _env_int("OPENSHORTS_MIN_CLIPS", 3)
    max_clips = _env_int("OPENSHORTS_MAX_CLIPS", 8)
    min_duration = _env_int("OPENSHORTS_MIN_DURATION", 15)
    max_duration = _env_int("OPENSHORTS_MAX_DURATION", 60)
    if max_clips < min_clips:
        max_clips = min_clips
    if max_duration < min_duration:
        max_duration = min_duration

    prompt = GEMINI_PROMPT_TEMPLATE.format(
        video_duration=video_duration,
        transcript_text=json.dumps(transcript_result['text']),
        words_json=json.dumps(words),
        min_clips=min_clips,
        max_clips=max_clips,
        min_duration=min_duration,
        max_duration=max_duration,
    )

    # Ollama-specific reinforcement. Smaller local models (qwen2.5:14b,
    # llama3.2 etc.) consistently anchor to the midpoint of the duration
    # range — e.g. 8 clips all at ~41s on a 20-60s allowed range —
    # because they pattern-match instead of reading the transcript.
    # Cloud frontier models (Gemini, GPT-5, Claude) follow the original
    # "vary lengths" instruction. We append an EXTRA, more emphatic
    # block when provider=ollama with a concrete worked example so the
    # local model gets the idea.
    if provider_id == "ollama":
        midpoint = (min_duration + max_duration) // 2
        prompt += (
            f"\n\n🛑 SPECIAL RULE FOR THIS RUN: Do NOT return clips all at "
            f"the same length. Returning {min_clips}+ clips all at "
            f"~{midpoint}s (the midpoint) means you picked SAFE numbers "
            f"instead of reading the transcript. The duration of each "
            f"clip MUST be determined by content boundaries — start when "
            f"the thought begins, end when it lands.\n\n"
            f"CONCRETE EXAMPLE of what GOOD output looks like for a "
            f"range of {min_duration}-{max_duration}s:\n"
            f"  Clip 1 (one-liner): 22.0s\n"
            f"  Clip 2 (setup → punchline): 35.5s\n"
            f"  Clip 3 (long argument): 58.0s\n"
            f"  Clip 4 (story with reversal): 41.2s\n"
            f"  Clip 5 (rapid-fire list): 28.0s\n\n"
            f"BAD output (which will be REJECTED and re-tried):\n"
            f"  All clips at ~{midpoint}s. All clips at ~{min_duration + 10}s. "
            f"All clips within 3s of each other. This is failure.\n\n"
            f"Pick boundaries from the WORDS_JSON timestamps — look for "
            f"sentence-end pauses, topic shifts, and the start of new "
            f"thoughts. Lengths SHOULD vary by 15s or more between clips."
        )

    def _do_pick(strict_anti_uniform=False, prev_durations=None):
        """Run the picker. When `strict_anti_uniform` is True, prepend an
        emphatic counter-example showing the LLM what we DON'T want.
        Used by the uniform-length retry below."""
        sys_msg = "You are a senior short-form video editor."
        eff_prompt = prompt
        if strict_anti_uniform and prev_durations:
            cnt = len(prev_durations)
            avg = sum(prev_durations) / max(1, cnt)
            durs_str = ", ".join(f"{d:.1f}s" for d in prev_durations)
            anti_uniform_preamble = (
                f"🛑 YOUR PREVIOUS ATTEMPT FAILED — you returned {cnt} clips all at "
                f"~{avg:.1f}s long (exact lengths: {durs_str}). That's the AVERAGE "
                f"of the allowed range — which means you ignored the content and "
                f"just picked the middle value. THIS IS UNACCEPTABLE.\n\n"
                f"This time, pick clip BOUNDARIES based on where the speaker's "
                f"natural thoughts START and END. Some clips will be SHORT "
                f"(15-25s — a single punchline), some MEDIUM (30-45s — a setup + "
                f"payoff), some LONG (50-60s — a full argument or list). Returning "
                f"another batch of uniform-length clips means you didn't read the "
                f"transcript carefully enough.\n\n"
            )
            eff_prompt = anti_uniform_preamble + prompt
        return provider.complete_json(
            system=sys_msg,
            user=eff_prompt,
            max_tokens=8192,
        )

    try:
        provider = build_provider(
            provider_id, model_name or "", api_key or "", base_url=base_url
        )
        # The prompt already asks for strict JSON; complete_json handles fences
        # + loose parsing + native JSON mode on providers that support it.
        result_json = _do_pick(strict_anti_uniform=False)
        if not isinstance(result_json, dict) or "shorts" not in result_json:
            # Accept bare list fallback and wrap it
            if isinstance(result_json, list):
                result_json = {"shorts": result_json}
            else:
                print(f"❌ Unexpected LLM output shape: {type(result_json).__name__}")
                return None

        # UNIFORM-LENGTH DETECTOR + RETRY.
        # Smaller Ollama models (qwen2.5:14b et al.) tend to ignore the
        # "vary clip lengths" instruction in the prompt and instead pick
        # the safe midpoint of the duration range for every clip. The
        # user reported 8 clips all at ~41s on a 20-60s range — a stddev
        # of practically zero. We detect this and retry ONCE with a
        # tighter prompt that calls out exactly what they did wrong.
        # We only do the retry on Ollama because cloud models (Gemini,
        # OpenAI, Anthropic) follow the original instruction reliably.
        shorts_raw = result_json.get("shorts", []) or []
        if provider_id == "ollama" and len(shorts_raw) >= 3:
            durs = []
            for s in shorts_raw:
                try:
                    d = float(s.get("end", 0)) - float(s.get("start", 0))
                    if d > 0:
                        durs.append(d)
                except (TypeError, ValueError):
                    pass
            if len(durs) >= 3:
                avg = sum(durs) / len(durs)
                # Use simple range (max - min) as the uniformity signal
                # — it's more intuitive than stddev and matches what the
                # user actually notices ("they're all 41 seconds").
                spread = max(durs) - min(durs)
                # Uniform = total spread under 5 seconds across all clips.
                # That's much tighter than the prompt's allowed range.
                if spread < 5.0:
                    print(f"⚠️  Uniform-length detected: {len(durs)} clips all at "
                          f"{min(durs):.1f}-{max(durs):.1f}s (spread {spread:.1f}s, "
                          f"avg {avg:.1f}s). Retrying with stricter prompt…")
                    try:
                        retry_json = _do_pick(strict_anti_uniform=True,
                                              prev_durations=durs)
                        if isinstance(retry_json, dict) and "shorts" in retry_json:
                            new_durs = [
                                float(s.get("end", 0)) - float(s.get("start", 0))
                                for s in (retry_json.get("shorts") or [])
                                if float(s.get("end", 0)) > float(s.get("start", 0))
                            ]
                            new_spread = (max(new_durs) - min(new_durs)
                                          if new_durs else 0)
                            if new_durs and new_spread > spread:
                                print(f"   Retry produced varied clips "
                                      f"(spread {new_spread:.1f}s, was {spread:.1f}s). "
                                      f"Using retry result.")
                                result_json = retry_json
                            else:
                                print(f"   Retry still uniform "
                                      f"(spread {new_spread:.1f}s). "
                                      f"Keeping original picks. "
                                      f"Consider switching to a cloud model "
                                      f"(Gemini free tier or MiniMax) for "
                                      f"better content-driven boundaries.")
                    except LLMError as e:
                        print(f"   Retry failed ({e}). Keeping original picks.")

        # 🔒 Enforce duration bounds. The LLM's prompt asks for clips
        # between {min_duration} and {max_duration} s, but providers
        # routinely ignore this when they think a hook is "punchy enough"
        # at 8 seconds. We post-process here: extend short clips by
        # padding symmetrically, trim long ones, drop anything we can't
        # stretch without going off the source.
        original_count = len(result_json.get("shorts", []))
        result_json["shorts"] = _enforce_clip_duration(
            result_json.get("shorts", []),
            min_duration=min_duration,
            max_duration=max_duration,
            video_duration=video_duration,
        )
        adjusted_count = len(result_json["shorts"])
        if original_count != adjusted_count:
            print(
                f"⏱️  Duration enforcement: {original_count} → {adjusted_count} clips "
                f"(min={min_duration}s, max={max_duration}s)"
            )

        # Cost analysis fields — defaults so the dashboard doesn't crash
        # on `cost_analysis.input_cost.toFixed(...)`.
        result_json.setdefault("cost_analysis", {})
        ca = result_json["cost_analysis"]
        ca.setdefault("provider", provider_id)
        ca.setdefault("model", model_name)
        ca.setdefault("input_tokens", 0)
        ca.setdefault("output_tokens", 0)
        ca.setdefault("input_cost", 0.0)
        ca.setdefault("output_cost", 0.0)
        ca.setdefault("total_cost", 0.0)
        return result_json
    except LLMError as e:
        print(f"❌ LLM provider error ({provider_id}/{model_name}): {e}")
        _write_picker_error_sidecar(str(e))
        return None
    except Exception as e:
        print(f"❌ Clip-analysis error: {e}")
        _write_picker_error_sidecar(str(e))
        return None


def _write_picker_error_sidecar(err_text: str) -> None:
    """Write the most-recent picker error to `<output_dir>/.last_picker_error.txt`
    so the run-level wrapper above can read it and emit a targeted
    failure message (daily quota vs minute quota vs auth vs malformed
    JSON). The sidecar location is opportunistic — we look for the
    output dir on argv since main.py is normally run with `-o <dir>`."""
    try:
        out_dir = None
        argv = sys.argv
        for i, a in enumerate(argv):
            if a in ("-o", "--output") and i + 1 < len(argv):
                out_dir = argv[i + 1]
                break
        if not out_dir:
            return
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, ".last_picker_error.txt")
        with open(path, "w") as f:
            f.write(err_text)
    except Exception:
        # Sidecar is best-effort; never let it break the real error path.
        pass

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="AutoCrop-Vertical with Viral Clip Detection.")
    
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument('-i', '--input', type=str, help="Path to the input video file.")
    input_group.add_argument('-u', '--url', type=str, help="YouTube URL to download and process.")
    
    parser.add_argument('-o', '--output', type=str, help="Output directory or file (if processing whole video).")
    parser.add_argument('--keep-original', action='store_true', help="Keep the downloaded YouTube video.")
    parser.add_argument('--skip-analysis', action='store_true', help="Skip AI analysis and convert the whole video.")
    
    args = parser.parse_args()

    script_start_time = time.time()
    
    def _ensure_dir(path: str) -> str:
        """Create directory if missing and return the same path."""
        if path:
            os.makedirs(path, exist_ok=True)
        return path
    
    # 1. Get Input Video
    if args.url:
        # For multi-clip runs, treat --output as an OUTPUT DIRECTORY (create it if needed).
        # For whole-video runs (--skip-analysis), --output can be a file path.
        if args.output and not args.skip_analysis:
            output_dir = _ensure_dir(args.output)
        else:
            # If output is a directory, use it; if it's a filename, use its directory; else default "."
            if args.output and os.path.isdir(args.output):
                output_dir = args.output
            elif args.output and not os.path.isdir(args.output):
                output_dir = os.path.dirname(args.output) or "."
            else:
                output_dir = "."
        
        input_video, video_title = download_youtube_video(args.url, output_dir)
    else:
        input_video = args.input
        video_title = os.path.splitext(os.path.basename(input_video))[0]
        
        if args.output and not args.skip_analysis:
            # For multi-clip runs, treat --output as an OUTPUT DIRECTORY (create it if needed).
            output_dir = _ensure_dir(args.output)
        else:
            # If output is a directory, use it; if it's a filename, use its directory; else default to input dir.
            if args.output and os.path.isdir(args.output):
                output_dir = args.output
            elif args.output and not os.path.isdir(args.output):
                output_dir = os.path.dirname(args.output) or os.path.dirname(input_video)
            else:
                output_dir = os.path.dirname(input_video)

    if not os.path.exists(input_video):
        print(f"❌ Input file not found: {input_video}")
        exit(1)

    # 2. Decision: Analyze clips or process whole?
    if args.skip_analysis:
        print("⏩ Skipping analysis, processing entire video...")
        output_file = args.output if args.output else os.path.join(output_dir, f"{video_title}_vertical.mp4")
        process_video_to_vertical(input_video, output_file)
    else:
        # 3. Transcribe
        transcript = transcribe_video(input_video)

        # 3b. AI cleanup pass on the Whisper transcript BEFORE clip selection.
        #
        # This is the critical step that determines clip quality. Whisper's
        # raw output is full of mishears, mangled proper nouns, and
        # repetition loops — feeding that directly to the clip-picker LLM
        # produces bad clip choices. So we always pipe Whisper → LLM
        # cleanup → clip picker.
        #
        # The mode chosen depends on the user's `OPENSHORTS_TRANSCRIPT_SCRIPT`
        # env var:
        #   • 'roman'   AND non-Latin language  → cleanup + transliterate
        #                                          to Roman/Latin script
        #                                          (Hindi/Urdu/Arabic users
        #                                          who want Hinglish output)
        #   • anything else                     → cleanup only, keeping the
        #                                          original language + script
        #
        # The cleanup pass runs for ALL languages, including English —
        # English Whisper transcripts also benefit from context-aware
        # proofreading (proper nouns, technical terms, repetition).
        #
        # Opt out via OPENSHORTS_TRANSCRIPT_SCRIPT=skip-cleanup if you
        # really want raw Whisper output.
        script_mode = (os.getenv("OPENSHORTS_TRANSCRIPT_SCRIPT") or "auto").lower()
        non_latin = {
            "hi", "ur", "ar", "fa", "ps", "ku",
            "bn", "pa", "ta", "te", "ml", "kn", "gu", "mr", "or",
            "th", "ja", "ko", "zh", "yue",
            "ru", "uk", "be", "bg", "sr", "mk",
            "el", "he", "yi",
        }
        detected = (transcript.get("language") or "").lower()

        if script_mode == "skip-cleanup":
            print("   AI transcript cleanup disabled by user.")
        else:
            # Choose mode: roman+transliterate when the user explicitly
            # asked for Roman script AND the language needs it; cleanup-
            # only otherwise.
            if script_mode == "roman" and detected in non_latin:
                pass_mode = "roman"
                pass_label = f"Cleaning up + transliterating '{detected}' to Roman/Latin"
            else:
                pass_mode = "cleanup"
                pass_label = f"Cleaning up '{detected or 'unknown'}' transcript"

            print(f"📝  {pass_label} (fixes Whisper mishears using full-clip context)…")
            try:
                from transcript_utils import llm_rewrite_transcript
                transcript = llm_rewrite_transcript(
                    transcript,
                    mode=pass_mode,
                    provider_id=os.getenv("OPENSHORTS_LLM_PROVIDER", "gemini"),
                    model_name=os.getenv("OPENSHORTS_LLM_MODEL", "gemini-2.5-flash"),
                    api_key=(
                        os.getenv("OPENSHORTS_LLM_KEY")
                        or os.getenv("GEMINI_API_KEY")
                        or ""
                    ),
                    base_url=os.getenv("OPENSHORTS_LLM_BASE_URL"),
                )
                print("   Transcript cleaned. Sample lines:")
                for sample in (transcript.get("segments") or [])[:3]:
                    print(f"   • {sample.get('text', '')[:120]}")
            except Exception as e:
                print(f"⚠️  AI cleanup failed (continuing with raw Whisper output): {e}")

        # Get duration
        cap = cv2.VideoCapture(input_video)
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = frame_count / fps
        cap.release()

        # 4. LLM analysis — provider/model/key come from env vars set by
        # CHECKPOINT: viral clip picks.
        #
        # If the same output_dir already contains the LLM picker's
        # output from a previous (possibly-crashed) attempt, REUSE it
        # instead of paying for the picker again. We write the
        # checkpoint immediately after the picker succeeds (BEFORE any
        # heavy reframing), so when the per-clip processing crashes
        # mid-batch the user can re-run and skip straight back to
        # cutting the remaining clips.
        #
        # Naming convention: `<video_title>_clips_checkpoint.json` lives
        # alongside the final `<video_title>_metadata.json`. The two
        # have the same content but the checkpoint is written FIRST and
        # is the resume point.
        checkpoint_file = os.path.join(output_dir, f"{video_title}_clips_checkpoint.json")
        metadata_file = os.path.join(output_dir, f"{video_title}_metadata.json")
        clips_data = None
        if os.path.isfile(checkpoint_file):
            try:
                with open(checkpoint_file, "r") as f:
                    clips_data = json.load(f)
                if clips_data and "shorts" in clips_data:
                    print(
                        f"♻️  Resuming from checkpoint: {checkpoint_file} "
                        f"({len(clips_data['shorts'])} clip picks already known). "
                        f"Skipping LLM picker."
                    )
                else:
                    clips_data = None
            except Exception as e:
                print(f"⚠️  Checkpoint unreadable; ignoring: {e}")
                clips_data = None

        if clips_data is None:
            # the HTTP layer, or fall back to Gemini defaults (openshorts' original
            # behavior) when running the CLI directly.
            clips_data = get_viral_clips(
                transcript, duration,
                provider_id=os.getenv("OPENSHORTS_LLM_PROVIDER"),
                model_name=os.getenv("OPENSHORTS_LLM_MODEL"),
                api_key=os.getenv("OPENSHORTS_LLM_KEY") or os.getenv("GEMINI_API_KEY"),
                base_url=os.getenv("OPENSHORTS_LLM_BASE_URL"),
            )

        if not clips_data or 'shorts' not in clips_data:
            # FAILURE MODE — the LLM picker came back empty. The old
            # behaviour was to fall back to converting the WHOLE source
            # to vertical, which:
            #   1. Burns 5-15 minutes of frame-tracking time on a video
            #      the user didn't ask to be reframed in full.
            #   2. Doesn't write a metadata.json, so app.py reports
            #      "No metadata file generated" and treats the job as
            #      failed anyway.
            # Better: exit immediately with a clear message so the user
            # can re-run when the rate limit clears (or switch model).
            # Any expensive work that DID succeed earlier in this run
            # is preserved on disk for the next attempt.
            #
            # If we can read the most-recent provider error from a
            # sidecar file, use it to give a specific actionable
            # message — particularly important for "daily quota"
            # vs "minute quota" so the user knows whether waiting
            # 60s or 24h is the right call.
            last_err = ""
            err_file = os.path.join(output_dir, ".last_picker_error.txt")
            try:
                if os.path.isfile(err_file):
                    with open(err_file, "r") as f:
                        last_err = f.read()
            except Exception:
                pass

            is_daily_quota = (
                "PerDayPerProject" in last_err
                or "GenerateRequestsPerDay" in last_err
                or "per day" in last_err.lower()
            )
            is_minute_quota = (
                "PerMinutePerProject" in last_err
                or "GenerateRequestsPerMinute" in last_err
                or "RESOURCE_EXHAUSTED" in last_err
            ) and not is_daily_quota

            if is_daily_quota:
                print(
                    "❌ Gemini DAILY free-tier quota exhausted (20 requests / day on "
                    "gemini-2.5-flash).\n"
                    "   This quota resets in ~24 hours from when you first hit it.\n"
                    "   To keep working today:\n"
                    "     • Use a local Ollama model (Smart Clipper) — no quota at all.\n"
                    "     • Upgrade to Gemini paid tier (pennies per video).\n"
                    "     • Use a different API key on a different Google project.\n"
                    "   Your transcript + checkpoint are saved; Resume after the quota "
                    "resets will pick up exactly where this stopped."
                )
                sys.exit(2)  # distinct code for daily-quota
            if is_minute_quota:
                print(
                    "❌ Gemini per-minute quota hit. Wait ~60 seconds and click Resume — "
                    "your transcript is cached, so it'll skip straight back to the picker."
                )
                sys.exit(3)  # distinct code for minute-quota

            print(
                "❌ Failed to identify clips — the picker returned no shorts. "
                "This usually means the LLM hit a rate limit, the API key is "
                "missing, or the model returned malformed JSON. NOT running the "
                "whole-video fallback (that wasted 5-15 min on a non-deliverable). "
                "Re-run after fixing the picker and we'll resume from the "
                "transcript checkpoint."
            )
            sys.exit(1)
        else:
            print(f"🔥 Found {len(clips_data['shorts'])} viral clips!")

            # Persist the picks IMMEDIATELY as the checkpoint so a
            # crash in clip-by-clip rendering below doesn't make us
            # re-pay for the picker on retry.
            clips_data['transcript'] = transcript  # Save full transcript for subtitles
            try:
                with open(checkpoint_file, 'w') as f:
                    json.dump(clips_data, f, indent=2)
                print(f"   💾 Checkpoint saved: {checkpoint_file}")
            except Exception as e:
                print(f"   ⚠️  Could not save checkpoint: {e}")

            # Save final metadata (same content). app.py looks for this
            # filename pattern explicitly.
            with open(metadata_file, 'w') as f:
                json.dump(clips_data, f, indent=2)
            print(f"   Saved metadata to {metadata_file}")

            # 5. Process each clip
            for i, clip in enumerate(clips_data['shorts']):
                start = clip['start']
                end = clip['end']
                print(f"\n🎬 Processing Clip {i+1}: {start}s - {end}s")
                print(f"   Title: {clip.get('video_title_for_youtube_short', 'No Title')}")

                # Cut clip
                clip_filename = f"{video_title}_clip_{i+1}.mp4"
                clip_temp_path = os.path.join(output_dir, f"temp_{clip_filename}")
                clip_final_path = os.path.join(output_dir, clip_filename)

                # CHECKPOINT: per-clip skip. If a previous run already
                # rendered this exact clip to disk (and the file is
                # non-empty), skip the cut + reframe entirely. This
                # makes Generate Clips resumable from any mid-batch
                # crash without losing already-rendered clips.
                if os.path.isfile(clip_final_path) and os.path.getsize(clip_final_path) > 1024:
                    print(f"   ♻️  Clip {i+1} already exists ({os.path.basename(clip_final_path)}) — skipping.")
                    continue
                
                # ffmpeg cut
                # Using re-encoding for precision as requested by strict seconds
                cut_command = [
                    'ffmpeg', '-y', 
                    '-ss', str(start), 
                    '-to', str(end), 
                    '-i', input_video,
                    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
                    '-c:a', 'aac',
                    clip_temp_path
                ]
                subprocess.run(cut_command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                
                # Process vertical
                success = process_video_to_vertical(clip_temp_path, clip_final_path)
                
                if success:
                    print(f"   ✅ Clip {i+1} ready: {clip_final_path}")
                
                # Clean up temp cut
                if os.path.exists(clip_temp_path):
                    os.remove(clip_temp_path)

    # Clean up original if requested
    if args.url and not args.keep_original and os.path.exists(input_video):
        os.remove(input_video)
        print(f"🗑️  Cleaned up downloaded video.")

    total_time = time.time() - script_start_time
    print(f"\n⏱️  Total execution time: {total_time:.2f}s")
