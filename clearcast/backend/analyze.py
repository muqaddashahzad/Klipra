"""Diagnose a voice recording — detect which problems it actually has so the
pipeline can apply only the fixes that are needed (adaptive, per-file).

Runs on the decoded 48 kHz mono wav. Pure numpy/scipy/soundfile (light).

Returns:
    {
      "metrics": {...},                # raw numbers
      "issues":  [ {id,label,severity,detail}, ... ],   # human-facing
      "fixes":   ["declip","denoise","dereverb",...],    # ordered fix ids
      "deess":   0.0-1.0,              # how hard to de-ess in the master
      "hum_freq": 50|60|None,
    }
"""
from __future__ import annotations

import numpy as np
import soundfile as sf

# thresholds (tuned on real recordings)
SNR_NOISY = 24.0        # speech-noise dynamic range below this => noisy
CLARITY_REVERB = -2.8   # modulation clarity below this => reverberant
CLIP_FRAC = 0.0005      # >0.05% samples near full-scale => clipping
HUM_DB = 10.0           # mains line >10 dB above neighbours => hum
SIB_DB = 4.0            # sibilant band this much above mid band => harsh sibilance
QUIET_DBFS = -30.0      # speech level below this => too quiet

# Per-issue: what the app does about it, and how the user can avoid it next time.
ADVICE = {
    "noise": (
        "Removed the background noise with AI (MossFormer2 + DeepFilterNet).",
        "Record in a quieter room and get closer to the mic — or point a cardioid mic away from noise sources (fans, AC, traffic)."),
    "reverb": (
        "Removed the room echo with WPE de-reverb plus a voice-restoration pass.",
        "Record in a smaller or soft room (rugs, curtains, a closet of clothes), and get closer to the mic — distance is what creates the 'hall' echo."),
    "clipping": (
        "Repaired the clipped, distorted peaks.",
        "Lower your recording input/gain so loud moments don't hit the maximum — aim for peaks around −6 dB."),
    "hum": (
        "Notched out the electrical mains hum and its harmonics.",
        "Try a different power outlet, keep audio cables away from power cables, or add a ground-loop isolator."),
    "sibilance": (
        "Tamed the harsh ‘s’/‘sh’ sounds with a de-esser.",
        "Angle the mic slightly off to the side of your mouth and add a pop filter."),
    "quiet": (
        "Boosted the level to broadcast loudness.",
        "Increase your input gain or move closer to the mic while recording."),
}


def _windowed_rms_db(x, sr, win=0.05):
    w = max(1, int(win * sr)); n = len(x) // w
    if n < 2:
        return np.array([20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)])
    rms = np.sqrt((x[:n * w].reshape(n, w) ** 2).mean(1) + 1e-12)
    return 20 * np.log10(rms + 1e-12)


def _clarity(x, sr):
    """Syllabic (3-8 Hz) vs slow (<2 Hz) envelope-modulation ratio in dB.
    Reverberation smears the envelope and lowers this."""
    fr = max(1, int(sr * 0.01)); n = len(x) // fr
    if n < 8:
        return 0.0
    env = np.sqrt((x[:n * fr].reshape(n, fr) ** 2).mean(1) + 1e-9)
    esr = sr / fr
    e = env - env.mean()
    E = np.abs(np.fft.rfft(e * np.hanning(len(e)))) ** 2
    f = np.fft.rfftfreq(len(e), 1 / esr)
    syl = E[(f >= 3) & (f <= 8)].sum()
    slow = E[(f > 0) & (f < 2)].sum()
    return float(10 * np.log10(syl / (slow + 1e-12) + 1e-12))


def _band_energy(X, f, lo, hi):
    m = (f >= lo) & (f < hi)
    return float(X[m].sum()) if m.any() else 0.0


