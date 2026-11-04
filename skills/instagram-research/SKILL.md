---
name: instagram-research
description: Researches other Instagram accounts and hashtags through the user's own web session (no Apify) to build a swipe file of outlier posts (posts beating their own account's median by 3x or more), extract the hook formulas and formats behind them, and turn that into content ideas. This skill should be used when the user asks to "research competitors on Instagram", "what's working in my niche", "find viral reels about X", "build a swipe file", "reverse engineer this account", "analyze these creators", "check the #hashtag top posts", or "find hook ideas from other accounts".
---

# Instagram research

Find posts that beat their *own* account's normal performance, not posts that are merely big.
A 3x post from a 5k account teaches more than a 1x post from a 5M account.

## Limits (account safety)

- At most 12 accounts and 50 posts per account per run. The CLI enforces both and spaces requests
  at least 1.5 s apart.
- One research run per session is plenty. On `rate_limited` or `checkpoint`, stop, report the
  hint, and do not continue with the remaining accounts.
- Research is read-only: never follow, like or comment on researched accounts.

## 1. Pick the accounts

Ask for 5 to 12 accounts in the same niche, ideally with similar or slightly larger audiences.
If the user has none, find candidates (run from `../instagram`):

```bash
npx -y bun scripts/main.ts search "<niche keyword>" --json
npx -y bun scripts/main.ts hashtag <tag> --limit 24 --json     # top and recent posts for a tag
```

Confirm the list with the user before pulling posts.

## 2. Build the swipe file

```bash
npx -y bun scripts/main.ts swipe user1,user2,user3 --limit 24 --min 3 --json > "<project-dir>/instagram-swipe.json"
```

The output has `outliers[]` (username, url, format, multiple, engagement, and hook, which is the
caption's first line), posts read per account, and `skipped` (private or missing accounts).
An account with fewer than 6 posts read is too thin to judge. Say so.

## 3. Reverse-engineer the winners

For each outlier, highest multiple first:

1. Classify the hook against `../instagram-content/scripts/hooks.json` (formula id and name), and
   score it with `npx -y bun ../instagram-content/scripts/hook-score.ts --hook "<line>"`.
2. Note the format, caption length, call to action and topic.
3. When needed, read the post (`npx -y bun scripts/main.ts media <url>`) and its top comments
   (`npx -y bun scripts/main.ts comments <url> --limit 20`), from `../instagram`.
   Comments show *why* it spread: questions, friends tagged, disagreement.

Then aggregate: which formulas and formats appear most among the outliers, and which topics
repeat across different accounts. A topic that wins on 3 or more accounts is a strong signal.

## 4. Output

```
SWIPE FILE · 8 accounts · 176 posts read · 14 outliers (>= 3x own median)

PATTERNS
- Hook formula #5 Time Collapse: 5 of 14 outliers, across 4 accounts.
- Carousels: 9 of 14 outliers, though only 40% of posts read were carousels.
- Topic "pricing mistakes" wins on 3 accounts.

TOP OUTLIERS
6.2x  @acct  reel      "Proposals used to take me five hours..."   <url>
...

IDEAS FOR YOU (adapted, not copied)
1. ...
```

Save it as `instagram-swipe.md` in the project when the user wants to keep it.
`instagram-content` reads that file. Adapt the structure, never the words: never copy captions,
scripts or footage.

## Additional resources

- `../instagram-content/scripts/hooks.json`: the 26 hook formulas used for classification.
- `../instagram/references/endpoints.md`: what the read commands call, and their limits.
