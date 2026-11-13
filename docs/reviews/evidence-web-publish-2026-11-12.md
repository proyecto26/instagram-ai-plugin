# Evidence: what instagram.com's web client sends when publishing (static read, 2026-11-12)

Method: the 580 public scripts listed in the resource map of one instagram.com page were downloaded
from `static.cdninstagram.com` without cookies and searched as text. No JavaScript was executed, no
composer was opened, nothing was uploaded or posted. Local copies (not committed):
a local scratch folder with an index mapping URL to file.

## Reels: `POST /api/v1/media/configure_to_clips/`

File `9dc73c658bf3.js`, the request builder next to
`XPolarisIGXAPIMediaPublishClipsControllerRouteBuilder`. Form fields it sets, from its inputs:

| Input | Field sent | Shape |
|---|---|---|
| `usertags` (list of `{userId, position}`) | `usertags` | JSON `{"in":[{"user_id":"<id>"}]}`; `position` only when the input has one |
| `collaborators` (list of `{userId}`) | `invite_coauthor_user_ids_string` | JSON array of ids |
| `isGenAiSelfDisclosure === true` | `is_gen_ai_self_disclosure` and `gen_ai_detection_method` | `true` and `"SELF_DISCLOSURE_FLOW"` |
| audio (`audioClusterId` set) | `music_params` | JSON `{audio_asset_id, audio_asset_start_time_in_ms, audio_cluster_id, browse_session_id, derived_content_start_time_in_ms, overlap_duration_in_ms, product}` |
| audio | `clips_audio_metadata` | JSON `{"song":{audio_apply_source, audio_asset_id, audio_cluster_id, is_picked_precapture, is_saved, volume_level}}` |
| always | `caption`, `upload_id`, `source_type`, `media_share_flow:"creation_flow"`, `clips_share_preview_to_feed`, `disable_comments`, `like_and_view_counts_disabled`, `disable_oa_reuse`, `archive_only`, `video_subtitles_enabled` | strings |

## Stories: `POST /api/v1/media/configure_to_story/`

File `48d193889f7e.js`, module `PolarisAPICreationFinalizeStory`. The whole body is:
`caption`, `configure_mode:"1"`, `gen_ai_detection_method` (`"SELF_DISCLOSURE_FLOW"` when the AI
flag is on, otherwise absent), `share_to_facebook`, `share_to_fb_destination_id`,
`share_to_fb_destination_type`, `upload_id`. Behind one gate the same object is sent wrapped as
`signed_body: "SIGNATURE." + JSON`.

There is NO mention field in the web story composer. `tap_models` and `story_sticker_ids` occur in
none of the 580 scripts. `reel_mentions` occurs once, in `40360f0a0170.js`, on the READ side (a story
item's `reel_mentions` mapped to tappable objects with `user`).

## What this does and does not establish

- Establishes the field names and shapes the current web client builds for reel tags, collaborator
  invites, the AI label (reels and stories) and attaching library audio to a reel.
- Does not establish server behaviour: acceptance, who is notified, eligibility, or whether a
  server accepts these fields from this session without the rest of the web flow (for audio:
  `browse_session_id`, `product`, `audio_apply_source` values are unknown).
- Story mentions: the web client gives no write contract. `reel_mentions`/`tap_models` on
  `configure_to_story` remain an assumption taken from open-source mobile-API clients.

## Live capture from the web composer (2026-11-12)

One reel published by hand through instagram.com's own composer (two tags, AI label), with an in-page
hook recording the publish requests. Secrets (cookies, CSRF, fb_dtsg, lsd and the other session
parameters) were not read out; only field names and the non-secret values below.

- Upload: `GET` then `POST /rupload_igvideo/fb_uploader_<id>`, `POST /rupload_igphoto/fb_uploader_<id>`.
- Publish: `POST /api/v1/media/configure_to_clips/`, `Content-Type: application/x-www-form-urlencoded`, sent three times.
  Every answer is **HTTP 200** with the body `for (;;);{"__ar":1,"rid":...,"payload":{...}}`.
  Answers 1 and 2: `payload = {"statusCode":202}` (still processing). Answer 3: `payload.media` with pk and code.
  So "202" is a value INSIDE the payload envelope, not the HTTP status.
- Request header names: X-Instagram-AJAX, X-IG-App-ID, X-ASBD-ID, X-Web-Session-ID, X-IG-Max-Touch-Points,
  X-FB-QPL-Active-Flows, X-IG-D, X-FB-LSD, X-FB-Entry-Nonce.
- Form fields: archive_only=false, caption, clips_share_preview_to_feed=1, cross_app_share_type=2,
  disable_comments=0, disable_oa_reuse=false, gen_ai_detection_method=SELF_DISCLOSURE_FLOW,
  is_gen_ai_self_disclosure=true, like_and_view_counts_disabled=0, media_share_flow=creation_flow,
  source_type=library, upload_id, usertags={"in":[{"user_id":"..."},{"user_id":"..."}]} (no position),
  video_subtitles_enabled=0, share_to_facebook=true, share_to_fb_destination_type=USER,
  share_to_fb_destination_id, signed_body="SIGNATURE."+JSON of exactly those fields,
  plus the async-request parameters: __d=www, __user, __a=1, __req, __hs, dpr, __ccg, __rev, __s, __hsi,
  __dyn, __csr, __hsdp, __hblp, __sjsp, __comet_req=7, fb_dtsg, jazoest, lsd, __spin_r, __spin_b,
  __spin_t, __crn, qpl_active_flow_ids.

What this explains: the plugin posts the same endpoint WITHOUT the async-request parameters and got
HTTP 200 with an empty body twice. The working request is the "comet async" form (fb_dtsg/lsd/__a=1 ...),
whose answer is wrapped in `for (;;);{payload}`. The plugin's request shape is therefore not the one the
server answers for this endpoint today; the tag and AI-label fields themselves match what the plugin sends.
