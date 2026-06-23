"""Dereverberation via WPE (Weighted Prediction Error, nara_wpe).

Single-channel late-reverberation suppression — removes the "speaking in a
hall" tail. soundfile I/O (no torchaudio). 48 kHz.

Usage: python run_dereverb.py <in.wav> <out.wav> [taps] [delay]
"""
import os
# Force NumPy and OpenBLAS to use exactly 1 thread per child process.
# This prevents CPU thread contention when running multiple processes in parallel.
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"

import sys
import numpy as np
import soundfile as sf
from concurrent.futures import ProcessPoolExecutor

def init_worker():
    # Pre-import in child processes to speed up execution start
    from nara_wpe.wpe import wpe
    from nara_wpe.utils import istft, stft

def process_single_chunk(args):
    idx, start, end, in_path, taps, delay = args
    # Read only the slice we need to avoid passing large arrays in arguments
    y, sr = sf.read(in_path, start=start, stop=end, dtype="float32", always_2d=True)
    y = y.mean(axis=1).astype(np.float32)  # mono
    
    from nara_wpe.wpe import wpe
    from nara_wpe.utils import istft, stft
    
    size, shift = 1024, 256
    Y = stft(y[None], size=size, shift=shift)      # (D=1, T, F)
    Y = Y.transpose(2, 0, 1)                        # (F, D, T)
    Z = wpe(Y, taps=taps, delay=delay, iterations=3, statistics_mode="full")
    z = istft(Z.transpose(1, 2, 0), size=size, shift=shift)  # (D, samples)
    z = np.asarray(z)
    if z.ndim > 1:
        z = z[0]
    return idx, z[:len(y)]

def main() -> int:
    if len(sys.argv) < 3:
        print("usage: run_dereverb.py <in.wav> <out.wav> [taps] [delay]", file=sys.stderr)
        return 2
    in_path, out_path = sys.argv[1], sys.argv[2]
    taps = int(sys.argv[3]) if len(sys.argv) > 3 else 24
    delay = int(sys.argv[4]) if len(sys.argv) > 4 else 3

    info = sf.info(in_path)
    sr = info.samplerate
    total_samples = info.frames
    two_mins = 2 * 60 * sr

    if total_samples <= two_mins:
        # Simple batch processing for small files
        y, sr = sf.read(in_path, dtype="float32", always_2d=True)
        y = y.mean(axis=1).astype(np.float32)
        
        from nara_wpe.wpe import wpe
        from nara_wpe.utils import istft, stft
        size, shift = 1024, 256
        Y = stft(y[None], size=size, shift=shift)      # (D=1, T, F)
        Y = Y.transpose(2, 0, 1)                        # (F, D, T)
        Z = wpe(Y, taps=taps, delay=delay, iterations=3, statistics_mode="full")
        z = istft(Z.transpose(1, 2, 0), size=size, shift=shift)
        z = np.asarray(z)
        if z.ndim > 1:
            z = z[0]
        z = z[:len(y)]
    else:
        # Chunk-based process-parallel mode for large files to avoid OOM and speed up
        chunk_size = 60 * sr
        overlap = 5 * sr
        step = chunk_size - overlap
        
        # Generate chunks
        chunks_indices = []
        start = 0
        while start < total_samples:
            end = min(start + chunk_size, total_samples)
            if total_samples - end < sr:
                end = total_samples
            chunks_indices.append((start, end))
            start += step
            if end == total_samples:
                break
                
        # Run WPE on chunks in parallel
        worker_args = []
        for i, (s, e) in enumerate(chunks_indices):
            worker_args.append((i, s, e, in_path, taps, delay))
            
        # Dynamically allocate workers based on core count (up to 4 performance cores)
        max_workers = min(4, os.cpu_count() or 4)
        
        with ProcessPoolExecutor(max_workers=max_workers, initializer=init_worker) as executor:
            results = list(executor.map(process_single_chunk, worker_args))
            
        results.sort(key=lambda x: x[0])
        
        # Stitch chunks together
        y, sr = sf.read(in_path, dtype="float32", always_2d=True)
        y = y.mean(axis=1).astype(np.float32)
        
        z = np.zeros_like(y, dtype=np.float32)
        w = np.linspace(0.0, 1.0, overlap)
        
        prev_overlap = None
        
        for i, (start, end) in enumerate(chunks_indices):
            _, z_chunk = results[i]
            L = len(z_chunk)
            
            if start == 0:
                if end == total_samples:
                    z = z_chunk
                else:
                    z[0 : end - overlap] = z_chunk[0 : end - overlap]
                    prev_overlap = z_chunk[end - overlap : end]
            else:
                blended = prev_overlap * (1.0 - w[:len(prev_overlap)]) + z_chunk[0 : len(prev_overlap)] * w[:len(prev_overlap)]
                z[start : start + len(prev_overlap)] = blended
                
                if end == total_samples:
                    z[start + len(prev_overlap) : end] = z_chunk[len(prev_overlap) : L]
                else:
                    z[start + len(prev_overlap) : end - overlap] = z_chunk[len(prev_overlap) : L - overlap]
                    prev_overlap = z_chunk[L - overlap : L]

    peak = float(np.max(np.abs(z))) if z.size else 0.0
    if peak > 1.0:
        z = z / peak * 0.99
    sf.write(out_path, z.astype(np.float32), sr)
    print("OK")
    return 0

if __name__ == "__main__":
    sys.exit(main())
