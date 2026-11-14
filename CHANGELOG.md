# Changelog


## Unreleased

- New skill `instagram-video-remake`: replace one person in a video you may remake, keeping the
  performance, the scene and everyone else, with MiniMax H3 in a local ComfyUI. Commands: `doctor`,
  `init` (requires a consent statement), `swap` (whole frame, or a crop around a small subject,
  with a point to pick the person and an optional reversed pass), `continue` (extends a shot,
  anchored on its last frames), `place`, `approve`, `assemble`, `audio` (source sound, or a longer
  recording placed by waveform matching; never looped), `compare`, `status`. Everything is
  recorded in `remake.json` (`ig.remake.v1`). Nothing is published and nothing leaves the computer.
- instagram: reels publish through the "comet async" request the web composer uses (`scripts/comet.ts`),
  after the plain form started answering HTTP 200 with an empty body. The publish step repeats only on an
  explicit "still processing" answer, and an unclear answer stays in the pending ledger. Verified live
  on 2026-11-13.
- instagram: `post reel --tag`, `--collab`, `--ai-label`, `post story --mention` and `--ai-label`
  (experimental; recipients must be approved with the `--approve` string the dry run prints).

## Unreleased (2026-11-11)

- New skill `instagram-video-breakdown`: `fetch` (one reel, story or carousel video through the
  session, or `--file`), `analyze` (cuts from ffmpeg's scene score plus frame-difference spikes,
  per-shot first/last frames, sheets and 2 fps strips, a low-motion hint, text-change candidates,
  loudness, gated tempo and cuts-on-beat), `frames`, `transcribe` (import `.srt`/`.vtt`/JSON or
  run your own recogniser; a Whisper recipe is included, no model is bundled or downloaded),
  `review` / `apply-review` (validated answers; script only from a transcript; voice and music
  stay unconfirmed without evidence) and `summary` (writes `recreate.md`). Needs ffmpeg.
- Media downloads go to Instagram's CDN hosts only, over https, without cookies.

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
