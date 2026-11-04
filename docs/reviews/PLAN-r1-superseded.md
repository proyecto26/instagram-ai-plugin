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

## Components
| Type | Count | Notes |
|---|---|---|
| Skills | 5 | `instagram` (core CLI) + 4 marketing skills |
| Agents / hooks / MCP | 0 | not needed; scripts cover the integration |

### 1. `skills/instagram` (core, scripts)
Files: `scripts/main.ts` (CLI router), `constants.ts`, `paths.ts`,
`cookie-store.ts`, `auth.ts` (Chrome CDP login, same pattern as notebooklm),
`client.ts` (HTTP: headers, CSRF, rate limiter, 429 backoff, error taxonomy),
`endpoints.ts` (one table: each logical op maps to an ordered fallback list of
REST paths/hosts), `media.ts` (JPEG/PNG/MP4 header parsing for width/height/duration,
no deps; ffmpeg optional for PNG/WEBP to JPEG and reel cover), `upload.ts`
(rupload photo/video), `publish.ts` (photo, carousel, reel, story; configure
with transcode retry), `read.ts` (whoami, profile, posts, media, comments,
hashtag, search), `analytics.ts` (engagement rate, outlier multiple vs median,
format mix, cadence, best posting hours), `types.ts`.

Commands:
- `login [--force]`, `import-cookies <file|->` (Cookie-Editor JSON, Netscape
  cookies.txt, or raw `Cookie:` header; also `INSTAGRAM_COOKIES` env), `logout`,
  `whoami`, `probe` (health-checks each endpoint with backoff, reports which
  fallback answered).
- Reads: `profile <user>`, `posts [user] [--limit]`, `media <shortcode|url|id>`,
  `comments <media>`, `hashtag <tag>`, `search <query>`, `audit [user]`
  (JSON metrics for the audit skill).
- Writes: `post photo <file> --caption`, `post carousel <f1> <f2>...`,
  `post reel <video> [--cover] [--no-feed]`, `post story <file>`,
  `edit-caption <media>`, `delete <media>`, `comment <media> --text`,
  `reply <media> <commentId> --text`.
- Every write is a dry run (prints the exact requests, media facts, and
  validation result) unless `--confirm` is passed. `--json` everywhere.
- Validation before upload: caption <= 2200 chars, <= 30 hashtags (warn above 5),
  carousel 2-20 items, image aspect 4:5..1.91:1, reel 9:16 and 3s..15min,
  JPEG required for photos (convert via ffmpeg when present, else error with fix).
- Safety: cookie file 0600 under `%APPDATA%/instagram-ai` (XDG / Library
  equivalents), never printed; min 1.5s between requests; 429, `feedback_required`,
  `checkpoint_required`, `login_required` stop immediately with a typed error and
  a human fix; no follow/like/DM automation commands.

### 2. `skills/instagram-content`
From marketingskills `social` (MIT, Corey Haines) narrowed to Instagram:
pillars, hooks, captions, carousel frameworks, Reels scripting, Stories,
calendar, repurposing, no-AI-tells rules. Scripts (TS ports of MIT code from
`instagram-agent-skill`, Jake Schincariol, attributed): `caption-lint.ts`
(from ig-caption/caption.py), `hook-score.ts` + `hooks.json` (ig-reel),
`beats.ts` (ig-reel), `humanize.ts` + `slop.json` (ig-human detect).
Publishing hands off to the core CLI (`../instagram/scripts/main.ts`), always
dry-run first and `--confirm` only after the user approves the exact post.

### 3. `skills/instagram-audit`
Profile and post-performance audit on live data from `main.ts audit`: outlier
multiples, engagement rate by format, cadence, bio/profile rubric
(`rubric.json` from ig-profile, MIT). Labels missing metrics MISSING
(reach/saves/shares need Insights, not exposed on web).

### 4. `skills/instagram-research`
Replaces the two Apify `instagram-scraper` skills: competitor profiles,
hashtag top posts, outlier swipe file (TS port of ig-viral/swipe.py) via the
core CLI. Hard caps (default 12 accounts, 50 posts each) and pacing.

### 5. `skills/instagram-ads`
From marketingskills `ads` narrowed to Meta/Instagram: Andromeda playbook,
kill/scale decision system, creative formats/specs, audience, budget.
States plainly that the web cookie cannot drive Ads Manager; uses organic
outliers from the core CLI to pick boost / creative-test candidates, and
outputs briefs and specs. References copied from marketingskills with attribution.

## Plugin shell
Same manifests as notebooklm-ai-plugin: `plugin.json` (Agent Plugins 1.0),
`.claude-plugin/plugin.json` + `marketplace.json`, `.codex-plugin/plugin.json`,
`.agents/plugins/marketplace.json`, `scripts/check-manifests.sh` adapted for 5
skills, README, LICENSE (MIT, Proyecto 26 + third-party notices), CHANGELOG,
.gitignore (cookies, outputs). `git init` in the plugin dir.

## Testing
- `test/` with bun: `tsc --noEmit`; offline unit tests for media parsers
  (generated fixtures), cookie parsing (3 formats), payload builders (snapshot
  of rupload params / configure bodies), validation rules, linters, analytics math.
- `live.test.ts`: read endpoints, skipped without a session.
  `INSTAGRAM_LIVE_WRITE=1`: posts one photo with `archive_only` then deletes it.
