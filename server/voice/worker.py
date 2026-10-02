"""Local speech-to-text worker for SketchUp Factory's mic button (server/voice.ts starts and stops it).

One process holds one faster-whisper model. It speaks JSON lines: stdin takes requests, stdout
gives replies; stderr is a log.

  start:    argv = --model <dir or name> --device auto|cuda|cpu [--compute-type ...] [--threads N]
  ready:    {"type": "ready", "device": "cuda", "computeType": "int8_float16", "loadSeconds": 1.9}
  request:  {"id": 1, "audio": "<base64 16-bit PCM WAV>", "prompt": "...", "language": "en"}
  reply:    {"id": 1, "text": "...", "audioSeconds": 12.3, "seconds": 0.8}  or  {"id": 1, "error": "..."}

The audio never touches the disk here. Closing stdin ends the process (and frees the VRAM).
"""

import argparse
import base64
import glob
import io
import json
import os
import site
import sys
import time
import wave


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def add_cuda_dlls():
    """The nvidia-*-cu12 wheels put cuBLAS/cuDNN DLLs in site-packages/nvidia/*/bin: make them loadable."""
    dirs = []
    for sp in site.getsitepackages():
        dirs += glob.glob(os.path.join(sp, "nvidia", "*", "bin")) + glob.glob(os.path.join(sp, "nvidia", "*", "lib"))
    for d in dirs:
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(d)
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])


def read_wav(data):
    """16-bit PCM WAV bytes -> mono float32 samples and their rate."""
    import numpy as np

    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2:
            raise ValueError("expected 16-bit PCM WAV")
        rate, channels = w.getframerate(), w.getnchannels()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm, rate


def resample(pcm, rate):
    """Whisper wants 16 kHz. The browser already sends 16 kHz; this only covers other callers."""
    import numpy as np

    if rate == 16000:
        return pcm
    n = int(round(len(pcm) * 16000 / rate))
    return np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)


def load(args):
    from faster_whisper import WhisperModel
    import numpy as np

    devices = ["cuda", "cpu"] if args.device == "auto" else [args.device]
    last = None
    for device in devices:
        compute = args.compute_type or ("int8_float16" if device == "cuda" else "int8")
        t0 = time.time()
        try:
            model = WhisperModel(args.model, device=device, compute_type=compute, cpu_threads=args.threads)
            # A missing cuDNN only shows at the first decode, so prove the device with a short one.
            list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en", beam_size=1)[0])
            return model, device, compute, time.time() - t0
        except Exception as e:  # noqa: BLE001 - any failure means: try the next device
            last = e
            log(f"could not load on {device}: {e}")
    raise RuntimeError(f"no device could load the model: {last}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--compute-type", default=None)
    p.add_argument("--threads", type=int, default=8)
    p.add_argument("--beam-size", type=int, default=5)
    args = p.parse_args()

    add_cuda_dlls()
    try:
        model, device, compute, secs = load(args)
    except Exception as e:  # noqa: BLE001
        reply({"type": "failed", "error": str(e)})
        return 1
    reply({"type": "ready", "device": device, "computeType": compute, "loadSeconds": round(secs, 2)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            pcm, rate = read_wav(base64.b64decode(req["audio"]))
            pcm = resample(pcm, rate)
            t0 = time.time()
            segments, _info = model.transcribe(
                pcm,
                language=req.get("language") or None,
                # hotwords go into every 30 s window's prompt; an initial_prompt only steers the first
                # one unless the previous text is carried too (which invites repetition loops).
                hotwords=req.get("prompt") or None,
                beam_size=args.beam_size,
                # Silence and breaths are where Whisper invents text ("Thank you."): cut them out first.
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 700},
                condition_on_previous_text=False,
                # Without timestamps a window's text that runs past its end is lost: a 45 s test clip
                # dropped a whole sentence at the 30 s boundary.
                without_timestamps=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            reply({"id": req_id, "text": text, "audioSeconds": round(len(pcm) / 16000, 2), "seconds": round(time.time() - t0, 3)})
        except Exception as e:  # noqa: BLE001 - one bad request must not end the worker
            reply({"id": req_id, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
