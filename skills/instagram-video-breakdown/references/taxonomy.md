# Shot taxonomy

Type the *base picture* of a shot. Text, stickers and picture-in-picture go in `on_screen_text`
and `layers`, never in the type: a filmed talking head with big captions is `filmed`.

Every type needs evidence from the frames. When two types fit, pick the one the evidence favours,
lower the confidence and say what would settle it. A confidence under 0.6 is flagged in the plan.

| Type | What it is | Evidence that supports it |
|---|---|---|
| `filmed` | Camera footage shot for this video | Sensor noise or grain, natural motion blur, shallow or consistent depth of field, hand-held shake, real light falloff, the creator on camera |
| `film_clip` | Footage taken from a film, TV, a stream or stock | Letterbox bars, a broadcaster logo or watermark, grading or aspect ratio unlike the rest, recognisable source |
| `ai_video` | Generated video | Texture that swims between tiles, objects that morph or merge, hands or text that deform, perfectly smooth "floating" camera, physics that drift |
| `avatar` | A generated or driven talking head | Locked torso with only the face moving, mouth shapes slightly off the consonants, identical framing across shots, waxy skin |
| `render_3d` | 3D render (product, game, architecture) | Clean geometric edges, uniform noise-free shading, physically perfect camera path, visible topology or render style |
| `animation_2d` | Drawn or vector animation | Flat fills, outlines, held poses, limited frame rate, squash and stretch |
| `code_render` | Motion graphics from a template or code | Vector-sharp text and shapes, easing curves, exact alignment and repetition, flat or gradient backgrounds, counters and charts |
| `screen_recording` | Capture of an app, site or game UI | UI chrome, a cursor, scrolling, system fonts, pixel-exact straight edges |
| `still_pan_zoom` | One image animated by a slow move | Every tile shows the same picture slightly shifted or scaled, no internal motion |
| `static_hold` | One image held | Identical tiles; `low_motion: true` |

## Pairs that get confused

- **`filmed` vs `ai_video`.** Look at the strip, not one frame. Real footage keeps textures
  attached to surfaces from tile to tile; generated footage lets them crawl. Check hands, text on
  objects and anything that enters or leaves the frame.
- **`still_pan_zoom` vs `ai_video` or `filmed`.** If nothing inside the picture moves (hair,
  leaves, water, eyes) and only the framing changes, it is probably a still; a pan across a
  distant, motionless scene looks the same, so lower the confidence when parallax is visible.
  `low_motion` may be false for a pan/zoom because the whole frame shifts; the strip decides.
- **`static_hold` vs `code_render`.** A held card is `static_hold`; if elements animate in (text
  pops, bars grow), it is `code_render` even when it ends on a hold.
- **`avatar` vs `filmed` talking head.** Compare shoulders and hair across the strip. A real
  person usually shifts weight; an avatar's body tends to stay frozen while the face works. A
  presenter who sits very still can look the same, so treat this as a cue, not proof.
- **`render_3d` vs `screen_recording`.** A game or 3D app viewport with UI around it is a screen
  recording of a 3D tool. Without UI, and with cinematic camera work, it is a render.
- **`film_clip` vs `filmed`.** Ask whether the creator could have shot it. Mixed aspect ratios and
  grading inside one video usually mean borrowed clips.

## Text roles

`caption` (words that follow the speech), `title` (headline or hook card), `label` (names a
thing on screen), `sticker` (a platform sticker with text), `watermark`, `ui` (text that is part
of a recorded interface; list it only when it matters for the remake).

## Layers

`sticker`, `picture_in_picture`, `screenshot`, `logo`, `shape` (arrows, circles, highlights),
`other`. Give position, timing and what it does (`action`: pops in, slides, pulses). Point to an
`assets` id when the layer needs a file the user must supply.

## Structure labels

Free text, but these cover most short videos: `hook`, `context`, `problem`, `demo`, `steps`,
`proof`, `payoff`, `cta`. Note the time of the first cut and of the first text change: the hook
is usually over by then.
