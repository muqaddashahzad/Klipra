"""SMTP-based email helpers for Klipra.

Why this lives here and not as part of accounts.py:
    - Accounts code is purely about identity / sessions / billing.
    - Email is an OPTIONAL side channel that should never block signup
      if SMTP is misconfigured. Keeping the import lazy + the failure
      mode safe means a flaky SMTP host can't take down auth.

Configuration (environment variables, all optional):
    SMTP_HOST       — e.g. smtp.gmail.com (default smtp.gmail.com)
    SMTP_PORT       — e.g. 587 (default 587)
    SMTP_USER       — sending address. When unset, every send is a
                      logged no-op so signup keeps working without
                      email.
    SMTP_PASSWORD   — app password / SMTP secret for SMTP_USER.
    SMTP_FROM_NAME  — display name in the From header (default "Klipra").
    SMTP_USE_TLS    — '1' / '0' to force-toggle STARTTLS (default '1').
    KLIPRA_BASE_URL — link the welcome email points users back to
                      (default http://localhost:5175).
"""

from __future__ import annotations

import os
import smtplib
import threading
from email.message import EmailMessage
from email.utils import formataddr
from typing import Optional


def _bool_env(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def is_email_configured() -> bool:
    """True iff we have enough config to actually send mail.

    Used by call sites that want to skip work upfront (e.g. logging
    differently when emails won't be sent).
    """
    return bool((os.environ.get("SMTP_USER") or "").strip()) and bool(
        (os.environ.get("SMTP_PASSWORD") or "").strip()
    )


def _send_blocking(
    *,
    to_email: str,
    subject: str,
    text_body: str,
    html_body: Optional[str] = None,
) -> bool:
    """Send one email synchronously. Returns True on success, False on
    any error (caller decides whether to surface that). Never raises.
    """
    if not is_email_configured():
        print(
            "📭 Email skipped — SMTP_USER/SMTP_PASSWORD not set "
            f"(would have sent '{subject}' to {to_email})."
        )
        return False

    host = (os.environ.get("SMTP_HOST") or "smtp.gmail.com").strip()
    try:
        port = int((os.environ.get("SMTP_PORT") or "587").strip())
    except ValueError:
        port = 587
    user = (os.environ.get("SMTP_USER") or "").strip()
    password = (os.environ.get("SMTP_PASSWORD") or "").strip()
    from_name = (os.environ.get("SMTP_FROM_NAME") or "Klipra").strip() or "Klipra"
    use_tls = _bool_env("SMTP_USE_TLS", True)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((from_name, user))
    msg["To"] = to_email
    msg.set_content(text_body or " ")
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    try:
        with smtplib.SMTP(host, port, timeout=15) as s:
            s.ehlo()
            if use_tls:
                s.starttls()
                s.ehlo()
            s.login(user, password)
            s.send_message(msg)
        print(f"✉️  Sent '{subject}' to {to_email} via {host}:{port}")
        return True
    except Exception as e:
        # We deliberately swallow all errors — email is best-effort.
        # Logging is enough for the operator to debug if delivery
        # stops working.
        print(f"⚠️  Email send failed ({type(e).__name__}: {e})")
        return False


def send_in_background(**kwargs) -> None:
    """Fire-and-forget wrapper. Spawns a daemon thread so the HTTP
    response that triggered the email isn't held back by SMTP latency
    (which can be 1-5 seconds).
    """
    threading.Thread(
        target=_send_blocking,
        kwargs=kwargs,
        daemon=True,
    ).start()


# ---------------------------------------------------------------------------
# Specific templates
# ---------------------------------------------------------------------------

def _welcome_html(full_name: Optional[str], app_url: str) -> str:
    """Inline-styled HTML so it renders correctly in Gmail / Outlook —
    both strip <style> blocks and don't load external CSS / SVG.

    Why no SVG / image logo: Outlook silently drops <svg> tags and
    every email client blocks remote images by default until the user
    opts in. A CSS-gradient wordmark renders reliably and looks like
    the in-app Klipra logo.
    """
    greeting = f"Hi {full_name.split()[0]}," if (full_name or "").strip() else "Hi there,"
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>Welcome to Klipra</title>
</head>
<body style="margin:0;padding:0;background:#0b0b0d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#e6e6ea;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0b0b0d;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;">
        <!-- ===== HEADER ===== -->
        <tr><td align="center" style="padding:8px 0 28px 0;">
          <div style="font-size:34px;font-weight:900;letter-spacing:-0.03em;line-height:1;
                      background:linear-gradient(135deg,#10b981 0%,#0ea5e9 50%,#6366f1 100%);
                      -webkit-background-clip:text;background-clip:text;color:transparent;">
            Klipra
          </div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:#6b7280;font-weight:700;margin-top:6px;">
            Long videos to viral clips, on any AI
          </div>
        </td></tr>

        <!-- ===== HERO ===== -->
        <tr><td style="padding:0 4px 24px 4px;">
          <h1 style="font-size:26px;line-height:1.2;margin:0 0 14px 0;color:#ffffff;font-weight:800;letter-spacing:-0.01em;">
            Welcome aboard 🎬
          </h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 14px 0;color:#bdbdc4;">
            {greeting}
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0;color:#bdbdc4;">
            Thanks for signing up for Klipra — your one-stop creator studio for turning long videos into share-ready content. Whether you're posting daily shorts, captioning interviews, or going global with a multi-language dub, you've got everything you need below.
          </p>
        </td></tr>

        <!-- ===== PRODUCT 1 — VIRAL CLIPS ===== -->
        <tr><td style="padding:8px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#16161a;border:1px solid #2a2a30;border-radius:14px;">
            <tr><td style="padding:18px 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:22px;line-height:1;padding-right:10px;vertical-align:middle;">🎬</td>
                  <td style="vertical-align:middle;">
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#10b981;font-weight:700;">Product 1</div>
                    <div style="font-size:17px;font-weight:800;color:#ffffff;margin-top:2px;letter-spacing:-0.01em;">Generate Viral Clips</div>
                  </td>
                </tr>
              </table>
              <p style="font-size:14px;line-height:1.55;color:#bdbdc4;margin:12px 0 0 0;">
                Drop in a podcast, lecture, or YouTube link. Klipra finds the moments people will actually share, cuts them into vertical clips, captions them, and gives you 6+ ready-to-publish shorts in minutes.
              </p>
              <ul style="margin:10px 0 0 18px;padding:0;font-size:13px;line-height:1.6;color:#d1d1d8;">
                <li>AI picks the most engaging segments using full transcript context</li>
                <li>Auto-vertical reframe with face tracking — no awkward crops</li>
                <li>Per-clip retrim, edit, hook overlay, dub, post — all in one place</li>
              </ul>
            </td></tr>
          </table>
        </td></tr>

        <!-- ===== PRODUCT 2 — AUTO SUBTITLE ===== -->
        <tr><td style="padding:8px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#16161a;border:1px solid #2a2a30;border-radius:14px;">
            <tr><td style="padding:18px 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:22px;line-height:1;padding-right:10px;vertical-align:middle;">📝</td>
                  <td style="vertical-align:middle;">
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#f59e0b;font-weight:700;">Product 2</div>
                    <div style="font-size:17px;font-weight:800;color:#ffffff;margin-top:2px;letter-spacing:-0.01em;">Auto Subtitle</div>
                  </td>
                </tr>
              </table>
              <p style="font-size:14px;line-height:1.55;color:#bdbdc4;margin:12px 0 0 0;">
                Burn accurate, styled subtitles into any video. AI generates a clean transcript with full-clip context, you edit any line, then style — font, colour, outline, vertical position. One click and it's burned in.
              </p>
              <ul style="margin:10px 0 0 18px;padding:0;font-size:13px;line-height:1.6;color:#d1d1d8;">
                <li>Original language, Roman / Latin transliteration, or full translation</li>
                <li>Per-segment editing — fix wrong words without re-running anything</li>
                <li>Word-by-word sync to actual audio, then export the .srt or burn the mp4</li>
              </ul>
            </td></tr>
          </table>
        </td></tr>

        <!-- ===== PRODUCT 3 — VOICE DUBBING ===== -->
        <tr><td style="padding:8px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#16161a;border:1px solid #2a2a30;border-radius:14px;">
            <tr><td style="padding:18px 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:22px;line-height:1;padding-right:10px;vertical-align:middle;">🎤</td>
                  <td style="vertical-align:middle;">
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#0ea5e9;font-weight:700;">Product 3</div>
                    <div style="font-size:17px;font-weight:800;color:#ffffff;margin-top:2px;letter-spacing:-0.01em;">Voice Dubbing</div>
                  </td>
                </tr>
              </table>
              <p style="font-size:14px;line-height:1.55;color:#bdbdc4;margin:12px 0 0 0;">
                Re-voice the whole video in 30+ languages. Same context-aware pipeline — transcribe, AI fixes mishears, translate, synthesize voice, mix back with your video. Free Microsoft Edge voices in 21 languages out of the box, or bring an ElevenLabs key for voice cloning.
              </p>
              <ul style="margin:10px 0 0 18px;padding:0;font-size:13px;line-height:1.6;color:#d1d1d8;">
                <li>21 free Edge TTS languages, or ElevenLabs voice cloning if you have a key</li>
                <li>Optional: keep your original voice underneath, documentary-style</li>
                <li>One-click "Add subtitles" so the dub ships with matching captions</li>
              </ul>
            </td></tr>
          </table>
        </td></tr>

        <!-- ===== QUICK WINS ===== -->
        <tr><td style="padding:24px 4px 8px 4px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;font-weight:700;margin-bottom:8px;">
            Three quick wins to start
          </div>
          <ol style="margin:0 0 0 18px;padding:0;font-size:14px;line-height:1.7;color:#d1d1d8;">
            <li>Paste a YouTube link in <strong style="color:#fff;">Generate Viral Clips</strong> and watch a 30-min video become 6+ shorts.</li>
            <li>Upload an interview, hit <strong style="color:#fff;">Auto Subtitle</strong>, fix any misheard words, burn it in.</li>
            <li>Take that subtitled clip, click <strong style="color:#fff;">Dub voice</strong>, pick a language — get a fully-localised version in minutes.</li>
          </ol>
        </td></tr>

        <!-- ===== CTA ===== -->
        <tr><td align="center" style="padding:28px 4px 12px 4px;">
          <a href="{app_url}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#10b981 0%,#0d9488 100%);color:#ffffff;text-decoration:none;border-radius:12px;font-weight:800;font-size:15px;letter-spacing:-0.01em;box-shadow:0 6px 20px rgba(16,185,129,0.25);">
            Open Klipra →
          </a>
          <p style="font-size:12px;line-height:1.55;color:#6b7280;margin:14px 0 0 0;">
            Free plan includes 5 jobs / month. No credit card required.
          </p>
        </td></tr>

        <!-- ===== FOOTER ===== -->
        <tr><td style="padding:36px 4px 0 4px;border-top:1px solid #1e1e22;margin-top:24px;">
          <p style="font-size:12px;line-height:1.55;color:#6b7280;text-align:center;margin:24px 0 6px 0;">
            You're receiving this because you just signed up for Klipra.<br>
            If that wasn't you, you can safely ignore this email.
          </p>
          <p style="font-size:11px;line-height:1.55;color:#52525b;text-align:center;margin:6px 0 0 0;">
            Klipra · Made with ❤ by ilmeaalim
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def _welcome_text(full_name: Optional[str], app_url: str) -> str:
    greeting = f"Hi {full_name.split()[0]}," if (full_name or "").strip() else "Hi there,"
    return f"""\
KLIPRA — Long videos to viral clips, on any AI

{greeting}

Welcome aboard! Thanks for signing up for Klipra — your one-stop
creator studio for turning long videos into share-ready content.
Whether you're posting daily shorts, captioning interviews, or going
global with a multi-language dub, you've got everything you need
below.


PRODUCT 1 — GENERATE VIRAL CLIPS

Drop in a podcast, lecture, or YouTube link. Klipra finds the moments
people will actually share, cuts them into vertical clips, captions
them, and gives you 6+ ready-to-publish shorts in minutes.
  - AI picks the most engaging segments using full transcript context
  - Auto-vertical reframe with face tracking — no awkward crops
  - Per-clip retrim, edit, hook overlay, dub, post — all in one place


PRODUCT 2 — AUTO SUBTITLE

Burn accurate, styled subtitles into any video. AI generates a clean
transcript, you edit any line, then style — font, colour, outline,
vertical position. One click and it's burned in.
  - Original language, Roman / Latin transliteration, or translation
  - Per-segment editing — fix wrong words without re-running anything
  - Word-by-word sync to actual audio; export .srt or burn the mp4


PRODUCT 3 — VOICE DUBBING

Re-voice the whole video in 30+ languages. Free Edge voices in 21
languages out of the box, or bring an ElevenLabs key for voice cloning.
  - 21 free Edge TTS languages or ElevenLabs voice cloning
  - Optional: keep your original voice underneath, documentary-style
  - One-click "Add subtitles" so the dub ships with matching captions


THREE QUICK WINS TO START

  1. Paste a YouTube link in Generate Viral Clips and watch a 30-min
     video become 6+ shorts.

  2. Upload an interview, hit Auto Subtitle, fix any misheard words,
     burn it in.

  3. Take that subtitled clip, click Dub voice, pick a language — get
     a fully-localised version in minutes.


Open Klipra: {app_url}

Free plan includes 5 jobs / month. No credit card required.

—
You're receiving this because you just signed up for Klipra. If that
wasn't you, you can safely ignore this email.

Klipra · Made with love by ilmeaalim
"""


def send_welcome_email(to_email: str, full_name: Optional[str] = None) -> None:
    """Fire-and-forget welcome email. Safe to call even when SMTP isn't
    configured — falls through to a logged no-op.
    """
    if not (to_email or "").strip():
        return
    app_url = (os.environ.get("KLIPRA_BASE_URL") or "http://localhost:5175").strip()
    send_in_background(
        to_email=to_email,
        subject="Welcome to Klipra 🎬",
        text_body=_welcome_text(full_name, app_url),
        html_body=_welcome_html(full_name, app_url),
    )