def analyze(wav_path: str) -> dict:
    x, sr = sf.read(wav_path, dtype="float32", always_2d=True)
    x = x.mean(axis=1).astype(np.float64)
    if x.size == 0:
        return {"metrics": {}, "issues": [], "fixes": [], "deess": 0.0, "hum_freq": None}

    peak = float(np.max(np.abs(x)))
    clip_frac = float(np.mean(np.abs(x) > 0.985))

    db = _windowed_rms_db(x, sr)
    noise = float(np.percentile(db, 10))
    speech = float(np.percentile(db, 90))
    snr = speech - noise

    clarity = _clarity(x, sr)

    # spectrum for hum + sibilance
    X = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / sr)

    def line_db(f0):
        # energy in a narrow band around the mains line vs a wider neighbourhood
        line = _band_energy(X, f, f0 - 2, f0 + 2)
        neigh = _band_energy(X, f, f0 - 25, f0 + 25) - line
        return 10 * np.log10((line + 1e-12) / (neigh / 12 + 1e-12) + 1e-12)
    hum50 = max(line_db(50), line_db(100), line_db(150))
    hum60 = max(line_db(60), line_db(120), line_db(180))
    hum_db = max(hum50, hum60)
    hum_freq = 50 if hum50 >= hum60 else 60

    mid = _band_energy(X, f, 1500, 4000)
    sib = _band_energy(X, f, 5500, 9000)
    sib_db = 10 * np.log10((sib + 1e-12) / (mid + 1e-12) + 1e-12)

    metrics = {
        "sr": sr, "duration": round(len(x) / sr, 2), "peak": round(peak, 4),
        "clip_frac": round(clip_frac, 5), "noise_floor_db": round(noise, 1),
        "speech_db": round(speech, 1), "snr_db": round(snr, 1),
        "clarity": round(clarity, 2), "hum_db": round(hum_db, 1),
        "sibilance_db": round(sib_db, 1),
    }

    issues, fixes = [], []

    if clip_frac > CLIP_FRAC:
        sev = "high" if clip_frac > 0.01 else "medium"
        issues.append({"id": "clipping", "label": "Clipping / distortion", "severity": sev,
                       "detail": f"{clip_frac*100:.2f}% of samples are clipped"})
        fixes.append("declip")

    if hum_db > HUM_DB:
        issues.append({"id": "hum", "label": f"{hum_freq} Hz electrical hum", "severity": "medium",
                       "detail": f"mains line {hum_db:.0f} dB above surroundings"})
        fixes.append("dehum")

    if snr < SNR_NOISY:
        sev = "high" if snr < 16 else "medium"
        issues.append({"id": "noise", "label": "Background noise", "severity": sev,
                       "detail": f"only {snr:.0f} dB speech-to-noise"})
        fixes.append("denoise")

    if clarity < CLARITY_REVERB:
        sev = "high" if clarity < -3.3 else "medium"
        issues.append({"id": "reverb", "label": "Room echo / reverb", "severity": sev,
                       "detail": "voice sounds distant / hall-like"})
        fixes.append("dereverb")

    deess = 0.0
    if sib_db > SIB_DB:
        deess = float(np.clip((sib_db - SIB_DB) / 6.0, 0.3, 1.0))
        issues.append({"id": "sibilance", "label": "Harsh sibilance", "severity": "low",
                       "detail": "strong 's'/'sh' energy"})

    if speech < QUIET_DBFS:
        issues.append({"id": "quiet", "label": "Low level", "severity": "low",
                       "detail": f"speech peaks near {speech:.0f} dBFS"})

    for it in issues:
        fx, tp = ADVICE.get(it["id"], ("", ""))
        it["fix"], it["tip"] = fx, tp

    return {"metrics": metrics, "issues": issues, "fixes": fixes,
            "deess": deess, "hum_freq": hum_freq if hum_db > HUM_DB else None}


if __name__ == "__main__":
    import json
    import sys
    print(json.dumps(analyze(sys.argv[1]), indent=2))
