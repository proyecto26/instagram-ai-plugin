# 📸 Instagram AI Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-blueviolet)](https://code.claude.com/docs/en/plugins)
[![Agent Plugins](https://img.shields.io/badge/Agent_Plugins-1.0-orange)](https://agent-plugins.org/specification)
[![Skills](https://img.shields.io/badge/Skills-5-brightgreen)](#-the-essentials-kit-features)
[![TypeScript](https://img.shields.io/badge/TypeScript-Bun-blue)](https://bun.sh)

<img src="https://github.com/proyecto26/sherlock-ai-plugin/blob/main/images/claude-mascot-jumping-animated.svg" width="150">

> **Your Instagram, driven from the terminal by Claude Code, Codex, Cursor, Copilot CLI or any agent that runs shell commands.**

Instagram AI Plugin signs in with **your own browser session** and calls the same endpoints
instagram.com's web client uses. No Graph API app, no Apify, no third-party connector. On top of
that client sit four marketing skills that work on your **real** account data: content, audits,
competitor research and ads.

Every write is a dry run until you approve the exact post. There are no like, follow or DM
commands, by design.

---

## 🧰 The Essentials Kit (Features)

### 📱 **1. Instagram (The Operator)**
*The client every other skill stands on.*
- **Cookie login**: Chrome opens with a dedicated profile, you sign in (2FA is fine), and the
  session cookies are captured through the DevTools protocol. You can also import cookies from
  Cookie-Editor JSON, `cookies.txt` or a raw `Cookie:` header.
- **Reads**: profiles, posts, reels, single media, comments, hashtags and search, through REST
  first, then GraphQL persisted queries (doc_ids discovered from the live bundles), then the posts
  embedded in the page. Every result says which source answered.
- **Publishing**: photos, carousels (2 to 10 items), reels and stories (photo or video), plus caption
  edits and comment replies. Each one is shown as a dry run first and needs `--confirm --account`.
  There is no delete, by design.
- **Metrics**: `audit` and `swipe` compute medians, formats, cadence and outliers from real posts.

### ✍️ **2. Instagram Content (The Writer)**
*Reels, carousels, captions, Stories and calendars that sound like a person.*
- **Hooks first**: three hooks per idea, scored offline with `hook-score`.
- **Offline linters**: `caption-lint` (first-line length, hashtag count, banned phrases),
  `beats` (reel timing) and `ai-tells` (detect and humanize AI-sounding copy).
- **Repurposing**: turn one idea into a reel, a carousel and a Story sequence.

### 🔎 **3. Instagram Audit (The Analyst)**
*An honest audit against the account's own median.*
- **Format, cadence and outlier analysis** with sample sizes on every finding.
- **Profile rubric** (100 points) covering name field, bio, highlights, grid and links.
- **Honest gaps**: reach, saves, shares and watch time only exist in Insights, and the audit says so.

### 🕵️ **4. Instagram Research (The Detective)**
*A swipe file of what is working in your niche.*
- **Outliers against their own median**: posts that beat the account's own median by 3x or more,
  so a big account does not drown a small one.
- **Hook formulas and patterns**, classified and adapted to your voice, never copied word for word.

### 📣 **5. Instagram Ads (The Strategist)**
*Meta Ads with Instagram placements, decided from data.*
- **What to promote** from organic outliers, not guesses.
- **Structure, copy and kill/keep/scale calls** in a FACTS / HYPOTHESES / MISSING / ACTIONS format
  that never invents a metric you did not provide.
- Boosting and campaign creation stay in the Instagram app or Ads Manager, so no money moves
  through this plugin.

---

## ⚠️ Read this first: account risk

This plugin uses Instagram's private web endpoints with your own session. That is how your browser
talks to Instagram, but it is **not an official API**, and automated use may break Instagram's
Terms of Use. Instagram can rate-limit, challenge or restrict accounts it believes are automated.
The plugin is built to stay conservative:

- Every write is a **dry run** until you approve the exact post (`--confirm`). A write type that
  has not passed a live test also needs `--experimental`. In v0.1 that is every write.
- Requests are spaced at least 1.5 s apart. On HTTP 429, a checkpoint or "action blocked", the CLI
  **stops** and never retries in a loop.
- A publish that ends without a clear answer is recorded as **pending**, and new posts are refused
  until you check the profile. This prevents duplicate posts.
- There are **no** like, follow, unfollow or DM commands.
- Cookies are stored only in a folder locked to your user (icacls on Windows, 0700/0600
  elsewhere). If that lock fails, nothing is saved. Cookie values are never printed.

Use a test account first. You are responsible for how you use your account.

---

## 🚀 Quick Start

### Requirements

- Node.js (for `npx`). Bun is fetched on demand by `npx -y bun`, with zero npm dependencies.
- Google Chrome, Chromium or Edge for `login`, or an exported cookie file.
- ffmpeg, optional: PNG/WebP conversion and reel cover frames.

### Standards

This plugin follows the [Agent Plugins](https://agent-plugins.org/) v1.0.0 packaging standard
(root [`plugin.json`](./plugin.json)) and every skill follows the [Agent Skills](https://agentskills.io/)
spec (`skills/<name>/SKILL.md`). It also ships the Claude Code manifests
(`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) and the Codex manifests
(`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`). Run
`bash scripts/check-manifests.sh` to confirm they agree.

### Installation

#### Option 1: CLI Install (Recommended)

Use [npx skills](https://github.com/vercel-labs/skills) to install skills directly:

```bash
# Install all skills
npx skills add proyecto26/instagram-ai-plugin

# Install specific skills
npx skills add proyecto26/instagram-ai-plugin --skill instagram instagram-content

# List available skills
npx skills add proyecto26/instagram-ai-plugin --list
```

#### Option 2: Claude Code Plugin

```bash
# Add the marketplace
/plugin marketplace add proyecto26/instagram-ai-plugin

# Install the plugin
/plugin install instagram-ai-plugin
```

#### Option 3: Codex / Cursor / Copilot CLI (Agent Plugins)

| Host | Install |
|------|---------|
| **OpenAI Codex** | `codex plugin marketplace add proyecto26/instagram-ai-plugin` then `codex plugin add instagram-ai-plugin@instagram-ai-plugin-marketplace` (or pick it from `/plugins`) |
| **GitHub Copilot CLI** | `copilot plugin marketplace add proyecto26/instagram-ai-plugin` then `copilot plugin install instagram-ai-plugin@instagram-ai-plugin-marketplace` |
| **Cursor** | Settings → Plugins → install from Git URL `https://github.com/proyecto26/instagram-ai-plugin` |

All five skills are discovered from `skills/`, so adding a skill is a one-directory change.

#### Option 4: Clone and Copy

```bash
git clone https://github.com/proyecto26/instagram-ai-plugin.git
cp -r instagram-ai-plugin/skills/* .claude/skills/
```

#### Option 5: Git Submodule

```bash
git submodule add https://github.com/proyecto26/instagram-ai-plugin.git .claude/instagram-ai-plugin
```

Then reference skills from `.claude/instagram-ai-plugin/skills/`.

#### Option 6: Fork and Customize

1. Fork this repository
2. Customize the skills for your brand and niche
3. Clone your fork into your projects

### Authentication

Just tell your agent:

> *"Log me into Instagram"*

Chrome opens with a dedicated profile. Sign in (2FA and "save login info" are fine) and the CLI
picks up `sessionid`, `csrftoken` and `ds_user_id`. Or run it yourself:

```bash
cd skills/instagram
npx -y bun --no-env-file scripts/main.ts login     # Chrome opens; sign in
npx -y bun --no-env-file scripts/main.ts whoami    # which account is signed in
npx -y bun --no-env-file scripts/main.ts status    # session state, cookie values redacted
```

Sessions expire. If a command answers `login_required`, run `login` again.

### Usage Examples

**"Audit my Instagram and tell me what to post more of."**
> Triggers **Instagram Audit**: runs `audit`, compares formats and hooks against your median, and
> lists what only Insights can answer.

**"Build a swipe file from these five accounts in my niche."**
> Triggers **Instagram Research**: runs `swipe` once and classifies the outliers' hooks.

**"Write a caption for this reel and post it."**
> Triggers **Instagram Content** for the caption, then **Instagram** for a dry run you approve
> before anything is published.

**"Is my ad working? I spent $300 and the CTR is 0.6%."**
> Triggers **Instagram Ads**: separates facts from hypotheses and asks for the numbers that decide it.

```bash
npx -y bun --no-env-file scripts/main.ts post carousel a.jpg b.jpg c.jpg --caption-file caption.txt   # dry run
npx -y bun --no-env-file scripts/main.ts post carousel a.jpg b.jpg c.jpg --caption-file caption.txt --confirm --account your_username
```

---

## ⚙️ How it works

- **Session:** `login` launches Chrome with a dedicated profile through the DevTools protocol and
  reads `sessionid`, `csrftoken` and `ds_user_id` (sessionid is HttpOnly, so page scripts cannot see
  it). The CLI sends the web client's headers (`X-CSRFToken`, `X-IG-App-ID`, `X-ASBD-ID`,
  `X-IG-WWW-Claim`), saves rotated cookies, and only ever sends them to `https://*.instagram.com`.
- **Reads:** REST endpoints first, then GraphQL persisted queries whose `doc_id`s are discovered from
  the live web bundles, then the posts embedded in the profile page.
- **Publishing:** media goes to `rupload_igphoto` / `rupload_igvideo`, then `media/configure/`,
  `configure_sidecar/` or `configure_to_clips/`. A per-run lock and a pending ledger stop duplicate
  posts after a timeout.
- The endpoint table, with evidence status and how to re-verify after Instagram changes something,
  is in [`skills/instagram/references/endpoints.md`](skills/instagram/references/endpoints.md).

## 📂 Structure

```text
instagram-ai-plugin/
├── plugin.json                  # Agent Plugins 1.0 manifest
├── .claude-plugin/              # Claude Code manifest + marketplace
├── .codex-plugin/               # Codex manifest
├── .agents/plugins/             # Codex marketplace
├── skills/
│   ├── instagram/               # Cookie client: login, reads, publish, metrics (scripts/)
│   ├── instagram-content/       # Content workflows + offline linters (scripts/)
│   ├── instagram-audit/         # Account audit
│   ├── instagram-research/      # Competitor swipe files
│   └── instagram-ads/           # Meta Ads decisions
├── evals/                       # `claude plugin eval .` suite
├── test/                        # Offline unit tests and opt-in live tests
└── scripts/check-manifests.sh   # Checks the manifests agree before a release
```

## 🧪 Development

```bash
cd test
npx -y bun install              # dev-only: typescript + types
npx -y bun x tsc --noEmit -p .
npx -y bun test unit            # offline; network is trapped in the CLI tests
bash ../scripts/check-manifests.sh
```

Behaviour evals (each case runs with and without the plugin, and uses model credits):

```bash
claude plugin eval .                                        # from the plugin root
claude plugin eval . --case reel-caption-rules --runs 1 --ablation none
```

Live tests are opt-in and use your saved session:

```bash
INSTAGRAM_LIVE=1 npx -y bun test live.test.ts                       # read-only
```

## 🚧 Known Limitations

- **Caption edits are not verified live yet.** Photos, carousels, reels, stories (photo and video),
  comments and replies have been published on a real account. `edit-caption` matches the web
  bundle's request but Instagram answered HTTP 500 in testing, so it still needs `--experimental`.
- **Private endpoints change.** doc_ids are rediscovered from the bundles, but field names can
  move. `npx -y bun --no-env-file scripts/main.ts probe` reports what still answers.
- **No Insights.** Reach, saves, shares, watch time and follows per post are not exposed to the web
  session, so the audit marks them as needing Insights instead of estimating them.
- **No ads API.** Ads advice is read-only. You create boosts and campaigns in the app or Ads Manager.

---

## 🌟 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=proyecto26/instagram-ai-plugin&type=Date)](https://star-history.com/#proyecto26/instagram-ai-plugin&Date)

## 💜 Sponsors

This project is free and open source. Sponsors help keep it maintained and growing.

[**Become a Sponsor**](https://github.com/sponsors/proyecto26) | [Sponsorship Program](https://proyecto26.com/sponsors/)

## 🤝 Contribution

When contributing to this repository, please first discuss the change you wish to make via issue,
email, or any other method with the owners of this repository before making a change.

Contributions are what make the open-source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated** ❤️.

You can learn more about how you can contribute to this project in the [contribution guide](https://github.com/proyecto26/.github/blob/master/CONTRIBUTING.md).

## ⚖️ License

This repository is available under the [MIT License](./LICENSE).

## 👍 Credits

- [marketingskills](https://github.com/coreyhaines31/marketingskills) (MIT, Corey Haines): the ads and social skills the marketing skills adapt
- instagram-agent-skill (MIT, Jake Schincariol): caption, hook and beats tooling, ported to TypeScript
- [notebooklm-ai-plugin](https://github.com/proyecto26/notebooklm-ai-plugin): Chrome DevTools login helpers
- [sherlock-ai-plugin](https://github.com/proyecto26/sherlock-ai-plugin): plugin layout and CDP authentication patterns

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Not affiliated with, endorsed by, or sponsored by Instagram or Meta.

## Happy vibe posting 💯
Made with ❤️ by [Proyecto 26](https://proyecto26.com) - Changing the world with small contributions.

One hand can accomplish great things, but many can take you into space and beyond! 🌌

Together we do more, together we are more ❤️ <img width="150px" src="https://avatars0.githubusercontent.com/u/28855608?s=200&v=4" align="right">
