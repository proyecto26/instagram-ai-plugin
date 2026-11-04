# instagram-ai-plugin: implementation plan

## Goal
A Claude Code (and Codex / Agent Plugins 1.0) plugin, structured like
`../../notebooklm-ai-plugin` and `../../sherlock-ai-plugin/skills/genimg-gemini-web`:
self-contained skills, TypeScript scripts run with `npx -y bun`, zero npm
dependencies, authenticated by the user's own browser session cookies, calling
the same private endpoints instagram.com's web client calls. No Apify, no Graph
API app, no third-party connectors.

## Evidence gathered (2026-11-03, live instagram.com, signed-in Chrome, read-only)
- Web app id `936619743392459` (page HTML), `X-ASBD-ID` = `359341`
  (`require("BDHeaderConfig").ASBD_ID`).
- Create-flow bundle (loaded by opening Create > Post, nothing posted) contains:
  `/api/v1/media/configure_sidecar/`, `/api/v1/media/configure_to_clips/`,
  `/api/v1/media/configure_to_story/`, `/api/v1/media/configure_to_longform/`,
  `media/configure`, `/api/v1/media/{media_id}/edit_media/`,
  `/api/v1/media/{media_id}/info/`, `/api/v1/media/{media_id}/comments/`,
  `.../comments/{parent_comment_id}/child_comments/`, `/api/v1/media/{media_id}/likers/`.
- Upload hosts: `https://i.instagram.com/rupload_igphoto/<entity>` and
  `https://i.instagram.com/rupload_igvideo/<entity>` with `withCredentials`.
  Headers: `X-Instagram-Rupload-Params`, `X-Entity-Name`, `X-Entity-Length`,
  `X-Entity-Type`, `Offset`. Video rupload params include `client-passthrough:"1"`,
  `is_sidecar:"0"`, `is_clips_video`, `extract_cover_frame:"1"`, `media_type`,
  `upload_id`, `upload_media_width/height/duration_ms`, `video_format`.
- configure_to_clips fields seen: `caption`, `upload_id`, `source_type`,
  `clips_share_preview_to_feed`, `disable_comments`, `like_and_view_counts_disabled`,
  `video_subtitles_enabled`, `archive_only`, `media_share_flow:"creation_flow"`,
  `invite_coauthor_user_ids_string`, `custom_accessibility_caption`,
  `is_meta_only_post`, `share_to_threads`, `trial_params`, `graduation_strategy:"manual"`.
  A retry module `polarisConfigureToClipsRetry` handles `in_progress` (transcode pending).
- Read probes: `tags/web_info/?tag_name=` 200 JSON; `accounts/current_user/?edit=true`
  200 (non-JSON with the headers used); `feed/user/{id}/`, `web/search/topsearch/`
  404 on www; `users/{id}/info/`, `users/web_profile_info/`, `clips/user/` 429.
  Probing stopped at the first 429s to protect the account. Several reads have moved
  to `/graphql/query` with rotating `doc_id`s.


## Status

This is the single current plan. It supersedes the base plan plus "Revision 1"
(kept for history in `docs/reviews/PLAN-r1-superseded.md`). Where the two disagreed,
for example on 429 backoff, the 30-hashtag cap, or an archive_only photo test, this
document wins. The implementation in `skills/` matches it, and `test/unit` checks it.

Review: Codex (Seldon) approved round 9 (confidence 0.91) after eight rounds of fixes; verdicts
are in `docs/reviews/seldon-plan-r*.json`. No write has been verified on a live account yet.

## Components (as built)

| Skill | Scripts | Purpose |
|---|---|---|
| `instagram` | `scripts/main.ts` and 15 modules (16 files) | Session, reads, metrics, publishing, pending ledger |
| `instagram-content` | `caption-lint.ts`, `hook-score.ts`, `beats.ts`, `ai-tells.ts` (+ `hooks.json`, `slop.json`) | Content workflow and offline linters; TS ports at output parity with the MIT Python originals |
| `instagram-audit` | uses `instagram audit` | Audit against the account's own median, plus a 100-point profile rubric |
| `instagram-research` | uses `instagram swipe/search/hashtag` | Swipe file of outliers over their own median (3x or more) |
| `instagram-ads` | none | Meta Ads with Instagram placements. Cannot drive Ads Manager; says so |

