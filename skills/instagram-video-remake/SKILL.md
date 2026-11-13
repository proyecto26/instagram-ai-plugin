---
name: instagram-video-remake
description: This skill should be used when the user asks to "remake this reel with another person", "replace the woman/man in this video", "swap the person in a clip", "put me (or someone) in this video", "recreate this video with a different character", "extend / continue this shot", or wants a new video that keeps the performance, camera, scene and bystanders of an existing one while changing who appears. Runs MiniMax H3 character swap and shot continuation in a local ComfyUI, puts the result back over the original, joins the timeline and keeps the music continuous. Local and free: no paid service, nothing published.
version: 0.1.0
---

# Instagram video remake

Remake a video the user is allowed to remake: replace ONE person with another (face, hair, body,
wardrobe), keep everything else, optionally continue a shot past its end, and deliver a finished
file with sound. Generation is MiniMax H3 in the user's own ComfyUI. Every step is a command of
`scripts/main.ts` and is recorded in `remake.json` (schema `ig.remake.v1`) inside the run folder.

```bash
npx -y bun scripts/main.ts --help      # run from this skill's folder
```

## Before anything: consent and scope

This edits a real person's likeness. Refuse to proceed, and say why, unless both hold:

- The person whose face is ADDED agreed to appear in this video. The user states it; `init`
  stores the statement (`--consent`). Do not invent it, and do not soften it into "it is public".
- The user may reuse the source video (their own, licensed, or a use they take responsibility for).

Never: remove clothing or sexualise beyond what the source shows, depict a minor, put words in
someone's mouth, or imitate a public figure to mislead. A faithful recast of an existing scene is
in scope; anything in that list is not, whatever consent is claimed.

The result is realistic AI video of a real person. Tell the user to label it as AI-generated
wherever they publish it (Instagram has an "AI label" setting; the `instagram` skill sets it with
`post reel --ai-label`), and to check the platform's current rules themselves. This skill never
publishes.

## What it needs

Run `doctor` first. It checks ffmpeg/ffprobe, the ComfyUI server (loopback only), the node classes
and the seven model files (about 45 GB). When something is missing, read `references/setup.md`:
it lists every file, its source and licence, and the one node pack to install. Ask before
downloading; state size and source. The kept runs used a 32 GB GPU; less memory is untested.

## The workflow

Read `references/workflow.md` once before the first remake: it has the decision rules, the
measured timings and the failures behind each rule. In short:

1. **Break the source down** with the `instagram-video-breakdown` skill (shots, who appears,
   where). Decide per shot: keep as is, swap, or continue.
2. **`init`** the run folder with the source, ONE identity photo and the consent statement.
   Use the same photo for every shot; identity drifts when references change.
3. **Write the prompt** from `references/prompts.md`: the same character card in every shot,
   plus that shot's framing, light and "keep the performance and everyone else".
4. **`swap`** each shot where the person appears. One stretch per run, up to 10 s.
   - Close or medium shot, person alone or clearly the largest: `--tier 768`, default detection.
   - Other people in frame: add `--point x,y` on the person, in source-frame pixels.
   - Small or distant person: `--crop w:h:x:y` around them (9:16, about 2-3x their height),
     `--tier 480`, `--point`, `--expand 32`. Only the crop is regenerated.
   - Person only clearly visible at the END of the stretch (camera arriving, something in front):
     add `--reverse`. Tracking starts where the person is clear; the result is flipped back.
   Each run prints the first frame the model sees. Look at it: the point must be on the person.
5. **`place`** each shot: a cropped shot is blended back inside its own area (outside it the
   picture is the original); a full-frame shot is fitted to the frame. The placed clip has exactly
   as many frames as the stretch it replaces. Then WATCH `placed.mp4` in motion.
6. **`approve`** what is good. Re-run `swap` with one thing changed for what is not (a new
   attempt; nothing is overwritten). `references/troubleshooting.md` maps each defect to a change.
7. **`continue`** when the user wants the shot to go on (the shot must be approved first):
   describe the movement in order, in the same tempo words as the shot; the last 25 frames of the
   shot are anchored automatically.
8. **`assemble`** the timeline from stretches of the source and placed shots, in order.
9. **`audio --rights "<basis>"`**: by default the source's own sound. If the remake is longer
   than the source, the music must carry on, never loop: give a longer recording of the same track
   (`--file`) and let `--match` find where the source's sound sits in it. `--rights` is always
   required: ask the user on what basis the video may be published with that sound, and write
   down their answer, not yours. "Review copy only, not for publication" is a valid answer.
10. **`compare`**, then have the user watch `final.mp4` with sound before anything is published.

Show the user frames and the comparison video at every review point; do not describe them.

## Commands

| Command | Does |
|---|---|
| `doctor` | checks tools, server, nodes, models |
| `init <run> --source --identity --consent [--character]` | creates the run folder |
| `swap <run> --shot --start --duration [...]` | regenerates one stretch with the person replaced |
| `continue <run> --shot --after --seconds --prompt` | extends a shot |
| `place <run> --shot [--attempt] [--feather]` | fits the generated clip to the source frame |
| `approve <run> --shot` | records that the placed shot was watched and accepted |
| `assemble <run> --segments "source:0-7.5,shot:far,..."` | joins the timeline |
| `audio <run> --rights [--file --match | --start]` | adds the sound, never looping |
| `audio-offset --clip --track` | finds a clip's sound inside a longer recording |
| `compare <run>` / `status <run>` | side-by-side video / what is done and what is next |

Generation takes minutes (about 45 s for a 2 s crop at 480, 4-5 min for 5 s at 768 on a 32 GB
GPU). If a command times out, the job keeps running: run the same command again with
`--resume <prompt-id>` (printed, and in `status`), or `--resume last` when no job id was ever
printed. Never submit the same shot twice to "retry".
One command at a time per run folder: a second one is refused while the first is working.

## Rules that came from failures

- One identity photo, one character card, every shot. Do not improve the prompt between shots.
- Never paste a generated face or body onto the original by hand; regenerate the shot.
- Do not hand-edit graphs; change a command option. The kept settings are in the code.
- Re-detecting a lost subject (`--recover`) is only for shots with one person: it can jump to
  someone else.
- A stretch is cut on whole frames. If a neighbouring shot shows up in the first frame, the
  stretch is one frame too long: shorten it.
- Changing a shot makes what was built on it out of date: its approval, any continuation of it,
  the timeline and the final file are cleared. Redo them; do not reuse an old `final.mp4`.
- Report honestly what was not checked. Tempo, lip sync and likeness are judged by the user's
  eyes and ears, not by a number.

## Additional resources

- **`references/workflow.md`** — decision rules per shot type, timings, what was tried and rejected.
- **`references/prompts.md`** — character card, shot card, swap and continuation prompt structure.
- **`references/setup.md`** — models (files, sources, sizes, licences), the node pack, ComfyUI.
- **`references/troubleshooting.md`** — each visible defect or error and the one change to try.
- **`references/manifest.md`** — the `ig.remake.v1` record and how to resume from it.
- **`assets/workflows/h3_swap.api.json`** — the character-swap graph (MIT, see its NOTICE).
