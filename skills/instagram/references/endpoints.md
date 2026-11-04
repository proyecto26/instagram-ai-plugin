# Instagram web endpoints and request contracts

Everything the `instagram` skill sends to Instagram, with the evidence behind each item.
Code of record: `scripts/endpoints.ts` (URLs), `scripts/publish.ts` (write bodies and the
`CONTRACTS` status map), `scripts/graphql.ts` (persisted queries), `scripts/client.ts` (headers).

## Evidence levels

| Status | Meaning |
|---|---|
| `verified-live` | Confirmed by `test/live.test.ts` against a real account |
| `observed-in-bundle` | Endpoint and field names read from the live instagram.com web client JS (2026-11-03) |
| `unverified` | Long-standing web/mobile contract, not re-confirmed |

Every write that is not `verified-live` needs `--experimental` in addition to `--confirm`.

When a live write test passes, change the entry in `CONTRACTS` (publish.ts) to `verified-live`.

## Headers (every request)

| Header | Value / source |
|---|---|
| `Cookie` | the saved session (`sessionid`, `csrftoken`, `ds_user_id`, `mid`, `ig_did`, `datr`, `rur`, ...) |
| `X-CSRFToken` | value of the `csrftoken` cookie (rotates; the client saves `Set-Cookie` updates) |
| `X-IG-App-ID` | `936619743392459` (web app id in the page HTML) |
| `X-ASBD-ID` | `359341` (`require("BDHeaderConfig").ASBD_ID` in the web client) |
| `X-IG-WWW-Claim` | `0`, then whatever Instagram returns in `x-ig-set-www-claim` |
| `X-Requested-With` | `XMLHttpRequest` |
| `Origin` / `Referer` | `https://www.instagram.com` |

`probe --refresh-config` re-reads the app id and ASBD id from the live page and stores them in
`runtime-config.json`. The client sends the session only to `https` Instagram hosts and never
follows redirects. A redirect to `/accounts/login` is reported as `not_logged_in`.

## Reads

| Op | Candidates (tried in order) | Observed 2026-11-03 |
|---|---|---|
| whoami | `www/api/v1/users/{ds_user_id}/info/`, same on `i.`, `www/api/v1/accounts/current_user/?edit=true` | 429 during probing / 200 (HTML without app headers) |
| profile | `www/api/v1/users/web_profile_info/?username=`, same on `i.` | 429 during probing |
| posts | `i./api/v1/feed/user/{id}/?count=&max_id=`, `www/api/v1/feed/user/{username}/username/`, GraphQL `PolarisProfilePostsQuery`, embedded 12 from `web_profile_info` | 404 on www for `feed/user/{id}` |
| media | `www/api/v1/media/{pk}/info/`, same on `i.` | in bundle |
| comments | `www/api/v1/media/{pk}/comments/?can_support_threading=true&min_id=`, same on `i.` | in bundle |
| hashtag | `www/api/v1/tags/web_info/?tag_name=` | 200 JSON |
| search | `www/api/v1/web/search/topsearch/?context=blended&query=`, `i./api/v1/fbsearch/topsearch_flat/`, `i./api/v1/users/search/?q=`, GraphQL `PolarisAPITopsearchQuery` | 404 without `context` |

The 429s came from probing many endpoints in a row. They show the endpoint exists, not that it
is broken. The client moves to the next candidate only on `not_found` or an unknown response
shape. Any auth, rate-limit or payload error stops the chain.

### GraphQL persisted queries

The web client registers each Relay operation in a CDN bundle:

```
__d("PolarisProfilePostsQuery_instagramRelayOperation",[],(function(a,b,c,d,e,f){e.exports="<17-digit doc_id>"}),null)
```

On 2026-11-03 a profile page loaded 188 such operations, including `PolarisProfilePostsQuery`,
`PolarisProfilePageContentQuery`, `PolarisAPITopsearchQuery`, `PolarisPostRootQuery`,
`PolarisFeedCommentsDialogQuery`, `PolarisCommentActionsDeleteMutation` and
`PolarisCommentActionsLikeMutation`. `graphql.ts`:

1. GETs an instagram.com page with the session (a profile page for posts).
2. Reads `fb_dtsg` (`"DTSGInitialData",[],{"token":"..."}`) and `lsd` (`"LSD",[],{"token":"..."}`).
3. Fetches the page's script bundles from the CDN **without cookies** and extracts doc ids.
   They are cached for 24 h in `graphql-docids.json`.
4. POSTs `www/graphql/query` as a form with `doc_id`, `variables` (JSON), `fb_dtsg`, `lsd`,
   `fb_api_req_friendly_name`, `fb_api_caller_class=RelayModern`, `server_timestamps=true`,
   and headers `X-FB-Friendly-Name` and `X-FB-LSD`.

Variable shapes are EXPERIMENTAL (see `GQL` in graphql.ts). If a call fails, the command reports
a typed error. It never guesses data. To pin an id, set `INSTAGRAM_DOCID_<Name>=<id>`.

## Uploads (rupload)

