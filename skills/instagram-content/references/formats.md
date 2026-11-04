<!-- Adapted from instagram-agent-skill (MIT, (c) 2026 Jake Schincariol): ig-reel, ig-carousel, ig-story SKILL.md. -->

# Instagram formats: Reels, carousels, Stories

## Reels

Pick a Reel when the idea has motion, a face, or a payoff that must be seen happening.

```
0:00 - 0:02   HOOK        the claim. Spoken line and on-screen line written separately.
                          Motion in the first frame, not a static face.
0:02 - 0:07   THE STAKE   why this matters to the viewer. One line.
0:07 - ...    THE BODY    one idea per beat; the frame changes every beat.
LAST 3s       THE PAYOFF  deliver what the hook promised, then the single ask.
LAST LINE     THE LOOP    echo one word from the hook so the replay lands clean.
```

- Length: 15 to 45 s is the working range. Reels can run to 15 minutes, but almost none should.
  Under 7 s, loop counts inflate and nothing else improves.
- Speech: about 165 wpm (typical range 150 to 200). `beats.py` times the script at that rate.
- Workflow: write 3 hooks from different formulas in `scripts/hooks.json`, rank them with
  `hook-score.ts`, and write the script on the winner. A top score under 50 means there is no
  hook yet. Time the script with `beats.ts --target <s>` and fix every flag: a hook over 3 s,
  a beat over 4 s, abstract runs, a missing loop.
- On-screen text is its own script: 6 words or fewer per card, the hook card at frame 1, and
  burned-in captions for the body (most viewers start muted).
- Safe zone on 1080x1920: keep text between y=230 and y=1440, and keep the right 230 px clear.
  The caption, action rail and audio strip cover everything outside that box.
- Rules: one idea per Reel, numbers over adjectives, no intro or greeting, change the frame
  every beat, one ask at the end. Never invent metrics; leave `{{your number}}` and flag it.

## Carousels

Pick a carousel when the idea has sequence and is worth re-reading: steps, a framework, a
before/after, or a list worth screenshotting. A single claim is neither format: make it a Reel.

```
1         COVER     the hook, 6 words or fewer, legible at grid thumbnail size, plus one line of promise.
2         THE STAKE why it matters in one sentence. It is a second cover, so no setup.
3..N      ONE IDEA PER SLIDE: a 3-7 word headline, at most 25 words under it.
N+1       RECAP     the whole thing as a list; the screenshot-and-send slide.
LAST      CTA       one action: save, comment a keyword, or follow.
```

- 6 to 10 slides. The cap is 20. Under 5, the swipe never starts.
- Build at 1080x1350 (4:5). Keep cover text clear of the outer 120 px so the grid crop never
  bites. Use type no smaller than 32 px, one accent color, and the brand system if one exists.
- Number the slides (3/8), put the handle small on every slide, and add alt text at least on the cover.
- Every slide must share the first slide's aspect ratio; Instagram crops the rest to it.
- Render slides from HTML (one 1080x1350 element per slide) with headless Chrome or any
  HTML-to-image tool, as JPEG. Then publish with `instagram` `post carousel`.
- For narrative architectures (Value-Stack, Problem-Proof, Hack List, Rant Callout, Demo
  Walkthrough) see `carousel-frameworks.md`.

## Stories

Use 3 to 7 frames a day. Past about 7, tap-forwards climb and the last frames play to nobody.

```
1       THE OPEN     something happening today, with a face or a hand in it.
2-3     THE MIDDLE   the content: process, result, mistake.
4       THE ASK      one sticker: poll, question box, quiz or link.
5       THE CLOSE    the answer, outcome, or tomorrow's setup.
```

| Sticker | Job |
|---|---|
| Poll | cheapest tap; volume of response |
| Question box | the audience's exact words: hooks, objections, content ideas |
| Quiz | teaching through a common misconception |
| Link | the only clickable surface besides the bio |
| Countdown | a launch or close date people can subscribe to |
| Add yours | occasional reach beyond followers |

- Safe zone on 1080x1920: keep text between y=250 and y=1600.
- Talk to one person ("you", singular). Never repost a feed post with no comment.
- Stickers cannot be added through this CLI. `post story` publishes a plain photo. Add
  stickers in the app.
- The honest DM funnel: they act first (vote, answer, comment), then the user replies by hand.
  Never bulk-DM people who did not interact.

## Feed photos

- 4:5 (1080x1350) takes the most feed space. 1:1 and 1.91:1 are also accepted.
- Alt text (`--alt`) helps screen readers and Instagram's understanding of the image.
