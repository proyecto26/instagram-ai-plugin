# Troubleshooting: one defect, one change

Change one thing per attempt, on the same shot id (each run is a new attempt; `place --attempt n`
picks which one is used). Look at `shots/<id>/first_frame.jpg` first: most swap failures are a
selection problem visible there.

## Errors

| Message | Cause | Change |
|---|---|---|
| `SAM lost the selected person at frames [1, 2, ...]` (from the first frames) | the point or word did not land on the person in the first frame the model sees | open `first_frame.jpg`; fix `--point`; if the frame belongs to a different shot, the stretch is wrong by a frame: adjust `--start` / `--duration` |
| `SAM lost the selected person at frames [40, 41, ...]` (later frames) | the person is hidden or leaves the frame part-way | shorten the stretch to where they are visible; or `--reverse` if they are clear at the end; `--recover` only when they are the only person |
| `Required input is missing` / `Value not in list` from ComfyUI | node pack or ComfyUI version differs from the one the graph was written for | run `doctor`; update ComfyUI; reinstall the node pack at the pinned commit (`setup.md`) |
| `ComfyUI did not answer` | server not running or another port | start ComfyUI; `--comfy-url` |
| `still running after N s ... --resume <id>` | generation slower than `--timeout` | `swap <run> --shot <id> --resume <prompt-id>` (or `continue ...`); nothing is prepared or submitted again |
| `Another command is working on this remake` | a generation is still running in another terminal | wait for it; one command at a time per run folder |
| `is out of date: it continues an earlier version of shot ...` | the shot was regenerated or another attempt chosen after the continuation was made | run `continue` again |
| `is not in ComfyUI's queue or in the history it still keeps` (after `--resume last`) | the submission never arrived, or ComfyUI's history was cleared | look for `remake_<shot>_<n>_*` in ComfyUI's output folder; if the job is known, `--resume <prompt-id>`; only if there is nothing, run the command again |
| `The run folder is busy (...remake.lock.guard...)` | a command died in the middle of taking the lock | check nothing is running, delete that folder |
| `The answer to the submission was lost and the job cannot be found` | unknown whether ComfyUI took the job | `--resume last` on that shot: it looks the job up again and collects it, or says it is not in the queue or retained history (see the next row) |
| out-of-memory in the ComfyUI log | not enough GPU memory for the tier | `--tier 480`; close other GPU programs |
| `The audio is too short` | the timeline is longer than the audio from that start | a longer recording with `--file`; it is never looped |
| `Could not place the source's sound inside that recording` | different version, speed or mix of the track | find the position by ear and pass `--start` |

## What is seen in the result

| Seen | Likely cause | Change |
|---|---|---|
| The original person is still there, only slightly changed (distant shot) | too few pixels on the person | `--crop` around them, `--tier 480` |
| A different person in the frame was replaced | detection picked the wrong one | `--point` on the right one |
| The whole scene was redrawn (new background) | the clip sent was not the intended one, or the mask covered the frame | check `first_frame.jpg` and the stretch; lower `--expand` |
| A halo or ghost of the original around the new person | mask too tight | raise `--expand` (64 → 96) |
| Neighbours or objects next to the person changed | mask too wide | lower `--expand` (64 → 32) |
| Original visible for the first frames, then replaced | person not trackable at the start | `--reverse` |
| The face is not the person in the photo | photo too small, lit from the side, or face partly hidden; or prompt describes someone else | a clearer photo (then redo ALL shots with it); make the character card match the photo |
| Wardrobe differs between shots | the card or the photo changed between shots | same photo, same card sentence |
| The new person looks pasted in, flat light | prompt does not state the light | add the light line of the shot card |
| A visible rectangle around a placed crop | the crop edge crosses something bright or moving | move or enlarge `--crop`; raise `--feather` (12 → 24) |
| The person looks a little larger or smaller than neighbours (distant shot) | crop too tight, the model had no scale reference | a larger crop that includes neighbours |
| Hands or arms cut off | crop too tight for the gesture | a larger crop |
| Continuation moves faster or slower than the shot | tempo not stated, or too many actions | state the tempo twice; fewer actions; keep 25 guide frames |
| Continuation jumps at the join | wrong attempt of the previous shot was continued, or the previous shot was re-placed | continue from the approved attempt; regenerate the continuation after any change to the shot before it |
| Continuation changes framing or background | camera line missing | "static camera, same framing"; shorter `--seconds` |
| Sound repeats | audio was looped by hand somewhere | use `audio --file ... --match` |
| Stutter after placing | 24 fps material shown at 30 fps | expected and usually invisible; if it shows on fast motion, deliver the remake at 24 fps |

## When to stop

Three attempts on one shot without improvement means the approach for that shot is wrong, not the
seed. Step back: a different crop, splitting the shot, or keeping the original shot and changing
the edit so the person is not seen there. Say so to the user instead of running more seeds.