Both are `POST https://i.instagram.com/rupload_ig{photo|video}/fb_uploader_<upload_id>`, with the
raw file bytes as the body (observed in the live upload module, `withCredentials`).

| Header | Value |
|---|---|
| `X-Instagram-Rupload-Params` | JSON, below |
| `X-Entity-Name` | `fb_uploader_<upload_id>` |
| `X-Entity-Length` | byte length |
| `X-Entity-Type` | `image/jpeg` or the video mime |
| `Offset` | `0` (single-shot upload) |
| `Content-Type` | same as `X-Entity-Type` |

`upload_id` = `String(Date.now())`, strictly increasing per item.

- Photo params: `{media_type:1, upload_id, upload_media_width, upload_media_height}`, plus
  `is_sidecar:"1"` for carousel children.
- Video params (field names from the bundle): `{"client-passthrough":"1", is_clips_video:"1"|"0",
  is_sidecar:"0"|"1", is_unified_video:"0", media_type:2, for_album:false, video_format:"",
  upload_id, upload_media_duration_ms, upload_media_width, upload_media_height,
  video_transform:null, extract_cover_frame:"1"}`.
- Video cover: a JPEG uploaded to `rupload_igphoto` under the **same** `upload_id`, with
  `media_type:2`. It is skipped when neither `--cover` nor ffmpeg is available; Instagram then
  extracts a frame itself.

## Publish (configure)

| Kind | Endpoint | Encoding | Body |
|---|---|---|---|
| photo | `www/api/v1/media/configure/` | form | `source_type=library, caption, upload_id, disable_comments, like_and_view_counts_disabled, igtv_share_preview_to_feed=1, is_unified_video=1, video_subtitles_enabled=0, is_meta_only_post=0, media_share_flow=creation_flow, share_to_threads=false, custom_accessibility_caption?` |
| carousel | `www/api/v1/media/configure_sidecar/` | JSON | `{archive_only:false, caption, children_metadata:[{upload_id}...] (user order), client_sidecar_id, disable_comments:"0", like_and_view_counts_disabled:false, source_type:"library"}` |
| reel | `www/api/v1/media/configure_to_clips/` | form | photo flags plus `clips_share_preview_to_feed=1|0, archive_only=false, disable_oa_reuse=false` |
| story | `www/api/v1/media/configure_to_story/` | form | `source_type=library, configure_mode=1, upload_id, caption=""` (unverified) |

Fields seen in the live `configure_to_clips` builder include `caption`, `upload_id`,
`source_type`, `clips_share_preview_to_feed`, `disable_comments`,
`like_and_view_counts_disabled`, `video_subtitles_enabled`, `archive_only`,
`media_share_flow:"creation_flow"`, `invite_coauthor_user_ids_string`,
`custom_accessibility_caption`, `is_meta_only_post`, `share_to_threads`, `trial_params` and
`graduation_strategy:"manual"` (trial reels). A retry module (`polarisConfigureToClipsRetry`)
handles transcode-in-progress. The CLI retries only on an explicit "not ready" answer
(HTTP 202 / "transcode not finished"), 10 times over about 5 minutes.

### Ambiguous outcomes

Before the configure call the CLI writes `pending/<upload_id>.json`. A definitive answer removes
it: success, or `bad_request` / `validation` / `rate_limited` / `feedback_required` /
`checkpoint` / `not_logged_in` / `not_found`. Anything else (network error, 5xx, HTML, a success
without a media id) leaves it `unresolved`, and new publishes are refused until the user runs
`pending resolve`. `pending check` lists recent posts created after the attempt, flagged by
caption match. It is advice only, because captions can repeat and reads can lag. Story ops
always need a manual check.

## Manage

| Op | Endpoint | Body | Status |
|---|---|---|---|
| edit caption | `www/api/v1/media/{pk}/edit_media/` | form `caption_text`, `coauthor_invites={"added":[],"in":[],"removed":[]}` (PolarisPostActionEditPost) | observed-in-bundle; live attempts on 2026-11-04 answered a non-JSON HTTP 500, still unresolved |
| comment / reply | GraphQL `PolarisPostCommentInputRevampedMutation` on `POST www/api/graphql` (doc_id from the post page's bundles), variables `{data:{comment_text, media_id, replied_to_comment_id?}, root_connections:[]}`; legacy REST `web/comments/{pk}/add/` and `i./media/{pk}/comment/` only when the doc_id is not found | verified-live 2026-11-04 (comment and threaded reply) |

## Re-verifying after an Instagram change

1. In a signed-in Chrome tab on instagram.com, open Create > Post (do not share). That loads the
   create-flow bundles.
2. In DevTools, search the loaded scripts for `configure_to_clips`, `rupload_igvideo`,
   `X-Instagram-Rupload-Params` and `_instagramRelayOperation`. Compare the field names with
   the tables above.
3. Run `npx -y bun scripts/main.ts probe --refresh-config --graphql`.
4. Edit `scripts/endpoints.ts` / `publish.ts`, run `cd test && npx -y bun test unit`, then the
   opt-in live tests (see the repository README).
