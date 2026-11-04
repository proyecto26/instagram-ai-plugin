# Changelog

## Unreleased (2026-11-04)

Verified on a real account: photo, carousel, reel, story (photo and video), comment and reply.

- `whoami` reads the signed-in account from the home page; the users/{id}/info endpoint answers
  429 to every web session and is no longer used.
- Every `--confirm` write needs `--account <username>` and refuses if the session is another
  account. Dry runs show `signedInAs`; `login` reports the username.
- Video stories (up to 60 s, with a cover). Story results link to `/stories/<user>/<pk>/`.
- Comments and replies use the web client's GraphQL mutation on `/api/graphql`.
- `delete` removed by design; the live write test that relied on it was dropped.
- Known issue: `edit-caption` answers HTTP 500 and stays behind `--experimental`.

## 0.1.0 (2026-11-03)

First release.

- `instagram` skill: Chrome or imported-cookie login with storage locked to the current user;
  reads (profile, posts, media, comments, hashtag, search) with REST, GraphQL and embedded
  fallbacks; `audit` and `swipe` metrics; dry-run-first publishing of photos, carousels and reels;
  edit caption; story, delete, comment and reply; every write needs `--experimental` until verified live; pending-publish ledger; stop on
  429, checkpoint and action blocked; `probe`.
- `instagram-content`: content workflow, plus TypeScript ports of caption-lint, hook-score, beats
  and AI-tell detect/humanize, at output parity with the Python originals.
- `instagram-audit`, `instagram-research`, `instagram-ads` skills.
- Manifests for Claude Code, Codex, and Agent Plugins 1.0.
- Not yet verified live: every write. See `test/live.test.ts` and the evidence column in
  `skills/instagram/references/endpoints.md`.
