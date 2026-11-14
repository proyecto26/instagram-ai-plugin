# The remake workflow, step by step

What worked, in the order it is done, with the reason behind each rule. The numbers are from one
production (a 15 s vertical reel, 720x1280 at 30 fps, three shots; an RTX 5090 with 32 GB). Treat
them as starting points, not constants.

## 0. What the method is

MiniMax H3 with the character-swap LoRA regenerates a clip from three things: the clip itself (the
"driving" video: motion, camera, timing, sound), a mask of the person to replace (SAM 3 detects
and tracks them), and ONE photo of the new person. Outside the mask the model is told to keep the
source. It is not a face paste: body, hair and clothes are regenerated together, which is why the
result holds together where face swaps and manual compositing did not.

Tried first and rejected, so they are not rediscovered:

| Tried | Why it was dropped |
|---|---|
| Pose-driven full regeneration (SCAIL-style) | re-framed the subject, lost the scene and the bystanders |
| Pasting a generated face/body over the original with tracked masks | ghost outline of the original, clipped arms, size jumps between frames |
| A second "performer" clip to drive a new movement | broke identity and lighting continuity |
| Continuing a shot from one still frame | the pose carried over, the speed did not: the dance doubled its tempo |
| Feeding the music to the continuation as an audio guide | movement got faster, not better synchronised |
| Looping the clip's own audio under an extension | audible repeat; the user heard it at once |

## 1. Break the source down

Use the `instagram-video-breakdown` skill: it gives shot boundaries, who is in each shot and how
large. From it, decide per shot: **keep** (the person is not in it), **swap**, or **continue**
(extend the last swapped shot). Write the plan down before generating; each generation is minutes.

Cut times from the breakdown are approximate to a frame or two, and one frame is enough to show
the original person at a cut. `init` measures the cuts from the picture (a jump in the frame
difference far above its neighbours) and `scenes <run>` lists every shot as an exact frame range.
Check that list against the breakdown; a strobe or a whip pan can be taken for a cut, a dissolve can
be missed: correct it with `scenes <run> --set <first frame of each shot,...>`. Plan every swap as
`--scene <n>`. The first frame the model sees is saved as `shots/<id>/first_frame.jpg` on every
run: check that it belongs to the right shot.

## 2. One identity, stated consent

`init <run> --source <video> --identity <photo> --consent "<statement>"`.

- One photo: front or three-quarter view, face unobstructed, the wardrobe wanted in the remake
  visible, even light. The wardrobe in the photo is what the model dresses the person in.
- The same photo for every shot. Changing reference between shots changed the face.
- `--character` stores the character card (see `prompts.md`) so every prompt repeats it.

## 3. Swap: which options for which shot

Every swap is `swap <run> --shot <id> --scene <n>` (the whole shot, cut to cut) or
`--scene <n> --start <s>` (from a later point, still ending on the cut), plus:

| Shot | Options | Kept run |
|---|---|---|
| Close or medium, the person is the largest thing in frame | `--tier 768` (defaults: detect "person", largest, mask growth 64) | 4.9 s in 4 min 23 s |
| Same, quick look first | `--tier 480` | 4.9 s in 2 min 6 s |
| Other people in frame, person is not the largest | add `--point x,y` | |
| Person small or far away (under about a fifth of the frame height) | `--crop w:h:x:y --tier 480 --point x,y --expand 32` | 2.3 s in 45 s |
| Person hidden at the start of the stretch, clear at the end | add `--reverse` | |

Why each one:

- **Tier.** 768 works at 736x1344, 480 at 512x928 (for a 9:16 source). 768 is for faces that
  fill the frame; for a small subject it only costs time.
- **Point instead of text.** With several people the detector's "largest person" is not the one
  wanted. One click on the first frame the model sees selects exactly one person and removes the
  text detection that competed with it.
- **Crop.** A distant person is a few dozen pixels tall: the model cannot draw a face there, and
  the result was still the original person. Cropping a 9:16 window around them (about 2-3 times
  their height, so the mask and some scene fit) gives the model pixels to work with. Only that
  window is regenerated; `place` blends it back and everything outside is untouched.
