---
name: instagram-audit
description: Audits an Instagram account from real data pulled with the user's own web session (no Apify, no Graph API app), covering profile conversion, format mix, cadence, best days and hours, caption length, hashtags, and outlier versus underperforming posts, with an honest note on what only Insights can show. This skill should be used when the user asks to "audit my Instagram", "why is my reach down", "which formats work best on my account", "best time to post", "which posts performed best", "review my Instagram profile", "score my bio", "analyze @someaccount", or "what's working on my Instagram", and whenever the user shares output from the plugin's `audit` command (saved audit JSON, "I already ran the audit") and wants it interpreted, even if they ask only "what should I post more of".
---

# Instagram audit

Turn the account's own numbers into a short list of claims with evidence attached, each with a
confidence level and one action. Raw totals mostly measure follower count. Compare each post
against the account's own median instead.

## 1. Pull the data

Run from the `instagram` skill directory (`../instagram`):

```bash
npx -y bun scripts/main.ts audit [username] --limit 30 --tz <Area/City> --json > "<project-dir>/instagram-audit.json"
npx -y bun scripts/main.ts profile [username] --json > "<project-dir>/instagram-profile.json"   # default: own account
```

- `<project-dir>` is the user's working folder (absolute path), never the plugin folder.
- Omit `username` for the signed-in account. Ask which timezone the audience lives in; the
  default is the machine's.
- On `rate_limited`, `checkpoint` or `not_logged_in`, stop and report the hint. Do not retry.
- Check `sample.source`. "embedded, max 12" means only 12 posts could be read, so every pattern
  is weak. Say so.

## 2. Read what the audit returns

| Field | Use |
|---|---|
| `account` | followers, isBusiness, category, bioChars, hasLink (inputs for the profile rubric) |
| `totals.medianEngagement`, `medianEngagementRatePct` | baseline (likes + comments, and that over followers) |
| `posts[].outlierMultiple` | engagement over the account median; 3x or more is a real hit |
| `outliers`, `underperformers` | top (3x+) and bottom (0.5x or less) posts with their hooks |
| `byFormat`, `byWeekday`, `byHour`, `byCaptionLength`, `hashtags` | buckets with `n`; `note` starting "insufficient data" when n < 3 |
| `cadence` | posts per week and the longest gap |
| `missing` | what the web session cannot see (reach, saves, shares, watch time, follows per post) |

Never present a bucket with `n < 3` as a finding. Instagram hides like counts on some posts
(`null`). Those are excluded, not counted as zero.

## 3. Find the pattern, in this order

1. **Outliers vs underperformers.** Put the top 5 and bottom 5 side by side. Compare the hook (the
   caption's first line, or the on-screen hook if the user describes it), format, length and
   theme. Score the hooks with `npx -y bun ../instagram-content/scripts/hook-score.ts --hook "<line>"` when useful.
2. **Format.** Reels vs carousels vs photos, by median engagement *rate* and `medianPlays`.
3. **Caption length and hashtags.** Usually minor. Report them only when the gap is large and n is solid.
4. **Cadence.** A gap longer than 14 days usually explains a "reach drop" better than anything else.
5. **Day and hour, last.** They are almost never the cause. Mention them only when nothing else
   shows up and the buckets have n of 3 or more.

State each finding as a claim with its evidence (numbers, n, example posts) and its confidence
(high, medium or low). Thirty posts can show a pattern. Six cannot, so say that instead of
inventing one.

## 4. Separate hook problems from profile problems

- Low plays or engagement across the board means a hook or content problem. Hand off to
  `instagram-content`.
- Posts that travel while the account does not grow means a profile problem. The web session
  cannot measure follows per post, so ask for Insights (non-follower reach, follows) to confirm.

## 5. Score the profile

Score `instagram-profile.json` (name field, bio, link, category, business account) against
**`references/profile-rubric.json`** (12 items, 100 points). Items the data cannot show
(highlights, pinned posts, photo, story ring) are scored from a screenshot or the user's
description, or marked "not checked". Score strictly. Most first-pass profiles land in the 30s
and 40s. Write replacement copy for the 3 lowest items (name field 30 chars, bio 150 chars).
Profile edits happen in the app. This plugin does not change profiles.

## 6. Output

```
INSTAGRAM AUDIT · @handle · 30 posts (2026-08-01 to 2026-11-01, America/Bogota) · source: REST
Baseline: median 412 engagements, 2.1% rate, reels median 9.8k plays
Profile score: 46/100 (name field 2/12, bio line 4/12, ...)

FINDINGS
1. Carousels outperform reels on this account: median rate 3.4% (n=9) vs 1.6% (n=14). Confidence: medium.
   Action: two carousels a week for the next 4 weeks, then re-run this audit.
2. ...

NOT VISIBLE FROM THE WEB SESSION
reach, saves, sends, watch time, follows per post -> paste Insights to sharpen findings 1 and 3.
```

Keep it to 3 to 5 findings, one action each, plus a re-audit date. See **`references/metrics.md`**
for definitions and the metrics that need Insights.

## Additional resources

- **`references/profile-rubric.json`**: 12-item, 100-point profile rubric.
- **`references/metrics.md`**: metric definitions, benchmarks, and what to ask for from Insights.
