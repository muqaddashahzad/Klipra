"""DeepFilterNet denoiser via its Python API.

We do file I/O with soundfile (NOT torchaudio) to avoid the torchaudio>=2.9
torchcodec dependency. DeepFilterNet runs at 48 kHz.

Usage: python run_deepfilter.py <in.wav> <out.wav>
"""
import sys
import types

import soundfile as sf
import torch


def _shim_torchaudio_backend() -> None:
    """DeepFilterNet 0.5.x imports torchaudio.backend.common.AudioMetaData,
    removed in torchaudio>=2.9. Provide a stub so df imports cleanly. We never
    use df's torchaudio file I/O (we pass tensors), so a stub is sufficient."""
    import torchaudio  # noqa: F401
    try:
        from torchaudio.backend.common import AudioMetaData  # noqa: F401
        return
    except Exception:
        pass
    backend = types.ModuleType("torchaudio.backend")
    common = types.ModuleType("torchaudio.backend.common")

    class AudioMetaData:  # minimal stand-in
        def __init__(self, sample_rate=0, num_frames=0, num_channels=0,
                     bits_per_sample=0, encoding="PCM_S"):
            self.sample_rate = sample_rate
            self.num_frames = num_frames
            self.num_channels = num_channels
            self.bits_per_sample = bits_per_sample
            self.encoding = encoding

    common.AudioMetaData = AudioMetaData
    backend.common = common
    sys.modules["torchaudio.backend"] = backend
    sys.modules["torchaudio.backend.common"] = common


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: run_deepfilter.py <in.wav> <out.wav>", file=sys.stderr)
        return 2
    in_path, out_path = sys.argv[1], sys.argv[2]

    _shim_torchaudio_backend()
    from df.enhance import enhance, init_df  # heavy import kept local

    model, df_state, _ = init_df()  # downloads the model on first run
    target_sr = df_state.sr()       # 48000

    audio, sr = sf.read(in_path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)      # mono
    t = torch.from_numpy(audio).unsqueeze(0)  # [1, T]

    if sr != target_sr:
        import torchaudio.functional as AF  # functional = pure torch, no file I/O
        t = AF.resample(t, sr, target_sr)

    out = enhance(model, df_state, t)           # [1, T] enhanced
    sf.write(out_path, out.squeeze(0).cpu().numpy(), target_sr)
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