- **Mask growth 32 for a crop.** At that scale 64 px of growth swallowed neighbours.
- **Reverse.** Tracking starts on the first frame. When the camera is still arriving, or someone
  is in front of the subject at the start, the tracker loses them ("SAM lost the selected
  person") or the original stays visible for the first frames. Running the stretch backwards
  starts tracking where the subject is clearest; the result is flipped back automatically.
- **Recover off.** Re-detecting on lost frames can lock onto a different person. Turn it on
  (`--recover`) only when the shot has a single person.

Limits: one person replaced per run, up to 10 s per stretch. Split longer shots at a cut.

**Stretches end on cuts.** A stretch that stops 1-8 frames before a cut, or starts 1-8 frames
after one, is refused: the leftover frames show the original person, and filling them with the
source puts a flash of the original person (one or two frames) right at the cut, which viewers do notice.
`--leave-original` accepts it when those frames really do not show the person. A stretch that
crosses a cut is refused too: the tracker and the model would see the jump.

**Frame rhythm.** The model works at 24 fps. Many reels are 24 fps material carried at 30 fps: one
frame in five repeats the one before. `swap` measures that and sends the model only the distinct
frames (at 24 fps, so nothing is resampled); `place` shows each generated frame where its source
frame was and repeats it where the source repeats. Without this, the model's own 30->24 resampling
can keep the repeats and drop real frames (which ones depends on the phase, and `--reverse` flips
it): a shot can come back with about 18 distinct images per second and, put back at 30 fps, stall
for two frames out of every five while the rest of the picture moves smoothly. Material that is not
24-in-30 (real 30 fps, 25 fps, 60 fps) is sent as it is and resampled by the model. The detection is
measured on the picture: very slow or nearly still stretches may not show their repeats, in which case
everything is sent as before. Sources with a variable frame rate (many phone recordings) are refused
at `init`, with the command to convert them: frame numbers and times would not agree.

## 4. Place, watch, approve

`place <run> --shot <id>` writes `shots/<id>/placed.mp4` at the source size and frame rate
(the model outputs 24 fps; frames are repeated to match, where the source repeats them when only
distinct frames were sent).

- Cropped shot: the generated clip is scaled into the part of the crop it covers and blended with
  a feather that lies inside that area (`--feather`, default 12 px). Outside it the picture is the
  original, re-encoded at high quality (visually the same, not bit-identical).
- The placed clip always has exactly the frame count of the stretch it replaces; when the 24 fps
  material comes up a frame short, the last frame is held.
- When only distinct frames were sent, `place` refuses an attempt that came back with a different
  number of frames, and `swap` measures how the returned frames line up with the frames sent (outside
  the person the model keeps the picture it was given); `place` refuses an attempt clearly shifted.
  The node pack counts floor(seconds x 24) frames, so asking for N frames as exactly N/24 s written
  with five decimals can lose the last frame the model sees: for a reversed stretch that is the first
  one in playing order, and every generated frame would land one frame early. The length is asked
  with a little margin. When the measurement cannot decide (for example a person filling the frame),
  it does not block: watch for it.
- `place` reports `cadence`: frames inside the replaced area that stand still while the source moves,
  and the longest run of them. More than two, or two in a row, usually read as jerky motion and it
  warns. It is a measurement, not a verdict: watching the shot is still what decides.
- Full-frame shot: scaled to cover the frame.

Then watch it in motion, at full size, at least twice: once for the person (face, hair, arms,
hands, dress), once for everything else (bystanders, edges of the placed area, light). A contact
sheet hides flicker and jumps. `approve` records the decision against that exact file; placing
again clears it.

## 5. Continue a shot

`continue <run> --shot <id> --after <shot> --seconds <s> --prompt "<...>"`

- The shot being continued must be approved: the continuation is built on that exact version,
  and is marked out of date if the shot is regenerated or another attempt is chosen.
- The scene reference is the last frame of the shot being continued; the identity photo is the
  same one. The last 25 frames (about one second) of that shot are anchored at the start of the
  generation, so the movement carries its speed over. Those frames are removed from the result by
  this command, once: `--seconds` is the NEW material.
- No character-swap LoRA here: this is plain reference-to-video with the 8-step LoRA.
- The prompt says the shot continues without a cut, repeats the character card and the framing,
  and then lists the movement in order (see `prompts.md`). Use the tempo words of the shot.
- In the kept run this combination (25 guide frames, tempo stated in the prompt, about 5.4 s of
  new material) held the tempo where a single-frame start had doubled it. It is one result, not a
  proven rule: judge the tempo by watching, and change one thing at a time.

Only a full-frame shot can be continued.

## 6. Assemble

`assemble <run> --segments "source:0-7.8,shot:far,shot:close,shot:more"`

Segments are stretches of the source (`source:<start>-<end>`, seconds) and placed shots
(`shot:<id>`), in playing order. A swapped shot replaces its own stretch: do not also list that
stretch as source. Unapproved shots are refused unless `--allow-unapproved` (a draft).

`assemble` checks every source stretch against the shots of the source: 8 frames or fewer taken
from a shot in which the person is replaced are refused (a flash of the original person at a cut),
longer ones are listed so you can check the person is not visible there (a camera approach where
the person is a few pixels in a crowd is often kept as source, and that is fine).
When the timeline reports a gap between two shots, the fix is a stretch that reaches the cut, not
a few frames of the source.

## 7. Audio

`--rights "<basis>"` is required every time: the user's own statement of why the video may be
published with this sound. The sound of someone else's reel is usually not theirs to republish;
"review copy only, not for publication" is a valid basis for a draft.

- Remake no longer than the source: `audio <run> --rights "..."` reuses the source's sound, in
  sync as long as the timeline does not skip or repeat source time (`assemble` warns when it does).
- Longer (a continuation): the music has to go on. Looping the last seconds was heard
  immediately. Give a longer recording of the same track:
  `audio <run> --file <track> --match --rights "<basis>"`.
  `--match` finds where the source's sound sits inside the recording (to the sample when it is
  the same master) and continues from there. If it reports no confident match, the recording is a
  different version: place it by ear with `--start <seconds>`.
- The recording replaces the whole soundtrack: voices and ambience of the source are not mixed in.
- After adding it, the command measures where the sound of the finished file sits in the
  recording and refuses a result more than 20 ms off. When the measurement is inconclusive it
  says so and the sync has to be checked by ear. (Seeking a compressed audio file instead of
  cutting decoded samples left the sound 45 ms late in the original production.)
- Having the file is not a basis for publishing it. For Instagram, a track from its own library
  is added in the app: deliver a review copy and say so.

## 8. Review and hand-off

`compare <run>` writes source and remake side by side. The user watches `final.mp4` with sound.
Publishing is a separate decision and a separate skill (`instagram`): reel with `--ai-label`,
tags if wanted. This skill stops at the file.
