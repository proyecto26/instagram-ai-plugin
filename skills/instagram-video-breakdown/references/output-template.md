# Reporting a breakdown

Show before telling: open `storyboard.jpg` (and the strip of the hook shot) so the user sees the
video's shape, then report. Keep the report to what was observed; put everything else under
"Unconfirmed".

```markdown
## <account> - <one line: what the video is>
<duration>s, <n> shots, median shot <x>s. <views/likes when the source has them>

**Hook (0-<t>s):** what is on screen and what it promises.
**Why it holds:** 2-3 observations tied to measurements (first cut at 1.7 s, text changes every
~1 s, cuts on the beat 80 % of the time). No claims about the algorithm.

### Structure
| Time | Section | What happens |

### Shots
| # | Time | Type (confidence) | Picture | Text on screen |

### Script
The transcript lines by shot, or: "Unconfirmed: no transcript."

### Audio
Measured: loudness, tempo or "no reliable tempo", share of cuts on beats.
Instagram credits: <track / original audio>, when present.
Voice / music: yes, no or unconfirmed, with who confirmed it.

### Unconfirmed
Everything that could not be observed: script without a transcript, music or voice nobody
listened to, shots typed under 0.6 confidence, warnings from apply-review.

### To make your version
Per shot: route, what you need, the concrete step. Then the assets you must supply and the
tools found or missing. Point to recreate.md for the full plan.
```

Rules:

- Adapt the format, not the content. Propose the user's own topic, words and footage on the same
  beat lengths; never suggest reusing the source's footage, audio or wording.
- Numbers come from `breakdown.json`. Do not round a "no reliable tempo" into a BPM, or call a
  measured rhythm "music".
- Pass on every warning and downgrade from `apply-review`; they are the honest limits of the
  result.
- End by offering the next step: draft the new script to these beats, generate one test shot, or
  record a shot list.
