---
name: instagram-ads
description: Plans and evaluates paid campaigns that run on Instagram (Meta Ads with Instagram feed, Stories and Reels placements). It picks which organic posts to promote using real performance pulled through the user's web session, writes ad copy and creative briefs, sets up Andromeda-era campaign structure, and makes kill, keep and scale decisions from numbers the user pastes. This skill should be used when the user asks to "run Instagram ads", "boost this post", "which post should I promote", "write Instagram ad copy", "set up a Meta campaign for Instagram", "is my Instagram ad working", "when should I kill this ad", "creative testing for Reels ads", or mentions ROAS, CPA, CPM or partnership ads on Instagram.
---

# Instagram ads

Use organic evidence to choose what to pay for, structure the campaign so Meta's delivery system
can learn, and decide with numbers instead of feel.

## What this plugin can and cannot do

- **Can:** read the account's organic performance (`instagram` skill `audit`, `posts`, `media`,
  and `swipe` for competitors), write copy and briefs, and evaluate exported or pasted results.
- **Cannot:** create, edit, boost, pause or fund ads. Ads Manager and the Boost flow use Meta's
  business systems and payment methods. The Instagram web cookie does not drive them, and this
  plugin must never try. The user makes every change in Ads Manager or the app, so give exact
  settings to enter.
- Never estimate missing ad metrics. Label anything not provided **MISSING** and say what it would change.

## Before starting

Read `.agents/product-marketing.md` (or `.claude/product-marketing.md`) if present. Collect only
what is missing: the goal (sales, leads, followers, traffic), the offer and price, the target CPA
or ROAS, the monthly budget, the pixel or Conversions API status, and any current results.

## 1. Choose what to promote (organic first)

From the `instagram` skill directory:

```bash
npx -y bun scripts/main.ts audit --limit 30 --json > "<project-dir>/instagram-audit.json"   # user folder, not the plugin
```

Shortlist `outliers` (3x or more of the account median). A post that already beats the account's
own median organically is the cheapest creative test there is. Prefer posts whose hook works with
the sound off, and whose first 3 seconds or cover state the claim. Comments full of questions are
a signal of buying intent. Read them with `comments <url>`.

When the account has no outliers, build concepts from a competitor swipe file
(`instagram-research`) and adapt their structure, never their copy.

## 2. Structure (Andromeda era)

Summary. The full detail is in **`references/meta-andromeda-playbook.md`** and **`references/meta-decision-system.md`**.

- **Broad audience, specific creative.** The creative does the targeting. Avoid stacked interests.
- **Creative volume is the lever.** Ship many cheap, distinct concepts (statics plus native-looking
  Reels) rather than polishing one. Variants of one idea count as one concept.
- **Two campaigns:** Testing (new concepts, controlled budget) and Scaling (graduated winners).
- **Placements:** Instagram Reels and Stories need 9:16 with text inside the safe zone
  (`../instagram-content/references/formats.md`). Feed takes 4:5.
- **Partnership ads** (creator posts promoted through the creator's handle) add net-new reach. They
  need the creator's permission in the app.
- **Sequence:** cold concept, then a different-angle retarget (proof or objection), then the offer.
  Do not retarget with the same ad.

## 3. Write the ads

For each concept give: the hook (first line or first 3 s), primary text (lead with the outcome, at
most 125 chars before "more"), the headline, the CTA button, the creative brief (format, first
frame, on-screen text, length) and the placement. Templates are in
**`references/ad-copy-templates.md`**. Audience notes are in **`references/audience-targeting.md`**.
Lint the primary text with `npx -y bun ../instagram-content/scripts/caption-lint.ts primary.txt` and
`npx -y bun ../instagram-content/scripts/ai-tells.ts detect primary.txt`. Native beats polished: ads that look like ads get scrolled past.

## 4. Decide: kill, keep, scale

Ask for these per ad, last 7 to 14 days: spend, impressions, CPM, link CTR, CPC, conversions,
CPA or ROAS, frequency, and 3-second hold for video. Then apply `references/meta-decision-system.md`:

- **Day 7 delivery check:** an ad with almost no spend is a delivery verdict, not a creative one.
- **Weekly quality check** on rolling 14-day data against the true CPA or CPL target.
- **Fatigue:** frequency rising, CTR falling, and CPA climbing together mean refresh the concept.
- **Graduate** to Scaling only past the documented thresholds. Scale budgets in steps, not jumps.

## 5. Output

```
FACTS        what the numbers show (with the date range and source)
HYPOTHESES   what probably explains it, with confidence
MISSING      inputs not provided and what they would change
ACTIONS      exact changes for the user to make in Ads Manager, in order
```

End every recommendation with those four blocks.

## Additional resources

- **`references/meta-andromeda-playbook.md`**: creative volume, creative as targeting, creator
  ads, sequencing.
- **`references/meta-decision-system.md`**: TCPL, two-campaign structure, delivery and quality
  stages, fatigue, scaling, partnership ads, benchmarks.
- **`references/ad-copy-templates.md`**: copy formulas and templates.
- **`references/audience-targeting.md`**: audience research and targeting by platform.

Credits: the references are copied from marketingskills `ads` (MIT, Corey Haines); see the
plugin's THIRD_PARTY_NOTICES.md.
