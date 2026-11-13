# Prompts: character card, shot card, swap and continuation

The model reads the prompt together with the clip and the photo. The prompt's job is to say what
must NOT change and to name the person consistently. Short and concrete beats long and adjectival.
English prompts worked best.

## The character card (written once, repeated in every shot)

Describe what the identity photo shows and nothing else:

```
<who>: <face in three or four words>, <hair: colour, length, how it is worn>, <build>,
<wardrobe: garment, colour, material, cut, straps/sleeves, length>, <accessories or "no jewellery">.
```

Example with invented details:
`a woman with an oval face and dark eyes, long dark brown hair worn loose, slim build with slender
arms, a black lace sleeveless mini dress with thin straps, no jewellery`

Rules: the same sentence, word for word, in every shot (store it with `init --character`). Do not
add traits the photo does not show; the model invents them differently each time. Do not describe
the ORIGINAL person.

## The shot card (written per shot, from the breakdown)

Four facts, taken from the source frame, not imagined:

- framing: close-up / medium shot from head to hips / full body / wide shot with the person small
- camera: static / slow push-in / pan left / handheld
- light: where it comes from and its colour (e.g. strong cool blue backlight, face in soft shadow)
- surroundings: what is around and behind the person that must stay (crowd, stage, bar, street)

## Swap prompt

```
Replace the selected <woman/man/person> in <Video 1> with the <woman/man/person> from <Picture 1>:
<character card>. Keep exactly the same pose, movement, timing and position as in <Video 1>.
<shot card: framing, camera>. <shot card: light>. Keep the background, the lighting and every
other person unchanged.
```

- `<Video 1>` is the clip, `<Picture 1>` the identity photo. Use those tags.
- "the selected ..." matters: the mask says who; the prompt must agree, especially with others in
  frame ("the selected woman standing on the stage").
- State the light. Without it the model lights the new person evenly and they look pasted in.
- For a cropped, distant person, describe them at that scale ("small figure, full body visible,
  standing on the stage") and keep "every other person unchanged".
- Without a prompt the template's generic one is used; it works for a quick look only.

## Continuation prompt

`<Picture 1>` is the scene (last frame of the shot), `<Picture 2>` the identity photo.

```
This video continues the previous shot without any cut: its first second is the end of that shot,
and the movement goes on with exactly the same <tempo words> and the same <what moves>, never
faster. <Picture 1> shows the scene and <Picture 2> shows the same <person>: <character card>.
<shot card: framing, camera, "same framing">. <shot card: light and surroundings>.
<What the person keeps doing, in the tempo of the shot>. <Then the new movement, one action at a
time, in order: "then slowly ..., then ..., then ...">. <How it ends>.
```

- Say "continues without any cut" and repeat the tempo twice (start and middle). A continuation
  that only described the new action came out at double speed.
- List actions in the order they happen, joined with "then". Three or four actions fit in five
  seconds; more get skipped or rushed.
- Keep the camera instruction ("static camera, same framing") or the model reframes.
- Do not name music or a beat; describe the body ("slow sway of the hips and shoulders").

## What not to put in any prompt

- Names of real people, brands or shows. Describe what is visible.
- Style names ("cinematic, 8k, masterpiece"): they pull the look away from the source.
- Instructions about clothing removal or anything the source does not show. Out of scope.
