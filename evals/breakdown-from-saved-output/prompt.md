---
description: A saved reel breakdown should be reported through instagram-video-breakdown without inventing the script or the audio, and turned into a plan for an original video.
tags: [video-breakdown]
max_turns: 20
allowed_tools: [Read, Glob, Grep, Skill]
---

I ran the plugin's video breakdown on a reel from an account in my niche. This is the `summary` output. I sell Notion templates; tell me how this reel is built and give me a plan to make my own version of it.

```
@studio_lena https://www.instagram.com/reel/Cxyz987/
21.40s, 1080x1920, 30 fps, 5 shots, median shot 4.10s, 1.87 cuts per 10s
Audio (measured): -13.9 LUFS, silence 2%, 118.2 BPM (strength 4.6, 75% of cuts on a beat)
Instagram credits: original audio "Original audio" by studio_lena (an attribution, not proof of what is audible)
Voice: unconfirmed. Music: unconfirmed.

HOOK: Close-up of a messy desk; a title asks "Still pricing by the hour?"
STYLE: warm daylight, hand-held phone footage, bold white captions with a yellow highlight word

STRUCTURE
  0.00-2.30  hook: question card over the desk
  2.30-14.80  steps: three steps, one shot each
  14.80-21.40  cta: result on screen, then follow prompt

SHOTS
   1  0.00-2.30  filmed (0.85)  Hand-held close-up of a cluttered desk, slow push-in
        text 0.00-2.30 [title, center] "Still pricing by the hour?"
   2  2.30-6.40  screen_recording (0.9)  Spreadsheet with an hourly rate column being deleted
        text 2.30-4.20 [caption, bottom] "Step 1"
        text 4.20-6.40 [caption, bottom] "Delete the hours column"
   3  6.40-10.50  filmed (0.8)  Creator at the desk talking to camera, medium shot
        text 6.40-10.50 [caption, bottom] "Step 2: price the outcome"
        layer 7.00-10.50 [picture_in_picture] small screenshot of a proposal in the top right
   4  10.50-14.80  code_render (0.55)  Three price cards animate in on a flat beige background
        text 10.50-14.80 [label, center] "Good / Better / Best"
   5  14.80-21.40  static_hold (0.9)  End card with the account handle
        text 14.80-21.40 [title, center] "Follow for part 2"

SCRIPT
  unconfirmed: no transcript. Run `transcribe` (see references/transcription.md).

NOTES
  - shot 4: typed "code_render" with confidence 0.55
  - music_present: true -> "unconfirmed" (audio_notes.evidence.music.source must be one of transcript, user_listened, no_audio_stream; tempo, loudness and Instagram's audio attribution are not evidence)
```
