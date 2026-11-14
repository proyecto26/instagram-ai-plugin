# The run folder and `remake.json` (ig.remake.v1)

```
<run>/
  remake.json            the record below
  source.mp4             copy of the source
  refs/identity.jpg      the identity photo
  shots/<id>/
    driving.mp4          the stretch sent to the model (cropped / reversed as asked; distinct frames only, at 24 fps, for 24-in-30 material)
    first_frame.jpg      the first frame the model sees
    attempt<N>.raw.mp4   exactly what ComfyUI returned
    attempt<N>.mp4       the same, in forward order and without guide frames
    placed.mp4           the chosen attempt fitted to the source frame
    scene.png            (continuation) last frame of the shot it continues
  timeline.mp4           the joined picture, silent
  final.mp4              the timeline with sound
  compare.mp4            source | remake
```

`remake.json`:

| Field | Meaning |
|---|---|
| `source` | file, sha256, size, frame rate, duration, whether it has audio, exact frame count, `cuts` (first frame of each shot) and whether they were measured or set by hand |
| `consent` | the user's statement and when it was given |
| `references[]` | id, role (`identity`), file, sha256 |
| `character` | the character card, when given |
| `shots[]` | one per regenerated stretch or continuation |
| `shots[].start/duration/crop/reversed` | what was sent to the model (swap) |
| `shots[].after` | the shot a continuation extends |
| `shots[].attempts[]` | number, time, every setting, graph hash, ComfyUI prompt id, status (`submitted`, `done`, `failed`, `unknown`), output file and its sha256, frame count, seconds taken, `keep`: the frames of the stretch sent to the model when only its distinct frames were sent, and `alignment`: the measured shift between the generated frames and the frames sent (0 is right) |
| `shots[].selected` | attempt chosen with `place --attempt` (default: the last finished one) |
| `shots[].placed` | file, sha256, area and feather used, attempt it came from, `cadence` (repeats the source does not have, longest run) |
| `shots[].approved` | when it was approved and the sha256 it was approved for |
| `timeline` | segments, file, sha256, duration |
| `audio` | `source` or `file` (with its sha256), start, the match result, where the sound was measured in the finished file, the stated basis |
| `final` | file, sha256, duration, time |

## Resuming

A later session needs only this file: `status <run>` lists each shot's state and what is next.

- `unknown` attempt: the command timed out or lost the connection. The job may still be running
  or finished in ComfyUI. Run the same command with `--resume <prompt-id>`.
- An approval is tied to the sha256 of `placed.mp4`; the file on disk is re-hashed before it is
  used. Placing again, a new attempt or choosing another attempt clears the approval, any
  continuation of that shot, the timeline and the final file.
- `remake.lock` exists while a command is working. A second command is refused; a lock left by a
  command that exited is replaced. (`remake.lock.guard` exists for a few milliseconds while the
  lock is taken or released.)
- A continuation records which attempt of the previous shot it continued (`afterAttempt`,
  `afterSha256`). If that shot is regenerated, regenerate the continuation too.
- Nothing is overwritten by a new attempt; choose between attempts with `place --attempt <n>`.

## Privacy

The run folder holds a person's photo and unpublished video. Keep it out of repositories and
shared drives, and delete it (and ComfyUI's `input/remake_*`, `output/video/remake_*`) when the
remake is finished, unless the user wants to keep it.
