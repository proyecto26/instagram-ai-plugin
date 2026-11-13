# Third-party notices

## comfy-openjutsu and H3 Character Swap

Source: https://github.com/Comfy-Org/comfy-openjutsu (MIT, Copyright (c) 2026 Comfy Org), built on
Akatz Labs' H3 Character Swap workflow, https://github.com/akatz-labs/h3-character-swap-tool
(workflow MIT, Copyright (c) 2026 Akatz Labs).
Used in: `skills/instagram-video-remake/assets/workflows/h3_swap.api.json`, copied unmodified from
`workflows/swap.api.json`; the full MIT text is in the `NOTICE.md` next to it. The way
`skills/instagram-video-remake/scripts/graphs.ts` fills that graph follows the upstream app's
`lib/swap.ts`; the code was written for this plugin.

The graph uses node classes from the `h3_character_swap` node pack of the same Akatz Labs
repository, which is GPL-3.0. That pack is NOT included in this repository and no code from it was
copied: users install it in their own ComfyUI. Model weights (MiniMax H3 Community License, SAM
License, Apache-2.0) are not included either; `skills/instagram-video-remake/references/setup.md`
lists them with their sources.

## marketingskills

Source: https://github.com/coreyhaines31/marketingskills
Used in: `skills/instagram-content/references/{carousel-frameworks,short-form-video,post-templates}.md`,
`skills/instagram-ads/references/{meta-andromeda-playbook,meta-decision-system,ad-copy-templates,audience-targeting}.md`,
and the structure and guidance of the `instagram-content` and `instagram-ads` skills.

```
MIT License

Copyright (c) 2025 Corey Haines

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## instagram-agent-skill

Used in: `skills/instagram-content/scripts/{caption-lint,hook-score,beats,ai-tells}.ts` (ports of
`caption.py`, `hookscore.py`, `beats.py`, `detect.py`, `humanize.py`),
`skills/instagram-content/scripts/{hooks,slop}.json` (verbatim),
`skills/instagram-audit/references/profile-rubric.json` (verbatim), and the format and metric
guidance in `instagram-content/references/formats.md` and `instagram-audit/references/metrics.md`.

```
MIT License

Copyright (c) 2026 Jake Schincariol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## notebooklm-ai-plugin

`skills/instagram/scripts/auth.ts` adapts the Chrome DevTools login helpers (free port, Chrome
discovery, CDP connection). Same author (Proyecto 26), MIT.

## rea-video

Source: https://github.com/JuneYaooo/rea-video (Apache-2.0)
Used in: `skills/instagram-video-breakdown`, as a design reference only. No code was copied and
the project is not a dependency. Ideas taken from it: measure first and let an image-capable
agent review per-shot evidence, validate the review answers before merging them, the shot-type
taxonomy with confusable pairs, keeping the overlay layer separate from the base picture,
on-demand extra frames, gated tempo estimation, and reporting "unconfirmed" instead of guessing.
