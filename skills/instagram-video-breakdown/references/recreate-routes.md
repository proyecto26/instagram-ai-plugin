# Recreate routes

`recreate.md` assigns each shot a route from its type. This file is how to carry a route out.
Routes are recommendations: never submit a paid generation, start a long render or install
anything without the user agreeing first.

The source frames are for composition, timing and style reference. Make new pictures; do not put
the source's frames or audio into the new video.

## What `doctor` tells you

| Tool | Needed for | If missing |
|---|---|---|
| `ffmpeg`, `ffprobe` | The breakdown itself, stills, pan/zoom, assembly, loudness | Stop: Windows `winget install Gyan.FFmpeg`, macOS `brew install ffmpeg`, Linux `sudo apt install ffmpeg` |
| `comfy` (ComfyUI CLI) | The generate routes | Optional: `pip install comfy-cli`, then `comfy install` for local or `comfy cloud login` for cloud. Or the user generates in another tool |
| A speech recogniser | The script | Optional: `references/transcription.md` |

## Routes

### `filmed`: film it
Give the user a shot card: duration, framing (from the first and last frames: subject size,
angle, headroom), light direction, what happens, and the on-screen text to leave room for.
Vertical 9:16, hold 1 s extra at both ends for the cut.

### `film_clip`: own or licensed footage
The original clip cannot be reused. Options: the user's own footage, licensed stock, or replace
the beat with a `filmed` or generated shot that plays the same role.

### `ai_video`, and `avatar` without a camera: generate
With ComfyUI (when the `comfy` skill is installed, load it; it covers discovery and running):

1. Make a start image of the user's own subject in the same composition (text-to-image or an
   edit of the user's photo). Never feed the source frame as the start image.
2. Image-to-video for the shot's duration. Motion prompt = how the scene moves, taken from
   `camera` and `description`, not what is in it.
3. Find what this install offers before choosing a model:
   `comfy --json templates ls --type video` and `comfy --json nodes ls --produces VIDEO`.
4. Paid partner nodes spend credits: state the cost question and get a yes before
   `--allow-spend`.

Generated clips come back off-spec. Probe each one and trim/scale to the shot length and
1080x1920 before assembly.

For a talking `avatar`, the mouth must be driven by the exact audio that will play. Record or
generate the voice first, then the avatar from that file.

### `render_3d`
Blender or the user's 3D tool; first and last frames give the camera start and end. A turntable
or a simple dolly covers most product shots.

### `animation_2d`, `code_render`: build it as a template
Rebuild from the text table: each `on_screen_text` and `layers` entry has role, position and
start/end. Any canvas/HTML renderer, After Effects template or a script that draws frames works.
Keep the timings; change the words, colours and brand.

### `screen_recording`
The user records their own screen doing the equivalent action, at the shot's duration. Record at
the device's native size and crop to 9:16.

### `still_pan_zoom`, `static_hold`: one image and ffmpeg

```bash
# hold a card for 2.5 s
ffmpeg -loop 1 -i card.png -t 2.5 -r 30 -pix_fmt yuv420p -vf scale=1080:1920 shot.mp4
# slow push-in over 3 s
ffmpeg -loop 1 -i image.jpg -vf "scale=2160:3840,zoompan=z='min(zoom+0.0012,1.15)':d=90:s=1080x1920:fps=30" -t 3 -pix_fmt yuv420p shot.mp4
```

## Text and layers

Burn text in the editor or with ffmpeg `drawtext` using `enable='between(t,START,END)'`. Keep
each text on screen at least as long as in the source: that duration was chosen for reading
speed.

## Audio

- Voice: the user records it, or generates it from their own script. Cut the picture to the
  voice, not the reverse.
- Music: the source's track cannot be extracted. When the video credits licensed music, the user
  can add that same track inside the Instagram app when posting. Otherwise pick or generate a
  track at the measured tempo (`audio.rhythm.bpm`) so the cuts can land on beats the same way.
- When `cuts_on_beat_ratio` is high, place cuts on beats: beat times for a tempo are
  `phase + n * 60/bpm`.

## Assembly

```bash
# shots.txt:  file 'shot_001.mp4'  (one line per shot, all 1080x1920, same fps)
ffmpeg -f concat -safe 0 -i shots.txt -c:v libx264 -pix_fmt yuv420p -r 30 silent.mp4
ffmpeg -i silent.mp4 -i audio.wav -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -shortest final.mp4
```

Check the result against the breakdown: same number of shots, each within a few frames of the
planned length, text timings in place. To post it, use the `instagram` skill (`post reel` is a
dry run until the user approves).
