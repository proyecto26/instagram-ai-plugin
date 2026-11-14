"""Speech-to-text recipe for `transcribe --cmd` using a Whisper model from the local Hugging Face cache.

    python asr_whisper.py <audio.wav> <out-path-without-extension> [language]

Writes <out>.json as {"language", "segments": [{start, end, text}], "words": [...]}.

Needs a Python that has `torch` and `transformers` (any environment you already use for ML,
for example a ComfyUI venv). Nothing is downloaded: the script runs offline and tells you the
command to fetch the model when it is not cached. Model: WHISPER_MODEL, default
openai/whisper-large-v3-turbo.
"""
import json
import os
import sys
import wave

# Forced, not defaulted: an inherited HF_HUB_OFFLINE=0 must not turn this into a download.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
MODEL = os.environ.get("WHISPER_MODEL", "openai/whisper-large-v3-turbo")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    audio, out = sys.argv[1], sys.argv[2]
    lang = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    try:
        import numpy as np
        import torch
        from transformers import pipeline
    except ImportError as e:
        print(f"This Python lacks {e.name}. Run the recipe with an interpreter that has torch and transformers.", file=sys.stderr)
        return 3

    with wave.open(audio, "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            print("Expected the 16-bit mono WAV that `analyze` writes to source/audio.wav.", file=sys.stderr)
            return 2
        rate = w.getframerate()
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0

    cuda = torch.cuda.is_available()
    try:
        asr = pipeline("automatic-speech-recognition", model=MODEL, device=0 if cuda else -1, torch_dtype=torch.float16 if cuda else torch.float32, model_kwargs={"local_files_only": True})
    except Exception as e:  # the model is not in the local cache
        print(f"Could not load {MODEL} offline ({type(e).__name__}). Download it once with:\n  hf download {MODEL}\nthen run this again.", file=sys.stderr)
        return 4

    kwargs = {"task": "transcribe"}
    if lang:
        kwargs["language"] = lang
    inp = {"raw": samples, "sampling_rate": rate}
    # Word timings are the reliable ones; sentence-level timestamps from this pipeline can
    # collapse several sentences into one short span, so segments are rebuilt from the words.
    result: dict = asr(dict(inp), return_timestamps="word", chunk_length_s=30, generate_kwargs=kwargs)  # type: ignore[assignment]
    words = []
    for c in result.get("chunks", []):
        start, end = c["timestamp"]
        text = c["text"].strip()
        if start is None or not text:
            continue
        words.append({"start": round(float(start), 3), "end": round(float(end if end is not None else start), 3), "text": text})
    segments = []
    cur = []
    for i, w in enumerate(words):
        cur.append(w)
        gap = words[i + 1]["start"] - w["end"] if i + 1 < len(words) else 99
        if w["text"][-1:] in ".?!" or gap > 0.7 or len(cur) >= 40:
            segments.append({"start": cur[0]["start"], "end": cur[-1]["end"], "text": " ".join(x["text"] for x in cur).replace(" -", "-")})
            cur = []

    with open(out + ".json", "w", encoding="utf-8") as f:
        json.dump({"language": lang, "model": MODEL, "segments": segments, "words": words}, f, ensure_ascii=False, indent=1)
    print(f"{len(segments)} segments, {len(words)} words -> {out}.json", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
