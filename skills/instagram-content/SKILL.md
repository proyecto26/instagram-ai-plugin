---
name: instagram-content
description: Plans and writes Instagram content (Reels scripts and hooks, carousels slide by slide, captions, Stories sequences, content pillars, weekly calendars, repurposing long-form into posts), lints it with bundled offline scorers, and hands approved posts to the instagram skill for publishing. This skill should be used when the user asks to "write a caption", "script a reel", "give me reel hooks", "make a carousel about", "plan my Instagram week", "content calendar for Instagram", "turn this blog post into Instagram posts", "give me post ideas", "what should I post this week", "make this sound less AI", or wants Instagram copy reviewed before posting.
---

# Instagram content

Produce Instagram content that a person would actually stop for, check it with the bundled
scorers, and publish only after the user approves the exact post. Story comes first: platform
tactics amplify a specific, true story and never replace one.

## Before writing

1. Read the product/brand context if present: `.agents/product-marketing.md`,
   `.claude/product-marketing.md`, or `product-marketing-context.md`. Ask only for what is missing.
2. Read a voice file if present (`.agents/instagram-voice.md` or `~/.claude/instagram/voice.md`).
   If none exists and the account is the user's own, pull their recent captions:
   `npx -y bun --no-env-file ../instagram/scripts/main.ts posts --limit 12 --json`. Infer the voice: sentence
   length, vocabulary, emoji use, the CTA they repeat. Offer to save it as `.agents/instagram-voice.md`.
3. If the idea is thin, ask one batched question: what happened, to whom, and what it cost or
   returned. Do not pad a thin idea.
4. If a swipe file from `instagram-research` exists, use its winning hook formulas over the defaults.

## Choose the format

| The idea has... | Format |
|---|---|
| motion, a face, a payoff that must be seen | Reel |
| sequence worth re-reading (steps, framework, before/after, list) | Carousel |
| one strong image, a moment, a product shot | Photo |
| today, behind the scenes, a question for the audience | Stories |

One idea per post. If a draft holds two ideas, split it and say so. Format playbooks, safe zones
and slide/beat structures are in **`references/formats.md`**.

## Scripts (offline, no network)

Run from this skill directory with `npx -y bun`:

```bash
npx -y bun scripts/caption-lint.ts caption.txt [--keywords "term one,term two"] [--json]
npx -y bun scripts/hook-score.ts hooks.txt            # rank hook options, one per line
npx -y bun scripts/hook-score.ts --hook "one line"    # score a single hook
npx -y bun scripts/beats.ts script.txt --target 30    # timed beat sheet for a Reel script
npx -y bun scripts/ai-tells.ts detect draft.txt       # AI-tell score and flagged phrases
npx -y bun scripts/ai-tells.ts humanize draft.txt     # mechanical cleanup (add --report for what changed)
```

- `caption-lint` prints what the feed shows before "... more" (~125 chars) and checks length,
  first line, concreteness, hashtags (cap 5), tag placement, dead links, one ask, emoji density
  and search terms. Exit 0 means READY.
- `hook-score` scores a hook on mechanical features (length, specificity, stakes, front-loading,
  direct address). Use it to kill weak hooks, not to crown winners. Its author found it weak at
  predicting hits. The 26 hook formulas to write from are in `scripts/hooks.json` (reference
  data; the scorer does not read it).
- `beats` times a script at 165 wpm and flags slow hooks, long beats, abstract runs and a
  missing loop.
- `ai-tells` uses the phrase and structure lists in `scripts/slop.json`. `humanize` deletes and
  replaces mechanically (invisible characters, em dashes, curly quotes, stock phrases), which can
  leave broken punctuation behind. Always re-read its output and fix it by hand. Structural tells
  are only flagged, never rewritten.

## Workflow per post

1. Draft 3 hooks from different formulas. Score them and show all three, word for word, with
   their scores, so the user can pick a different one than the scorer did. Score a hook only
   once its numbers are filled in; a `{{your number}}` placeholder inflates the score.
2. Write the body in the user's voice: contractions, short lines, numbers over adjectives,
   no invented facts. A missing number becomes `{{your number}}`, and say so.
