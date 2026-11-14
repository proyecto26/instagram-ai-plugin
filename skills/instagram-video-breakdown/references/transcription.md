# Transcription

The script of a video comes only from a transcript. This skill ships no speech model and never
downloads one; it runs the recogniser the user already has, or imports a transcript file.

## Pick one

1. **A transcript already exists** (captions exported from an editor, a `.srt` from any tool):
   `transcribe <dir> --import file.srt`. Accepts `.srt`, `.vtt` and JSON.
2. **A local model through a command**: `transcribe <dir> --cmd "<template>"`.
3. **Neither**: skip it. The breakdown still works; the script is reported as unconfirmed and
   the on-screen captions (read from frames) are listed as text, not as speech.

Ask the user before downloading a model: they are large.

## The command template

```
transcribe <dir> --cmd "<program> <args with {audio} and {out}>" [--lang es]
```

- `{audio}` becomes the path of `source/audio.wav` (16 kHz mono, written by `analyze`).
- `{out}` becomes a path *without extension*. The program must write `{out}.json`, `{out}.srt`,
  `{out}.vtt`, or exactly `{out}`.
- `{lang}` is optional and becomes the `--lang` value.
- The template is split into arguments first (spaces separate; single or double quotes group),
  then the placeholders are filled in, and the program is started without a shell. Paths with
  spaces are safe; pipes, `&&` and `$VAR` do not work.
- To avoid retyping it, set `IG_BREAKDOWN_ASR_CMD` to the template.

## JSON shapes accepted

```jsonc
{"language": "en", "segments": [{"start": 0.0, "end": 2.3, "text": "...", "speaker": "A"}],
 "words": [{"start": 0.0, "end": 0.4, "text": "Two"}]}          // this skill, openai-whisper
{"text": "...", "chunks": [{"timestamp": [0.0, 2.3], "text": "..."}]}   // transformers pipeline
{"transcription": [{"offsets": {"from": 0, "to": 2300}, "text": "..."}]} // whisper.cpp -oj
```

## Recipes

Status says whether the recipe was run with this skill, and where.

| Recipe | Size | Good for | Status |
|---|---|---|---|
| `openai/whisper-large-v3-turbo` with `scripts/recipes/asr_whisper.py` | about 1.6 GB | Default. 99 languages, word timings | Tested (Windows, CUDA, transformers 5.8): 44 s clip in about 35 s including model load |
| whisper.cpp | see its docs | No Python, CPU-friendly | Not tested here |
| `nvidia/parakeet-tdt-0.6b-v3` | see model card | Fast, European languages | Not tested here |
| `Qwen/Qwen3-ASR-1.7B` | see model card | Multilingual, noisy audio | Not tested here |
| `nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B` | 30 B parameters | High end: 40 languages; its model tags list timestamps and speaker diarization | Not tested here. Licence `openmdw-1.1` (read it before commercial use). Hardware needs not verified; expect a large GPU |

### Whisper through transformers (default)

Needs a Python that already has `torch` and `transformers` (a ComfyUI virtual environment
works). The recipe runs offline and prints the download command when the model is not cached.

```bash
npx -y bun scripts/main.ts transcribe <dir> \
  --cmd "/path/to/python scripts/recipes/asr_whisper.py {audio} {out} en"
```

Third argument is the language code; leave it out to auto-detect. `WHISPER_MODEL` selects
another Whisper checkpoint. Segments are built from word timings (sentence end or a pause over
0.7 s), which is more reliable than the pipeline's own sentence timestamps.

To fetch the model once, with the user's agreement: `hf download openai/whisper-large-v3-turbo`.

### whisper.cpp

```bash
transcribe <dir> --cmd "whisper-cli -m /models/ggml-large-v3-turbo.bin -f {audio} -oj -of {out}"
```

`-oj -of {out}` writes `{out}.json` in the `transcription[]` shape.

### Any other model

Write a small script that reads `{audio}` and writes one of the JSON shapes, then pass it with
`--cmd`. For a model that returns speakers, put them in `segments[].speaker`; they flow into the
script. Mark the recipe untested until it has produced a transcript.

## Reading the result

- Proper nouns and handles are often wrong (a made-up example: "Anna Lopes" for the handle `analopez`). Correct them from the
  caption and on-screen text when reporting, and say you did.
- An empty transcript means "no speech was transcribed". It does not prove the video has no
  voice: quiet speech under music gets missed. Voice absence needs the user's ear.
- Music with lyrics may be transcribed as speech. If the "script" reads like a song, say so and
  ask.
