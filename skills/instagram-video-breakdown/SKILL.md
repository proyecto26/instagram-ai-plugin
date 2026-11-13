---
name: instagram-video-breakdown
description: Reverse-engineers an Instagram reel or any short video so a similar, original one can be made - downloads the video through the user's own web session (or takes a local file), measures cuts, pacing and audio with ffmpeg, extracts per-shot frames and timelines, optionally transcribes speech with the user's local model, and produces a shot list, on-screen text timeline, script, asset list and a per-shot production plan (film it, ComfyUI, code render, screen recording, ffmpeg). This skill should be used when the user asks to "break down this reel", "analyze this Instagram video", "how was this reel made", "recreate this reel", "make a video like this one", "extract the script / shots / captions from this reel", "reverse engineer this video", "turn this reel into a template", or pastes an instagram.com/reel/ or /p/ link and asks what makes it work or how to make their own version. Not for posting, and not for downloading a video to re-upload it.
---

# Instagram video breakdown

Turn one video into everything needed to make an original video in the same format: structure,
shot list, text timeline, script, pacing, assets and a production route per shot.

Scripts measure. You look at frames and describe. Nobody guesses: anything that was not observed
stays "unconfirmed". That rule is what makes the result trustworthy enough to produce from.

Run every command from this skill's directory:

```bash
npx -y bun scripts/main.ts <command>
```

Needs `ffmpeg` and `ffprobe` on PATH. Instagram links need a saved session (run `login` in the
`instagram` skill); local files need nothing else.

## Boundaries

- The goal is a new video in the same format. The downloaded video, its frames and its audio are
  reference only. Do not re-upload them, do not lift the audio track, and do not paste frames
  into the new video. If the user asks to download a reel and repost it, decline that part and
  offer the breakdown plus an original remake.
- Downloads stay in the output directory. Nothing is sent to any third-party service.
- Read-only towards Instagram: one media lookup and the CDN download. On `rate_limited`,
  `checkpoint`, HTTP 403/429 or a private/unavailable post, stop and report the message. Do not
  retry or work around it.
- One video per run.

## Workflow

### 1. Check the tools

```bash
npx -y bun scripts/main.ts doctor
```

If ffmpeg is missing, give the user the printed install command and stop. A missing speech
recogniser or `comfy` is fine: say what will be unavailable (script, generate routes).

### 2. Fetch

```bash
npx -y bun scripts/main.ts fetch "<instagram link | shortcode | id>" -o <dir>
npx -y bun scripts/main.ts fetch --file <video.mp4> -o <dir>
```

Use a new directory per video, in the user's project (not a temp dir). Instagram serves video at
about playback speed, so the download takes roughly as long as the video: give the command a
timeout of a few minutes and do not treat a slow download as a failure. A carousel answers with
its list of items: show it and re-run with `--item N` for the video the user means.

### 3. Analyze

```bash
npx -y bun scripts/main.ts analyze <dir>
```

Writes `breakdown.json` plus, per shot, `shots/shot_NNN_first.jpg`, `_last.jpg`, a 3-frame
sheet `shot_NNN.jpg` and a dense timeline `shot_NNN_strip.jpg` (2 frames per second, source
time under each tile), and `storyboard.jpg` for the whole video.

Open `storyboard.jpg` first. If the shot count looks wrong against it (animated transitions and
dissolves are easy to miss; fast action can add false cuts), fix it now:
`analyze <dir> --add-cut 5.1,9.4` or `--remove-cut 7.2`. Corrections are remembered.

### 4. Transcribe (when the video has speech)

The skill ships no speech model. Run the user's local one, or import a transcript:

```bash
npx -y bun scripts/main.ts transcribe <dir> --cmd "<python> scripts/recipes/asr_whisper.py {audio} {out} en"
npx -y bun scripts/main.ts transcribe <dir> --import captions.srt
```

`references/transcription.md` has the recipes and how to pick one. Without a transcript the
script is reported as unconfirmed; do not write spoken lines from what the captions seem to say.
Ask before downloading any model.

### 5. Review the frames

```bash
npx -y bun scripts/main.ts review <dir>
```

Read `review_tasks.json`, then open the images of every shot (first, last, sheet, strip) and
fill `review_answers.json`. For each shot:

- `type` from the taxonomy, a `confidence`, and `evidence`: what in the frames supports the
  type. Read `references/taxonomy.md` before typing shots; it lists the pairs that get confused.
- `description`, `camera`, `transition_in`.
- `on_screen_text`: every text with its role, position and start/end read from the strip
  timestamps. One item per distinct text state.
- `layers`: stickers, picture-in-picture, screenshots, logos. Anything composited over the base
  picture that is not text.

For the whole video: `hook` (what the first seconds show and promise), `structure` (sections
with times), `cast`, `visual_style`, `assets` (each marked `user_must_supply`, `can_generate` or
`reference_only`), `sound_cues`.

How to look:

- `text_change_candidates` mark moments where a band of the frame changed while the rest stood
  still. Check each one. A shot with no candidates can still have changing text (text over moving
  footage never triggers), so scan every strip.
- When a strip is too coarse to read or time something:
  `npx -y bun scripts/main.ts frames <dir> --from 3.0 --to 5.0 --fps 6`
- `low_motion: true` means the picture barely changes: probably a still or a hold. If you still
  type it as moving footage, say what moves in `motion_note`.
- If one detected shot contains two different shots, answer `{"id": N, "split_at": [t]}` for it;
  `apply-review` then prints the `analyze --add-cut` command to run before reviewing again.

Audio: you cannot hear it. `voice_present` and `music_present` stay `"unconfirmed"` unless there
is evidence: a transcript with speech (voice only), a file with no audio stream, or the user
telling you what they heard (`"source": "user_listened"` with their words in `note`). Tempo,
loudness and Instagram's audio credit are measurements and attributions, not proof of music. When
it matters for the remake, ask the user to listen and say whether there is music, a voice, and
any sound effects on the cuts or captions; record effects in `sound_cues`.

### 6. Apply and summarise

```bash
npx -y bun scripts/main.ts apply-review <dir>
npx -y bun scripts/main.ts summary <dir>
```

The answers are bound to the analysis they were written for (`analysis_id`): after any change of
cuts, run `review` again and answer from the new tasks. A new transcript clears the applied
review; run `apply-review` again.

`apply-review` validates everything and writes nothing on error: fix what it lists and run it
again. Warnings and downgrades are kept in the result; pass them on to the user rather than
hiding them. `summary` prints the breakdown and writes `recreate.md`.

### 7. Report and plan the remake

Follow `references/output-template.md`. Show the storyboard, lead with the hook and structure,
then the shot table, then what is unconfirmed, then the production plan. Read
`references/recreate-routes.md` to turn each shot into concrete steps with the tools the user
has (`doctor` says which). Adapt the format, not the content: new script, new footage, the
user's own subject. Offer to draft the new script to the same beat lengths
(`../instagram-content` has the hook and caption tools).

## Files

| File | Purpose |
|---|---|
| `breakdown.json` | Everything measured and reviewed (`ig.breakdown.v1`) |
| `source/meta.json` | Caption, hashtags, mentions, metrics, audio credit |
| `transcript.json` | Normalised transcript, when one exists |
| `review_tasks.json`, `review_answers.json` | The review contract |
| `recreate.md` | The production plan |

## References

- `references/taxonomy.md`: shot types, what evidence supports each, confusable pairs.
- `references/recreate-routes.md`: production route per shot type, tools and install notes.
- `references/transcription.md`: transcript formats, the command template, local model recipes.
- `references/output-template.md`: how to report the result.
