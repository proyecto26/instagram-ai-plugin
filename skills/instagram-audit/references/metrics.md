<!-- Metric framework adapted from instagram-agent-skill (MIT, (c) 2026 Jake Schincariol), ig-audit. -->

# Metrics

## Available from the web session (`audit`)

| Metric | Definition | Notes |
|---|---|---|
| Engagement | likes + comments | `null` when likes are hidden |
| Engagement rate | engagement / followers x 100 | uses current followers, so older posts read slightly low |
| Plays | reel play count (`play_count`, else `view_count`) | reels only |
| Outlier multiple | post engagement / account median engagement | 3x+ outlier, 0.5x or less underperformer |
| Cadence | posts per week across the sample; longest gap in days | |

## Only in Insights (ask the user for screenshots)

| Metric | Why it matters |
|---|---|
| Reach and non-follower share | whether a post travelled beyond followers |
| Hold at 3 s (retention graph) | grades the hook; the best and worst reel graphs are worth more than everything else |
| Average watch time | whether the middle worked |
| Sends (shares) per reach | the strongest signal a viewer can give |
| Saves per reach | reference value, strong for carousels |
| Follows per reach | whether the profile converted the attention |

Rank by outlier multiple and sends per reach, never by raw views. A reel with 4,000 views and 90
sends beat one with 60,000 views and 11.

## Rough benchmarks (directional only)

- Engagement rate: under 1% weak, 1 to 3% typical, over 3% strong. Smaller accounts run higher.
- Reels: 15 to 45 s is the working range. For most accounts, the hook explains more than the length.
- Cadence: 3 to 5 feed posts a week kept up steadily beats bursts followed by gaps.

Benchmarks shift with account size and niche. The account's own median is the only reliable baseline.