Shell: `plugin.json` (Agent Plugins 1.0), `.claude-plugin/{plugin,marketplace}.json`,
`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, `scripts/check-manifests.sh`
(identity, wiring, 5 skill names, `claude plugin validate`, JSON schema).

## Safety contract (each item has a unit test unless noted)

1. **Storage fails closed.** `secure.ts` locks the data dir and Chrome profile to the current
   user *before* anything is written (Windows: `icacls /inheritance:r`, grant self, remove every
   other principal, re-read the ACL. POSIX: 0700/0600). Failure throws `InsecureStorageError` and
   nothing is saved, unless `INSTAGRAM_ALLOW_INSECURE_STORAGE=1`. Verified manually on Windows: the
   ACL shows only the current user. The parser has a unit test.
2. **Session never leaves Instagram.** `IgClient.request` refuses non-https and non-Instagram
   hosts, uses `redirect: 'manual'`, and treats a login redirect as `not_logged_in`. Origin
   overrides are accepted only for https `*.instagram.com`, because Bun auto-loads `.env` from the cwd.
   GraphQL bundle fetches go to Meta CDN hosts without cookies. `fb_dtsg`, `lsd` and cookies are
   redacted from every dry-run output.
3. **Writes are dry runs.** No network request without `--confirm`. A subprocess test with a
   fetch trap proves zero requests for valid and invalid dry runs.
4. **Unproven contracts are gated.** `CONTRACTS` in `publish.ts` records evidence per write:
   photo, carousel, reel and edit-caption are `observed-in-bundle`; story, delete, comment and
   reply are `unverified`. Any write that is not `verified-live` needs `--experimental` as well as
   `--confirm`, which in v0.1 means all of them. A contract moves to `verified-live` only after its own
   live test passes (`test/live.test.ts`).
9. **Mutations never fall through.** Read candidates fall through on `not_found` or an unknown
   shape. Delete and comment fall through only on a plain HTTP 404, so a committed write that
   answers oddly is never sent a second time. Configure retries only on an explicit
   transcode-pending answer, and only for plans with video.
11. **One publish at a time.** Each run creates its own uniquely named claim file (`wx`), then
    withdraws and stops if any other claim may be live. Two runs starting together may both stop;
    they can never both continue. No step deletes a claim that might be live: claims of exited
    processes are ignored, and `pending unlock` deletes only those.
13. **Ambiguous stays pending.** A configure failure clears the pending record only for a definitive
    JSON answer with HTTP status below 500. HTML (even a 200 challenge page), a 5xx, or a dropped
    connection stays pending whatever its body. The transcode retry also needs a JSON
    "not ready" answer below 500.
15. **Account signals in HTML.** Non-JSON bodies are checked for challenge, login, action-block and
    please-wait markers before anything else, so they stop the run instead of falling through.
    These markers are heuristics until a live restriction page has been seen.
14. **Switches cannot be set to false by value.** `--confirm=false` and `--experimental=false` unset
    the switch, and any other value is rejected.
12. **Reused Chrome profiles are re-locked.** Login resets explicit permissions on every file in the
    profile, then checks that all of them inherit only the current user.
10. **Unknown ledger state blocks.** A corrupt pending record, or an unreadable ledger, blocks
    publishing rather than looking empty.
5. **Stop on account signals.** `rate_limited` (429 or "please wait"), `checkpoint`,
   `feedback_required` and `not_logged_in` stop the operation: `tryEach` falls through only on
   `not_found` or an unknown response shape, and `probe` and `swipe` stop at the first of these
   signals. There is no backoff loop. The one bounded retry is transcode-pending on configure
   (an explicit "not ready" answer, 10 configure attempts in total over about 5 min).
6. **No duplicate posts.** `pending.ts` writes a record before configure. Definitive answers
   clear it. Anything ambiguous (network error, 5xx, HTML, success without a media id, process
   death) leaves it unresolved, and every later publish is refused. `pending check` lists
   candidates (posts after the start time, caption match flagged) and never auto-resolves.
   Captions can repeat and reads can lag, so a human decides with
   `pending resolve --posted|--not-posted`.
7. **No engagement automation.** No like, follow or DM commands. Comments and replies are one per
   command, each text approved by the user.
8. **Request pacing.** At least 1.5 s between requests (`INSTAGRAM_MIN_GAP_MS`). Research is
   capped at 12 accounts and 50 posts each.

## Reads and GraphQL (acceptance criteria)

- Each read op has an ordered candidate list in `endpoints.ts` and reports `via`.
- Posts: v1 feed (`max_id` pagination), then the username feed, then GraphQL
  `PolarisProfilePostsQuery` (cursor pagination, `GQL.profilePosts`), then the 12 posts embedded in
  the profile (flagged as a small sample).
- GraphQL is **experimental**: doc ids come from live bundles (`extractDocIds`, unit test with
  the real registration shape) and are cached 24 h. Each can be pinned with
  `INSTAGRAM_DOCID_<Name>`. Variable shapes are not yet verified live, so failures surface as
  typed errors. They never fall back to guessed data. GraphQL is a read fallback only. No write
  uses GraphQL.
- Acceptance: the live read test (`INSTAGRAM_LIVE=1`) must return the account and posts with
  a `via`. Until it has been run, the docs label GraphQL experimental.

## Analytics honesty

`audit` reports n for every bucket, marks n<3 "insufficient data", and excludes posts with
hidden likes (they are not counted as comments only). It lists what only Insights provides
(reach, saves, shares, watch time, follows). Engagement rate uses current followers, as
documented.

## Testing

- `test/unit` is offline and runs under `bun test`:
  - cookie formats, ids, parseArgs, doc-id, token and script-url extraction, icacls parsing
  - classifyBody, host refusal, origin overrides, stop on 429, not_found fallthrough, the manual
    login redirect
  - media header parsers (ffmpeg fixtures when available)
  - caption, aspect, carousel and reel validation
  - the pending ledger: blocking, and ambiguous failure recorded without retry
  - normalizers and analytics
  - CLI subprocesses with a fetch trap
  - parity fixtures for the four content scripts
- `tsc --noEmit` over all scripts and tests.
- `test/live.test.ts` is opt-in. The read test needs `INSTAGRAM_LIVE=1`. The write test needs
  `INSTAGRAM_LIVE_WRITE=1` and `INSTAGRAM_LIVE_ACCOUNT` equal to the signed-in username. It posts
  one photo, reads it back, deletes it, and confirms it is gone. It is run only with the account
  owner's explicit go-ahead, on a test account.
- `test/evals.json` holds prompt-level behaviour cases (dry-run gate, experimental gate, stop on 429,
  pending, cookie privacy, no automation, linters, audit n, research caps, ads honesty).

## Known gaps (v0.1)

- Update 2026-11-04: photo, carousel, reel, story, comment and reply are verified live; `delete` was
  removed by design, and `edit-caption` still answers HTTP 500. See CHANGELOG.md.
- Story publishing is photo only. Stickers, music, collabs, trial reels, locations and user tags are
  not supported.
- Insights metrics are not available through this session.
- The private endpoints can change at any time. `probe` and `references/endpoints.md` describe
  how to re-verify them.