3. Reels: write the on-screen text as a separate script, then run `beats`.
   Carousels: give a numbered slide list the user can edit in ten seconds before rendering.
4. Write the caption, for every post including a Reel script, because the caption is what
   ships with it. The hook goes in line one, there is one ask (save, share, comment or follow,
   never "none"), at most 5 topical hashtags below the fold, and no links in the body. Run
   `caption-lint` and `ai-tells detect`. Fix and re-run until clean, or explain the remaining
   warnings.
5. Show the final package: media plan, on-screen text, caption, lint verdicts.
6. Publishing: once media files exist, run the `instagram` skill's dry run, for example
   `npx -y bun --no-env-file ../instagram/scripts/main.ts post carousel s1.jpg s2.jpg ... --caption-file caption.txt`.
   Show its output, wait for an explicit yes for that exact post, then re-run with `--confirm --account <username>` (add `--experimental` for a write type not yet verified live; `status` lists them).
   Never publish without that yes, and never batch-approve several posts.

## Writing rules (no AI tells)

Never write:
- Contrast reveals ("It's not X, it's Y"), negation lists ("No X, no Y, no Z"), trailing pile-ons.
- Self-answered questions and colon reveals ("The result? 3x faster.").
- Stock phrases: "Say goodbye to", "Unlock the power of", "Take it to the next level", "Here's the thing".
- Em dashes in posts. Use a period or a line break.
- Broetry (one sentence per line for the whole post), engagement bait ("Agree?", "Read that
  again"), manufactured vulnerability, emoji as bullets.

Keep fragments and lists of three to one per post. `ai-tells detect` catches most of these
mechanically.

## Hooks and post templates

Hook families: curiosity ("I was wrong about [belief]"), story ("Last week, [unexpected
thing]"), value ("How to [outcome] without [pain]"), contrarian ("[Common advice] cost us
[result]"). Fill each with a specific fact. A formula is only a shape. More templates are in
**`references/post-templates.md`**. Reel hook and script patterns are in
**`references/short-form-video.md`**. Carousel narrative frameworks are in
**`references/carousel-frameworks.md`**.

## Planning and repurposing

- **Pillars**: 3 to 5 pillars tied to expertise and audience questions (for example insights
  30%, behind the scenes 25%, education 25%, personal 15%, promotion 5%).
- **Cadence**: 3 to 5 feed posts a week (Reels and carousels first) plus Stories most days.
  Consistency beats volume. For the account's real best formats and slots, use `instagram-audit`.
- **Weekly plan**: a table of day, format, pillar, hook, and status (draft, approved, posted).
  Save it as `instagram-plan.md` in the project if the user wants it kept.
- **Repurposing**: extract content atoms from long-form (a quotable line becomes a Reel, a story
  arc a Reel, a framework a carousel, a stat a photo or carousel, behind the scenes a Story).
  Every post must stand alone without the source.

## Engagement on own posts

To triage comments, read them with `npx -y bun --no-env-file ../instagram/scripts/main.ts comments <post> --json`.
Sort them into questions, objections, praise and spam, and draft a reply for each worth answering.
Replies go out one at a time, each text approved by the user, with
`npx -y bun --no-env-file ../instagram/scripts/main.ts reply <post> <commentId> --text "..." --confirm --account <username>`. No bulk replies, likes, follows or DMs.

## Additional resources

- **`references/formats.md`**: Reels, carousel and Stories structures, safe zones, specs.
- **`references/carousel-frameworks.md`**: five slide-by-slide carousel architectures.
- **`references/short-form-video.md`**: video hook formulas and scripting templates.
- **`references/post-templates.md`**: post templates and hook bank.
- `scripts/hooks.json`: 26 hook formulas (reference). `scripts/slop.json`: the AI-tell lexicon used by `ai-tells.ts`.

Credits: adapted from marketingskills `social` (MIT, Corey Haines) and instagram-agent-skill
(MIT, Jake Schincariol); see the plugin's THIRD_PARTY_NOTICES.md.