- `claude plugin validate .` + `check-manifests.sh`.
- plugin-validator and skill-reviewer agents; Codex (Seldon rubric) reviews
  plan and implementation.

## Risks
- Private endpoints change without notice: one endpoint table, fallbacks,
  `probe`, typed errors that name the file to update.
- Account risk (automation detection, ToS): pacing, no engagement automation,
  explicit `--confirm`, README disclosure.
- Writes cannot be verified without posting on the user's account; the first live
  write test requires the user's explicit go-ahead.

## Revision 1 (after Seldon/Codex review, docs/reviews/seldon-plan.json)
1. **Credential isolation (Windows).** Cookie file: mode 0600 on POSIX; on Windows
   `icacls <file> /inheritance:r /grant:r <user>:F` after every write, verified by
   reading the ACL back (warn loudly if it fails). `logout` deletes the cookie file,
   runtime config and the dedicated Chrome profile (`--keep-profile` to retain it).
   `import-cookies` never echoes values; `whoami --json` shows redacted lengths only.
2. **Reads get a GraphQL transport.** Verified 2026-11-03: web bundles register
   188 relay operations as `__d("<Name>_instagramRelayOperation",[],(function(...){e.exports="<17-digit doc_id>"}))`,
   including `PolarisProfilePostsQuery`, `PolarisProfilePageContentQuery`,
   `PolarisAPITopsearchQuery`, `PolarisPostRootQuery`, `PolarisFeedCommentsDialogQuery`.
   `graphql.ts` loads one instagram.com page, reads `fb_dtsg`/`lsd` tokens from the
   HTML, scans its script bundles (CDN, not the API) for doc ids, caches them 24h,
   and POSTs `/graphql/query` (form: `doc_id`, `variables`, `fb_dtsg`, `lsd`,
   `fb_api_req_friendly_name`, `server_timestamps`). Read ops try REST first, then
   GraphQL; variable shapes are marked EXPERIMENTAL in code. If both fail the
   command exits with `unsupported_now` naming the op, never guessed data.
3. **Mutation contracts written out** in `publish.ts` (and README):
   - `upload_id` = `String(Date.now())`, unique per item (+1ms per carousel child);
     entity name `fb_uploader_<upload_id>`.
   - Photo rupload params `{media_type:1, upload_id, upload_media_width, upload_media_height}`;
     configure (form): `source_type=library, caption, upload_id, disable_comments=0,
     like_and_view_counts_disabled=0, igtv_share_preview_to_feed=1, is_unified_video=1,
     video_subtitles_enabled=0, media_share_flow=creation_flow, share_to_threads=false`.
   - Carousel: children uploaded with `is_sidecar:"1"`; `configure_sidecar` JSON
     `{caption, children_metadata:[{upload_id},...] in user order, client_sidecar_id,
     disable_comments:"0", like_and_view_counts_disabled:false, source_type:"library"}`.
   - Reel: video params from the live bundle + cover photo upload under the same
     upload_id (ffmpeg frame or `--cover`; without either rely on
     `extract_cover_frame:"1"`), then `configure_to_clips` (fields observed live).
   - Story: photo only in v0.1 (`configure_to_story`, `configure_mode=1`,
     `source_type=library`); video stories deferred.
   - Delete (`web/create/{pk}/delete/`) and comment/reply (`web/comments/{pk}/add/`,
     `replied_to_comment_id`) are legacy web contracts; marked UNVERIFIED until the
     live write test passes. Like/follow/DM are out of scope.
   Each contract carries a status flag (`verified-live` / `observed-in-bundle` /
   `unverified`) that the CLI prints on dry run.
4. **Live tests and write recovery.**
   - Live writes require `INSTAGRAM_LIVE_WRITE=1` AND `INSTAGRAM_LIVE_ACCOUNT=<username>`
     equal to `whoami` (binds approval to one account; use a test account).
     The test posts one photo (no archive assumption), verifies it via media info,
     deletes it, verifies deletion, and writes media ids to the action log so a
     failed cleanup can be finished by hand.
   - Transcode polling is bounded (10 tries, backoff to ~5 min total) and only
     retries on an explicit "not ready" answer. A network error or 5xx on configure
     is never retried blindly: the CLI reports the upload_id and checks the account's
     latest post for that caption before offering a retry.
5. **429 = stop**, no backoff loop (the plan's "backoff" wording is dropped); `probe`
   stops at the first 429/checkpoint. The client refuses any URL whose host is not an
   Instagram host and never follows redirects. Dry runs perform zero network requests
   (unit-tested with a fetch spy). Previews redact Cookie and CSRF headers.
6. **Limits.** Hashtags: default hard cap 5 (Instagram's late-2025 limit per the
   marketing reference), `--max-hashtags` to change; caption 2200; story 9:16;
   carousel crops to the first item's aspect (warned); video codec must be avc1/hvc1;
   photo <= 8MB.
7. **Tooling.** `test/package.json` with dev-only typescript, @types/bun, @types/node
   (same as notebooklm); Windows smoke test runs the CLI from outside the repo with a
   path containing spaces.
8. **Analytics honesty.** Posting-hour output is descriptive: sample size per bucket,
   the timezone used, and "insufficient data" under 3 posts per bucket.
