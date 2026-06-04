"""Subprocess wrapper around ClearVoice MossFormer2_SE_48K speech enhancement.

Run in its own interpreter so heavy torch imports never live in the API server
and a model crash can never take the server down.

Usage: python run_clearvoice.py <input.wav> <output.wav>
"""
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: run_clearvoice.py <in.wav> <out.wav>", file=sys.stderr)
        return 2
    in_path, out_path = sys.argv[1], sys.argv[2]

    from clearvoice import ClearVoice  # heavy import, kept local

    cv = ClearVoice(task="speech_enhancement", model_names=["MossFormer2_SE_48K"])
    wav = cv(input_path=in_path, online_write=False)
    cv.write(wav, output_path=out_path)

    # Some versions write into a directory; normalise to the requested file.
    out = Path(out_path)
    if not out.exists():
        cand = sorted(out.parent.glob("**/*.wav"))
        if cand:
            cand[0].replace(out)
    if not out.exists():
        print("clearvoice produced no output", file=sys.stderr)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
