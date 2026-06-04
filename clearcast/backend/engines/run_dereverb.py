"""Dereverberation via WPE (Weighted Prediction Error, nara_wpe).

Single-channel late-reverberation suppression — removes the "speaking in a
hall" tail. soundfile I/O (no torchaudio). 48 kHz.

Usage: python run_dereverb.py <in.wav> <out.wav> [taps] [delay]
"""
import sys

import numpy as np
import soundfile as sf


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: run_dereverb.py <in.wav> <out.wav> [taps] [delay]", file=sys.stderr)
        return 2
    in_path, out_path = sys.argv[1], sys.argv[2]
    taps = int(sys.argv[3]) if len(sys.argv) > 3 else 24
    delay = int(sys.argv[4]) if len(sys.argv) > 4 else 3

    from nara_wpe.wpe import wpe
    from nara_wpe.utils import istft, stft

    y, sr = sf.read(in_path, dtype="float32", always_2d=True)
    y = y.mean(axis=1).astype(np.float64)  # mono

    size, shift = 1024, 256
    Y = stft(y[None], size=size, shift=shift)      # (D=1, T, F)
    Y = Y.transpose(2, 0, 1)                        # (F, D, T)
    Z = wpe(Y, taps=taps, delay=delay, iterations=3, statistics_mode="full")
    z = istft(Z.transpose(1, 2, 0), size=size, shift=shift)  # (D, samples)
    z = np.asarray(z)
    if z.ndim > 1:
        z = z[0]
    z = z[: len(y)]

    peak = float(np.max(np.abs(z))) if z.size else 0.0
    if peak > 1.0:
        z = z / peak * 0.99
    sf.write(out_path, z.astype(np.float32), sr)
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
