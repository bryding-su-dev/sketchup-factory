"""Local text-to-speech worker for SketchUp Factory's voice mode (server/voice.ts starts and stops it).

Kokoro-82M through onnxruntime, on the GPU (CUDA execution provider) when it loads, else the CPU.
JSON lines, like worker.py:

  start:    argv = --model <kokoro .onnx> --voices <voices .bin> --device auto|cuda|cpu
  ready:    {"type": "ready", "device": "cuda", "loadSeconds": 0.9, "voices": ["af_heart", ...]}
  request:  {"id": 1, "text": "...", "voice": "af_heart", "speed": 1.0}
  reply:    {"id": 1, "audio": "<base64 16-bit mono WAV>", "audioSeconds": 2.1, "seconds": 0.14}
"""

import argparse
import base64
import io
import json
import sys
import time
import wave


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def to_wav(samples, rate):
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def load(args):
    import onnxruntime as ort

    if args.device != "cpu" and hasattr(ort, "preload_dlls"):
        try:
            # The nvidia-* wheels (CUDA runtime, cuBLAS, cuDNN): load them before the session wants them.
            ort.preload_dlls()
        except Exception as e:  # noqa: BLE001
            log(f"preload_dlls: {e}")
    from kokoro_onnx import Kokoro

    so = ort.SessionOptions()
    so.log_severity_level = 3
    providers = ["CPUExecutionProvider"]
    if args.device != "cpu":
        # kSameAsRequested: grow the GPU arena only as needed (the Unity editors share this GPU).
        providers = [("CUDAExecutionProvider", {"arena_extend_strategy": "kSameAsRequested"})] + providers
    t0 = time.time()
    sess = ort.InferenceSession(args.model, so, providers=providers)
    device = "cuda" if "CUDAExecutionProvider" in sess.get_providers() else "cpu"
    if args.device == "cuda" and device != "cuda":
        raise RuntimeError("the CUDA execution provider did not load")
    kokoro = Kokoro.from_session(sess, args.voices)
    # First runs compile kernels; do it now rather than on the first reply.
    for _ in range(2):
        kokoro.create("Ready.", voice="af_heart", speed=1.0, lang="en-us")
    return kokoro, device, time.time() - t0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--voices", required=True)
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    args = p.parse_args()
    try:
        kokoro, device, secs = load(args)
    except Exception as e:  # noqa: BLE001
        reply({"type": "failed", "error": str(e)})
        return 1
    reply({"type": "ready", "device": device, "loadSeconds": round(secs, 2), "voices": sorted(kokoro.get_voices())})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            t0 = time.time()
            samples, rate = kokoro.create(req["text"], voice=req.get("voice") or "af_heart", speed=float(req.get("speed") or 1.0), lang=req.get("lang") or "en-us")
            reply({"id": req_id, "audio": base64.b64encode(to_wav(samples, rate)).decode("ascii"), "audioSeconds": round(len(samples) / rate, 2), "seconds": round(time.time() - t0, 3)})
        except Exception as e:  # noqa: BLE001
            reply({"id": req_id, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
